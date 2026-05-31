import { CliAgentAdapter } from './base.js';
import type { AgentInput, AgentInvocation, AgentRole } from '../types.js';

export class OpenCodeAdapter extends CliAgentAdapter {
  readonly id: string;
  readonly type = 'opencode' as const;
  private readonly model: string | undefined;

  constructor(options: { id?: string; command?: string; roles?: AgentRole[]; model?: string } = {}) {
    super({ command: options.command ?? 'opencode', roles: options.roles ?? ['implementer', 'reviewer'] });
    this.id = options.id ?? 'opencode';
    this.model = options.model;
  }

  buildInvocation(input: AgentInput): AgentInvocation {
    const args = ['run', input.prompt];
    if (this.model) args.push('--model', this.model);
    return { command: this.command, args, cwd: input.cwd, shell: false };
  }
}
