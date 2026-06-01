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

function seedRun(cwd: string, id = '20260102030405-deadbeef'): string {
  const runDir = join(cwd, '.xdou', 'runs', id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({
    id,
    mission: 'add terminal cockpit',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:06.000Z',
    status: 'blocked',
    phase: 'review',
    artifactDir: runDir,
    events: 4,
    worktreePath: join(cwd, '.xdou', 'worktrees', id),
  }, null, 2));
  writeFileSync(join(runDir, 'timeline.ndjson'), [
    JSON.stringify({ time: '2026-01-02T03:04:05.000Z', type: 'run.created', by: 'xdou' }),
    JSON.stringify({ time: '2026-01-02T03:04:06.000Z', type: 'review.finished', by: 'claude', verdict: 'request_changes' }),
  ].join('\n'));
  writeFileSync(join(runDir, 'review-verdicts.json'), JSON.stringify([
    { agent: 'claude', verdict: 'request_changes', confidence: 0.9, reason: 'missing cockpit action bar', missingRequirements: ['action bar'] },
  ], null, 2));
  return id;
}

describe('cockpit command', () => {
  it('appears in help output', async () => {
    const result = await runCli(['help']);
    expect(result.stdout).toContain('cockpit [run-id]');
  });

  it('renders a non-interactive mission-control snapshot for the latest run', async () => {
    const cwd = temporaryDirectory();
    const runId = seedRun(cwd);
    const result = await runCli(['cockpit', '--snapshot', '--cwd', cwd]);
    expect(result.stdout).toContain('xdou cockpit');
    expect(result.stdout).toContain(runId);
    expect(result.stdout).toContain('add terminal cockpit');
    expect(result.stdout).toContain('blocked/review');
    expect(result.stdout).toContain('claude: request_changes');
    expect(result.stdout).toContain('[a] apply  [r] rerun  [v] view diff  [l] logs  [c] context  [q] quit');
  });
});
