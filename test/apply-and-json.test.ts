import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

const repoRoot = resolve(__dirname, '..');
const cli = [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'cli.ts')];

async function runCli(args: string[], cwd = repoRoot, reject = true) {
  return execa(process.execPath, [...cli, ...args], { cwd, reject });
}

async function initGitRepo(): Promise<string> {
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

describe('apply command and machine-readable output', () => {
  it('applies an approved run diff from its worktree into the main checkout', async () => {
    const cwd = await initGitRepo();
    const runId = '20260102030405-deadbeef';
    const runDir = join(cwd, '.xdou', 'runs', runId);
    const worktreePath = join(cwd, '.xdou', 'worktrees', runId);
    const baseRef = (await execa('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await execa('git', ['worktree', 'add', '--detach', worktreePath, baseRef], { cwd });
    writeFileSync(join(worktreePath, 'app.txt'), 'base\napplied\n');
    const diff = await execa('git', ['diff', 'HEAD', '--', '.'], { cwd: worktreePath });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'diff.patch'), diff.stdout);
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
      id: runId,
      mission: 'apply worktree patch',
      createdAt: '2026-01-02T03:04:05.000Z',
      updatedAt: '2026-01-02T03:04:06.000Z',
      status: 'completed',
      phase: 'done',
      artifactDir: runDir,
      events: 3,
      worktreePath,
      baseRef,
    }, null, 2));

    const result = await runCli(['apply', runId, '--json', '--cwd', cwd]);
    const payload = JSON.parse(result.stdout) as { applied: boolean; runId: string; filesChanged: number };

    expect(payload).toEqual(expect.objectContaining({ applied: true, runId, filesChanged: 1 }));
    expect(readFileSync(join(cwd, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\napplied\n');
    expect(existsSync(join(runDir, 'apply-result.json'))).toBe(true);
  });

  it('refuses to apply a run whose base ref no longer matches the operator checkout', async () => {
    const cwd = await initGitRepo();
    const runId = '20260104030405-cafebabe';
    const runDir = join(cwd, '.xdou', 'runs', runId);
    const worktreePath = join(cwd, '.xdou', 'worktrees', runId);
    const baseRef = (await execa('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    await execa('git', ['worktree', 'add', '--detach', worktreePath, baseRef], { cwd });
    writeFileSync(join(worktreePath, 'app.txt'), 'base\nstale apply\n');
    const diff = await execa('git', ['diff', 'HEAD', '--', '.'], { cwd: worktreePath });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'diff.patch'), diff.stdout);
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
      id: runId,
      mission: 'apply stale worktree patch',
      createdAt: '2026-01-04T03:04:05.000Z',
      updatedAt: '2026-01-04T03:04:06.000Z',
      status: 'completed',
      phase: 'done',
      artifactDir: runDir,
      events: 3,
      worktreePath,
      baseRef,
    }, null, 2));
    writeFileSync(join(cwd, 'unrelated.txt'), 'advance main\n');
    await execa('git', ['add', 'unrelated.txt'], { cwd });
    await execa('git', ['commit', '-m', 'advance main'], { cwd });

    const result = await runCli(['apply', runId, '--cwd', cwd], repoRoot, false);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Run ${runId} was based on ${baseRef}`);
    expect(result.stderr).toContain('current HEAD is');
    expect(readFileSync(join(cwd, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n');
  });

  it('apply --json emits an agent-readable result envelope', async () => {
    const cwd = await initGitRepo();
    const runId = '20260103030405-feedface';
    const runDir = join(cwd, '.xdou', 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'diff.patch'), 'No diff produced.');
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
      id: runId,
      mission: 'seeded json mission',
      createdAt: '2026-01-03T03:04:05.000Z',
      updatedAt: '2026-01-03T03:04:06.000Z',
      status: 'completed',
      phase: 'done',
      artifactDir: runDir,
      events: 3,
    }, null, 2));

    const result = await runCli(['status', runId, '--json', '--cwd', cwd]);
    const payload = JSON.parse(result.stdout) as { id: string; status: string; artifactDir: string };
    expect(payload).toEqual(expect.objectContaining({ id: runId, status: 'completed', artifactDir: runDir }));
  });

  it('refuses to undo an applied run while the operator checkout is dirty', async () => {
    const cwd = await initGitRepo();
    writeFileSync(join(cwd, 'app.txt'), 'base\napplied\n');
    await execa('git', ['add', 'app.txt'], { cwd });
    await execa('git', ['commit', '-m', 'applied state'], { cwd });
    const runId = '20260105030405-cafebabe';
    const runDir = join(cwd, '.xdou', 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'diff.patch'), [
      'diff --git a/app.txt b/app.txt',
      'index df967b9..35301e4 100644',
      '--- a/app.txt',
      '+++ b/app.txt',
      '@@ -1 +1,2 @@',
      ' base',
      '+applied',
      '',
    ].join('\n'));
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
      id: runId,
      mission: 'undo dirty safety',
      createdAt: '2026-01-05T03:04:05.000Z',
      updatedAt: '2026-01-05T03:04:06.000Z',
      status: 'completed',
      phase: 'done',
      artifactDir: runDir,
      events: 3,
      appliedAt: '2026-01-05T03:05:00.000Z',
    }, null, 2));
    writeFileSync(join(cwd, 'dirty.txt'), 'operator work\n');

    const result = await runCli(['undo', runId, '--json', '--cwd', cwd], repoRoot, false);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('"ok": false');
    expect(result.stderr).toContain('dirty working tree');
    expect(readFileSync(join(cwd, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\napplied\n');
  });
});
