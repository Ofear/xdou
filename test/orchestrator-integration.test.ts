import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { XdouOrchestrator } from '../src/orchestrator.js';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult, AgentType } from '../src/types.js';

class FakeAgent implements AgentAdapter {
  readonly type: AgentType = 'codex';
  readonly command: string;

  constructor(readonly id: string, readonly roles: AgentRole[] = ['brainstormer', 'critic', 'architect', 'implementer', 'reviewer']) {
    this.command = `fake-${id}`;
  }

  buildInvocation(input: AgentInput): AgentInvocation {
    return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false };
  }

  detect(): Promise<{ available: boolean; version: string }> {
    return Promise.resolve({ available: true, version: 'fake' });
  }

  run(input: AgentInput): Promise<AgentRunResult> {
    const started = Date.now();
    if (this.roles.includes('implementer')) writeFileSync(join(input.cwd, 'implemented.txt'), `implemented by ${this.id}\n`);
    return Promise.resolve({
      agent: this.id,
      command: this.command,
      args: [input.prompt],
      exitCode: 0,
      stdout: `# ${this.id} output\n\nrole prompt included ${input.prompt.includes('ROLE:') ? 'role' : 'missing-role'}`,
      stderr: '',
      durationMs: Date.now() - started,
      ok: true,
    });
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

describe('XdouOrchestrator collaborative run', () => {
  it('runs council, synthesis, implementation, validation, and multiple reviews through artifacts', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      claude: new FakeAgent('claude'),
      codex: new FakeAgent('codex'),
      critic: new FakeAgent('critic', ['critic', 'reviewer']),
    });

    const runId = await orchestrator.run({
      cwd,
      mission: 'build collaborative loop',
      team: ['claude', 'codex', 'claude'],
      brainstormers: ['claude', 'codex'],
      critics: ['critic'],
      reviewers: ['claude', 'critic'],
    });

    const runDir = orchestrator.store.runDir(runId);
    const council = readFileSync(join(runDir, 'council.md'), 'utf8');
    const synthesis = readFileSync(join(runDir, 'synthesis.md'), 'utf8');
    const finalSummary = readFileSync(join(runDir, 'final-summary.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as { status: string; phase: string };

    expect(council).toContain('## claude (brainstormer)');
    expect(council).toContain('## critic (critic)');
    expect(synthesis).toContain('Selected implementation direction');
    expect(finalSummary).toContain('Mission');
    expect(finalSummary).toContain('Reviewers: claude, critic');
    expect(manifest).toEqual(expect.objectContaining({ status: 'completed', phase: 'done' }));
  });

  it('refuses mutating runs on a dirty working tree', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    writeFileSync(join(cwd, 'dirty.txt'), 'uncommitted');
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, { claude: new FakeAgent('claude'), codex: new FakeAgent('codex') });

    await expect(orchestrator.run({ cwd, mission: 'should refuse', team: ['claude', 'codex', 'claude'] })).rejects.toThrow(/dirty working tree/);
  });
});
