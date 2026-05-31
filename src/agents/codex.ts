import { CliAgentAdapter } from './base.js';
import type { AgentInput, AgentInvocation, AgentRole } from '../types.js';

export class CodexAdapter extends CliAgentAdapter {
  readonly id: string;
  readonly type = 'codex' as const;
  private readonly fullAuto: boolean;

  constructor(options: { id?: string; command?: string; roles?: AgentRole[]; fullAuto?: boolean } = {}) {
    super({ command: options.command ?? 'codex', roles: options.roles ?? ['implementer', 'fixer', 'critic'] });
    this.id = options.id ?? 'codex';
    this.fullAuto = options.fullAuto ?? false;
  }

  buildInvocation(input: AgentInput): AgentInvocation {
    const args = ['exec', '--cd', input.cwd, '-'];
    if (this.fullAuto) args.splice(3, 0, '--dangerously-bypass-approvals-and-sandbox');
    return { command: this.command, args, cwd: input.cwd, shell: false, stdin: input.prompt };
  }
}
