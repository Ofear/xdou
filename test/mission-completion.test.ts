import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { XdouOrchestrator } from '../src/orchestrator.js';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult, AgentType } from '../src/types.js';

class StaticAgent implements AgentAdapter {
  readonly type: AgentType = 'codex';
  readonly command: string;
  constructor(readonly id: string, readonly roles: AgentRole[], private readonly behavior: (input: AgentInput) => void = () => undefined) {
    this.command = `static-${id}`;
  }
  buildInvocation(input: AgentInput): AgentInvocation { return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false }; }
  detect(): Promise<{ available: boolean; version: string }> { return Promise.resolve({ available: true, version: 'static' }); }
  run(input: AgentInput): Promise<AgentRunResult> {
    this.behavior(input);
    return Promise.resolve({ agent: this.id, command: this.command, args: [input.prompt], exitCode: 0, stdout: `${this.id} ok`, stderr: '', durationMs: 0, ok: true });
  }
}

async function initGitRepo(cwd: string): Promise<void> {
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  writeFileSync(join(cwd, 'math.js'), 'export function add(a,b){ return a+b; }\n');
  writeFileSync(join(cwd, '.gitignore'), '.xdou/runs/\n.xdou/worktrees/\n');
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
}

describe('mission completion validation', () => {
  it('blocks a false green when the requested function never appears in the produced diff', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      claude: new StaticAgent('claude', ['brainstormer', 'architect', 'reviewer']),
      codex: new StaticAgent('codex', ['implementer'], (input) => writeFileSync(join(input.cwd, 'notes.txt'), 'unrelated change\n')),
    });

    const runId = await orchestrator.run({ cwd, mission: 'Add a divide(a, b) function exported from math.js', team: ['claude', 'codex', 'claude'], maxFixAttempts: 0 });
    const manifest = await orchestrator.store.readManifest(runId);
    const validation = readFileSync(join(orchestrator.store.runDir(runId), 'mission-check.json'), 'utf8');

    expect(manifest.status).toBe('blocked');
    expect(validation).toContain('divide');
    expect(validation).toContain('failed');
  });
});
