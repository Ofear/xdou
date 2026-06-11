import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

const repoRoot = resolve(__dirname, '..');
const cli = [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'cli.ts')];

async function runCli(args: string[], reject = true) {
  return execa(process.execPath, [...cli, ...args], { cwd: repoRoot, reject });
}

function seedLoop(cwd: string, id = '20260102030405-deadbeef', status = 'running'): string {
  const dir = join(cwd, '.xdou', 'loops', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    id,
    mode: 'loop',
    prompt: 'triage new github issues',
    status,
    cwd,
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    ticks: 0,
    pollIntervalMs: 15_000,
    intervalMs: 3_600_000,
    consecutiveErrors: 0,
    nextRunAt: '2026-01-02T04:00:00.000Z',
    cadence: 'hourly',
  }, null, 2));
  writeFileSync(join(dir, 'daemon.log'), '2026-01-02T03:04:05.000Z created mode=loop\n');
  return id;
}

describe('loop CLI', () => {
  it('lists loop commands in help output', async () => {
    const result = await runCli(['--help']);
    expect(result.stdout).toContain('loop <cadence> <prompt>');
    expect(result.stdout).toContain('goal <condition>');
    expect(result.stdout).toContain('loops list');
  });

  it('reports an empty loop list', async () => {
    const cwd = temporaryDirectory();
    const result = await runCli(['loops', 'list', '--cwd', cwd]);
    expect(result.stdout).toContain('No loops found');
  });

  it('lists, pauses, and stops a seeded loop', async () => {
    const cwd = temporaryDirectory();
    const id = seedLoop(cwd);

    const listed = await runCli(['loops', 'list', '--json', '--cwd', cwd]);
    const loops = JSON.parse(listed.stdout) as Array<{ id: string; status: string }>;
    expect(loops.map((loop) => loop.id)).toContain(id);

    const paused = await runCli(['loops', 'pause', id, '--json', '--cwd', cwd]);
    expect((JSON.parse(paused.stdout) as { status: string }).status).toBe('paused');

    const resumed = await runCli(['loops', 'resume', id, '--json', '--cwd', cwd]);
    expect((JSON.parse(resumed.stdout) as { status: string }).status).toBe('running');

    const stopped = await runCli(['loops', 'stop', id, '--json', '--cwd', cwd]);
    expect((JSON.parse(stopped.stdout) as { status: string }).status).toBe('stopped');
  });

  it('shows loop logs', async () => {
    const cwd = temporaryDirectory();
    const id = seedLoop(cwd);
    const result = await runCli(['loops', 'logs', id, '--cwd', cwd]);
    expect(result.stdout).toContain('created mode=loop');
  });

  it('rejects an unrecognized cadence before starting a loop', async () => {
    const cwd = temporaryDirectory();
    const result = await runCli(['loop', 'whenever', 'do', 'stuff', '--cwd', cwd], false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unrecognized cadence');
  });

  it('requires a prompt for loop and a condition for goal', async () => {
    const cwd = temporaryDirectory();
    const loop = await runCli(['loop', 'hourly', '--cwd', cwd], false);
    expect(loop.exitCode).toBe(1);
    expect(loop.stderr).toContain('Usage: xdou loop <cadence> <prompt>');

    const goal = await runCli(['goal', '--cwd', cwd], false);
    expect(goal.exitCode).toBe(1);
    expect(goal.stderr).toContain('Usage: xdou goal <condition>');
  });

  it('rejects invalid loop ids before touching the filesystem', async () => {
    const cwd = temporaryDirectory();
    const result = await runCli(['loops', 'stop', '../../escape', '--cwd', cwd], false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid loop id');
  });
});
