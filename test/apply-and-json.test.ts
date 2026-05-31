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
    await execa('git', ['worktree', 'add', '--detach', worktreePath, 'HEAD'], { cwd });
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
      baseRef: 'HEAD'
    }, null, 2));

    const result = await runCli(['apply', runId, '--json', '--cwd', cwd]);
    const payload = JSON.parse(result.stdout) as { applied: boolean; runId: string; filesChanged: number };

    expect(payload).toEqual(expect.objectContaining({ applied: true, runId, filesChanged: 1 }));
    expect(readFileSync(join(cwd, 'app.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\napplied\n');
    expect(existsSync(join(runDir, 'apply-result.json'))).toBe(true);
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
});
