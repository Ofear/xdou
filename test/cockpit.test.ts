import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { parseCockpitInputChunk, parseCockpitMissionCommand, parseCockpitOperatorCommand, renderCockpitSnapshot } from '../src/tui/cockpit.js';

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
    JSON.stringify({ time: '2026-01-02T03:04:05.500Z', type: 'validation.finished', by: 'xdou', ok: false }),
    JSON.stringify({ time: '2026-01-02T03:04:06.000Z', type: 'review.finished', by: 'claude', verdict: 'request_changes' }),
  ].join('\n'));
  writeFileSync(join(runDir, 'review-verdicts.json'), JSON.stringify([
    { agent: 'claude', verdict: 'request_changes', confidence: 0.9, reason: 'missing cockpit action bar', missingRequirements: ['action bar'] },
  ], null, 2));
  writeFileSync(join(runDir, 'plan.md'), '## Plan\n1. Build visual cockpit panes\n2. Stream agent activity\n');
  writeFileSync(join(runDir, 'diff.patch'), 'diff --git a/src/tui/cockpit.ts b/src/tui/cockpit.ts\n+visual panes\n');
  mkdirSync(join(runDir, 'agents', 'codex'), { recursive: true });
  writeFileSync(join(runDir, 'agents', 'codex', 'implementation-result.json'), JSON.stringify({ agent: 'codex', ok: true, stdout: 'Implemented cockpit pane layout and artifact previews.' }, null, 2));
  return id;
}

