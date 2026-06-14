import type { TeamConfig } from '../config/schema.js';

export interface RosterAgent { id: string; roles: string[] }

// Unique roster of agents across all team roles, with each agent's roles aggregated — drives the
// cockpit's toggleable AGENTS panel.
export function teamRoster(team: TeamConfig): RosterAgent[] {
  const roleMap = new Map<string, Set<string>>();
  const add = (id: string, role: string): void => {
    const roles = roleMap.get(id) ?? new Set<string>();
    roles.add(role);
    roleMap.set(id, roles);
  };
  team.brainstormers.forEach((id) => add(id, 'brainstormer'));
  add(team.architect, 'architect');
  add(team.critic, 'critic');
  add(team.implementer, 'implementer');
  team.reviewer.forEach((id) => add(id, 'reviewer'));
  add(team.fixer, 'fixer');
  return [...roleMap.entries()].map(([id, roles]) => ({ id, roles: [...roles] }));
}

// Drop disabled agents from the multi-agent pools; single-slot roles fall back to the first enabled
// agent so a run still has an architect/implementer/critic/fixer.
export function filterTeam(team: TeamConfig, disabledAgents: string[]): TeamConfig {
  const disabled = new Set(disabledAgents);
  if (disabled.size === 0) return team;
  const firstEnabled = teamRoster(team).map((agent) => agent.id).find((id) => !disabled.has(id));
  const keepArr = (ids: string[]): string[] => ids.filter((id) => !disabled.has(id));
  const keepOne = (id: string): string => (disabled.has(id) ? (firstEnabled ?? id) : id);
  const reviewer = keepArr(team.reviewer);
  return {
    brainstormers: keepArr(team.brainstormers),
    architect: keepOne(team.architect),
    critic: keepOne(team.critic),
    implementer: keepOne(team.implementer),
    reviewer: reviewer.length ? reviewer : (firstEnabled ? [firstEnabled] : team.reviewer),
    fixer: keepOne(team.fixer),
  };
}
