import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { parseCockpitOperatorCommand } from '../src/tui/cockpit.js';

const repoRoot = resolve(__dirname, '..');
const cli = [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'cli.ts')];

async function runCli(args: string[], reject = true) {
  return execa(process.execPath, [...cli, ...args], { cwd: repoRoot, reject });
}

async function initRepo(): Promise<string> {
  const cwd = temporaryDirectory();
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }, null, 2));
  writeFileSync(join(cwd, 'app.txt'), 'base\n');
  writeFileSync(join(cwd, '.gitignore'), '.xdou/runs/\n.xdou/worktrees/\n');
  await execa('git', ['add', '.'], { cwd });
  await execa('git', ['commit', '-m', 'initial'], { cwd });
  return cwd;
}

async function seedCompletedRun(cwd: string, runId = '20260109030405-deadbeef'): Promise<string> {
  const runDir = join(cwd, '.xdou', 'runs', runId);
  const worktreePath = join(cwd, '.xdou', 'worktrees', runId);
  const baseRef = (await execa('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  await execa('git', ['worktree', 'add', '--detach', worktreePath, baseRef], { cwd });
  writeFileSync(join(worktreePath, 'app.txt'), 'base\napplied\n');
  const diff = await execa('git', ['diff', 'HEAD', '--', '.'], { cwd: worktreePath });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'diff.patch'), diff.stdout);
  writeFileSync(join(runDir, 'review.md'), '# Review\nApproved\n');
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
    id: runId,
    mission: 'apply productivity patch',
    createdAt: '2026-01-09T03:04:05.000Z',
    updatedAt: '2026-01-09T03:04:06.000Z',
    status: 'completed',
    phase: 'done',
    artifactDir: runDir,
    events: 3,
    worktreePath,
    baseRef,
  }, null, 2));
  return runId;
}

describe('100% cockpit productivity contracts', () => {
  it('parses the complete cockpit-native loop commands', () => {
    expect(parseCockpitOperatorCommand('/test')).toEqual({ action: 'test' });
    expect(parseCockpitOperatorCommand('/fix 20260109030405-deadbeef')).toEqual({ action: 'fix', runId: '20260109030405-deadbeef' });
    expect(parseCockpitOperatorCommand('/discard')).toEqual({ action: 'discard' });
    expect(parseCockpitOperatorCommand('/undo 20260109030405-deadbeef')).toEqual({ action: 'undo', runId: '20260109030405-deadbeef' });
  });

  it('reruns validation for the latest run and stores cockpit-visible evidence', async () => {
    const cwd = await initRepo();
    const runId = await seedCompletedRun(cwd);

    const result = await runCli(['test', '--cwd', cwd]);

    expect(result.stdout).toContain(`validation complete run=${runId}`);
    expect(existsSync(join(cwd, '.xdou', 'runs', runId, 'validation-rerun.json'))).toBe(true);
    expect(readFileSync(join(cwd, '.xdou', 'runs', runId, 'timeline.ndjson'), 'utf8')).toContain('validation.rerun');
  });

  it('discards a selected run worktree without deleting audit artifacts', async () => {
    const cwd = await initRepo();
    const runId = await seedCompletedRun(cwd);
    const worktreePath = join(cwd, '.xdou', 'worktrees', runId);

    const result = await runCli(['discard', runId, '--cwd', cwd]);

    expect(result.stdout).toContain(`discarded run=${runId}`);
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(cwd, '.xdou', 'runs', runId, 'manifest.json'))).toBe(true);
  });

  it('undoes an applied run by reversing its patch and recording the undo', async () => {
    const cwd = await initRepo();
    const runId = await seedCompletedRun(cwd);
    await runCli(['apply', runId, '--cwd', cwd]);
    expect(readFileSync(join(cwd, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\napplied\n');

    const result = await runCli(['undo', runId, '--cwd', cwd]);

    expect(result.stdout).toContain(`undone run=${runId}`);
    expect(readFileSync(join(cwd, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n');
    expect(existsSync(join(cwd, '.xdou', 'runs', runId, 'undo-result.json'))).toBe(true);
  });
});
