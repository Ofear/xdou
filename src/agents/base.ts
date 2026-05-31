import { execa } from 'execa';
import which from 'which';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult, AgentType } from '../types.js';

export abstract class CliAgentAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly type: AgentType;
  readonly command: string;
  readonly roles: AgentRole[];

  protected constructor(options: { command: string; roles: AgentRole[] }) {
    this.command = options.command;
    this.roles = options.roles;
  }

  abstract buildInvocation(input: AgentInput): AgentInvocation;

  async detect(): Promise<{ available: boolean; path?: string; version?: string; error?: string }> {
    try {
      const path = await which(this.command);
      const version = await this.readVersion();
      return { available: true, path, ...(version ? { version } : {}) };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async run(input: AgentInput): Promise<AgentRunResult> {
    const invocation = this.buildInvocation(input);
    const started = Date.now();
    try {
      const options = {
        cwd: invocation.cwd,
        shell: invocation.shell,
        timeout: input.timeoutMs ?? 30 * 60_000,
        reject: false,
        all: false,
        ...(invocation.env ? { env: invocation.env } : {}),
      };
      const result = await execa(invocation.command, invocation.args, options);
      return {
        agent: this.id,
        command: invocation.command,
        args: invocation.args,
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
        ok: (result.exitCode ?? 0) === 0,
      };
    } catch (error) {
      return {
        agent: this.id,
        command: invocation.command,
        args: invocation.args,
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
        ok: false,
      };
    }
  }

  protected async readVersion(): Promise<string | undefined> {
    const result = await execa(this.command, ['--version'], { reject: false, timeout: 10_000 });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    return text || undefined;
  }
}