describe('cockpit command', () => {
  it('appears in help output', async () => {
    const result = await runCli(['help']);
    expect(result.stdout).toContain('cockpit [run-id]');
  });

  it('renders a non-interactive cockpit v2 pane snapshot for the latest run', async () => {
    const cwd = temporaryDirectory();
    const runId = seedRun(cwd);
    const result = await runCli(['cockpit', '--snapshot', '--cwd', cwd]);
    expect(result.stdout).toContain('xdou visual cockpit');
    expect(result.stdout).toContain(runId);
    expect(result.stdout).toContain('add terminal cockpit');
    expect(result.stdout).toContain('blocked/review');
    expect(result.stdout).toContain('claude request_changes');
    expect(result.stdout).toContain('┌ Mission Tabs ');
    expect(result.stdout).toContain('┌ Agents ');
    expect(result.stdout).toContain('┌ Live Work / Timeline ');
    expect(result.stdout).toContain('┌ Artifacts / Gates ');
    expect(result.stdout).toContain('┌ Current Focus ');
    expect(result.stdout).toContain('┌ Operator Attention ');
    expect(result.stdout).toContain('┌ Prompt Composer ');
    expect(result.stdout).not.toContain('xdou cockpit — visual mission control');
    expect(result.stdout).toContain('Changed: 1 file(s)');
    expect(result.stdout).toContain('Tests: failed');
    expect(result.stdout).toContain('Review: claude request_changes');
  });

  it('renders an empty cockpit as an operator cockpit v2, not a plain launcher', async () => {
    const cwd = temporaryDirectory();
    const result = await runCli(['cockpit', '--snapshot', '--cwd', cwd]);
    expect(result.stdout).toContain('xdou visual cockpit');
    expect(result.stdout).toContain('┌ Mission Tabs ');
    expect(result.stdout).toContain('┌ Agents ');
    expect(result.stdout).toContain('┌ Live Work / Timeline ');
    expect(result.stdout).toContain('┌ Artifacts / Gates ');
    expect(result.stdout).toContain('┌ Current Focus ');
    expect(result.stdout).toContain('┌ Operator Attention ');
    expect(result.stdout).toContain('┌ Prompt Composer ');
    expect(result.stdout).toContain('No action needed. Type a mission or command below.');
    expect(result.stdout).toContain('Prompt: /ask question | /find file | /web topic | /plan <idea> | /code <idea>');
    expect(result.stdout).toContain('/ask /find /web do not require Git. /code and /run will initialize Git in a project folder.');
  });

  it('documents cockpit keyboard controls consistently with the action bar', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

    expect(readme).toContain('p    start /plan prompt');
    expect(readme).toContain('t    rerun tests');
    expect(readme).toContain('f    fix blockers');
    expect(readme).toContain('u    undo applied run');
    expect(readme).toContain('d    discard run');
    expect(readme).toContain('/test /fix /apply /undo');
    expect(readme).not.toContain('p    show plan path');
  });

  it('parses cockpit prompt commands for planning and coding missions', () => {
    expect(parseCockpitMissionCommand('plan add oauth login')).toEqual({ action: 'plan', mission: 'add oauth login' });
    expect(parseCockpitMissionCommand('/code build the visual panes')).toEqual({ action: 'run', mission: 'build the visual panes' });
    expect(parseCockpitMissionCommand('run fix windows path handling')).toEqual({ action: 'run', mission: 'fix windows path handling' });
    expect(parseCockpitMissionCommand('improve the cockpit')).toEqual({ action: 'run', mission: 'improve the cockpit' });
    expect(parseCockpitMissionCommand('plan')).toBeUndefined();
    expect(parseCockpitMissionCommand('hi')).toBeUndefined();
    expect(parseCockpitMissionCommand('/code hi')).toBeUndefined();
  });

  it('parses productive cockpit operator commands for ask, continue, and parallel work', () => {
    expect(parseCockpitOperatorCommand('/ask why this architecture?')).toEqual({ action: 'ask', prompt: 'why this architecture?' });
    expect(parseCockpitOperatorCommand('why this architecture?')).toEqual({ action: 'ask', prompt: 'why this architecture?' });
    expect(parseCockpitOperatorCommand('/web npm 2fa bypass token')).toEqual({ action: 'web', query: 'npm 2fa bypass token' });
    expect(parseCockpitOperatorCommand('/find package.json')).toEqual({ action: 'find', query: 'package.json' });
    expect(parseCockpitOperatorCommand('/continue')).toEqual({ action: 'continue' });
    expect(parseCockpitOperatorCommand('/diff')).toEqual({ action: 'diff' });
    expect(parseCockpitOperatorCommand('/review 20260102030405-deadbeef')).toEqual({ action: 'review', runId: '20260102030405-deadbeef' });
    expect(parseCockpitOperatorCommand('/status')).toEqual({ action: 'status' });
    expect(parseCockpitOperatorCommand('/apply 20260102030405-deadbeef')).toEqual({ action: 'apply', runId: '20260102030405-deadbeef' });

    expect(parseCockpitOperatorCommand('/code build mission tabs')).toEqual({ action: 'run', mission: 'build mission tabs' });
  });

  it('treats bare conversational prompts as assistant chat, not coding missions', () => {
    expect(parseCockpitOperatorCommand('hi')).toEqual({ action: 'ask', prompt: 'hi' });
    expect(parseCockpitOperatorCommand('hello')).toEqual({ action: 'ask', prompt: 'hello' });
    expect(parseCockpitOperatorCommand('thanks')).toEqual({ action: 'ask', prompt: 'thanks' });
    expect(parseCockpitOperatorCommand('/code hi')).toBeUndefined();
  });

  it('shows typed prompt text in the visible composer instead of hiding it in an overlay', () => {
    const output = renderCockpitSnapshot({ runs: [], selected: undefined, timeline: [], verdicts: [], artifacts: { plan: [], diff: [], review: [], summary: [] } }, 120, 'plan test cockpit prompt');
    expect(output).toContain('┌ Prompt Composer ');
    expect(output).toContain('Prompt: plan test cockpit prompt█');
    expect(output).toContain('/ask /find /web do not require Git. /code and /run will initialize Git in a project folder.');
  });

  it('keeps snapshot lines within the requested wide terminal width', () => {
    const output = renderCockpitSnapshot({ runs: [], selected: undefined, timeline: [], verdicts: [], artifacts: { plan: [], diff: [], review: [], summary: [] } }, 140);
    const maxLineWidth = Math.max(...output.split('\n').map((line) => [...line].length));
    expect(maxLineWidth).toBeLessThanOrEqual(140);
    expect(output).toContain('architect/reviewer');
    expect(output).toContain('operator prompt');
  });

  it('counts changed files from live patch deltas when diff preview is truncated', () => {
    const output = renderCockpitSnapshot({
      runs: [],
      selected: { id: 'run-1', mission: 'build app', createdAt: '', updatedAt: '', status: 'completed', phase: 'done', artifactDir: '', events: 0 },
      timeline: [{ time: '', type: 'validation.finished', by: 'xdou', verdict: undefined, status: undefined, phase: undefined, ok: true }],
      verdicts: [{ agent: 'claude', verdict: 'approve', confidence: 1, reason: 'ok', missingRequirements: [] }],
      artifacts: { plan: [], diff: ['diff --git a/package.json b/package.json'], review: [], summary: [] },
      collaboration: {
        agents: [],
        events: [],
        warnings: [],
        blockers: [],
        latestPatchDeltas: [
          { type: 'file.patch.delta', from: 'codex', file: 'package.json' },
          { type: 'file.patch.delta', from: 'codex', file: 'src/cli.js' },
          { type: 'file.patch.delta', from: 'codex', file: 'test/cli.test.js' },
        ],
      },
    }, 120);

    expect(output).toContain('Changed: 3 file(s)');
  });

  it('normalizes bracketed paste and multi-character terminal input for the live prompt', () => {
    expect(parseCockpitInputChunk('\u001b[200~nplan test cockpit prompt\u001b[201~')).toBe('nplan test cockpit prompt');
    expect(parseCockpitInputChunk('plan typed from paste')).toBe('plan typed from paste');
  });

  it('suggests a safe project folder and approval path instead of dead-ending real coding missions from home', async () => {
    const home = process.env.USERPROFILE || process.env.HOME;
    expect(home).toBeTruthy();

    const result = await runCli(['run', 'build', 'todo', 'app', '--cwd', home as string], false);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Coding missions need a project folder.');
    expect(result.stderr).toContain('Suggested project folder:');
    expect(result.stderr).toContain('projects');
    expect(result.stderr).toContain('build-todo-app');
    expect(result.stderr).toContain('Approve it, or counter with: xdou cockpit --cwd <your-folder>');
  });

  it('rejects underspecified CLI coding missions before suggesting or creating a project folder', async () => {
    const home = process.env.USERPROFILE || process.env.HOME;
    expect(home).toBeTruthy();

    const result = await runCli(['run', 'hi', '--cwd', home as string], false);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('That does not look like a coding mission yet.');
    expect(result.stderr).toContain('/ask hi');
    expect(result.stderr).not.toContain('Suggested project folder:');
  });
});
