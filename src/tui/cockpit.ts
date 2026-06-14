import fs from 'fs-extra';
import { join } from 'node:path';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import stripAnsi from 'strip-ansi';
import type { ArtifactStore } from '../core/artifact-store.js';
import { readCollaborationState, type CollaborationEvent, type CollaborationState } from '../core/live-collaboration.js';
import type { RunManifest } from '../types.js';

interface TimelineEvent {
  time: string | undefined;
  type: string | undefined;
  by: string | undefined;
  verdict: string | undefined;
  status: string | undefined;
  phase: string | undefined;
  ok: boolean | undefined;
}

interface ReviewVerdictSummary {
  agent: string;
  verdict: string;
  reason: string;
  confidence: number | undefined;
  missingRequirements: string[];
}

interface ArtifactPreview {
  plan: string[];
  diff: string[];
  review: string[];
  summary: string[];
}

interface AgentCard {
  id: string;
  role: string;
  status: string;
  last: string;
}

export interface CockpitState {
  runs: RunManifest[];
  selected: RunManifest | undefined;
  timeline: TimelineEvent[];
  verdicts: ReviewVerdictSummary[];
  artifacts: ArtifactPreview;
  collaboration?: CollaborationState;
}

export interface CockpitMissionCommand {
  action: 'plan' | 'run';
  mission: string;
}

export type CockpitOperatorCommand =
  | CockpitMissionCommand
  | { action: 'ask'; prompt: string }
  | { action: 'web'; query: string }
  | { action: 'find'; query: string }
  | { action: 'continue' }
  | { action: 'parallel'; mission: string }
  | { action: 'diff' | 'review' | 'status' | 'apply' | 'test' | 'fix' | 'discard' | 'undo'; runId?: string };

export type CockpitLaunchResult =
  | { kind: 'exit' }
  | { kind: 'mission'; command: 'plan' | 'run'; mission: string }
  | { kind: 'operator'; command: CockpitOperatorCommand };

const missionActionVerbs = new Set([
  'add', 'build', 'create', 'make', 'implement', 'fix', 'debug', 'refactor', 'update', 'change', 'improve', 'write', 'generate', 'design', 'plan', 'run', 'code', 'test',
]);

const conversationalOpeners = new Set(['hi', 'hello', 'hey', 'yo', 'thanks', 'thank', 'ok', 'okay', 'sup']);
const nonCodingOpeners = new Set(['what', 'how', 'why', 'who', 'when', 'where', 'tell', 'explain', 'summarize', 'describe', 'read', 'show']);

export function isActionableCodingMission(input: string): boolean {
  const normalized = input.trim().toLowerCase().replace(/^[:/]/, '');
  if (!normalized || normalized.endsWith('?')) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  if (!words.length) return false;
  if (words.length === 1 && conversationalOpeners.has(first)) return false;
  if (nonCodingOpeners.has(first)) return false;
  if (normalized.length < 6 && words.length < 2) return false;
  return missionActionVerbs.has(first) || words.length >= 3;
}

export function parseCockpitMissionCommand(input: string): CockpitMissionCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/^[:/]/, '');
  const [rawVerb, ...rest] = normalized.split(/\s+/);
  const verb = rawVerb?.toLowerCase();
  if (!verb) return undefined;
  if (['plan', 'p'].includes(verb)) {
    const mission = rest.join(' ').trim();
    return mission && isActionableCodingMission(mission) ? { action: 'plan', mission } : undefined;
  }
  if (['run', 'code', 'c'].includes(verb)) {
    const mission = rest.join(' ').trim();
    return mission && isActionableCodingMission(mission) ? { action: 'run', mission } : undefined;
  }
  return isActionableCodingMission(trimmed) ? { action: 'run', mission: trimmed } : undefined;
}

