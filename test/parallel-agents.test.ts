import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { XdouOrchestrator } from '../src/orchestrator.js';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult, AgentType } from '../src/types.js';

const starts: Array<{ id: string; role: string; time: number }> = [];

class DelayedAgent implements AgentAdapter {
  readonly type: AgentType = 'codex';
  readonly command: string;
  constructor(readonly id: string, readonly roles: AgentRole[], private readonly delayMs: number, private readonly mutate = false) {
    this.command = `delayed-${id}`;
  }
  buildInvocation(input: AgentInput): AgentInvocation { return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false }; }
  detect(): Promise<{ available: boolean; version: string }> { return Promise.resolve({ available: true, version: 'delayed' }); }
  async run(input: AgentInput): Promise<AgentRunResult> {
    const role = input.prompt.match(/ROLE: ([^\n]+)/)?.[1] ?? 'unknown';
    starts.push({ id: this.id, role, time: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.mutate) writeFileSync(join(input.cwd, 'implemented.txt'), 'done\n');
    const stdout = input.prompt.includes('ROLE: reviewer') ? 'REVIEW_VERDICT:\n{"verdict":"approve","confidence":1,"reason":"test reviewer approves","missingRequirements":[]}' : `${this.id} ok`;
    return { agent: this.id, command: this.command, args: [input.prompt], exitCode: 0, stdout, stderr: '', durationMs: this.delayMs, ok: true };
  }
}

async function initGitRepo(cwd: string): Promise<void> {
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  writeFileSync(join(cwd, '.gitignore'), '.xdou/runs/\n.xdou/worktrees/\n');
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
}

describe('parallel co-development phases', () => {
  it('runs council and review agents concurrently', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      a: new DelayedAgent('a', ['brainstormer', 'architect', 'reviewer'], 250),
      b: new DelayedAgent('b', ['brainstormer', 'reviewer'], 250),
      c: new DelayedAgent('c', ['critic', 'reviewer'], 250),
      codex: new DelayedAgent('codex', ['implementer'], 5, true),
    });

    starts.length = 0;
    await orchestrator.run({ cwd, mission: 'parallel timing', team: ['a', 'codex', 'a'], brainstormers: ['a', 'b'], critics: ['c'], reviewers: ['a', 'b', 'c'], maxFixAttempts: 0 });

    const councilStarts = starts.filter((entry) => ['brainstormer', 'critic'].includes(entry.role)).map((entry) => entry.time);
    const reviewStarts = starts.filter((entry) => entry.role === 'reviewer').map((entry) => entry.time);
    expect(Math.max(...councilStarts) - Math.min(...councilStarts)).toBeLessThan(150);
    expect(Math.max(...reviewStarts) - Math.min(...reviewStarts)).toBeLessThan(150);
  });
});
