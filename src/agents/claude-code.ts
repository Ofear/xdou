import { CliAgentAdapter } from './base.js';
import type { AgentInput, AgentInvocation, AgentRole, AgentRunResult } from '../types.js';

const NON_MUTATING_ALLOWED_TOOLS = '';

export function normalizeClaudeJsonOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{')) return output;
  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; subtype?: unknown; is_error?: unknown; stop_reason?: unknown; error?: unknown };
    if (typeof parsed.result === 'string' && parsed.result.trim()) return parsed.result;
    const details = [parsed.subtype, parsed.stop_reason, parsed.error].filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (details.length) return details.join(': ');
  } catch {
    return output;
  }
  return output;
}

export function normalizeClaudeRunResult(result: AgentRunResult): AgentRunResult {
  const stdout = normalizeClaudeJsonOutput(result.stdout);
  const stderr = normalizeClaudeJsonOutput(result.stderr);
  if (result.ok && !stdout.trim() && !stderr.trim()) {
    return { ...result, exitCode: 1, ok: false, stdout, stderr: 'Claude Code returned no assistant text.' };
  }
  return { ...result, stdout, stderr };
}

export class ClaudeCodeAdapter extends CliAgentAdapter {
  readonly id: string;
  readonly type = 'claude-code' as const;
  private readonly maxTurns: number;

  constructor(options: { id?: string; command?: string; roles?: AgentRole[]; maxTurns?: number } = {}) {
    super({ command: options.command ?? 'claude', roles: options.roles ?? ['architect', 'reviewer', 'debugger'] });
    this.id = options.id ?? 'claude';
    this.maxTurns = options.maxTurns ?? 10;
  }

  buildInvocation(input: AgentInput): AgentInvocation {
    const role = /ROLE:\s*([a-z-]+)/i.exec(input.prompt)?.[1]?.toLowerCase();
    const isNonMutatingRole = role ? !['implementer', 'fixer', 'tester'].includes(role) : false;
    const maxTurns = role === 'reviewer' ? Math.min(this.maxTurns, 5) : this.maxTurns;
    // Web research: explicitly enable (only) the read-only web tools so the model can actually search
    // and cannot touch the filesystem. xdou controls the capability rather than hoping it's on.
    // Analyze: read-only codebase review — allow file *reading* tools but no Write/Edit, so it can
    // inspect the project and report findings without mutating anything.
    const toolArgs = input.web
      ? ['--allowedTools', 'WebSearch,WebFetch']
      : input.analyze
        ? ['--allowedTools', 'Read,Grep,Glob,LS']
        : isNonMutatingRole
          ? ['--allowedTools', NON_MUTATING_ALLOWED_TOOLS]
          : ['--permission-mode', 'bypassPermissions'];
    return { command: this.command, args: ['-p', input.prompt, '--max-turns', String(maxTurns), '--output-format', 'json', ...toolArgs], cwd: input.cwd, shell: false };
  }

  override async run(input: AgentInput): Promise<AgentRunResult> {
    const result = await super.run(input);
    return normalizeClaudeRunResult(result);
  }
}
