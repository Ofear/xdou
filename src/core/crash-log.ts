import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// xdou writes rich per-run artifacts under .xdou/runs/<id>/, but those only exist once a mission is
// created and only capture failures the orchestrator's try/catch sees. A crash in the CLI/cockpit
// itself (a render-loop bug, an unhandled rejection in ask/web) would otherwise vanish — the stack
// goes to stderr and, inside the cockpit's alt screen, is wiped when the terminal restores on exit.
// This module is the catch-all: it restores the terminal and persists the stack to .xdou/logs/.

export interface CrashContext {
  argv: string[];
  cwd: string;
  nodeVersion: string;
  platform: string;
}

export function formatCrashReport(error: unknown, context: CrashContext, at: string): string {
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
  const stack = err.stack ?? `${err.name}: ${err.message}`;
  return [
    `# xdou crash ${at}`,
    `command : ${context.argv.join(' ')}`,
    `cwd     : ${context.cwd}`,
    `runtime : node ${context.nodeVersion} (${context.platform})`,
    `error   : ${err.name}: ${err.message}`,
    '',
    stack,
    '',
    '-'.repeat(72),
    '',
  ].join('\n');
}

// Append (never overwrite) so repeated crashes in one logs dir accumulate. Returns the file path.
export function writeCrashReport(logsDir: string, error: unknown, context: CrashContext, at: string): string {
  mkdirSync(logsDir, { recursive: true });
  const path = join(logsDir, `crash-${at.replace(/[:.]/g, '-')}.log`);
  appendFileSync(path, formatCrashReport(error, context, at), 'utf8');
  return path;
}

// Register last-resort handlers for errors that escape the awaited CLI chain. getCwd is a thunk so we
// read the working directory lazily at crash time (it may be set by the --cwd flag after install).
export function installCrashHandlers(getCwd: () => string, now: () => string = () => new Date().toISOString()): void {
  let handling = false;
  const handle = (error: unknown, kind: 'uncaughtException' | 'unhandledRejection'): void => {
    if (handling) { return; } // guard against a throw inside this handler recursing forever
    handling = true;
    // Drop the cockpit's alt screen and re-show the cursor, else the trace is invisible/lost.
    if (process.stdout.isTTY) { try { process.stdout.write('\x1b[?1049l\x1b[?25h'); } catch { /* terminal already gone */ } }
    const at = now();
    const context: CrashContext = { argv: process.argv.slice(1), cwd: getCwd(), nodeVersion: process.version, platform: `${process.platform} ${process.arch}` };
    let logPath: string | undefined;
    try { logPath = writeCrashReport(join(context.cwd, '.xdou', 'logs'), error, context, at); } catch { /* best-effort: still print below */ }
    const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    process.stderr.write(`\nxdou crashed (${kind})\n${detail}\n`);
    if (logPath) { process.stderr.write(`crash log: ${logPath}\n`); }
    process.exit(1);
  };
  process.on('uncaughtException', (error) => { handle(error, 'uncaughtException'); });
  process.on('unhandledRejection', (reason) => { handle(reason, 'unhandledRejection'); });
}