export function parseCockpitOperatorCommand(input: string): CockpitOperatorCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/^[:/]/, '');
  const [rawVerb, ...rest] = normalized.split(/\s+/);
  const verb = rawVerb?.toLowerCase();
  const body = rest.join(' ').trim();
  if (!verb) return undefined;
  if (['ask', 'question', 'q'].includes(verb)) return body ? { action: 'ask', prompt: body } : undefined;
  if (['web', 'search-web'].includes(verb)) return body ? { action: 'web', query: body } : undefined;
  if (['find', 'file', 'search'].includes(verb)) return body ? { action: 'find', query: body } : undefined;
  if (verb === 'continue') return { action: 'continue' };
  if (['diff', 'changes', 'v'].includes(verb)) return body ? { action: 'diff', runId: body } : { action: 'diff' };
  if (['review', 'r'].includes(verb)) return body ? { action: 'review', runId: body } : { action: 'review' };
  if (['status', 's'].includes(verb)) return body ? { action: 'status', runId: body } : { action: 'status' };
  if (['apply', 'a'].includes(verb)) return body ? { action: 'apply', runId: body } : { action: 'apply' };
  if (['test', 'rerun-tests', 'validate', 't'].includes(verb)) return body ? { action: 'test', runId: body } : { action: 'test' };
  if (['fix', 'repair', 'f'].includes(verb)) return body ? { action: 'fix', runId: body } : { action: 'fix' };
  if (['discard', 'drop', 'd'].includes(verb)) return body ? { action: 'discard', runId: body } : { action: 'discard' };
  if (['undo', 'rollback', 'u'].includes(verb)) return body ? { action: 'undo', runId: body } : { action: 'undo' };
  if (['parallel', 'fork'].includes(verb)) return body ? { action: 'parallel', mission: body } : undefined;
  if (['plan', 'p', 'run', 'code', 'c'].includes(verb)) return parseCockpitMissionCommand(trimmed);
  if (trimmed.endsWith('?')) return { action: 'ask', prompt: trimmed };
  if (!isActionableCodingMission(trimmed)) return { action: 'ask', prompt: trimmed };
  return parseCockpitMissionCommand(trimmed);
}

export function parseCockpitInputChunk(data: string): string {
  const bracketed = data.match(/^\x1b\[200~([\s\S]*)\x1b\[201~$/);
  return bracketed ? bracketed[1] ?? '' : data;
}

const reset = '\x1b[0m';
const sgr = (code: number, value: string): string => `\x1b[${code}m${value}${reset}`;
const bold = (value: string): string => sgr(1, value);
const dim = (value: string): string => sgr(2, value);
const red = (value: string): string => sgr(31, value);
const green = (value: string): string => sgr(32, value);
const yellow = (value: string): string => sgr(33, value);
const magenta = (value: string): string => sgr(35, value);
const cyan = (value: string): string => sgr(36, value);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
function boolValue(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }

function parseTimelineLine(line: string): TimelineEvent | undefined {
  const parsed = asRecord(JSON.parse(line) as unknown);
  if (!parsed) return undefined;
  return {
    time: stringValue(parsed.time),
    type: stringValue(parsed.type),
    by: stringValue(parsed.by),
    verdict: stringValue(parsed.verdict),
    status: stringValue(parsed.status),
    phase: stringValue(parsed.phase),
    ok: boolValue(parsed.ok),
  };
}

async function readTimeline(runDir: string): Promise<TimelineEvent[]> {
  const file = join(runDir, 'timeline.ndjson');
  if (!(await fs.pathExists(file))) return [];
  const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
  const events: TimelineEvent[] = [];
  for (const line of lines) {
    try {
      const event = parseTimelineLine(line);
      if (event) events.push(event);
    } catch { /* ignore malformed historical timeline rows */ }
  }
  return events;
}

async function readVerdicts(runDir: string): Promise<ReviewVerdictSummary[]> {
  const file = join(runDir, 'review-verdicts.json');
  if (!(await fs.pathExists(file))) return [];
  const parsed = await fs.readJson(file) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item, index) => {
    const record = asRecord(item) ?? {};
    return {
      agent: stringValue(record.agent) ?? `reviewer-${index + 1}`,
      verdict: stringValue(record.verdict) ?? 'unknown',
      reason: stringValue(record.reason) ?? '',
      confidence: numberValue(record.confidence),
      missingRequirements: stringArray(record.missingRequirements),
    };
  });
}

async function readLinesIfExists(path: string, maxLines: number): Promise<string[]> {
  if (!(await fs.pathExists(path))) return [];
  const content = await fs.readFile(path, 'utf8');
  return content.split(/\r?\n/).filter(Boolean).slice(0, maxLines);
}

