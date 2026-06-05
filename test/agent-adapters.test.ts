import { describe, expect, it } from 'vitest';
import { CliAgentAdapter, sanitizeAgentText } from '../src/agents/base.js';
import { normalizeClaudeJsonOutput, normalizeClaudeRunResult, ClaudeCodeAdapter } from '../src/agents/claude-code.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { OpenCodeAdapter } from '../src/agents/opencode.js';

const input = { cwd: process.cwd(), prompt: 'hello', runDir: process.cwd(), timeoutMs: 1000 };

class EchoAdapter extends CliAgentAdapter {
  readonly id = 'echo';
  readonly type = 'codex' as const;
  constructor(command: string) { super({ command, roles: ['implementer'] }); }
  buildInvocation() { return { command: this.command, args: ['-e', 'process.stdin.resume()', 'arg\0bad'], cwd: process.cwd(), shell: false as const, stdin: 'stdin\0bad' }; }
}

describe('agent adapters command construction', () => {
  it('constructs Claude Code print-mode command safely', () => {
    const cmd = new ClaudeCodeAdapter({ command: 'claude', maxTurns: 7 }).buildInvocation(input);
    expect(cmd.command).toBe('claude');
    expect(cmd.args).toEqual([
      '-p',
      'hello',
      '--max-turns',
      '7',
      '--output-format',
      'json',
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(cmd.shell).toBe(false);
  });

  it('normalizes Claude Code JSON result envelopes into assistant text', () => {
    const output = JSON.stringify({ type: 'result', subtype: 'success', result: 'Smallest useful version: add, list, and clear.' });

    expect(normalizeClaudeJsonOutput(output)).toBe('Smallest useful version: add, list, and clear.');
  });

  it('limits Claude Code non-mutating calls to no tools so agents cannot hang in tool loops', () => {
    const cmd = new ClaudeCodeAdapter({ command: 'claude', maxTurns: 10 }).buildInvocation({
      ...input,
      prompt: 'XDOU CONTEXT PACKET\nROLE: reviewer\nReview this diff and emit REVIEW_VERDICT JSON.',
    });
    const brainstormer = new ClaudeCodeAdapter({ command: 'claude', maxTurns: 10 }).buildInvocation({
      ...input,
      prompt: 'XDOU CONTEXT PACKET\nROLE: brainstormer\nThink about this mission.',
    });

    expect(cmd.args).toContain('--max-turns');
    expect(cmd.args[cmd.args.indexOf('--max-turns') + 1]).toBe('5');
    expect(cmd.args).toContain('--allowedTools');
    expect(cmd.args[cmd.args.indexOf('--allowedTools') + 1]).toBe('');
    expect(cmd.args).not.toContain('--disallowedTools');
    expect(brainstormer.args).toContain('--allowedTools');
    expect(brainstormer.args[brainstormer.args.indexOf('--allowedTools') + 1]).toBe('');
  });

  it('preserves Claude Code error envelopes as readable stderr details', () => {
    const output = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, stop_reason: 'tool_use' });

    expect(normalizeClaudeJsonOutput(output)).toContain('error_max_turns');
    expect(normalizeClaudeJsonOutput(output)).toContain('tool_use');
  });

  it('marks empty Claude Code responses as failed instead of accepting a blank plan', () => {
    const result = normalizeClaudeRunResult({ agent: 'claude', command: 'claude', args: [], exitCode: 0, stdout: '', stderr: '', durationMs: 10, ok: true });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('returned no assistant text');
  });

  it('removes NUL bytes from agent prompts before spawning CLI processes', async () => {
    expect(sanitizeAgentText('a\0b')).toBe('ab');
    const result = await new EchoAdapter(process.execPath).run(input);

    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['-e', 'process.stdin.resume()', 'argbad']);
    expect(result.stderr).not.toContain('null bytes');
  });

  it('constructs Codex exec command safely', () => {
    const cmd = new CodexAdapter({ command: 'codex', fullAuto: true }).buildInvocation(input);
    expect(cmd.args).toEqual(['exec', '--cd', process.cwd(), '--dangerously-bypass-approvals-and-sandbox', '-']);
    expect(cmd.stdin).toBe('hello');
    expect(cmd.shell).toBe(false);
  });

  it('keeps Codex full-auto opt-in instead of default', () => {
    const cmd = new CodexAdapter({ command: 'codex' }).buildInvocation(input);
    expect(cmd.args).toEqual(['exec', '--cd', process.cwd(), '-']);
    expect(cmd.stdin).toBe('hello');
  });

  it('constructs OpenCode one-shot command safely', () => {
    const cmd = new OpenCodeAdapter({ command: 'opencode', model: 'openrouter/qwen/qwen3-coder' }).buildInvocation(input);
    expect(cmd.args).toEqual(['run', 'hello', '--model', 'openrouter/qwen/qwen3-coder']);
  });
});
