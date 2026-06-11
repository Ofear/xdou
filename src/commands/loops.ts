import Table from 'cli-table3';
import pc from 'picocolors';
import { createLoopEngine, loopSummary } from './loop.js';
import type { LoopCommandContext } from './loop.js';
import type { LoopManifest, LoopStatus } from '../core/loop-engine.js';

const STATUS_COLOR: Record<LoopStatus, (text: string) => string> = {
  running: pc.green,
  paused: pc.yellow,
  stopped: pc.dim,
  completed: pc.cyan,
  failed: pc.red,
};

function colorStatus(status: LoopStatus): string {
  return (STATUS_COLOR[status] ?? ((text: string) => text))(status);
}

function requireLoopId(args: string[]): string {
  const id = args[1];
  if (!id) throw new Error('A loop id is required. Run `xdou loops list` to see active loops.');
  return id;
}

function tailFlag(args: string[]): number {
  const idx = args.indexOf('--tail');
  if (idx < 0) return 200;
  const value = Number(args[idx + 1]);
  if (!Number.isInteger(value) || value <= 0) throw new Error('--tail requires a positive integer');
  return value;
}

export async function runLoopsCommand(ctx: LoopCommandContext): Promise<void> {
  const engine = createLoopEngine(ctx);
  const sub = ctx.args[0] ?? 'list';
  switch (sub) {
    case '_run': {
      const id = requireLoopId(ctx.args);
      await engine.runDaemon(id);
      return;
    }
    case 'list': {
      await engine.reconcile();
      const loops = await engine.listLoops();
      if (ctx.json) { ctx.log(JSON.stringify(loops.map(loopSummary), null, 2)); return; }
      if (!loops.length) { ctx.log('No loops found. Start one with `xdou loop <cadence> <prompt>` or `xdou goal <condition>`.'); return; }
      const table = new Table({ head: ['id', 'mode', 'status', 'ticks', 'next run', 'prompt'] });
      for (const loop of loops) table.push([loop.id, loop.mode, colorStatus(loop.status), String(loop.ticks), nextRunLabel(loop), truncate(loop.condition ?? loop.prompt, 48)]);
      ctx.log(table.toString());
      return;
    }
    case 'pause': {
      const loop = await engine.pauseLoop(requireLoopId(ctx.args));
      ctx.log(ctx.json ? JSON.stringify(loopSummary(loop), null, 2) : `${pc.yellow('paused')} ${loop.id}`);
      return;
    }
    case 'resume': {
      const loop = await engine.resumeLoop(requireLoopId(ctx.args));
      ctx.log(ctx.json ? JSON.stringify(loopSummary(loop), null, 2) : `${pc.green('resumed')} ${loop.id} (next run ${loop.nextRunAt})`);
      return;
    }
    case 'stop': {
      const loop = await engine.stopLoop(requireLoopId(ctx.args));
      ctx.log(ctx.json ? JSON.stringify(loopSummary(loop), null, 2) : `${pc.dim('stopped')} ${loop.id}`);
      return;
    }
    case 'logs': {
      const id = requireLoopId(ctx.args);
      const logs = await engine.readLogs(id, tailFlag(ctx.args));
      ctx.log(logs || `No logs recorded yet for ${id}.`);
      return;
    }
    default:
      throw new Error('Usage: xdou loops list|pause|resume|stop|logs <id>');
  }
}

function nextRunLabel(loop: LoopManifest): string {
  if (loop.status === 'completed' || loop.status === 'stopped' || loop.status === 'failed') return '-';
  return loop.nextRunAt;
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
