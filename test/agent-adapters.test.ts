import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/agents/claude-code.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { OpenCodeAdapter } from '../src/agents/opencode.js';

const input = { cwd: process.cwd(), prompt: 'hello', runDir: process.cwd(), timeoutMs: 1000 };

describe('agent adapters command construction', () => {
  it('constructs Claude Code print-mode command safely', () => {
    const cmd = new ClaudeCodeAdapter({ command: 'claude', maxTurns: 7 }).buildInvocation(input);
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual(['-p', 'hello', '--max-turns', '7', '--output-format', 'json']);
    expect(cmd.shell).toBe(false);
  });

  it('constructs Codex exec command safely', () => {
    const cmd = new CodexAdapter({ command: 'codex', fullAuto: true }).buildInvocation(input);
    expect(cmd.args).toEqual(['exec', '--full-auto', 'hello']);
    expect(cmd.shell).toBe(false);
  });

  it('keeps Codex full-auto opt-in instead of default', () => {
    const cmd = new CodexAdapter({ command: 'codex' }).buildInvocation(input);
    expect(cmd.args).toEqual(['exec', 'hello']);
  });

  it('constructs OpenCode one-shot command safely', () => {
    const cmd = new OpenCodeAdapter({ command: 'opencode', model: 'openrouter/qwen/qwen3-coder' }).buildInvocation(input);
    expect(cmd.args).toEqual(['run', 'hello', '--model', 'openrouter/qwen/qwen3-coder']);
  });
});
