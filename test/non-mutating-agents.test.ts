import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { XdouOrchestrator } from '../src/orchestrator.js';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult, AgentType } from '../src/types.js';

class WritingAgent implements AgentAdapter {
  readonly type: AgentType = 'codex';
  readonly command: string;

  constructor(readonly id: string, readonly roles: AgentRole[], private readonly marker: string) {
    this.command = `fake-${id}`;
  }

  buildInvocation(input: AgentInput): AgentInvocation {
    return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false };
  }

  detect(): Promise<{ available: boolean; version: string }> {
    return Promise.resolve({ available: true, version: 'fake' });
  }

  run(input: AgentInput): Promise<AgentRunResult> {
    writeFileSync(join(input.cwd, this.marker), `written by ${this.id}\n`);
    const stdout = input.prompt.includes('ROLE: reviewer') ? 'REVIEW_VERDICT:\n{"verdict":"approve","confidence":1,"reason":"test reviewer approves","missingRequirements":[]}' : `ok ${this.id}`;
    return Promise.resolve({
      agent: this.id,
      command: this.command,
      args: [input.prompt],
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 0,
      ok: true,
    });
  }
}

class TimeoutCapturingAgent implements AgentAdapter {
  readonly type: AgentType = 'codex';
  readonly command: string;
  readonly inputs: AgentInput[] = [];

  constructor(readonly id: string, readonly roles: AgentRole[]) {
    this.command = `fake-${id}`;
  }

  buildInvocation(input: AgentInput): AgentInvocation {
    return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false };
  }

  detect(): Promise<{ available: boolean; version: string }> {
    return Promise.resolve({ available: true, version: 'fake' });
  }

  run(input: AgentInput): Promise<AgentRunResult> {
    this.inputs.push(input);
    return Promise.resolve({ agent: this.id, command: this.command, args: [input.prompt], exitCode: 0, stdout: `ok ${this.id}`, stderr: '', durationMs: 0, ok: true });
  }
}

async function initGitRepo(cwd: string): Promise<void> {
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
}

describe('non-mutating agent isolation', () => {
  it('keeps brainstormers, critics, architects, and reviewers out of the operator repo and implementation worktree', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      claude: new WritingAgent('claude', ['brainstormer', 'critic', 'architect', 'reviewer'], 'non-mutating-agent-wrote.txt'),
      codex: new WritingAgent('codex', ['implementer'], 'implementation-agent-wrote.txt'),
    });

    const runId = await orchestrator.run({
      cwd,
      mission: 'verify agent cwd isolation',
      team: ['claude', 'codex', 'claude'],
      brainstormers: ['claude'],
      critics: ['claude'],
      reviewers: ['claude'],
    });

    const manifest = await orchestrator.store.readManifest(runId);
    expect(manifest.worktreePath).toBeTruthy();
    expect(existsSync(join(cwd, 'non-mutating-agent-wrote.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'implementation-agent-wrote.txt'))).toBe(false);
    expect(existsSync(join(manifest.worktreePath!, 'non-mutating-agent-wrote.txt'))).toBe(false);
    expect(existsSync(join(manifest.worktreePath!, 'implementation-agent-wrote.txt'))).toBe(true);
    expect(existsSync(join(orchestrator.store.runDir(runId), 'project-snapshot', 'non-mutating-agent-wrote.txt'))).toBe(true);
  });

  it('gives autonomous agent calls a bounded default timeout so one slow agent cannot hang a live run indefinitely', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const claude = new TimeoutCapturingAgent('claude', ['brainstormer', 'critic', 'architect', 'reviewer']);
    const codex = new TimeoutCapturingAgent('codex', ['brainstormer', 'implementer']);
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, { claude, codex });

    await orchestrator.run({
      cwd,
      mission: 'plan a bounded agent run',
      execute: false,
      team: ['claude', 'codex', 'claude'],
      brainstormers: ['claude', 'codex'],
      critics: ['claude'],
    });

    expect([...claude.inputs, ...codex.inputs].length).toBeGreaterThan(0);
    expect([...claude.inputs, ...codex.inputs].every((input) => input.timeoutMs === 180_000)).toBe(true);
  });
});
