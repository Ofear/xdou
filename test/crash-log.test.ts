import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatCrashReport, writeCrashReport, type CrashContext } from '../src/core/crash-log.js';

const context: CrashContext = { argv: ['cli.js', 'cockpit'], cwd: '/proj', nodeVersion: 'v22.0.0', platform: 'linux x64' };

describe('crash log', () => {
  it('formats a report with command, runtime and the full stack', () => {
    const error = new Error('boom');
    const report = formatCrashReport(error, context, '2026-06-15T00:00:00.000Z');
    expect(report).toContain('# xdou crash 2026-06-15T00:00:00.000Z');
    expect(report).toContain('command : cli.js cockpit');
    expect(report).toContain('runtime : node v22.0.0 (linux x64)');
    expect(report).toContain('error   : Error: boom');
    expect(report).toContain(error.stack as string); // full stack preserved
  });

  it('handles non-Error throws (strings, objects) without losing them', () => {
    expect(formatCrashReport('plain string fail', context, 't')).toContain('plain string fail');
    expect(formatCrashReport({ code: 42 }, context, 't')).toContain('"code":42');
  });

  it('writes the report under the logs dir and appends rather than overwrites', () => {
    const dir = temporaryDirectory();
    const logsDir = join(dir, '.xdou', 'logs');
    const p1 = writeCrashReport(logsDir, new Error('first'), context, '2026-06-15T00:00:00.000Z');
    const p2 = writeCrashReport(logsDir, new Error('second'), context, '2026-06-15T00:00:01.000Z');

    expect(readdirSync(logsDir).filter((f) => f.endsWith('.log'))).toHaveLength(2); // distinct timestamps
    expect(p1).not.toBe(p2);
    expect(readFileSync(p1, 'utf8')).toContain('Error: first');
    // colons/dots are stripped from the timestamp so the filename is filesystem-safe
    expect(p1).toMatch(/crash-2026-06-15T00-00-00-000Z\.log$/);

    // appending to the same timestamped file accumulates entries (no clobber)
    writeCrashReport(logsDir, new Error('again'), context, '2026-06-15T00:00:00.000Z');
    const reread = readFileSync(p1, 'utf8');
    expect(reread).toContain('Error: first');
    expect(reread).toContain('Error: again');
  });
});
