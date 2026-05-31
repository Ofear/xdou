import { CliAgentAdapter } from './base.js';
import type { AgentInput, AgentInvocation, AgentRole } from '../types.js';

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
    return { command: this.command, args: ['-p', input.prompt, '--max-turns', String(this.maxTurns), '--output-format', 'json'], cwd: input.cwd, shell: false };
  }
}
