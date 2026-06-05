import { describe, expect, it } from 'vitest';
import { compileContextPacket } from '../src/core/context-compiler.js';

describe('agent safety policy', () => {
  it('injects destructive command and path guardrails into agent context packets', () => {
    const packet = compileContextPacket({
      runId: '20260101010101-deadbeef',
      agent: 'codex',
      role: 'implementer',
      mission: 'build todo app',
    });

    expect(packet).toContain('DESTRUCTIVE COMMAND POLICY');
    expect(packet).toContain('git push');
    expect(packet).toContain('git reset --hard');
    expect(packet).toContain('git clean');
    expect(packet).toContain('Never edit files outside the assigned working directory');
  });
});
