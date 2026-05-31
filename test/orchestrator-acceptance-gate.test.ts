import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { XdouOrchestrator } from '../src/orchestrator.js';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult, AgentType } from '../src/types.js';

class AcceptanceAgent implements AgentAdapter {
  readonly type: AgentType = 'codex';
  readonly command: string;
  constructor(readonly id: string, readonly roles: AgentRole[], private readonly behavior: (input: AgentInput) => string = () => 'ok') {
    this.command = `acceptance-${id}`;
  }
  buildInvocation(input: AgentInput): AgentInvocation { return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false }; }
  detect(): Promise<{ available: boolean; version: string }> { return Promise.resolve({ available: true, version: 'acceptance' }); }
  run(input: AgentInput): Promise<AgentRunResult> {
    const stdout = this.behavior(input);
    return Promise.resolve({ agent: this.id, command: this.command, args: [input.prompt], exitCode: 0, stdout, stderr: '', durationMs: 0, ok: true });
  }
}

async function initGitRepo(cwd: string): Promise<void> {
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  writeFileSync(join(cwd, 'math.js'), 'export function add(a,b){ return a+b; }\n');
  writeFileSync(join(cwd, '.gitignore'), '.xdou/runs/\n.xdou/worktrees/\n');
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
}

describe('orchestrator generated acceptance gate', () => {
  it('blocks when generated behavioral acceptance tests fail before semantic review approval can pass it', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      claude: new AcceptanceAgent('claude', ['brainstormer', 'architect', 'reviewer'], (input) => {
        if (input.prompt.includes('ROLE: reviewer')) return 'REVIEW_VERDICT:\n{"verdict":"approve","confidence":1,"reason":"looks fine","missingRequirements":[]}';
        return 'plan ok';
      }),
      codex: new AcceptanceAgent('codex', ['implementer'], (input) => {
        writeFileSync(join(input.cwd, 'math.js'), 'export function add(a,b){ return a+b; }\nexport function divide(a,b){ return a*b; }\n');
        return 'implemented divide';
      }),
    });

    const runId = await orchestrator.run({ cwd, mission: 'Add a divide(a, b) function exported from math.js', team: ['claude', 'codex', 'claude'], maxFixAttempts: 0 });
    const manifest = await orchestrator.store.readManifest(runId);
    const generated = readFileSync(join(orchestrator.store.runDir(runId), 'generated-acceptance.json'), 'utf8');

    expect(manifest.status).toBe('blocked');
    expect(generated).toContain('divide(8, 2) expected 4 but got 16');
  });
});
