import type { AgentAdapter, AgentRole, AgentType } from '../types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { OpenCodeAdapter } from './opencode.js';
import { OpenRouterAdapter } from './openrouter.js';

export interface AgentDefinition { type: AgentType; command?: string | undefined; model?: string | undefined; roles?: string[] | undefined; enabled?: boolean | undefined; fullAuto?: boolean | undefined }

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export function assertSafeAgentId(id: string): void { if (!SAFE_ID.test(id)) throw new Error(`Invalid agent id "${id}". Use 1-64 letters, numbers, _ or -; no path separators.`); }
function asRoles(roles: string[] | undefined, fallback: AgentRole[]): AgentRole[] { return (roles?.length ? roles : fallback) as AgentRole[]; }

export function defaultAgents(definitions: Record<string, AgentDefinition> = {}): Record<string, AgentAdapter> {
  const agents: Record<string, AgentAdapter> = {
    claude: new ClaudeCodeAdapter({ id: 'claude' }),
    codex: new CodexAdapter({ id: 'codex', fullAuto: false }),
    opencode: new OpenCodeAdapter({ id: 'opencode' }),
  };
  for (const [id, def] of Object.entries(definitions)) {
    assertSafeAgentId(id);
    if (def.enabled === false) continue;
    if (def.type === 'claude-code') agents[id] = new ClaudeCodeAdapter({ id, ...(def.command ? { command: def.command } : {}), roles: asRoles(def.roles, ['architect', 'reviewer', 'debugger']) });
    if (def.type === 'codex') agents[id] = new CodexAdapter({ id, ...(def.command ? { command: def.command } : {}), roles: asRoles(def.roles, ['implementer', 'fixer', 'critic']), fullAuto: def.fullAuto ?? false });
    if (def.type === 'opencode') agents[id] = new OpenCodeAdapter({ id, ...(def.command ? { command: def.command } : {}), roles: asRoles(def.roles, ['implementer', 'reviewer']), ...(def.model ? { model: def.model } : {}) });
    if (def.type === 'openrouter') {
      if (!def.model) throw new Error(`OpenRouter agent "${id}" requires model`);
      agents[id] = new OpenRouterAdapter({ id, model: def.model, roles: asRoles(def.roles, ['brainstormer', 'critic', 'reviewer']) });
    }
  }
  return agents;
}

export function selectAgents(names: string[], agents = defaultAgents()): AgentAdapter[] {
  return names.map((name) => {
    const agent = agents[name];
    if (!agent) throw new Error(`Unknown agent "${name}". Known agents: ${Object.keys(agents).join(', ')}`);
    return agent;
  });
}