async function readArtifacts(runDir: string): Promise<ArtifactPreview> {
  return {
    plan: await readLinesIfExists(join(runDir, 'plan.md'), 12),
    diff: await readLinesIfExists(join(runDir, 'diff.patch'), 12),
    review: await readLinesIfExists(join(runDir, 'review.md'), 12),
    summary: await readLinesIfExists(join(runDir, 'final-summary.md'), 12),
  };
}

export async function readCockpitState(store: ArtifactStore, runId?: string): Promise<CockpitState> {
  await store.recoverStaleRuns();
  const runs = await store.listRuns();
  const selectedId = runId ?? runs.at(-1)?.id;
  const selected = selectedId ? runs.find((run) => run.id === selectedId) ?? await store.readManifest(selectedId) : undefined;
  const runDir = selected ? store.runDir(selected.id) : undefined;
  const timeline = runDir ? await readTimeline(runDir) : [];
  const verdicts = runDir ? await readVerdicts(runDir) : [];
  const artifacts = runDir ? await readArtifacts(runDir) : { plan: [], diff: [], review: [], summary: [] };
  const collaboration = selected ? await readCollaborationState(store, selected.id).catch(() => undefined) : undefined;
  return collaboration ? { runs, selected, timeline, verdicts, artifacts, collaboration } : { runs, selected, timeline, verdicts, artifacts };
}

// ─── Human-readable event translation ───

const HUMAN_EVENTS: Record<string, { label: string; icon: string; color: (s: string) => string }> = {
  'run.created': { label: 'Run started', icon: '🚀', color: cyan },
  'council.finished': { label: 'Agent council complete', icon: '✅', color: green },
  'council.started': { label: 'Agent council started', icon: '🤝', color: cyan },
  'plan.created': { label: 'Plan created', icon: '📋', color: cyan },
  'implementation.finished': { label: 'Implementation done', icon: '💻', color: green },
  'implementation.started': { label: 'Implementation started', icon: '💻', color: yellow },
  'validation.finished': { label: 'Tests passed', icon: '✅', color: green },
  'validation.started': { label: 'Running tests', icon: '🧪', color: yellow },
  'validation.failed': { label: 'Tests failed', icon: '❌', color: red },
  'review.finished': { label: 'Review complete', icon: '👁', color: magenta },
  'review.started': { label: 'Review started', icon: '👁', color: cyan },
  'run.aborted': { label: 'Run aborted', icon: '⛔', color: red },
  'run.completed': { label: 'Run completed', icon: '✅', color: green },
  'fix.started': { label: 'Fix started', icon: '🔧', color: yellow },
  'fix.finished': { label: 'Fix complete', icon: '🔧', color: green },
  'apply.started': { label: 'Applying changes', icon: '📥', color: cyan },
  'apply.finished': { label: 'Changes applied', icon: '✅', color: green },
  'discard.started': { label: 'Discarding run', icon: '🗑', color: yellow },
  'discard.finished': { label: 'Run discarded', icon: '🗑', color: red },
  'undo.started': { label: 'Rolling back', icon: '↩️', color: yellow },
  'undo.finished': { label: 'Rollback complete', icon: '✅', color: green },
};

function humanEvent(event: TimelineEvent): { label: string; icon: string; color: (s: string) => string } {
  const key = event.type ?? '';
  const base = HUMAN_EVENTS[key] ?? { label: key || 'event', icon: '•', color: dim };
  // Special handling for validation events based on ok status
  if (key === 'validation.finished') {
    if (event.ok === false) return { label: 'Tests failed', icon: '❌', color: red };
    if (event.ok === true) return { label: 'Tests passed', icon: '✅', color: green };
  }
  return base;
}

function fmtEvent(event: TimelineEvent): { time: string; line: string; raw: string } {
  const time = event.time ? event.time.slice(11, 19) : '--:--:--';
  const human = humanEvent(event);
  const actor = event.by ? ` ${dim(event.by)}` : '';
  const verdict = event.verdict ? ` ${event.verdict}` : '';
  const ok = event.ok === undefined ? '' : event.ok ? ` ${green('✓')}` : ` ${red('✗')}`;
  const line = `${human.icon} ${human.color(human.label)}${actor}${verdict}${ok}`;
  const raw = `${time} ${event.type ?? 'event'}${actor}${verdict}${ok}`;
  return { time, line, raw };
}

