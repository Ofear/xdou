import { describe, expect, it } from 'vitest';
import { compileContextPacket } from '../src/core/context-compiler.js';

const base = {
  runId: 'run-1',
  mission: 'Add OAuth',
  projectContext: 'Next.js app. Use npm test.',
  plan: '1. Add route\n2. Add tests',
  decisions: ['Use existing session middleware'],
  rejected: ['Do not add NextAuth'],
  risks: ['CSRF callback validation'],
};

describe('compileContextPacket', () => {
  it('builds role-specific implementation packets without raw transcript leakage', () => {
    const packet = compileContextPacket({
      ...base,
      agent: 'codex',
      role: 'implementer',
      task: { id: 'task-1', title: 'Add callback route', objective: 'Create callback endpoint', files: ['src/auth.ts'] },
      transcript: 'RAW SECRET CHAT SHOULD NOT APPEAR',
      budget: 'balanced',
    });

    expect(packet).toContain('AGENT: codex');
    expect(packet).toContain('ROLE: implementer');
    expect(packet).toContain('TASK task-1: Add callback route');
    expect(packet).toContain('Use existing session middleware');
    expect(packet).not.toContain('RAW SECRET CHAT');
  });

  it('includes diff and validation in reviewer packets', () => {
    const packet = compileContextPacket({
      ...base,
      agent: 'claude',
      role: 'reviewer',
      diff: 'diff --git a/a.ts b/a.ts',
      validation: { command: 'npm test', status: 'failed', output: '1 failed' },
      budget: 'minimal',
    });

    expect(packet).toContain('DIFF TO REVIEW');
    expect(packet).toContain('npm test');
    expect(packet).toContain('1 failed');
  });
});
