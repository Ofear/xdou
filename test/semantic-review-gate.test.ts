import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { XdouOrchestrator } from '../src/orchestrator.js';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult, AgentType } from '../src/types.js';

class SemanticAgent implements AgentAdapter {
  readonly type: AgentType = 'codex';
  readonly command: string;
  constructor(readonly id: string, readonly roles: AgentRole[], private readonly behavior: (input: AgentInput) => string = () => 'ok') {
    this.command = `semantic-${id}`;
  }
  buildInvocation(input: AgentInput): AgentInvocation { return { command: this.command, args: [input.prompt], cwd: input.cwd, shell: false }; }
  detect(): Promise<{ available: boolean; version: string }> { return Promise.resolve({ available: true, version: 'semantic' }); }
  run(input: AgentInput): Promise<AgentRunResult> {
    const stdout = this.behavior(input);
    return Promise.resolve({ agent: this.id, command: this.command, args: [input.prompt], exitCode: 0, stdout, stderr: '', durationMs: 0, ok: true });
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

describe('semantic reviewer completion gate', () => {
  it('blocks a symbol-present but semantically rejected implementation', async () => {
    const cwd = temporaryDirectory();
    await initGitRepo(cwd);
    const orchestrator = new XdouOrchestrator(cwd, '.xdou', {}, {
      claude: new SemanticAgent('claude', ['brainstormer', 'architect', 'reviewer'], (input) => {
        if (input.prompt.includes('ROLE: reviewer')) return 'REVIEW_VERDICT:\n{"verdict":"request_changes","confidence":0.95,"reason":"divide returns multiplication","missingRequirements":["divide must return quotient"]}';
        return 'plan ok';
      }),
      codex: new SemanticAgent('codex', ['implementer'], (input) => {
        writeFileSync(join(input.cwd, 'math.js'), 'export function add(a,b){ return a+b; }\nexport function divide(a,b){ return a*b; }\n');
        return 'implemented divide';
      }),
    });

    const runId = await orchestrator.run({ cwd, mission: 'Add a divide(a, b) function exported from math.js', team: ['claude', 'codex', 'claude'], maxFixAttempts: 0 });
    const manifest = await orchestrator.store.readManifest(runId);
    const semantic = readFileSync(join(orchestrator.store.runDir(runId), 'review-verdicts.json'), 'utf8');

    expect(manifest.status).toBe('blocked');
    expect(semantic).toContain('request_changes');
    expect(semantic).toContain('divide returns multiplication');
  });
});
