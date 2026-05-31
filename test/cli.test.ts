import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

const repoRoot = resolve(__dirname, '..');
const cli = [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'cli.ts')];

async function runCli(args: string[], reject = true) {
  return execa(process.execPath, [...cli, ...args], { cwd: repoRoot, reject });
}

async function initGitRepo(): Promise<string> {
  const cwd = temporaryDirectory();
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
  return cwd;
}

function seedRun(cwd: string, id = '20260102030405-deadbeef'): string {
  const runDir = join(cwd, '.xdou', 'runs', id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
    id,
    mission: 'seeded mission',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:06.000Z',
    status: 'completed',
    phase: 'done',
    artifactDir: runDir,
    events: 3,
  }, null, 2));
  return id;
}

describe('CLI', () => {
  it('init creates config, artifact dirs, and gitignore safety entries', async () => {
    const cwd = await initGitRepo();
    const result = await runCli(['init', '--cwd', cwd]);
    expect(result.stdout).toContain('created');
    expect(existsSync(join(cwd, 'xdou.yaml'))).toBe(true);
    expect(existsSync(join(cwd, '.xdou', 'runs'))).toBe(true);
  });

  it('config validate accepts generated config', async () => {
    const cwd = await initGitRepo();
    await runCli(['init', '--cwd', cwd]);
    const result = await runCli(['config', 'validate', '--cwd', cwd]);
    expect(result.stdout).toContain('valid');
  });

  it('status --json emits latest run manifest', async () => {
    const cwd = await initGitRepo();
    await runCli(['init', '--cwd', cwd]);
    const runId = seedRun(cwd);
    const result = await runCli(['status', '--json', '--cwd', cwd]);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ id: runId, status: 'completed', phase: 'done' }));
  });

  it('runs list --json emits all run manifests', async () => {
    const cwd = await initGitRepo();
    await runCli(['init', '--cwd', cwd]);
    seedRun(cwd, '20260102030405-deadbeef');
    seedRun(cwd, '20260103030405-feedface');
    const result = await runCli(['runs', 'list', '--json', '--cwd', cwd]);
    const runs = JSON.parse(result.stdout) as Array<{ id: string }>;
    expect(runs.map((run) => run.id)).toEqual(['20260102030405-deadbeef', '20260103030405-feedface']);
  });

  it('rejects --agents without a value', async () => {
    const cwd = await initGitRepo();
    await runCli(['init', '--cwd', cwd]);
    const result = await runCli(['plan', 'mission', '--agents', '--cwd', cwd], false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/expects a value|requires a comma-separated value/);
  });
});
