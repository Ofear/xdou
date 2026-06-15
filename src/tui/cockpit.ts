import fs from 'fs-extra';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import stripAnsi from 'strip-ansi';
import type { ArtifactStore } from '../core/artifact-store.js';
import { readCollaborationState, type CollaborationEvent, type CollaborationState } from '../core/live-collaboration.js';
import { CONTEXT_CHAR_BUDGET, turnChars } from '../core/assistant-prompt.js';
import { killInFlightAgents } from '../agents/base.js';
import type { RunManifest } from '../types.js';

// Verbatim conversation past this many characters triggers an automatic summary fold-in before the
// next chat call. Kept below CONTEXT_CHAR_BUDGET so older turns get summarized (not silently dropped
// by the cap) once a session grows long.
const AUTO_SUMMARIZE_CHARS = 6000;

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

// Natural-language web-search intent, e.g. "search the web for X", "look up X online", "google X".
// Deliberately strict: a bare "web"/"internet" used as an adjective ("search web component") is a
// FILE search, not web research. Requires a real signal: "the web/internet", "online", or "google".
function detectWebIntent(text: string): boolean {
  const t = text.toLowerCase();
  if (/^\s*google\s+\S/i.test(text)) return true;                                   // "google X"
  if (/\bthe\s+(web|internet)\b/.test(t)) return true;                              // "search/on the web/internet"
  if (/\bonline\b/.test(t) && /\b(search|look\s?up|find|browse|fetch|check)\b/.test(t)) return true; // "... online"
  if (/\b(search|browse|look\s?up)\s+(the\s+net|google)\b/.test(t)) return true;
  return false;
}

// Strip the "search the web for …" framing so the web query is just the subject.
function webQuery(text: string): string {
  const cleaned = text.trim()
    .replace(/^[:/]/, '')
    .replace(/^\s*(please\s+)?(google|search|look\s?up|browse|fetch|check)\s+/i, '')
    .replace(/^\s*(on\s+)?(the\s+)?(web|internet|online)\s*/i, '')
    .replace(/^\s*(for|about|on)\s+/i, '')
    .trim();
  return cleaned || text.trim();
}

export function parseCockpitOperatorCommand(input: string): CockpitOperatorCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const explicit = /^[:/]/.test(trimmed);
  const normalized = trimmed.replace(/^[:/]/, '');
  const [rawVerb, ...rest] = normalized.split(/\s+/);
  const verb = rawVerb?.toLowerCase();
  const body = rest.join(' ').trim();
  if (!verb) return undefined;
  if (['ask', 'question', 'q'].includes(verb)) return body ? { action: 'ask', prompt: body } : undefined;
  if (['web', 'search-web'].includes(verb)) return body ? { action: 'web', query: body } : undefined;
  if (['find', 'file'].includes(verb)) return body ? { action: 'find', query: body } : undefined;
  // "search …" is web when it mentions the web/internet, otherwise a file search.
  if (verb === 'search') return detectWebIntent(trimmed) ? { action: 'web', query: webQuery(trimmed) } : (body ? { action: 'find', query: body } : undefined);
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
  // Natural language (no slash command): infer web-search intent before falling back to chat/mission.
  if (!explicit && detectWebIntent(trimmed)) return { action: 'web', query: webQuery(trimmed) };
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
const inverse = (value: string): string => `\x1b[7m${value}\x1b[27m`;
const italic = (value: string): string => `\x1b[3m${value}\x1b[23m`;
const underline = (value: string): string => `\x1b[4m${value}\x1b[24m`;
const red = (value: string): string => sgr(31, value);
const green = (value: string): string => sgr(32, value);
const yellow = (value: string): string => sgr(33, value);
const blue = (value: string): string => sgr(34, value);
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

