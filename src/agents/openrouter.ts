import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { AgentAdapter, AgentInput, AgentInvocation, AgentRole, AgentRunResult } from '../types.js';

export class OpenRouterAdapter implements AgentAdapter {
  readonly id: string;
  readonly type = 'openrouter' as const;
  readonly command = 'openrouter-api'; // HTTP API, not a CLI binary
  readonly roles: AgentRole[];
  private readonly model: string;
  private readonly apiKeyEnv: string;

  constructor(options: { id: string; model: string; roles?: AgentRole[]; apiKeyEnv?: string }) {
    this.id = options.id;
    this.model = options.model;
    this.roles = options.roles ?? ['brainstormer', 'critic', 'reviewer'];
    this.apiKeyEnv = options.apiKeyEnv ?? 'OPENROUTER_API_KEY';
  }

  buildInvocation(input: AgentInput): AgentInvocation {
    return { command: 'openrouter-api', args: [this.model, input.prompt], cwd: input.cwd, shell: false };
  }

  detect(): Promise<{ available: boolean; path?: string; version?: string; error?: string }> {
    const key = process.env[this.apiKeyEnv];
    return Promise.resolve(key ? { available: true, version: this.model } : { available: false, error: `${this.apiKeyEnv} is not set` });
  }

  async run(input: AgentInput): Promise<AgentRunResult> {
    const started = Date.now();
    const apiKey = process.env[this.apiKeyEnv];
    if (!apiKey) {
      return { agent: this.id, command: 'openrouter-api', args: [this.model], exitCode: 1, stdout: '', stderr: `${this.apiKeyEnv} is not set`, durationMs: Date.now() - started, ok: false };
    }
    try {
      const openrouter = createOpenRouter({ apiKey });
      const result = await generateText({ model: openrouter.chat(this.model), prompt: input.prompt, abortSignal: AbortSignal.timeout(input.timeoutMs ?? 10 * 60_000) });
      return { agent: this.id, command: 'openrouter-api', args: [this.model], exitCode: 0, stdout: result.text, stderr: '', durationMs: Date.now() - started, ok: true };
    } catch (error) {
      return { agent: this.id, command: 'openrouter-api', args: [this.model], exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, ok: false };
    }
  }
}
