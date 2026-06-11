import { createLoopEngine, emitStarted, resolveTeam, stripAgentsFlag } from './loop.js';
import type { LoopCommandContext } from './loop.js';

export function buildGoalMission(condition: string): string {
  return [
    `Work toward satisfying this goal in the current project: ${condition}`,
    '',
    'Make concrete code changes that move the project toward the goal.',
    "A separate checker validates completion via the project's build/test/lint after your changes — do not declare the goal done yourself.",
  ].join('\n');
}

export async function runGoalCommand(ctx: LoopCommandContext): Promise<void> {
  const condition = stripAgentsFlag(ctx.args).join(' ').trim();
  if (!condition) {
    throw new Error('Usage: xdou goal <condition>\nExample: xdou goal "all tests pass and lint clean"');
  }
  const team = resolveTeam(ctx);
  const engine = createLoopEngine(ctx);
  const loop = await engine.startLoop({
    mode: 'goal',
    condition,
    prompt: buildGoalMission(condition),
    intervalMs: ctx.config.goal.pollIntervalMs,
    pollIntervalMs: ctx.config.loop.pollIntervalMs,
    maxTicks: ctx.config.goal.maxTicks,
    ...(team.length ? { team } : {}),
  });
  emitStarted(ctx, loop);
}
