import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { parseCockpitInputChunk, parseCockpitMissionCommand, parseCockpitOperatorCommand, renderCockpitSnapshot, renderMarkdownLines } from '../src/tui/cockpit.js';
import stripAnsi from 'strip-ansi';

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
    // New format: mission header box (no title line for selected runs)
    expect(result.stdout).toContain(runId);
    expect(result.stdout).toContain('add terminal cockpit');
    expect(result.stdout).toContain('Status: blocked');
    expect(result.stdout).toContain('Phase: review');
    expect(result.stdout).toContain('Tests: FAIL');
    expect(result.stdout).toContain('Risk: HIGH');
    // Human-readable events
    expect(result.stdout).toContain('Run started');
    expect(result.stdout).toContain('Tests failed');
    expect(result.stdout).toContain('Review complete');
    // Agent status icons
    expect(result.stdout).toContain('🔴');
    expect(result.stdout).toContain('👁');
    // Three columns (no box borders)
    expect(result.stdout).toContain('AGENTS');
    expect(result.stdout).toContain('TIMELINE (live)');
    expect(result.stdout).toContain('ARTIFACTS');
    // Actions footer box (slash-command hints)
    expect(result.stdout).toContain('/fix blockers');
    expect(result.stdout).toContain('/discard');
    expect(result.stdout).toContain('/diff view changes');
    // Prompt composer box
    expect(result.stdout).toContain('Prompt: /ask question');
    expect(result.stdout).toContain('/ask /find /web do not require Git');
    // No old boxed panels
    expect(result.stdout).not.toContain('┌ Mission Tabs ');
    expect(result.stdout).not.toContain('┌ Current Focus ');
    expect(result.stdout).not.toContain('┌ Operator Attention ');
    expect(result.stdout).not.toContain('xdou cockpit — visual mission control');
    expect(result.stdout).toContain('Changed: 1 file(s)');
    expect(result.stdout).toContain('Review: claude request_changes');
  });

  it('renders an empty cockpit as an operator cockpit v2, not a plain launcher', async () => {
    const cwd = temporaryDirectory();
    const result = await runCli(['cockpit', '--snapshot', '--cwd', cwd]);
    expect(result.stdout).toContain('xdou visual cockpit');
    // Empty mission header box (chat-first wording, no stale "waiting" copy)
    expect(result.stdout).toContain('No active mission');
    // Three columns with default agents - note: role truncated due to column width
    expect(result.stdout).toContain('AGENTS');
    expect(result.stdout).toContain('⚪ claude');
    expect(result.stdout).toContain('architect / rev'); // truncated
    expect(result.stdout).toContain('⚪ codex');
    expect(result.stdout).toContain('implementer / fixer');
    expect(result.stdout).toContain('⚪ tester');
    expect(result.stdout).toContain('validation gates');
    expect(result.stdout).toContain('TIMELINE (live)');
    expect(result.stdout).toContain('Shared room: waiting');
    expect(result.stdout).toContain('ARTIFACTS');
    expect(result.stdout).toContain('plan.md');
    expect(result.stdout).toContain('(not created)');
    // Actions footer (slash-command hints)
    expect(result.stdout).toContain('/ask <q>');
    expect(result.stdout).toContain('/find <file>');
    expect(result.stdout).toContain('/web <topic>');
    expect(result.stdout).toContain('/plan <idea>');
    expect(result.stdout).toContain('/code <idea>');
    expect(result.stdout).toContain('Ctrl+C quits');
    // Prompt composer
    expect(result.stdout).toContain('Prompt: /ask question');
    expect(result.stdout).toContain('/ask /find /web do not require Git. /code and /run will initialize Git in a project folder.');
    // No old boxed panels
    expect(result.stdout).not.toContain('┌ Mission Tabs ');
    expect(result.stdout).not.toContain('┌ Current Focus ');
    expect(result.stdout).not.toContain('┌ Operator Attention ');
    expect(result.stdout).not.toContain('[1] new mission idle');
    expect(result.stdout).not.toContain('[2] parallel task empty');
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

  it('routes natural-language web searches to /web, not file find', () => {
    expect(parseCockpitOperatorCommand('Search the web for Wix stock price')).toEqual({ action: 'web', query: 'Wix stock price' });
    expect(parseCockpitOperatorCommand('search the web for cats')).toEqual({ action: 'web', query: 'cats' });
    expect(parseCockpitOperatorCommand('google latest node lts')).toEqual({ action: 'web', query: 'latest node lts' });
    const lookup = parseCockpitOperatorCommand('look up the weather online');
    expect(lookup?.action).toBe('web');
    // file searches still go to find — bare "web" as an adjective is NOT web research
    expect(parseCockpitOperatorCommand('search package.json')).toEqual({ action: 'find', query: 'package.json' });
    expect(parseCockpitOperatorCommand('search web component')).toEqual({ action: 'find', query: 'web component' });
    expect(parseCockpitOperatorCommand('/find src/cli.ts')).toEqual({ action: 'find', query: 'src/cli.ts' });
    expect(parseCockpitOperatorCommand('/web wix stock price')).toEqual({ action: 'web', query: 'wix stock price' });
  });

  it('renders agent Markdown into styled, width-bounded lines', () => {
    const lines = renderMarkdownLines('**Wix.com (NASDAQ: WIX): $45.91 USD**, up **+4.18%** on the day.\n\n- one\n- `code` item\n# Heading', 80);
    const plain = lines.map(stripAnsi);
    // markers are consumed (no literal ** or backticks left), bullets become •
    expect(plain.join('\n')).not.toContain('**');
    expect(plain.join('\n')).not.toContain('`');
    expect(plain.some((l) => l.startsWith('• one'))).toBe(true);
    expect(plain.some((l) => l.includes('Heading') && !l.includes('#'))).toBe(true);
    // styling actually applied (ANSI bold present somewhere)
    expect(lines.join('\n')).toContain('\x1b[1m');
    // never exceeds the requested width
    expect(Math.max(...plain.map((l) => l.length))).toBeLessThanOrEqual(80);
  });

  it('shows typed prompt text in the visible composer instead of hiding it in an overlay', () => {
    const output = renderCockpitSnapshot({ runs: [], selected: undefined, timeline: [], verdicts: [], artifacts: { plan: [], diff: [], review: [], summary: [] } }, 120, 'plan test cockpit prompt');
    expect(output).toContain('Prompt: plan test cockpit prompt');
    expect(output).toContain('/ask /find /web do not require Git. /code and /run will initialize Git in a project folder.');
  });

  it('keeps snapshot lines within the requested wide terminal width', () => {
    const output = renderCockpitSnapshot({ runs: [], selected: undefined, timeline: [], verdicts: [], artifacts: { plan: [], diff: [], review: [], summary: [] } }, 140);
    const maxLineWidth = Math.max(...output.split('\n').map((line) => [...line].length));
    expect(maxLineWidth).toBeLessThanOrEqual(140);
    expect(output).toContain('architect / rev'); // truncated in column
    expect(output).toContain('No active mission');
  });

  it('never overflows the terminal width even with long artifact/timeline content', () => {
    // Regression: an un-truncated right column overflowed the layout width, wrapped onto
    // extra physical rows, and scrolled the TUI — duplicating the whole frame on every render.
    const longLine = 'x'.repeat(300);
    const output = renderCockpitSnapshot({
      runs: [],
      selected: { id: 'run-1', mission: longLine, createdAt: '', updatedAt: '', status: 'completed', phase: 'done', artifactDir: '', events: 5 },
      timeline: [{ time: '2026-01-01T00:00:00Z', type: 'validation.finished', by: longLine, verdict: longLine, status: undefined, phase: undefined, ok: true }],
      verdicts: [{ agent: 'claude', verdict: 'request_changes', confidence: 0.9, reason: longLine, missingRequirements: [longLine] }],
      artifacts: { plan: [longLine], diff: ['diff --git a/x b/x'], review: [longLine], summary: [longLine] },
    }, 120);
    const maxLineWidth = Math.max(...output.split('\n').map((line) => [...line].length));
    expect(maxLineWidth).toBeLessThanOrEqual(120);
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

    expect(output).toContain('Changed:');
    expect(output).toContain('3 file(s)');
    expect(output).toContain('Status: completed');
    expect(output).toContain('Tests: PASS');
    expect(output).toContain('Risk: LOW');
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