function threeColumn(left: string[], mid: string[], right: string[], leftW: number, midW: number, rightW: number, gap = 2): string[] {
  const height = Math.max(left.length, mid.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const l = left[i] ?? '';
    const m = mid[i] ?? '';
    const r = right[i] ?? '';
    // Truncate the right column too — leaving it raw lets long artifact/timeline lines
    // overflow past the layout width and wrap, which scrolls the TUI and duplicates frames.
    out.push(pad(l, leftW) + ' '.repeat(gap) + pad(m, midW) + ' '.repeat(gap) + truncate(r, rightW));
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

// Replace the home dir with ~ so the path stays short and recognizable in the header.
export function contractHome(path: string): string {
  const home = homedir();
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

export function formatCharCount(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
}

// One-line workspace bar: where we are (path), the branch (or "no git"), and how full the chat
// context is. Always visible regardless of mission state. Left unpadded (like the title line) — the
// per-frame home+clear wipes any trailing content, and padding to full width would trip the
// width-1 truncation clamp in renderToTerminal and append a stray "…".
function renderWorkspaceBar(cwd: string, branch: string | undefined, contextChars: number, turns: number): string {
  const place = bold(contractHome(cwd));
  const ref = branch ? `${dim('⎇')} ${branch}` : dim('no git');
  const ctx = dim(`context: ${formatCharCount(contextChars)} · ${turns} turn${turns === 1 ? '' : 's'}`);
  return `  ${place}  ${ref}   ${dim('·')}   ${ctx}`;
}

function renderEmptyMissionHeader(width: number): string[] {
  const contentWidth = width - 4;
  return [
    `┌${'─'.repeat(contentWidth)}┐`,
    pad(`  ${bold('No active mission')} ${dim('· chatting — start one with /code <idea> or /plan <idea>')}`, contentWidth),
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

// The toggleable roster: each agent shows a checkbox reflecting whether it participates in runs.
function renderRosterColumn(roster: CockpitRosterAgent[], disabled: Set<string>, height: number): string[] {
  const lines: string[] = [`${bold('AGENTS')}  ${dim('/enable /disable')}`];
  for (const agent of roster) {
    const off = disabled.has(agent.id);
    const box = off ? dim('[ ]') : green('[x]');
    const name = off ? dim(agent.id) : authorStyle(agent.id)(agent.id);
    lines.push(`${box} ${name}  ${dim(agent.roles.join(', ') || 'agent')}`);
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
    lines.push(`  ${dim('Gate:')} ${dim('no mission yet — /code or /plan to start')}`);
  }
  while (lines.length < height) lines.push('');
  return lines.slice(0, height);
}

// Context-aware "what next" hint for the selected run. Command *discovery* now lives in the slash
// palette (type /), so this surfaces only the few actions that make sense for the current run state,
// as a single dim line — and nothing at all in the chat/empty state, where the palette covers it.
function renderActionsFooter(state: CockpitState): string[] {
  const selected = state.selected;
  let next = '';
  if (!selected) next = '';
  else if (selected.status === 'completed' && !selected.appliedAt) next = '/diff · /test · /apply';
  else if (selected.status === 'blocked') next = '/fix · /diff · /discard';
  else if (selected.status === 'running') next = '/status · /diff';
  else if (selected.appliedAt) next = '/undo · /continue · /diff';
  if (!next) return [];
  return ['', dim(`  next: ${next}`)];
}

// Single source of truth for the slash-command menu. `arg` controls what Enter does on a highlighted
// item: 'required' tees up "/name " and waits for the operator to type the argument; 'optional'/'none'
// run immediately. Keep names aligned with the parsers in parseCockpitOperatorCommand.
export interface SlashCommand { name: string; arg: 'required' | 'optional' | 'none'; desc: string }
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'ask', arg: 'required', desc: 'Ask a question — chat with the assistant' },
  { name: 'find', arg: 'required', desc: 'Find files by name/content in this folder' },
  { name: 'web', arg: 'required', desc: 'Live web research with cited, labeled sources' },
  { name: 'plan', arg: 'required', desc: 'Plan a coding mission (no code changes)' },
  { name: 'code', arg: 'required', desc: 'Run a coding mission end-to-end' },
  { name: 'parallel', arg: 'required', desc: 'Fork the mission across multiple agents' },
  { name: 'diff', arg: 'optional', desc: 'Show changes for a run [run-id]' },
  { name: 'review', arg: 'optional', desc: 'Run reviewers on a run [run-id]' },
  { name: 'test', arg: 'optional', desc: 'Re-run validation/tests [run-id]' },
  { name: 'apply', arg: 'optional', desc: "Apply a run's changes to the working tree [run-id]" },
  { name: 'undo', arg: 'optional', desc: 'Undo an applied run [run-id]' },
  { name: 'fix', arg: 'optional', desc: 'Run the fixer on a blocked run [run-id]' },
  { name: 'discard', arg: 'optional', desc: 'Discard a run [run-id]' },
  { name: 'status', arg: 'optional', desc: 'Show status of a run [run-id]' },
  { name: 'continue', arg: 'none', desc: 'Continue the current run' },
  { name: 'agents', arg: 'none', desc: 'List agents and their on/off state' },
  { name: 'enable', arg: 'required', desc: 'Enable an agent — /enable <id>' },
  { name: 'disable', arg: 'required', desc: 'Disable an agent — /disable <id>' },
  { name: 'context', arg: 'none', desc: 'Show chat context size & summary' },
  { name: 'summarize', arg: 'none', desc: 'Compact the conversation now' },
  { name: 'clear', arg: 'none', desc: 'Clear context — agents start fresh' },
  { name: 'sessions', arg: 'none', desc: 'List saved chat sessions' },
  { name: 'resume', arg: 'required', desc: 'Resume a saved session — /resume <id>' },
];

export function filterSlashCommands(filter: string): SlashCommand[] {
  const f = filter.toLowerCase();
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(f));
}

// Claude-Code-style command palette: a bordered list of matching commands with descriptions, the
// highlighted row inverse-video. Windows around the selection so a long list stays one screenful.
function renderSlashMenu(items: SlashCommand[], index: number, width: number, maxRows = 8): string[] {
  const contentWidth = width - 4;
  const nameCol = Math.max(...items.map((c) => c.name.length)) + 3;
  const start = Math.max(0, Math.min(index - Math.floor(maxRows / 2), items.length - maxRows));
  const window = items.slice(Math.max(0, start), Math.max(0, start) + maxRows);
  const rows = window.map((cmd) => {
    const i = items.indexOf(cmd);
    const name = `/${cmd.name}`.padEnd(nameCol);
    const raw = `  ${name}${cmd.desc}`;
    const line = truncate(raw, contentWidth);
    return i === index ? inverse(pad(line, contentWidth)) : `${line}${' '.repeat(Math.max(0, contentWidth - visibleWidth(line)))}`;
  });
  const more = items.length > maxRows ? dim(`  … ${items.length - maxRows} more — keep typing to filter`) : '';
  return [
    '',
    `┌${'─'.repeat(contentWidth)}┐`,
    pad(`  ${bold('commands')}  ${dim('↑/↓ select · Enter run · Tab complete · Esc cancel')}`, contentWidth),
    ...rows,
    ...(more ? [more] : []),
    `└${'─'.repeat(contentWidth)}┘`,
  ];
}

// Hard-wrap `label + prompt` (honouring explicit \n line breaks) to `width` cells per row and draw
// a reverse-video block cursor at `cursor` (an index into `prompt`). Never truncates the operator's
// own input — long lines wrap to more rows instead.
function editableRows(label: string, prompt: string, width: number, cursor: number): string[] {
  const full = label + prompt;
  const cursorAbs = label.length + cursor;
  const rows: Array<{ start: number; text: string }> = [];
  let pos = 0;
  const segments = full.split('\n');
  segments.forEach((seg, si) => {
    if (seg.length === 0) {
      rows.push({ start: pos, text: '' });
    } else {
      for (let s = 0; s < seg.length; s += width) rows.push({ start: pos + s, text: seg.slice(s, s + width) });
    }
    pos += seg.length + (si < segments.length - 1 ? 1 : 0); // count the '\n' between segments
  });
  if (!rows.length) rows.push({ start: 0, text: '' });

  return rows.map((row) => {
    const end = row.start + row.text.length;
    if (cursorAbs >= row.start && cursorAbs < end) {
      const col = cursorAbs - row.start;
      return row.text.slice(0, col) + inverse(row.text[col] ?? ' ') + row.text.slice(col + 1);
    }
    // Cursor at end of input, or at the end of a logical line (sitting on the newline): show it here.
    if (cursorAbs === end && (cursorAbs === full.length || full[cursorAbs] === '\n')) {
      return `${row.text}${inverse(' ')}`;
    }
    return row.text;
  });
}

function renderPromptComposer(width: number, activePrompt: string, promptError?: string, footerMessage?: string, cursor?: number): string[] {
  const contentWidth = width - 4;
  const innerWidth = Math.max(8, contentWidth - 2); // leading "  " indent
  const lines: string[] = [`┌${'─'.repeat(contentWidth)}┐`];
  if (activePrompt) {
    const cur = cursor === undefined ? activePrompt.length : Math.max(0, Math.min(cursor, activePrompt.length));
    // Leave one cell for a trailing cursor block so it never overflows the box.
    for (const row of editableRows('Prompt: ', activePrompt, innerWidth - 1, cur)) lines.push(pad(`  ${row}`, contentWidth));
  } else {
    lines.push(pad(`  ${dim('Type to chat · / for commands · \\ then Enter = newline')}`, contentWidth));
  }
  lines.push(`└${'─'.repeat(contentWidth)}┘`);
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
      leftW, midW, rightW
    ),
    ...renderActionsFooter({ runs: [], selected: undefined, timeline: [], verdicts: [], artifacts: { plan: [], diff: [], review: [], summary: [] } }),
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
    leftW, midW, rightW
  ));

  // Decision summary (compact)
  lines.push(...decisionSummaryLines(state).map(l => `  ${l}`));
  lines.push('');

  // Actions footer
  lines.push(...renderActionsFooter(state));

  // Prompt composer
  lines.push(...renderPromptComposer(totalWidth, activePrompt));

  return lines.map(stripAnsi).join('\n');
}

