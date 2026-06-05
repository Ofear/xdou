import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { XdouOrchestrator } from '../src/orchestrator.js';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult, AgentType } from '../src/types.js';

class ScriptedAgent implements AgentAdapter {
  readonly type: AgentType = 'codex';
  readonly command: string;
  calls = 0;

  constructor(readonly id: string, readonly roles: AgentRole[], private readonly behavior: (input: AgentInput, call: number) => Partial<AgentRunResult> | void) {
    this.command = `scripted-${id}`;
  }

  buildInvocation(input: AgentInput): AgentInvocation { return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false }; }
  detect(): Promise<{ available: boolean; version: string }> { return Promise.resolve({ available: true, version: 'scripted' }); }
  run(input: AgentInput): Promise<AgentRunResult> {
    this.calls += 1;
    const started = Date.now();
    const override = this.behavior(input, this.calls) ?? {};
    return Promise.resolve({
      agent: this.id,
      command: this.command,
      args: [input.prompt],
      exitCode: override.exitCode ?? 0,
      stdout: override.stdout ?? (input.prompt.includes('ROLE: reviewer') ? 'REVIEW_VERDICT:\n{"verdict":"approve","confidence":1,"reason":"test reviewer approves","missingRequirements":[]}' : `${this.id} ok`),
      stderr: override.stderr ?? '',
      durationMs: Date.now() - started,
      ok: override.ok ?? true,
    });
  }
}

async function initGitRepo(cwd: string, testCommand = 'node check.cjs'): Promise<void> {
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: testCommand } }, null, 2));
  writeFileSync(join(cwd, 'check.cjs'), "process.exit(require('fs').existsSync('implemented.txt') ? 0 : 1);\n");
  writeFileSync(join(cwd, '.gitignore'), '.xdou/runs/\n.xdou/worktrees/\n');
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
}

describe('worktree isolation and fix loop', () => {
  it('runs mutating agents in an isolated worktree and leaves the operator checkout untouched', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const implementer = new ScriptedAgent('codex', ['implementer'], (input) => { if (input.prompt.includes('ROLE: implementer')) writeFileSync(join(input.cwd, 'implemented.txt'), 'from isolated worktree\n'); });
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      claude: new ScriptedAgent('claude', ['brainstormer', 'architect', 'reviewer'], () => undefined),
      codex: implementer,
    });

    const runId = await orchestrator.run({ cwd, mission: 'change safely', team: ['claude', 'codex', 'claude'], maxFixAttempts: 0 });
    const manifest = JSON.parse(readFileSync(join(orchestrator.store.runDir(runId), 'manifest.json'), 'utf8')) as { worktreePath: string; status: string };
    const diff = readFileSync(join(orchestrator.store.runDir(runId), 'diff.patch'), 'utf8');

    expect(existsSync(join(cwd, 'implemented.txt'))).toBe(false);
    expect(existsSync(join(manifest.worktreePath, 'implemented.txt'))).toBe(true);
    expect(diff).toContain('implemented.txt');
    expect(diff).not.toContain('.xdou/runs');
    expect(manifest.status).toBe('completed');
  });

  it('blocks completed status when implementer produces no worktree diff', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd, 'node -e "process.exit(0)"');
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      claude: new ScriptedAgent('claude', ['brainstormer', 'architect', 'reviewer'], () => undefined),
      codex: new ScriptedAgent('codex', ['implementer'], () => undefined),
    });

    const runId = await orchestrator.run({ cwd, mission: 'create a tiny greet CLI project', team: ['claude', 'codex', 'claude'], maxFixAttempts: 0 });
    const runDir = orchestrator.store.runDir(runId);
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as { status: string; phase: string };
    const validation = readFileSync(join(runDir, 'validation.json'), 'utf8');

    expect(manifest).toEqual(expect.objectContaining({ status: 'blocked', phase: 'needs_attention' }));
    expect(validation).toContain('xdou diff-required-check');
    expect(validation).toContain('No worktree diff was produced');
  });

  it('runs fixer after validation failure and completes when validation passes', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const fixer = new ScriptedAgent('fixer', ['fixer'], (input) => { writeFileSync(join(input.cwd, 'implemented.txt'), 'fixed\n'); });
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      claude: new ScriptedAgent('claude', ['brainstormer', 'architect', 'reviewer'], () => undefined),
      codex: new ScriptedAgent('codex', ['implementer'], () => undefined),
      fixer,
    });

    const runId = await orchestrator.run({ cwd, mission: 'fix until green', team: ['claude', 'codex', 'claude'], fixer: 'fixer', maxFixAttempts: 1 });
    const runDir = orchestrator.store.runDir(runId);
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as { status: string; phase: string };
    const timeline = readFileSync(join(runDir, 'timeline.ndjson'), 'utf8');

    expect(fixer.calls).toBe(1);
    expect(existsSync(join(runDir, 'fixes', 'attempt-1', 'result.json'))).toBe(true);
    expect(existsSync(join(runDir, 'fixes', 'attempt-1', 'validation.json'))).toBe(true);
    expect(timeline).toContain('fix.started');
    expect(manifest).toEqual(expect.objectContaining({ status: 'completed', phase: 'done' }));
  });
});
