import { z } from 'zod';

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const agentSchema = z.object({
  type: z.enum(['claude-code', 'codex', 'opencode', 'openrouter']),
  command: z.string().optional(),
  model: z.string().optional(),
  roles: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  fullAuto: z.boolean().default(false),
});

const teamSchema = z.object({
  brainstormers: z.array(z.string().regex(safeId)).default(['claude', 'codex']),
  architect: z.string().regex(safeId).default('claude'),
  critic: z.string().regex(safeId).default('codex'),
  implementer: z.string().regex(safeId).default('codex'),
  reviewer: z.array(z.string().regex(safeId)).default(['claude']),
  fixer: z.string().regex(safeId).default('codex'),
});

const loopSchema = z.object({
  // How often a `/loop` ticks when no cadence is supplied on the command line.
  defaultCadence: z.string().default('hourly'),
  // How often the background daemon wakes to check status and due ticks (ms).
  pollIntervalMs: z.number().int().positive().default(15_000),
  // Optional safety cap on total ticks before the loop auto-completes.
  maxTicks: z.number().int().positive().optional(),
  // Optional agent team override for missions spawned by the loop.
  team: z.array(z.string().regex(safeId)).optional(),
  // Agent to use as separate checker for goal validation (e.g., 'critic', 'reviewer').
  checkerAgent: z.string().regex(safeId).optional(),
  // Whether to use a separate checker agent for goal validation.
  useSeparateChecker: z.boolean().default(false),
  // Work discovery configuration for goal mode.
  workDiscovery: z.object({
    github: z.object({
      owner: z.string().optional(),
      repo: z.string().optional(),
      labels: z.array(z.string()).optional(),
    }).optional(),
    ci: z.object({
      provider: z.enum(['github', 'gitlab', 'custom']).optional(),
      owner: z.string().optional(),
      repo: z.string().optional(),
    }).optional(),
    todoFiles: z.array(z.string()).optional(),
  }).optional(),
  // Path to MCP plugin manifest file (e.g., xdou-plugins.json).
  mcpPluginConfigPath: z.string().optional(),
});

const goalSchema = z.object({
  // Delay between goal attempts (ms); 0 means run the next attempt as soon as the prior one finishes.
  pollIntervalMs: z.number().int().nonnegative().default(0),
  // Hard cap on attempts so an unsatisfiable goal cannot loop forever.
  maxTicks: z.number().int().positive().default(20),
  // Optional agent team override for missions spawned by the goal.
  team: z.array(z.string().regex(safeId)).optional(),
});

export const configSchema = z.object({
  artifactDir: z.string().default('.xdou'),
  agents: z.record(z.string().regex(safeId), agentSchema).default({}),
  teams: z.record(z.string().regex(safeId), teamSchema).default({ default: teamSchema.parse({}) }),
  loop: loopSchema.default(loopSchema.parse({})),
  goal: goalSchema.default(goalSchema.parse({})),
});

export type XdouConfig = z.infer<typeof configSchema>;
export type TeamConfig = z.infer<typeof teamSchema>;
export type LoopConfig = z.infer<typeof loopSchema>;
export type GoalConfig = z.infer<typeof goalSchema>;
export function parseConfig(input: unknown): XdouConfig { return configSchema.parse(input ?? {}); }
export function defaultConfig(): XdouConfig { return parseConfig({}); }