// ─── Interactive VisualCockpit ───

export interface ConversationEntry {
  author: string;   // 'you', 'claude', 'codex', 'xdou', 'system', …
  text: string;
  mine?: boolean;   // true for lines the operator typed
}

export interface CockpitCommandResult {
  output: string;
  author: string;   // who produced the output, for per-author coloring in the OUTPUT panel
  state: CockpitState;
}

// One roster agent shown in (and toggled from) the AGENTS panel.
export interface CockpitRosterAgent { id: string; roles: string[] }

export interface CockpitController {
  // Run a quick/conversational command without leaving the dashboard. The returned text is shown
  // in the OUTPUT panel and the returned state refreshes the dashboard in place. `history` (recent
  // verbatim turns) + `summary` (compacted older turns) give the assistant bounded session context.
  runInline(command: CockpitOperatorCommand, opts: { history: ConversationEntry[]; summary: string }): Promise<CockpitCommandResult>;
  // Run a long mission/fix that needs the full terminal (streams output, may prompt the operator).
  // The cockpit leaves the alternate screen before calling this and re-enters afterwards.
  // `disabledAgents` are excluded from the multi-agent team for this run.
  runSuspended(command: CockpitOperatorCommand, opts: { disabledAgents: string[] }): Promise<CockpitCommandResult>;
  // Compress the conversation into a compact summary (context compaction).
  summarize(opts: { priorSummary: string; turns: ConversationEntry[] }): Promise<{ summary: string }>;
  // List saved chat sessions for the in-cockpit /sessions browser.
  listSessions(): Promise<CockpitSessionSummary[]>;
  // Load a saved session and re-point persistence at it. Returns its conversation, or undefined if
  // no such session exists. After this resolves, future persists write to the resumed session.
  resumeSession(id: string): Promise<CockpitResumeResult | undefined>;
}

export interface CockpitSessionSummary { id: string; updatedAt: string; messages: number; last: string }
export interface CockpitResumeResult { id: string; entries: ConversationEntry[]; summary: string; summarizedCount: number }

export interface CockpitPersistSnapshot {
  entries: ConversationEntry[];
  summary: string;
  summarizedCount: number;
}

export interface CockpitLaunchOptions {
  sessionId?: string;
  history?: ConversationEntry[];
  summary?: string;
  summarizedCount?: number;
  onPersist?: (snapshot: CockpitPersistSnapshot) => void; // persist after each conversation change
  roster?: CockpitRosterAgent[];                          // agents that can be toggled on/off
  cwd?: string;                                           // working directory shown in the header
  branch?: string | undefined;                            // current git branch, or undefined if no repo
}

// Distinct, stable color per author so it's obvious at a glance who wrote what in the OUTPUT panel.
function authorStyle(author: string): (s: string) => string {
  const a = author.toLowerCase();
  if (a === 'you' || a === 'human' || a === 'operator') return cyan;
  if (a.includes('claude')) return magenta;
  if (a.includes('codex')) return green;
  if (a.includes('gpt') || a.includes('openai') || a.includes('openrouter') || a.includes('opencode')) return yellow;
  if (a === 'system' || a.includes('xdou')) return blue;
  return bold;
}

// Commands that drive the agent pipeline (vs. quick chat/tool replies). They run inline behind the
// spinner — they can be slow, but agents use piped stdio so the dashboard never needs to be dropped.
function isMissionCommand(command: CockpitOperatorCommand): boolean {
  return command.action === 'plan' || command.action === 'run' || command.action === 'fix' || command.action === 'parallel';
}

// True when the operator explicitly asked for a mission (typed /plan, /run, /code, …). Plain prose
// that merely *looks* like a mission is not explicit, so we confirm before launching agents.
function isExplicitMissionCommand(input: string): boolean {
  const verb = input.trim().replace(/^[:/]/, '').split(/\s+/)[0]?.toLowerCase();
  return ['plan', 'p', 'run', 'code', 'c', 'parallel', 'fork'].includes(verb ?? '');
}

function describeCommand(command: CockpitOperatorCommand): string {
  if (command.action === 'plan') return `plan: ${command.mission}`;
  if (command.action === 'run') return `mission: ${command.mission}`;
  if (command.action === 'parallel') return `parallel: ${command.mission}`;
  return command.action;
}

// Word-wrap plain (ANSI-free) conversation text to a column width so the OUTPUT panel never
// emits a line wider than its box — which would wrap and scroll the whole TUI.
function wrapPlain(text: string, width: number): string[] {
  if (width <= 1) return text.split(/\r?\n/);
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    if (line === '') { out.push(''); continue; }
    // Measure by visible width and break on code-point boundaries so wide chars (CJK) and emoji
    // (surrogate pairs) don't overflow the column or get split mid-character.
    while (visibleWidth(line) > width) {
      const chars = [...line];
      let acc = '';
      for (const ch of chars) {
        if (visibleWidth(acc + ch) > width) break;
        acc += ch;
      }
      if (!acc) acc = chars[0] ?? line; // never make zero progress
      const lastSpace = acc.lastIndexOf(' ');
      if (lastSpace > Math.floor(acc.length * 0.5)) {
        out.push(acc.slice(0, lastSpace));
        line = line.slice(lastSpace + 1);
      } else {
        out.push(acc);
        line = line.slice(acc.length);
      }
    }
    out.push(line);
  }
  return out;
}