function truncate(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  return truncateToWidth(value, Math.max(0, width - 1)) + '…';
}

function pad(value: string, width: number): string {
  const clipped = truncate(value, width);
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

// ─── Semantic status colors for agents ───

function agentStatusDisplay(status: string): { icon: string; color: (s: string) => string; label: string } {
  switch (status) {
    case 'done':
    case 'completed':
      return { icon: '🟢', color: green, label: 'done' };
    case 'working':
    case 'active':
    case 'running':
      return { icon: '🟡', color: yellow, label: 'working' };
    case 'blocked':
    case 'failed':
      return { icon: '🔴', color: red, label: 'blocked' };
    case 'waiting':
    case 'queued':
    case 'idle':
    default:
      return { icon: '⚪', color: dim, label: 'waiting' };
  }
}

function agentsFromState(state: CockpitState): AgentCard[] {
  const seen = new Map<string, AgentCard>();
  for (const event of state.timeline) {
    if (!event.by) continue;
    const prior = seen.get(event.by);
    seen.set(event.by, {
      id: event.by,
      role: event.by.includes('claude') ? 'architect / reviewer' : event.by.includes('codex') ? 'implementer / fixer' : 'agent',
      status: event.ok === false ? 'blocked' : event.type?.includes('finished') ? 'done' : event.type?.includes('started') ? 'working' : state.selected?.phase ?? 'waiting',
      last: event.type ?? 'event',
    });
    if (prior && !event.type) seen.set(event.by, prior);
  }
  for (const verdict of state.verdicts) {
    seen.set(verdict.agent, { id: verdict.agent, role: 'reviewer', status: verdict.verdict, last: verdict.reason || 'reviewed run' });
  }
  if (!seen.size) {
    seen.set('claude', { id: 'claude', role: 'architect / reviewer', status: 'waiting', last: 'ready to plan/review' });
    seen.set('codex', { id: 'codex', role: 'implementer / fixer', status: 'waiting', last: 'ready to code/fix' });
  }
  return [...seen.values()].slice(0, 8);
}

function artifactLines(state: CockpitState): string[] {
  const sections: Array<[string, string[]]> = [
    ['plan.md', state.artifacts.plan],
    ['diff.patch', state.artifacts.diff],
    ['review.md', state.artifacts.review],
    ['final-summary.md', state.artifacts.summary],
  ];
  const out: string[] = [];
  for (const [name, lines] of sections) {
    out.push(`${yellow(name)}`);
    out.push(...(lines.length ? lines : [dim('(not created)')]).slice(0, 5));
    out.push('');
  }
  return out;
}

function collaborationEventLine(event: CollaborationEvent): string {
  const sev = event.severity ? `[${event.severity}] ` : '';
  const to = event.to ? ` → ${event.to}` : '';
  const file = event.file ? ` ${event.file}` : '';
  return `${sev}${event.from}${to}: ${event.type}${file}${event.message ? ` — ${event.message}` : ''}`;
}

function collaborationLines(state: CockpitState): string[] {
  const collab = state.collaboration;
  if (!collab?.events.length) return [dim('Shared room: waiting for live agent notes and patch deltas')];
  const blockers = collab.blockers.slice(-3).map(collaborationEventLine);
  const warnings = collab.warnings.slice(-3).map(collaborationEventLine);
  const patches = collab.latestPatchDeltas.slice(-4).map(collaborationEventLine);
  return [
    dim(`Shared room: ${collab.agents.length} agents, ${collab.events.length} events`),
    ...(blockers.length ? [red('Blockers:'), ...blockers.map(b => `  ${b}`)] : []),
    ...(warnings.length ? [yellow('Warnings:'), ...warnings.map(w => `  ${w}`)] : []),
    ...(patches.length ? [cyan('Live patch deltas:'), ...patches.map(p => `  ${p}`)] : []),
  ].slice(0, 12);
}

function decisionSummaryLines(state: CockpitState): string[] {
  const selected = state.selected;
  if (!selected) return ['Status: ready for input', 'Next: /ask, /find, /web, /plan, /code'];
  const diffHeaderCount = state.artifacts.diff.filter((line) => line.startsWith('diff --git ')).length;
  const patchDeltaCount = new Set(state.collaboration?.latestPatchDeltas?.map((e) => e.file).filter(Boolean) ?? []).size;
  const changedFiles = Math.max(diffHeaderCount, patchDeltaCount);
  const verdict = state.verdicts.find((item) => item.verdict.toLowerCase().includes('request')) ?? state.verdicts[0];
  const tests = [...state.timeline].reverse().find((event) => event.type === 'validation.finished');
  const next = selected.status === 'completed' && !selected.appliedAt
    ? '[1] Review diff  [2] Run tests  [3] Apply'
    : selected.status === 'blocked'
      ? '[1] Fix blockers  [2] Discard'
      : selected.appliedAt
        ? '[1] Undo  [2] Continue'
        : selected.status === 'running'
          ? 'Wait / refresh'
          : '/code or /plan next mission';
  return [
    `Status: ${bold(selected.status)}/${selected.phase}`,
    `Changed: ${changedFiles ? bold(`${changedFiles} file(s)`) : dim('no diff yet')}`,
    `Tests: ${tests ? (tests.ok ? bold(green('PASS')) : bold(red('FAIL'))) : dim('waiting')}`,
    `Review: ${verdict ? `${verdict.agent} ${verdict.verdict}` : dim('waiting')}`,
    `Risk: ${selected.status === 'completed' ? green('low') : selected.status === 'blocked' ? red('needs attention') : dim('unknown')}`,
    `Next: ${next}`,
  ];
}

// ─── Layout Helpers ───

function threeColumn(left: string[], mid: string[], right: string[], leftW: number, midW: number, gap = 2): string[] {
  const height = Math.max(left.length, mid.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const l = left[i] ?? '';
    const m = mid[i] ?? '';
    const r = right[i] ?? '';
    out.push(pad(l, leftW) + ' '.repeat(gap) + pad(m, midW) + ' '.repeat(gap) + r);
  }
  return out;
}

// ─── Snapshot / Render Functions ───

function renderMissionHeader(state: CockpitState, width: number): string[] {
  const selected = state.selected;
  if (!selected) return [];

  const missionLine = `  ${bold(selected.mission)}`;
  const statusLine = `  Status: ${bold(selected.status)}  │  Phase: ${selected.phase}  │  Tests: ${state.timeline.some(e => e.type === 'validation.finished' && e.ok) ? green('PASS') : state.timeline.some(e => e.type === 'validation.finished' && !e.ok) ? red('FAIL') : dim('pending')}  │  Risk: ${selected.status === 'completed' ? green('LOW') : selected.status === 'blocked' ? red('HIGH') : dim('unknown')}`;
  const idLine = `  Run: ${dim(selected.id)}`;

  const contentWidth = width - 4;
  const lines = [
    `┌${'─'.repeat(contentWidth)}┐`,
    pad(missionLine, contentWidth),
    pad(statusLine, contentWidth),
    pad(idLine, contentWidth),
    `└${'─'.repeat(contentWidth)}┘`,
    '',
  ];
  return lines;
}

function renderEmptyMissionHeader(width: number): string[] {
  const contentWidth = width - 4;
  return [
    `┌${'─'.repeat(contentWidth)}┐`,
    pad('  Waiting for operator prompt...', contentWidth),
    `└${'─'.repeat(contentWidth)}┘`,
    '',
  ];
}

function renderAgentsColumn(agents: AgentCard[], width: number, height: number): string[] {
  const lines: string[] = [bold('AGENTS')];
  for (const agent of agents) {
    const statusDisp = agentStatusDisplay(agent.status);
    lines.push(`${statusDisp.icon} ${statusDisp.color(agent.id)}  ${dim(agent.role)}`);
    lines.push(`  ${dim(agent.last)}`);
    lines.push('');
  }
  while (lines.length < height) lines.push('');
  return lines.slice(0, height);
}

function renderTimelineColumn(state: CockpitState, width: number, height: number): string[] {
  const lines: string[] = [bold('TIMELINE (live)')];

  const collabLines = collaborationLines(state);
  for (const line of collabLines.slice(0, 2)) {
    lines.push(`  ${line}`);
  }
  if (collabLines.length > 2) lines.push('');

  const timelineEvents = state.timeline.length ? state.timeline.slice(-8) : [];
  for (const event of timelineEvents) {
    const { line } = fmtEvent(event);
    lines.push(`  ${line}`);
  }

  while (lines.length < height) lines.push('');
  return lines.slice(0, height);
}

function renderArtifactsColumn(state: CockpitState, width: number, height: number): string[] {
  const lines: string[] = [bold('ARTIFACTS')];
  const artifacts = artifactLines(state);
  for (const line of artifacts.slice(0, height - 4)) {
    lines.push(`  ${line}`);
  }
  lines.push('');
  if (state.selected) {
    const applied = state.selected.appliedAt ? green('[Applied]') : '';
    lines.push(`  ${dim('Gate:')}${state.selected.status === 'completed' ? ' ' + green('Ready to apply') : ' ' + dim('waiting')} ${applied}`);
  } else {
    lines.push(`  ${dim('Gate:')} waiting for operator prompt`);
  }
  while (lines.length < height) lines.push('');
  return lines.slice(0, height);
}

function renderActionsFooter(state: CockpitState, width: number): string[] {
  const selected = state.selected;
  let actions: string[] = [];

  if (!selected) {
    actions = [
      '[1] /ask Question    [2] /find File    [3] /web Search    [4] /plan Mission    [5] /code Mission    [6] Quit',
    ];
  } else if (selected.status === 'completed' && !selected.appliedAt) {
    actions = [
      '[1] Review diff (v)  [2] Run tests (t)  [3] Apply (a)  [4] Ask agent (q)  [5] New mission  [q] Quit',
    ];
  } else if (selected.status === 'blocked') {
    actions = [
      '[1] Fix (f)  [2] Discard (d)  [3] Review diff (v)  [4] Ask agent (q)  [q] Quit',
    ];
  } else if (selected.status === 'running') {
    actions = [
      '[r] Refresh  [v] View diff  [q] Quit',
    ];
  } else if (selected.appliedAt) {
    actions = [
      '[1] Undo (u)  [2] Continue (c)  [3] Review diff (v)  [q] Quit',
    ];
  } else {
    actions = [
      '[1] /plan Mission  [2] /code Mission  [3] /ask Question  [q] Quit',
    ];
  }

  const contentWidth = width - 4;
  return [
    '',
    `┌${'─'.repeat(contentWidth)}┐`,
    pad(`  ${actions[0]}`, contentWidth),
    `└${'─'.repeat(contentWidth)}┘`,
  ];
}

function renderPromptComposer(width: number, activePrompt: string, promptError?: string, footerMessage?: string): string[] {
  const contentWidth = width - 4;
  const lines: string[] = [
    `┌${'─'.repeat(contentWidth)}┐`,
    pad(`  ${activePrompt ? `Prompt: ${activePrompt}█` : 'Prompt: /ask question | /find file | /web topic | /plan <idea> | /code <idea>'}`, contentWidth),
    pad(`  /ask /find /web do not require Git. /code and /run will initialize Git in a project folder.`, contentWidth),
    `└${'─'.repeat(contentWidth)}┘`,
  ];
  if (promptError) lines.push(red(`  ${promptError}`));
  if (footerMessage) lines.push(dim(`  ${footerMessage}`));
  return lines;
}

function emptyCockpitLines(width: number, activePrompt = ''): string[] {
  const agents = [
    { id: 'claude', role: 'architect / reviewer', status: 'waiting', last: 'ready to plan/review' },
    { id: 'codex', role: 'implementer / fixer', status: 'waiting', last: 'ready to code/fix' },
    { id: 'tester', role: 'validation gates', status: 'queued', last: '' },
  ];

  const leftW = Math.max(28, Math.floor(width * 0.25));
  const midW = Math.max(42, Math.floor(width * 0.4));
  const rightW = width - leftW - midW - 4;
  const colHeight = 14;

  return [
    bold('xdou visual cockpit') + ' ' + dim('operator cockpit for multi-agent co-development'),
    ...renderEmptyMissionHeader(width),
    ...threeColumn(
      renderAgentsColumn(agents, leftW, colHeight),
      renderTimelineColumn({ runs: [], selected: undefined, timeline: [], verdicts: [], artifacts: { plan: [], diff: [], review: [], summary: [] } }, midW, colHeight),
      renderArtifactsColumn({ runs: [], selected: undefined, timeline: [], verdicts: [], artifacts: { plan: [], diff: [], review: [], summary: [] } }, rightW, colHeight),
      leftW, midW
    ),
    ...renderActionsFooter({ runs: [], selected: undefined, timeline: [], verdicts: [], artifacts: { plan: [], diff: [], review: [], summary: [] } }, width),
    ...renderPromptComposer(width, activePrompt),
  ];
}

export function renderCockpitSnapshot(state: CockpitState, width = 120, activePrompt = ''): string {
  const totalWidth = Math.max(100, width);
  const leftW = Math.max(28, Math.floor(totalWidth * 0.25));
  const midW = Math.max(42, Math.floor(totalWidth * 0.4));
  const rightW = totalWidth - leftW - midW - 4;
  const colHeight = 14;

  const lines: string[] = [];

  if (!state.selected) {
    return emptyCockpitLines(totalWidth, activePrompt).map(stripAnsi).join('\n');
  }

  // Mission header
  lines.push(...renderMissionHeader(state, totalWidth));

  // Three columns
  const agents = agentsFromState(state);
  lines.push(...threeColumn(
    renderAgentsColumn(agents, leftW, colHeight),
    renderTimelineColumn(state, midW, colHeight),
    renderArtifactsColumn(state, rightW, colHeight),
    leftW, midW
  ));

  // Decision summary (compact)
  lines.push(...decisionSummaryLines(state).map(l => `  ${l}`));
  lines.push('');

  // Actions footer
  lines.push(...renderActionsFooter(state, totalWidth));

  // Prompt composer
  lines.push(...renderPromptComposer(totalWidth, activePrompt));

  return lines.map(stripAnsi).join('\n');
}

// ─── Interactive VisualCockpit ───

class VisualCockpit {
  private focus = 1;
  private promptMode = false;
  private prompt = '';
  private promptError = '';
  private footerMessage = '';
  private result: CockpitLaunchResult = { kind: 'exit' };
  private readonly stdin = process.stdin;
  private readonly stdout = process.stdout;
  private readonly inputHandler = (data: string): void => this.handleInput(data);
  private readonly resizeHandler = (): void => this.renderToTerminal();
  private wasRaw = false;

  constructor(private readonly state: CockpitState, private readonly onExit: (result: CockpitLaunchResult) => void) {}

  start(): void {
    this.wasRaw = Boolean(this.stdin.isRaw);
    if (this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.resume();
    this.stdin.on('data', this.inputHandler);
    this.stdout.on('resize', this.resizeHandler);
    // Enter alternate screen buffer
    this.stdout.write('\x1b[?1049h\x1b[?25l');
    this.renderToTerminal();
  }

  private handleInput(data: string): void {
    const chunk = parseCockpitInputChunk(data);
    if (matchesKey(chunk, 'q') && !this.promptMode) { this.shutdown(); return; }
    if (matchesKey(chunk, 'escape') || matchesKey(chunk, 'ctrl+c')) { this.promptMode = false; this.prompt = ''; this.promptError = ''; this.renderToTerminal(); return; }
    if (matchesKey(chunk, 'tab')) { this.focus = (this.focus + 1) % 3; this.renderToTerminal(); return; }

    if (!this.promptMode) {
      if (matchesKey(chunk, 'a')) { this.commandSelectedRun('apply'); return; }
      if (matchesKey(chunk, 'v')) { this.commandSelectedRun('diff'); return; }
      if (matchesKey(chunk, 't')) { this.commandSelectedRun('test'); return; }
      if (matchesKey(chunk, 'f')) { this.commandSelectedRun('fix'); return; }
      if (matchesKey(chunk, 'u')) { this.commandSelectedRun('undo'); return; }
      if (matchesKey(chunk, 'd')) { this.commandSelectedRun('discard'); return; }
      if (matchesKey(chunk, 'p')) { this.promptMode = true; this.prompt = '/plan '; this.renderToTerminal(); return; }
      if (matchesKey(chunk, 'r')) { this.commandSelectedRun('review'); return; }
      if (matchesKey(chunk, 'n')) { this.promptMode = false; this.prompt = ''; this.footerMessage = 'Composer ready — type directly.'; this.renderToTerminal(); return; }
      if (matchesKey(chunk, 'enter') || chunk === '\r' || chunk === '\n') { this.promptMode = true; this.prompt = ''; this.renderToTerminal(); return; }
      // Any printable char starts prompt
      if (/^[\x20-\x7E]+$/.test(chunk)) { this.promptMode = true; this.prompt = chunk; this.renderToTerminal(); return; }
    }

    this.handlePromptInput(chunk);
  }

  private handlePromptInput(data: string): void {
    const chunk = parseCockpitInputChunk(data);
    this.promptError = '';
    if (matchesKey(chunk, 'escape') || matchesKey(chunk, 'ctrl+c')) { this.promptMode = false; this.prompt = ''; this.renderToTerminal(); return; }
    if (matchesKey(chunk, 'enter') || chunk === '\r' || chunk === '\n') {
      const command = parseCockpitOperatorCommand(this.prompt);
      if (!command) { this.promptError = 'Type /plan <idea>, /code <idea>, /ask question, /continue, or /parallel <idea>'; this.renderToTerminal(); return; }
      if (command.action === 'plan' || command.action === 'run') {
        this.result = { kind: 'mission', command: command.action, mission: command.mission };
        this.shutdown();
        return;
      }
      this.result = { kind: 'operator', command };
      this.shutdown();
      return;
    }
    if (matchesKey(chunk, 'backspace') || chunk === '\x7f' || chunk === '\b') {
      this.prompt = this.prompt.slice(0, -1);
    } else if (/^[\x20-\x7E]+$/.test(chunk)) {
      this.prompt += chunk;
    }
    this.renderToTerminal();
  }

  private commandSelectedRun(action: 'apply' | 'diff' | 'review' | 'status' | 'test' | 'fix' | 'discard' | 'undo'): void {
    const runId = this.state.selected?.id;
    if (!runId) { this.showFooter('No run selected yet.'); return; }
    this.result = { kind: 'operator', command: { action, runId } };
    this.shutdown();
  }

  private showFooter(message: string): void {
    this.footerMessage = message;
    this.renderToTerminal();
  }

  private renderLines(width: number): string[] {
    const selected = this.state.selected;
    const totalWidth = Math.max(100, width);
    const leftW = Math.max(28, Math.floor(totalWidth * 0.25));
    const midW = Math.max(42, Math.floor(totalWidth * 0.4));
    const rightW = totalWidth - leftW - midW - 4;
    const colHeight = 14;

    const lines: string[] = [];

    if (!selected) {
      const emptyLines = emptyCockpitLines(totalWidth, this.promptMode ? this.prompt : '');
      if (this.promptError) emptyLines.push(red(`  ${this.promptError}`));
      if (this.footerMessage) emptyLines.push(dim(`  ${this.footerMessage}`));
      return emptyLines;
    }

    // Mission header
    lines.push(...renderMissionHeader(this.state, totalWidth));

    // Three columns
    const agents = agentsFromState(this.state);
    lines.push(...threeColumn(
      renderAgentsColumn(agents, leftW, colHeight),
      renderTimelineColumn(this.state, midW, colHeight),
      renderArtifactsColumn(this.state, rightW, colHeight),
      leftW, midW
    ));

    // Actions footer
    lines.push(...renderActionsFooter(this.state, totalWidth));

    // Prompt composer
    const promptText = this.promptMode ? this.prompt : '';
    lines.push(...renderPromptComposer(totalWidth, promptText, this.promptError, this.footerMessage));

    return lines;
  }

  private renderToTerminal(): void {
    const width = this.stdout.columns || Number(process.env.COLUMNS) || 120;
    const height = this.stdout.rows || Number(process.env.LINES) || 30;
    const lines = this.renderLines(width).slice(0, Math.max(1, height - 1));
    // Move cursor to home and clear to end of screen (no full-screen clear flicker)
    this.stdout.write('\x1b[H\x1b[J' + lines.join('\r\n'));
  }

  private shutdown(): void {
    this.stdin.off('data', this.inputHandler);
    this.stdout.off('resize', this.resizeHandler);
    if (this.stdin.setRawMode) this.stdin.setRawMode(this.wasRaw);
    // Exit alternate screen buffer
    this.stdout.write('\x1b[?1049l\x1b[?25h\r\n');
    this.onExit(this.result);
  }
}

export async function launchCockpit(state: CockpitState): Promise<CockpitLaunchResult> {
  return new Promise<CockpitLaunchResult>((resolve) => {
    const app = new VisualCockpit(state, resolve);
    app.start();
  });
}