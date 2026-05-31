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

export const configSchema = z.object({
  artifactDir: z.string().default('.xdou'),
  agents: z.record(z.string().regex(safeId), agentSchema).default({}),
  teams: z.record(z.string().regex(safeId), teamSchema).default({ default: teamSchema.parse({}) }),
});

export type XdouConfig = z.infer<typeof configSchema>;
export type TeamConfig = z.infer<typeof teamSchema>;
export function parseConfig(input: unknown): XdouConfig { return configSchema.parse(input ?? {}); }
export function defaultConfig(): XdouConfig { return parseConfig({}); }