// Apply inline Markdown styling to a single (already width-wrapped) line.
function styleMarkdownInline(line: string): string {
  return line
    .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => bold(t))
    .replace(/__([^_]+)__/g, (_, t: string) => bold(t))
    .replace(/`([^`]+)`/g, (_, t: string) => yellow(t))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, u: string) => `${underline(t)} ${dim(`(${u})`)}`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, (_, pre: string, t: string) => `${pre}${italic(t)}`);
}

// Render Markdown to width-wrapped, ANSI-styled lines for the OUTPUT panel. Block markers (headings,
// bullets, quotes, fenced code) are handled per line; inline markers are applied after wrapping so a
// long line never overflows the panel width.
export function renderMarkdownLines(text: string, width: number): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; } // skip fence markers
    if (inCode) { for (const l of wrapPlain(raw, width)) out.push(green(l)); continue; }
    const heading = raw.match(/^\s*(#{1,6})\s+(.*)$/);
    const bullet = raw.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = raw.match(/^\s*(\d+)\.\s+(.*)$/);
    const quote = raw.match(/^\s*>\s?(.*)$/);
    let bodyText = raw;
    let prefix = '';
    let wrap: (s: string) => string = (s) => s;
    if (heading) { bodyText = heading[2] ?? ''; wrap = (s) => bold(cyan(s)); }
    else if (bullet) { bodyText = bullet[1] ?? ''; prefix = '• '; }
    else if (numbered) { bodyText = numbered[2] ?? ''; prefix = `${numbered[1]}. `; }
    else if (quote) { bodyText = quote[1] ?? ''; wrap = (s) => dim(s); }
    const wrapped = wrapPlain(prefix + bodyText, width);
    if (!wrapped.length) out.push('');
    for (const w of wrapped) out.push(wrap(styleMarkdownInline(w)));
  }
  return out;
}

function renderOutputPanel(entries: ConversationEntry[], width: number, height: number, scroll: number, busyLabel: string): string[] {
  const contentWidth = width - 4;
  const innerWidth = Math.max(8, contentWidth - 2);
  const bodyH = Math.max(1, height - 2);

  const display: string[] = [];
  for (const entry of entries) {
    const color = entry.mine ? cyan : authorStyle(entry.author);
    const isSystem = !entry.mine && entry.author === 'system';
    // xdou tool output (diff/status/find/…) is preformatted — Markdown rendering would mangle a patch
    // (turning `-`/`#` lines into bullets/headings). Only real agent chat replies are Markdown.
    const isTool = !entry.mine && entry.author === 'xdou';
    // Colored author label + a colored gutter bar down the message so each speaker is scannable.
    display.push(`  ${color(bold(entry.mine ? `› ${entry.author}` : entry.author))}`);
    const bodyLines = entry.mine || isSystem || isTool
      ? wrapPlain(entry.text, innerWidth - 2).map((l) => (isSystem ? dim(l) : l))
      : renderMarkdownLines(entry.text, innerWidth - 2);
    for (const l of bodyLines) display.push(`  ${color('│')} ${l}`);
    display.push('');
  }
  if (busyLabel) display.push(`  ${yellow(busyLabel)}`);
  if (!display.length) display.push(`  ${dim('Type a prompt below — replies appear here.')}`);

  const total = display.length;
  const maxScroll = Math.max(0, total - bodyH);
  const clamped = Math.min(Math.max(0, scroll), maxScroll);
  const start = Math.max(0, total - bodyH - clamped);
  const windowLines = display.slice(start, start + bodyH);
  while (windowLines.length < bodyH) windowLines.push('');

  const title = busyLabel
    ? ` OUTPUT · ${busyLabel} `
    : maxScroll > 0 ? ` OUTPUT · ↑↓/PgUp/PgDn (${maxScroll - clamped} above) ` : ' OUTPUT ';
  const fill = Math.max(0, contentWidth - 1 - visibleWidth(title));
  return [
    `┌─${title}${'─'.repeat(fill)}┐`,
    ...windowLines.map((l) => pad(l, contentWidth)),
    `└${'─'.repeat(contentWidth)}┘`,
  ];
}

// Split one stdin read into individual key tokens. A single read can carry several keypresses —
// most commonly when an arrow key autorepeats (held down) and the terminal coalesces the escape
// sequences into one chunk. Each escape sequence (\x1b[… / \x1bO…) becomes its own token; runs of
// non-escape bytes (typed text) stay together.
function splitKeyTokens(data: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === '\x1b') {
      let j = i + 1;
      if (data[j] === '[' || data[j] === 'O') {
        j += 1;
        while (j < data.length && !/[A-Za-z~]/.test(data[j] ?? '')) j += 1;
        j += 1; // include the final byte of the sequence
      }
      tokens.push(data.slice(i, j));
      i = j;
    } else {
      let j = i;
      while (j < data.length && data[j] !== '\x1b') j += 1;
      tokens.push(data.slice(i, j));
      i = j;
    }
  }
  return tokens.length ? tokens : [data];
}

class VisualCockpit {
  private prompt = '';
  private cursor = 0; // insertion point within `prompt`
  private promptError = '';
  private footerMessage = '';
  private busy = false;
  private busyStart = 0;
  private spinnerTick = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private scroll = 0;
  private menuIndex = 0; // highlighted row in the slash-command palette
  private done = false;
  private pendingMission: { command: CockpitOperatorCommand; text: string } | undefined; // awaiting y/N confirmation
  private state: CockpitState;
  private readonly conversation: ConversationEntry[];
  private summary: string;            // rolling summary of older turns
  private summarizedCount: number;    // leading entries folded into `summary`
  private readonly disabledAgents = new Set<string>(); // roster agents the operator has turned off
  private readonly roster: CockpitRosterAgent[];
  private sessionId: string | undefined; // mutable: /resume switches the active session live
  private readonly cwd: string;
  private readonly branch: string | undefined;
  private readonly onPersist: ((snapshot: CockpitPersistSnapshot) => void) | undefined;
  private readonly stdin = process.stdin;
  private readonly stdout = process.stdout;
  private readonly inputHandler = (data: string): void => { void this.handleInput(data); };
  private readonly resizeHandler = (): void => this.renderToTerminal();
  private wasRaw = false;

