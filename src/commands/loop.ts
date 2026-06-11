import { LoopEngine, parseCadence } from '../core/loop-engine.js';
import { defaultConfig } from '../config/schema.js';
import { discoverAllWork, formatWorkForPrompt } from '../core/work-discovery.js';
import type { DaemonInvocation, LoopManifest } from '../core/loop-engine.js';
import type { XdouConfig, LoopConfig } from '../config/schema.js';
import type { McpTool } from '../core/mcp-plugins.js';

export interface LoopCommandContext {
  cwd: string;
  config: XdouConfig;
  args: string[];
  json: boolean;
  agentsFlag?: string | undefined;
  daemonInvocation: DaemonInvocation;
  log: (message: string) => void;
}

export function createLoopEngine(ctx: LoopCommandContext): LoopEngine {
  return new LoopEngine({
    cwd: ctx.cwd,
    artifactDir: ctx.config.artifactDir,
    agentDefs: ctx.config.agents,
    daemonInvocation: ctx.daemonInvocation,
    hooks: {
      discoverWork: async (loop) => {
        if (loop.mode !== 'goal') return '';
        const workDiscovery = ctx.config.loop.workDiscovery as NonNullable<LoopConfig['workDiscovery']> ?? {};
        const workConfig: { cwd: string; github?: { owner: string; repo: string; labels: string[] }; ci?: { provider: 'github' | 'gitlab' | 'custom'; owner: string; repo: string }; todoFiles?: string[]; mcpTools: McpTool[] } = { cwd: ctx.cwd, mcpTools: [] };
        if (workDiscovery.github) {
          workConfig.github = { owner: workDiscovery.github.owner!, repo: workDiscovery.github.repo!, labels: workDiscovery.github.labels!.filter((l): l is string => !!l) };
        }
        if (workDiscovery.ci) {
          workConfig.ci = { provider: workDiscovery.ci.provider!, owner: workDiscovery.ci.owner!, repo: workDiscovery.ci.repo! };
        }
        if (workDiscovery.todoFiles) {
          workConfig.todoFiles = workDiscovery.todoFiles;
        }
        return formatWorkForPrompt(await discoverAllWork(workConfig));
      },
    },
    ...(ctx.config.loop.checkerAgent ? { checkerAgent: ctx.config.loop.checkerAgent } : {}),
    useSeparateChecker: ctx.config.loop.useSeparateChecker,
    mcpPlugins: {
      ...(ctx.config.loop.mcpPluginConfigPath ? { configPath: ctx.config.loop.mcpPluginConfigPath } : {}),
    },
  });
}

export function stripAgentsFlag(args: string[]): string[] {
  const idx = args.indexOf('--agents');
  return idx >= 0 ? [...args.slice(0, idx), ...args.slice(idx + 2)] : args;
}

export function resolveTeam(ctx: LoopCommandContext): string[] {
  if (ctx.agentsFlag) return splitAgents(ctx.agentsFlag);
  const idx = ctx.args.indexOf('--agents');
  if (idx >= 0) {
    const value = ctx.args[idx + 1];
    if (!value) throw new Error('--agents requires a comma-separated value');
    return splitAgents(value);
  }
  const team = ctx.config.teams.default ?? defaultConfig().teams.default!;
  return [team.architect, team.implementer, team.reviewer[0] ?? team.architect];
}

function splitAgents(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export function emitStarted(ctx: LoopCommandContext, loop: LoopManifest): void {
  if (ctx.json) { ctx.log(JSON.stringify(loopSummary(loop), null, 2)); return; }
  const schedule = loop.mode === 'goal'
    ? `until satisfied: ${loop.condition ?? loop.prompt}`
    : `cadence ${loop.cadence ?? `${loop.intervalMs}ms`}`;
  ctx.log([
    `started ${loop.mode} ${loop.id} (${schedule})`,
    `  next run: ${loop.nextRunAt}`,
    `  manage:   xdou loops list | xdou loops logs ${loop.id} | xdou loops stop ${loop.id}`,
  ].join('\n'));
}

export function loopSummary(loop: LoopManifest): Record<string, unknown> {
  return {
    id: loop.id,
    mode: loop.mode,
    status: loop.status,
    ticks: loop.ticks,
    nextRunAt: loop.nextRunAt,
    ...(loop.cadence ? { cadence: loop.cadence } : {}),
    ...(loop.condition ? { condition: loop.condition } : {}),
    ...(loop.lastRunId ? { lastRunId: loop.lastRunId } : {}),
    ...(loop.completedReason ? { completedReason: loop.completedReason } : {}),
  };
}

export async function runLoopCommand(ctx: LoopCommandContext): Promise<void> {
  const cleaned = stripAgentsFlag(ctx.args);
  const cadence = cleaned[0];
  const prompt = cleaned.slice(1).join(' ').trim();
  if (!cadence || !prompt) {
    throw new Error('Usage: xdou loop <cadence> <prompt>\nExample: xdou loop hourly "check CI failures and fix"\nExample: xdou loop "*/30 * * * *" "triage new github issues"');
  }
  parseCadence(cadence);
  const team = resolveTeam(ctx);
  const engine = createLoopEngine(ctx);
  const loop = await engine.startLoop({
    mode: 'loop',
    cadence,
    prompt,
    pollIntervalMs: ctx.config.loop.pollIntervalMs,
    ...(team.length ? { team } : {}),
    ...(ctx.config.loop.maxTicks ? { maxTicks: ctx.config.loop.maxTicks } : {}),
  });
  emitStarted(ctx, loop);
}
