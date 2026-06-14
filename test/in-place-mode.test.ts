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
  constructor(readonly id: string, readonly roles: AgentRole[], private readonly behavior: (input: AgentInput) => void) {
    this.command = `scripted-${id}`;
  }
  buildInvocation(input: AgentInput): AgentInvocation { return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false }; }
  detect(): Promise<{ available: boolean; version: string }> { return Promise.resolve({ available: true, version: 'scripted' }); }
  run(input: AgentInput): Promise<AgentRunResult> {
    this.behavior(input);
    const stdout = input.prompt.includes('ROLE: reviewer')
      ? 'REVIEW_VERDICT:\n{"verdict":"approve","confidence":1,"reason":"ok","missingRequirements":[]}'
      : `${this.id} ok`;
    return Promise.resolve({ agent: this.id, command: this.command, args: [input.prompt], exitCode: 0, stdout, stderr: '', durationMs: 1, ok: true });
  }
}

function buildOrchestrator(cwd: string): XdouOrchestrator {
  const implementer = new ScriptedAgent('codex', ['implementer'], (input) => {
    if (input.prompt.includes('ROLE: implementer')) writeFileSync(join(input.cwd, 'implemented.txt'), 'edited in place\n');
  });
  return new XdouOrchestrator(cwd, '.xdou', {}, {
    claude: new ScriptedAgent('claude', ['brainstormer', 'architect', 'reviewer'], () => undefined),
    codex: implementer,
  });
}

describe('in-place mode', () => {
  it('edits the working directory directly on a DIRTY git repo (no refusal)', async () => {
    const cwd = temporaryDirectory();
    await execa('git', ['init'], { cwd });
    await execa('git', ['config', 'user.email', 't@t'], { cwd });
    await execa('git', ['config', 'user.name', 't'], { cwd });
    writeFileSync(join(cwd, 'seed.txt'), 'seed\n');
    await execa('git', ['add', '.'], { cwd });
    await execa('git', ['commit', '-m', 'init'], { cwd });
    writeFileSync(join(cwd, 'dirty.txt'), 'uncommitted work\n'); // make the tree dirty

    const orchestrator = buildOrchestrator(cwd);
    const runId = await orchestrator.run({ cwd, mission: 'edit in place', team: ['claude', 'codex', 'claude'], isolated: false, maxFixAttempts: 0 });
    const manifest = JSON.parse(readFileSync(join(orchestrator.store.runDir(runId), 'manifest.json'), 'utf8')) as { status: string; inPlace?: boolean };

    expect(existsSync(join(cwd, 'implemented.txt'))).toBe(true); // edited the real working dir, not a worktree
    expect(existsSync(join(cwd, 'dirty.txt'))).toBe(true);       // pre-existing uncommitted work untouched
    expect(manifest.status).toBe('completed');
    expect(manifest.inPlace).toBe(true);
  });

  it('runs without any git repo at all', async () => {
    const cwd = temporaryDirectory(); // no git init
    const orchestrator = buildOrchestrator(cwd);
    const runId = await orchestrator.run({ cwd, mission: 'edit without git', team: ['claude', 'codex', 'claude'], isolated: false, maxFixAttempts: 0 });
    const manifest = JSON.parse(readFileSync(join(orchestrator.store.runDir(runId), 'manifest.json'), 'utf8')) as { status: string; inPlace?: boolean };

    expect(existsSync(join(cwd, 'implemented.txt'))).toBe(true);
    expect(manifest.status).toBe('completed'); // diff-required/mission checks are skipped without git
    expect(manifest.inPlace).toBe(true);
  });

  it('still refuses isolated (default) runs on a dirty tree', async () => {
    const cwd = temporaryDirectory();
    await execa('git', ['init'], { cwd });
    await execa('git', ['config', 'user.email', 't@t'], { cwd });
    await execa('git', ['config', 'user.name', 't'], { cwd });
    await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd });
    writeFileSync(join(cwd, 'dirty.txt'), 'x\n');
    const orchestrator = buildOrchestrator(cwd);
    await expect(orchestrator.run({ cwd, mission: 'isolated on dirty', team: ['claude', 'codex', 'claude'] })).rejects.toThrow(/dirty working tree/);
  });
});