  constructor(initialState: CockpitState, private readonly controller: CockpitController, private readonly onExit: () => void, options: CockpitLaunchOptions = {}) {
    this.state = initialState;
    this.conversation = options.history ? [...options.history] : [];
    this.summary = options.summary ?? '';
    this.summarizedCount = Math.min(options.summarizedCount ?? 0, this.conversation.length);
    // Invariant: a non-empty summary must cover some history. If a stale/odd session has a summary
    // with summarizedCount 0, treat the loaded history as already covered so it isn't double-sent.
    if (this.summary && this.summarizedCount === 0) this.summarizedCount = this.conversation.length;
    this.roster = options.roster ?? [];
    this.sessionId = options.sessionId;
    this.cwd = options.cwd ?? process.cwd();
    this.branch = options.branch;
    this.onPersist = options.onPersist;
  }

  private persist(): void {
    this.onPersist?.({ entries: this.conversation, summary: this.summary, summarizedCount: this.summarizedCount });
  }

  // An animated spinner with an elapsed-seconds counter, re-rendered on a timer so a long agent call
  // visibly progresses instead of looking frozen. Only used for in-cockpit (non-suspended) work.
  private startSpinner(): void {
    this.busy = true;
    this.busyStart = Date.now();
    this.spinnerTick = 0;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = setInterval(() => { this.spinnerTick += 1; this.renderToTerminal(); }, 250);
    this.renderToTerminal();
  }

  private stopSpinner(): void {
    this.busy = false;
    if (this.spinnerTimer) { clearInterval(this.spinnerTimer); this.spinnerTimer = undefined; }
  }

  private busyLabel(): string {
    if (!this.busy) return '';
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const elapsed = this.busyStart ? Math.floor((Date.now() - this.busyStart) / 1000) : 0;
    return `${frames[this.spinnerTick % frames.length] ?? '⠿'} working… ${elapsed}s`;
  }

  // Append a conversation entry and persist the session (for resume).
  private push(entry: ConversationEntry): void {
    this.conversation.push(entry);
    this.persist();
  }

  // Verbatim turns not yet folded into the summary (excluding the just-typed current line at index -1).
  private contextTurns(): ConversationEntry[] {
    return this.conversation.slice(this.summarizedCount, Math.max(this.summarizedCount, this.conversation.length - 1));
  }

  private contextChars(): number {
    // Use the same per-turn sizing as capHistory so auto-summarize triggers before the cap would
    // silently drop the oldest turns.
    return turnChars(this.contextTurns());
  }

  start(): void {
    this.wasRaw = Boolean(this.stdin.isRaw);
    if (this.stdin.setRawMode) this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.resume();
    this.stdin.on('data', this.inputHandler);
    this.stdout.on('resize', this.resizeHandler);
    // Enter alternate screen buffer + hide cursor
    this.stdout.write('\x1b[?1049h\x1b[?25l');
    this.renderToTerminal();
  }

  private async handleInput(data: string): Promise<void> {
    const unwrapped = parseCockpitInputChunk(data);
    // Bracketed paste arrives as one block — insert it as a single token. Otherwise split the read
    // into individual keys so coalesced/held arrows are each handled.
    const tokens = unwrapped !== data ? [unwrapped] : splitKeyTokens(data);
    for (const token of tokens) await this.handleKey(token);
  }

  private async handleKey(chunk: string): Promise<void> {
    if (matchesKey(chunk, 'ctrl+c')) { this.shutdown(); return; }
    if (this.busy) return; // ignore keystrokes while a command is running
    if (this.pendingMission) { await this.resolvePendingMission(chunk); return; } // waiting on y/N confirm

    // Slash-command palette: while it's open, ↑/↓ move the selection, Tab completes, Enter runs the
    // highlighted command, and Esc closes it. Other keys fall through to normal editing (re-filtering).
    const menu = this.menuItems();
    if (menu.length) {
      this.menuIndex = Math.max(0, Math.min(this.menuIndex, menu.length - 1));
      if (chunk === '\x1b[A' || chunk === '\x1bOA') { this.menuIndex = (this.menuIndex - 1 + menu.length) % menu.length; this.renderToTerminal(); return; }
      if (chunk === '\x1b[B' || chunk === '\x1bOB') { this.menuIndex = (this.menuIndex + 1) % menu.length; this.renderToTerminal(); return; }
      if (chunk === '\t') { const item = menu[this.menuIndex]; if (item) this.completeMenu(item); return; }
      if (matchesKey(chunk, 'enter') || chunk === '\r' || chunk === '\n') { const item = menu[this.menuIndex]; if (item) await this.acceptMenu(item); return; }
      if (matchesKey(chunk, 'escape')) { this.prompt = ''; this.cursor = 0; this.menuIndex = 0; this.renderToTerminal(); return; }
    }

    // PgUp/PgDn scroll the OUTPUT panel. (Arrow/page escapes contain \x1b so they never match the
    // printable-character test used for prompt typing.)
    if (chunk === '\x1b[5~') { this.scroll += 5; this.renderToTerminal(); return; }
    if (chunk === '\x1b[6~') { this.scroll = Math.max(0, this.scroll - 5); this.renderToTerminal(); return; }

    // The input line is always focused: arrows/Home/End/Delete edit it. Accept both CSI (\x1b[) and
    // application-cursor SS3 (\x1bO) encodings.
    if (chunk === '\x1b[D' || chunk === '\x1bOD') { this.cursor = Math.max(0, this.cursor - 1); this.renderToTerminal(); return; } // left
    if (chunk === '\x1b[C' || chunk === '\x1bOC') { this.cursor = Math.min(this.prompt.length, this.cursor + 1); this.renderToTerminal(); return; } // right
    if (chunk === '\x1b[A' || chunk === '\x1bOA') { this.onArrowVertical(-1); this.renderToTerminal(); return; } // up
    if (chunk === '\x1b[B' || chunk === '\x1bOB') { this.onArrowVertical(1); this.renderToTerminal(); return; } // down
    if (chunk === '\x1b[H' || chunk === '\x1bOH' || chunk === '\x1b[1~' || chunk === '\x1b[7~') { this.cursor = this.lineBounds().start; this.renderToTerminal(); return; } // home
    if (chunk === '\x1b[F' || chunk === '\x1bOF' || chunk === '\x1b[4~' || chunk === '\x1b[8~') { this.cursor = this.lineBounds().end; this.renderToTerminal(); return; } // end
    if (chunk === '\x1b[3~') { // delete (forward)
      if (this.cursor < this.prompt.length) this.prompt = this.prompt.slice(0, this.cursor) + this.prompt.slice(this.cursor + 1);
      this.renderToTerminal();
      return;
    }
    if (matchesKey(chunk, 'escape')) { this.prompt = ''; this.cursor = 0; this.promptError = ''; this.renderToTerminal(); return; } // clear the line

    await this.handlePromptInput(chunk);
  }

  // Up/Down move the cursor between input lines, or scroll the OUTPUT panel once the cursor is at the
  // input's top/bottom edge (so a single-line chat box still scrolls the transcript naturally).
  private onArrowVertical(direction: -1 | 1): void {
    const { start, end } = this.lineBounds();
    if (direction < 0 && start === 0) { this.scroll += 1; return; }
    if (direction > 0 && end === this.prompt.length) { this.scroll = Math.max(0, this.scroll - 1); return; }
    this.moveCursorVertical(direction);
  }

  // Bounds (in `prompt` indices) of the logical line the cursor currently sits on.
  private lineBounds(): { start: number; end: number } {
    const start = this.prompt.lastIndexOf('\n', this.cursor - 1) + 1;
    const nextNl = this.prompt.indexOf('\n', this.cursor);
    return { start, end: nextNl === -1 ? this.prompt.length : nextNl };
  }

  // Move the cursor up/down across logical (\n-separated) lines, preserving the column where possible.
  private moveCursorVertical(direction: -1 | 1): void {
    const { start, end } = this.lineBounds();
    const col = this.cursor - start;
    if (direction < 0) {
      if (start === 0) { this.cursor = 0; return; }
      const prevStart = this.prompt.lastIndexOf('\n', start - 2) + 1;
      const prevLen = start - 1 - prevStart;
      this.cursor = prevStart + Math.min(col, prevLen);
    } else {
      if (end === this.prompt.length) { this.cursor = this.prompt.length; return; }
      const nextStart = end + 1;
      const nextNl = this.prompt.indexOf('\n', nextStart);
      const nextLen = (nextNl === -1 ? this.prompt.length : nextNl) - nextStart;
      this.cursor = nextStart + Math.min(col, nextLen);
    }
  }

  private async handlePromptInput(chunk: string): Promise<void> {
    this.promptError = '';
    if (matchesKey(chunk, 'enter') || chunk === '\r' || chunk === '\n') {
      // A backslash immediately before the cursor is a continuation: replace it with a newline and
      // keep composing instead of submitting.
      if (this.cursor > 0 && this.prompt[this.cursor - 1] === '\\') {
        this.prompt = `${this.prompt.slice(0, this.cursor - 1)}\n${this.prompt.slice(this.cursor)}`;
        this.renderToTerminal();
        return;
      }
      await this.submitPrompt();
      return;
    }
    if (matchesKey(chunk, 'backspace') || chunk === '\x7f' || chunk === '\b') {
      if (this.cursor > 0) {
        this.prompt = this.prompt.slice(0, this.cursor - 1) + this.prompt.slice(this.cursor);
        this.cursor -= 1;
      }
      this.menuIndex = 0;
    } else if (/^[\x20-\x7E]+$/.test(chunk)) {
      this.prompt = this.prompt.slice(0, this.cursor) + chunk + this.prompt.slice(this.cursor);
      this.cursor += chunk.length;
      this.menuIndex = 0; // editing the command token re-filters the palette from the top
    }
    this.renderToTerminal();
  }

  // Run whatever is in the prompt: context compaction, a cockpit-local command, or an operator
  // command dispatched to the controller. Shared by Enter and the slash-menu accept path.
  private async submitPrompt(): Promise<void> {
    const text = this.prompt.trim();
    if (!text) { this.renderToTerminal(); return; }
    // Manual context compaction (async, needs the assistant agent).
    const lc = text.replace(/^\//, '').toLowerCase();
    if (lc === 'summarize' || lc === 'compact') {
      this.prompt = '';
      this.cursor = 0;
      this.push({ author: 'you', text, mine: true });
      this.startSpinner();
      try { await this.runSummary(false); } finally { this.stopSpinner(); this.renderToTerminal(); }
      return;
    }
    // Session browsing/switching (async, needs the controller's store access).
    const normalized = text.replace(/^\//, '');
    const [verb, ...restWords] = normalized.split(/\s+/);
    const lowerVerb = (verb ?? '').toLowerCase();
    if (lowerVerb === 'sessions' || lowerVerb === 'resume') {
      this.prompt = '';
      this.cursor = 0;
      this.push({ author: 'you', text, mine: true });
      if (lowerVerb === 'sessions') await this.showSessions();
      else await this.resumeSessionById(restWords.join(' ').trim());
      this.renderToTerminal();
      return;
    }
    // Cockpit-local commands (agent toggles, context, help) handled here without touching the controller.
    if (this.tryLocalCommand(text)) { this.prompt = ''; this.cursor = 0; this.renderToTerminal(); return; }
    const command = parseCockpitOperatorCommand(text);
    if (!command) { this.promptError = 'Type /plan <idea>, /code <idea>, /ask question, /continue, or /parallel <idea>'; this.renderToTerminal(); return; }
    this.prompt = '';
    this.cursor = 0;
    this.push({ author: 'you', text, mine: true });
    // Plain prose that only *looks* like a coding mission: confirm before launching agents.
    if ((command.action === 'run' || command.action === 'plan') && !isExplicitMissionCommand(text)) {
      this.pendingMission = { command, text };
      this.push({ author: 'system', text: `This looks like a coding mission: "${command.mission}". Press y to run the agents, or any other key to send it as a chat question instead.` });
      this.renderToTerminal();
      return;
    }
    await this.dispatch(command);
  }

  // /sessions — list saved chat sessions in the OUTPUT panel so the operator can resume without
  // leaving the cockpit.
  private async showSessions(): Promise<void> {
    try {
      const sessions = await this.controller.listSessions();
      if (!sessions.length) { this.push({ author: 'system', text: 'No saved sessions yet.' }); return; }
      const lines = sessions.map((s) => {
        const here = s.id === this.sessionId ? ' (current)' : '';
        const last = s.last.replace(/\s+/g, ' ').slice(0, 48);
        return `${s.id}${here}  ·  ${s.messages} msg  ·  ${last}`;
      });
      this.push({ author: 'system', text: ['Saved sessions — switch with /resume <id>:', ...lines].join('\n') });
    } catch (error) {
      this.push({ author: 'system', text: `Could not list sessions: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // /resume <id> — swap the running cockpit onto another saved session: load its transcript/summary
  // and re-point persistence at it (handled controller-side), no restart needed.
  private async resumeSessionById(id: string): Promise<void> {
    if (!id) { this.push({ author: 'system', text: 'Usage: /resume <session-id> — see /sessions for ids.' }); return; }
    if (id === this.sessionId) { this.push({ author: 'system', text: `Already in session ${id}.` }); return; }
    try {
      const resumed = await this.controller.resumeSession(id);
      if (!resumed) { this.push({ author: 'system', text: `Session "${id}" not found. See /sessions.` }); return; }
      this.conversation.length = 0;
      this.conversation.push(...resumed.entries);
      this.summary = resumed.summary;
      this.summarizedCount = Math.min(resumed.summarizedCount, this.conversation.length);
      this.sessionId = resumed.id;
      this.scroll = 0;
      // Persisted to the now-active session; the title bar updates to show the new id.
      this.push({ author: 'system', text: `Resumed session ${resumed.id} — ${resumed.entries.length} earlier message(s) loaded.` });
    } catch (error) {
      this.push({ author: 'system', text: `Could not resume "${id}": ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // Resolve a confirmation for an auto-detected coding mission: 'y' runs the agents, anything else
  // re-routes the original text to chat (/ask) instead.
  private async resolvePendingMission(chunk: string): Promise<void> {
    const pending = this.pendingMission;
    this.pendingMission = undefined;
    if (!pending) return;
    if (chunk === 'y' || chunk === 'Y') {
      await this.dispatch(pending.command);
    } else {
      this.push({ author: 'system', text: 'Sending it as a chat question instead.' });
      await this.dispatch({ action: 'ask', prompt: pending.text });
    }
  }

  // The slash palette is active while the operator is typing the command token: prompt starts with
  // "/", has no space yet, and at least one command matches. Once a space (args) is typed, it closes.
  private menuItems(): SlashCommand[] {
    if (!this.prompt.startsWith('/') || /\s/.test(this.prompt)) return [];
    return filterSlashCommands(this.prompt.slice(1));
  }

  private completeMenu(cmd: SlashCommand): void { // Tab: fill "/name " and keep composing
    this.prompt = `/${cmd.name} `;
    this.cursor = this.prompt.length;
    this.renderToTerminal();
  }

  // Enter on a palette item: required-arg commands tee up "/name " and wait; others run immediately.
  private async acceptMenu(cmd: SlashCommand): Promise<void> {
    if (cmd.arg === 'required') { this.prompt = `/${cmd.name} `; this.cursor = this.prompt.length; this.menuIndex = 0; this.renderToTerminal(); return; }
    this.prompt = `/${cmd.name}`;
    this.cursor = this.prompt.length;
    await this.submitPrompt();
  }

  // Agent enable/disable + help, handled entirely inside the cockpit. Returns true if it consumed
  // the input.
  private tryLocalCommand(text: string): boolean {
    const normalized = text.replace(/^\//, '').trim();
    const [verb, ...rest] = normalized.split(/\s+/);
    const arg = rest.join(' ').trim();
    const lower = (verb ?? '').toLowerCase();
    if (lower === 'agents') {
      this.push({ author: 'you', text, mine: true });
      const lines = this.roster.length
        ? this.roster.map((a) => `${this.disabledAgents.has(a.id) ? '[ ]' : '[x]'} ${a.id}  (${a.roles.join(', ') || 'agent'})`)
        : ['(no roster configured)'];
      this.push({ author: 'system', text: ['Agents (/enable <id>, /disable <id> to toggle):', ...lines].join('\n') });
      return true;
    }
    if (lower === 'enable' || lower === 'disable') {
      this.push({ author: 'you', text, mine: true });
      if (!arg) { this.push({ author: 'system', text: `Usage: /${lower} <agent-id>` }); return true; }
      const known = this.roster.some((a) => a.id === arg);
      if (!known) { this.push({ author: 'system', text: `Unknown agent "${arg}". Known: ${this.roster.map((a) => a.id).join(', ') || '(none)'}` }); return true; }
      if (lower === 'disable') this.disabledAgents.add(arg); else this.disabledAgents.delete(arg);
      this.push({ author: 'system', text: `${arg} is now ${this.disabledAgents.has(arg) ? 'disabled' : 'enabled'}.` });
      return true;
    }
    if (lower === 'clear' || lower === 'reset') {
      this.push({ author: 'you', text, mine: true });
      this.summary = '';
      this.summarizedCount = this.conversation.length;
      this.persist();
      this.push({ author: 'system', text: 'Context cleared — agents start fresh from here. Earlier messages stay visible but are no longer sent.' });
      return true;
    }
    if (lower === 'context') {
      this.push({ author: 'you', text, mine: true });
      const lines = [
        `Context: ${this.contextTurns().length} recent turn(s), ~${this.contextChars()} chars (cap ~${CONTEXT_CHAR_BUDGET}, auto-summarize > ${AUTO_SUMMARIZE_CHARS}).`,
        this.summary ? `Summary: ${this.summary.length} chars covering ${this.summarizedCount} earlier message(s).` : 'No summary yet.',
        'Manage with: /summarize (compact now) · /clear (drop context).',
      ];
      this.push({ author: 'system', text: lines.join('\n') });
      return true;
    }
    return false;
  }

  // Compress unsummarized turns into the rolling summary via the assistant. `auto` runs silently
  // inside a chat dispatch; manual runs (/summarize) report success/failure.
  private async runSummary(auto: boolean): Promise<void> {
    const boundary = Math.max(this.summarizedCount, this.conversation.length - 1); // exclude the current line
    const turns = this.conversation.slice(this.summarizedCount, boundary).filter((entry) => entry.author !== 'system' && entry.text.trim());
    if (!turns.length) { if (!auto) this.push({ author: 'system', text: 'Nothing to summarize yet.' }); return; }
    try {
      const { summary } = await this.controller.summarize({ priorSummary: this.summary, turns });
      if (summary.trim()) {
        this.summary = summary.trim();
        this.summarizedCount = boundary;
        this.persist();
        this.push({ author: 'system', text: `${auto ? 'Auto-summarized' : 'Summarized'} ${turns.length} earlier message(s) — context compacted.` });
      } else if (!auto) {
        this.push({ author: 'system', text: 'Summary came back empty; keeping full context.' });
      }
    } catch (error) {
      if (!auto) this.push({ author: 'system', text: `Summarize failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  // Run a command without ever leaving the cockpit: in-panel commands render their reply into the
  // OUTPUT panel; suspending commands (missions/fix) temporarily drop the alt screen so they can
  // stream output and prompt, then the dashboard re-renders in place with refreshed state.
  private async dispatch(command: CockpitOperatorCommand): Promise<void> {
    this.footerMessage = '';
    this.scroll = 0;
    this.startSpinner();
    try {
      if (isMissionCommand(command)) {
        // Missions can take minutes, but agents always run with piped (non-TTY) stdio — nothing needs
        // the terminal. So we run them INLINE behind the live spinner instead of dropping the alt
        // screen: the dashboard stays visible and responsive, and the result lands in the OUTPUT panel.
        this.push({ author: 'system', text: `Running ${describeCommand(command)} — agents are working; this can take a while. Output appears here when done.` });
        const result = await this.controller.runSuspended(command, { disabledAgents: [...this.disabledAgents] });
        this.state = result.state;
        this.push({ author: 'xdou', text: result.output.trim() || `${describeCommand(command)} complete — see artifacts.` });
      } else {
        // Auto-compact: fold older turns into the summary before a chat call if the verbatim context
        // has grown past the threshold, so the assistant prompt stays bounded.
        if ((command.action === 'ask' || command.action === 'web') && this.contextChars() > AUTO_SUMMARIZE_CHARS) {
          await this.runSummary(true);
        }
        // Pass the (post-summary) recent turns + rolling summary so the assistant has bounded memory.
        const result = await this.controller.runInline(command, { history: this.contextTurns(), summary: this.summary });
        this.state = result.state;
        this.push({ author: result.author, text: result.output.trim() || '(no output)' });
      }
    } catch (error) {
      this.push({ author: 'system', text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.stopSpinner();
      this.scroll = 0;
      this.renderToTerminal();
    }
  }

  private renderFrame(width: number, height: number): string[] {
    const totalWidth = Math.max(100, width);
    const leftW = Math.max(28, Math.floor(totalWidth * 0.25));
    const midW = Math.max(42, Math.floor(totalWidth * 0.4));
    const rightW = totalWidth - leftW - midW - 4;

    const sessionTag = this.sessionId ? dim(` · session ${this.sessionId}`) : '';
    const title = bold('xdou cockpit') + ' ' + dim('· type to chat · / for commands · Ctrl+C quits') + sessionTag;
    const header = this.state.selected ? renderMissionHeader(this.state, totalWidth) : renderEmptyMissionHeader(totalWidth);
    // While the slash palette is open it replaces the action hints below the OUTPUT panel.
    const menu = this.menuItems();
    const footer = menu.length
      ? renderSlashMenu(menu, Math.max(0, Math.min(this.menuIndex, menu.length - 1)), totalWidth)
      : renderActionsFooter(this.state);
    const composer = renderPromptComposer(totalWidth, this.prompt, this.promptError, this.footerMessage, this.cursor);

    // Divide the remaining vertical space between the dashboard columns and the OUTPUT panel so the
    // whole frame fits one screenful (no wrap/scroll) regardless of terminal height.
    const fixed = 1 + 1 + header.length + footer.length + composer.length; // title + workspace bar + header + footer/menu + composer
    const body = Math.max(8, (height - 1) - fixed);
    // Favor the OUTPUT panel: the dashboard columns take a smaller, capped slice and the rest goes
    // to the conversation so longer replies are visible without scrolling.
    const colHeight = Math.max(6, Math.min(10, Math.floor(body * 0.38)));
    const outHeight = Math.max(6, body - colHeight);

    // When a roster is configured, the AGENTS panel shows toggle state; otherwise fall back to the
    // agents inferred from the run timeline.
    const agentsCol = this.roster.length
      ? renderRosterColumn(this.roster, this.disabledAgents, colHeight)
      : renderAgentsColumn(agentsFromState(this.state), leftW, colHeight);
    const workspace = renderWorkspaceBar(this.cwd, this.branch, this.contextChars(), this.contextTurns().length);
    return [
      title,
      workspace,
      ...header,
      ...threeColumn(
        agentsCol,
        renderTimelineColumn(this.state, midW, colHeight),
        renderArtifactsColumn(this.state, rightW, colHeight),
        leftW, midW, rightW,
      ),
      ...renderOutputPanel(this.conversation, totalWidth, outHeight, this.scroll, this.busyLabel()),
      ...footer,
      ...composer,
    ];
  }

  private renderToTerminal(): void {
    if (this.done) return; // stop painting once the cockpit has shut down
    const width = this.stdout.columns || Number(process.env.COLUMNS) || 120;
    const height = this.stdout.rows || Number(process.env.LINES) || 30;
    // Cap to height-1 ROWS and clamp every line to the terminal width. A line wider than the
    // terminal wraps onto extra physical rows, overflowing the height cap and forcing the terminal
    // to scroll — which makes `\x1b[H` miss the true top and stacks a fresh copy of the frame into
    // the scrollback on every render. Truncating keeps each frame exactly one screenful so the
    // home+clear overwrites in place.
    const lines = this.renderFrame(width, height)
      .slice(0, Math.max(1, height - 1))
      .map((line) => truncate(line, width - 1));
    // Move cursor to home and clear to end of screen (no full-screen clear flicker)
    this.stdout.write('\x1b[H\x1b[J' + lines.join('\r\n'));
  }

  private shutdown(): void {
    if (this.done) return;
    this.done = true;
    // Ctrl+C may land mid-mission. Kill any in-flight agent subprocesses so their promises settle and
    // the process can actually exit — otherwise node lingers in the background until agents finish.
    killInFlightAgents();
    this.stopSpinner(); // clear the render timer so the event loop can exit
    this.stdin.off('data', this.inputHandler);
    this.stdout.off('resize', this.resizeHandler);
    if (this.stdin.setRawMode) this.stdin.setRawMode(this.wasRaw);
    this.stdin.pause();
    // Exit alternate screen buffer + restore cursor
    this.stdout.write('\x1b[?1049l\x1b[?25h\r\n');
    this.onExit();
  }
}

export async function launchCockpit(state: CockpitState, controller: CockpitController, options: CockpitLaunchOptions = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    const app = new VisualCockpit(state, controller, resolve, options);
    app.start();
  });
}