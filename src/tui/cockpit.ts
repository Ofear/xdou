import fs from 'fs-extra';
import { join } from 'node:path';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import stripAnsi from 'strip-ansi';
import type { ArtifactStore } from '../core/artifact-store.js';
import { readCollaborationState, type CollaborationEvent, type CollaborationState } from '../core/live-collaboration.js';
import type { RunManifest } from '../types.js';

interface TimelineEvent { time: string | undefined; type: string | undefined; by: string | undefined; verdict: string | undefined; status: string | undefined; phase: string | undefined; ok: boolean | undefined }
interface ReviewVerdictSummary { agent: string; verdict: string; reason: string; confidence: number | undefined; missingRequirements: string[] }
interface ArtifactPreview { plan: string[]; diff: string[]; review: string[]; summary: string[] }
interface AgentCard { id: string; role: string; status: string; last: string }
export interface CockpitState { runs: RunManifest[]; selected: RunManifest | undefined; timeline: TimelineEvent[]; verdicts: ReviewVerdictSummary[]; artifacts: ArtifactPreview; collaboration?: CollaborationState }
export interface CockpitMissionCommand { action: 'plan' | 'run'; mission: string }
export type CockpitOperatorCommand = CockpitMissionCommand | { action: 'ask'; prompt: string } | { action: 'web'; query: string } | { action: 'find'; query: string } | { action: 'continue' } | { action: 'parallel'; mission: string } | { action: 'diff' | 'review' | 'status' | 'apply' | 'test' | 'fix' | 'discard' | 'undo'; runId?: string };
export type CockpitLaunchResult = { kind: 'exit' } | { kind: 'mission'; command: 'plan' | 'run'; mission: string } | { kind: 'operator'; command: CockpitOperatorCommand };

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

const actionBar = '[tab] pane  [enter] send  /ask /find /web /plan /code /test /fix /apply /undo  [v] diff [r] review [t] test [f] fix [a] apply [q] quit';
function actionBarLine(width: number): string { return dim(truncate(actionBar, Math.max(20, width))); }

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

function fmtEvent(event: TimelineEvent): string {
  const time = event.time ? event.time.slice(11, 19) : '--:--:--';
  const actor = event.by ? ` ${event.by}` : '';
  const verdict = event.verdict ? ` ${event.verdict}` : '';
  const ok = event.ok === undefined ? '' : event.ok ? ' ✓' : ' ✗';
  return `${time} ${event.type ?? 'event'}${actor}${verdict}${ok}`;
}

function truncate(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  return truncateToWidth(value, Math.max(0, width - 1)) + '…';
}

function pad(value: string, width: number): string {
  const clipped = truncate(value, width);
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function agentsFromState(state: CockpitState): AgentCard[] {
  const seen = new Map<string, AgentCard>();
  for (const event of state.timeline) {
    if (!event.by) continue;
    const prior = seen.get(event.by);
    seen.set(event.by, {
      id: event.by,
      role: event.by.includes('claude') ? 'architect / reviewer' : event.by.includes('codex') ? 'implementer / fixer' : 'agent',
      status: event.ok === false ? 'blocked' : event.type?.includes('finished') ? 'done' : event.type?.includes('started') ? 'working' : state.selected?.phase ?? 'active',
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
    out.push(yellow(name));
    out.push(...(lines.length ? lines : [dim('not created yet')]).slice(0, 5));
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
  if (!collab?.events.length) return ['Shared room: waiting for live agent notes and patch deltas'];
  const blockers = collab.blockers.slice(-3).map(collaborationEventLine);
  const warnings = collab.warnings.slice(-3).map(collaborationEventLine);
  const patches = collab.latestPatchDeltas.slice(-4).map(collaborationEventLine);
  return [
    `Shared room: ${collab.agents.length} agents, ${collab.events.length} events`,
    ...(blockers.length ? ['Blockers:', ...blockers] : []),
    ...(warnings.length ? ['Warnings:', ...warnings] : []),
    ...(patches.length ? ['Live patch deltas:', ...patches] : []),
  ].slice(0, 12);
}

function decisionSummaryLines(state: CockpitState): string[] {
  const selected = state.selected;
  if (!selected) return ['Status: ready for input', 'Next: /ask, /find, /web, /plan, /code'];
  const diffHeaderCount = state.artifacts.diff.filter((line) => line.startsWith('diff --git ')).length;
  const patchDeltaCount = new Set((state.collaboration?.latestPatchDeltas ?? []).map((event) => event.file).filter(Boolean)).size;
  const changedFiles = Math.max(diffHeaderCount, patchDeltaCount);
  const verdict = state.verdicts.find((item) => item.verdict.toLowerCase().includes('request')) ?? state.verdicts[0];
  const tests = [...state.timeline].reverse().find((event) => event.type === 'validation.finished');
  const next = selected.status === 'completed' && !selected.appliedAt ? '[a] apply, [t] rerun tests, or [v] inspect diff' : selected.status === 'blocked' ? '[f] fix blockers or [d] discard' : selected.appliedAt ? '[u] undo or continue' : selected.status === 'running' ? 'wait / refresh cockpit' : '/code or /plan next mission';
  return [
    `Status: ${selected.status}/${selected.phase}`,
    `Changed: ${changedFiles ? `${changedFiles} file(s)` : 'no diff yet'}`,
    `Tests: ${tests ? tests.ok ? 'passed' : 'failed' : 'waiting'}`,
    `Review: ${verdict ? `${verdict.agent} ${verdict.verdict}` : 'waiting'}`,
    `Risk: ${selected.status === 'completed' ? 'low after inspect' : selected.status === 'blocked' ? 'needs attention' : 'unknown'}`,
    `Next: ${next}`,
  ];
}

function promptComposerLines(width: number, activePrompt = ''): string[] {
  const shownPrompt = activePrompt ? `Prompt: ${activePrompt}█` : 'Prompt: /ask question | /find file | /web topic | /plan <idea> | /code <idea>';
  return panel('Prompt Composer', [
    shownPrompt,
    '/ask /find /web do not require Git. /code and /run will initialize Git in a project folder.',
  ], width, 4, true);
}

function emptyCockpitLines(width: number, activePrompt = ''): string[] {
  const totalWidth = Math.max(100, width);
  const leftWidth = Math.max(26, Math.floor(totalWidth * 0.24));
  const midWidth = Math.max(40, Math.floor(totalWidth * 0.42));
  const rightWidth = Math.max(34, totalWidth - leftWidth - midWidth);
  const tabs = ['[1] new mission idle', '[2] parallel task empty', '[3] npm publish blocked/auth'];
  const agents = [
    `${magenta('claude')} ${green('idle')}  architect/reviewer`,
    'next: plan, critique, review',
    '',
    `${magenta('codex')} ${green('idle')}   implementer/fixer`,
    'next: code, test, repair',
    '',
    `${magenta('tester')} ${dim('queued')} validation gates`,
  ];
  const timeline = [
    `${dim('--:--:--')} ${yellow('[ready]')} operator cockpit v2 online`,
    'Type /ask, /find, /web, /plan, /code, /continue, or /parallel below.',
    '',
    `${dim('--:--:--')} ${yellow('[workflow]')} plan → code → test → review → fix → done`,
    'Agent activity, decisions, and compact logs appear here.',
  ];
  const artifacts = [
    'Plan: not created',
    'Diff: 0 files',
    'Tests: waiting',
    'Review: waiting',
    'Summary: waiting',
    '',
    'Gate: waiting for operator prompt',
  ];
  return [
    `${bold('xdou visual cockpit')} ${dim('operator cockpit v2 for multi-agent co-development')}`,
    `${cyan('Stage')} idle  ${cyan('Status')} ready/no-run  ${cyan('Mission')} waiting for operator input`,
    'No action needed. Type a mission or command below.',
    ...panel('Mission Tabs', tabs, totalWidth, 4, false),
    ...hjoin([
      panel('Agents', agents, leftWidth, 12, false),
      panel('Live Work / Timeline', timeline, midWidth, 12, true),
      panel('Artifacts / Gates', artifacts, rightWidth, 12, false),
    ]),
    ...hjoin([
      panel('Current Focus', ['Waiting for operator intent.', 'Next: type /ask question, /find file, /web topic, /plan, or /code.'], Math.floor(totalWidth * 0.58), 5, false),
      panel('Operator Attention', ['No action needed. Type a mission or command below.'], totalWidth - Math.floor(totalWidth * 0.58), 5, false),
    ]),
    ...promptComposerLines(totalWidth, activePrompt),
    actionBarLine(totalWidth),
  ];
}

export function renderCockpitSnapshot(state: CockpitState, width = 100, activePrompt = ''): string {
  const selected = state.selected;
  if (!selected) return emptyCockpitLines(width, activePrompt).map(stripAnsi).join('\n');

  const totalWidth = Math.max(100, width);
  const leftWidth = Math.max(26, Math.floor(totalWidth * 0.24));
  const midWidth = Math.max(40, Math.floor(totalWidth * 0.42));
  const rightWidth = Math.max(34, totalWidth - leftWidth - midWidth);
  const runTabs = (state.runs.length ? state.runs : [selected]).slice(-3).map((run, index) => `${index + 1 === Math.min(3, state.runs.length || 1) ? '●' : '○'} ${run.id} ${run.status}/${run.phase}`);
  const agentContent = agentsFromState(state).flatMap((agent) => [`${agent.id} ${agent.status}`, agent.role, agent.last, '']);
  const timelineContent = [
    ...collaborationLines(state).map((line) => `[shared-room] ${line}`),
    '',
    ...(state.timeline.length ? state.timeline.slice(-8).map(fmtEvent) : ['--:--:-- waiting xdou']),
  ];
  const focus = [
    `Run: ${selected.id}`,
    `Mission: ${selected.mission}`,
    ...(selected.worktreePath ? [`Worktree: ${selected.worktreePath}`] : []),
    `Artifacts: ${selected.artifactDir}`,
  ];
  const attention = decisionSummaryLines(state);
  return [
    `${bold('xdou visual cockpit')} ${dim('operator cockpit v2 for multi-agent co-development')}`,
    `${cyan('Stage')} ${selected.phase}  ${cyan('Status')} ${selected.status}/${selected.phase}  ${cyan('Mission')} ${truncate(selected.mission, Math.max(10, totalWidth - 42))}`,
    selected.status === 'blocked' ? 'Action needed. Review blockers, fix, discard, or ask the agents.' : 'No action needed. Inspect, apply, test, continue, or type below.',
    ...panel('Mission Tabs', runTabs, totalWidth, 4, false),
    ...hjoin([
      panel('Agents', agentContent, leftWidth, 12, false),
      panel('Live Work / Timeline', timelineContent, midWidth, 12, true),
      panel('Artifacts / Gates', artifactLines(state), rightWidth, 12, false),
    ]),
    ...hjoin([
      panel('Current Focus', focus, Math.floor(totalWidth * 0.58), 7, false),
      panel('Operator Attention', attention, totalWidth - Math.floor(totalWidth * 0.58), 7, false),
    ]),
    ...promptComposerLines(totalWidth, activePrompt),
    actionBarLine(totalWidth),
  ].map(stripAnsi).join('\n');
}

function panel(title: string, content: string[], width: number, height: number, focused: boolean): string[] {
  const border = focused ? yellow : dim;
  const titleText = ` ${title} `;
  const top = border(`┌${titleText}${'─'.repeat(Math.max(0, width - visibleWidth(titleText) - 2))}┐`);
  const bottom = border(`└${'─'.repeat(Math.max(0, width - 2))}┘`);
  const bodyHeight = Math.max(0, height - 2);
  const body = Array.from({ length: bodyHeight }, (_, index) => `${border('│')}${pad(content[index] ?? '', width - 2)}${border('│')}`);
  return [top, ...body, bottom];
}

function hjoin(columns: string[][]): string[] {
  const height = Math.max(...columns.map((column) => column.length));
  return Array.from({ length: height }, (_, row) => columns.map((column) => column[row] ?? '').join(''));
}

class VisualCockpit {
  private focus = 1;
  private promptMode = true;
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
    this.stdout.write('\x1b[?25l');
    this.renderToTerminal();
  }

  private handleInput(data: string): void {
    const chunk = parseCockpitInputChunk(data);
    if (matchesKey(chunk, 'q') && !this.prompt) { this.shutdown(); return; }
    if (matchesKey(chunk, 'escape') || matchesKey(chunk, 'ctrl+c')) { this.prompt = ''; this.promptError = ''; this.renderToTerminal(); return; }
    if (matchesKey(chunk, 'tab')) { this.focus = (this.focus + 1) % 3; this.renderToTerminal(); return; }
    if (!this.prompt && matchesKey(chunk, 'a')) { this.commandSelectedRun('apply'); return; }
    if (!this.prompt && matchesKey(chunk, 'v')) { this.commandSelectedRun('diff'); return; }
    if (!this.prompt && matchesKey(chunk, 't')) { this.commandSelectedRun('test'); return; }
    if (!this.prompt && matchesKey(chunk, 'f')) { this.commandSelectedRun('fix'); return; }
    if (!this.prompt && matchesKey(chunk, 'u')) { this.commandSelectedRun('undo'); return; }
    if (!this.prompt && matchesKey(chunk, 'd')) { this.commandSelectedRun('discard'); return; }
    if (!this.prompt && matchesKey(chunk, 'p')) { this.prompt = '/plan '; this.renderToTerminal(); return; }
    if (!this.prompt && matchesKey(chunk, 'r')) { this.commandSelectedRun('review'); return; }
    if (!this.prompt && matchesKey(chunk, 'n')) { this.prompt = ''; this.footerMessage = 'Composer ready — type directly.'; this.renderToTerminal(); return; }
    this.handlePromptInput(chunk);
  }

  private handlePromptInput(data: string): void {
    const chunk = parseCockpitInputChunk(data);
    this.promptError = '';
    if (matchesKey(chunk, 'escape') || matchesKey(chunk, 'ctrl+c')) { this.prompt = ''; this.renderToTerminal(); return; }
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

  private openMissionPrompt(): void {
    this.promptMode = true;
    this.prompt = '';
    this.promptError = '';
    this.footerMessage = 'Prompt active — type plan/run/code text, Enter launches, Esc cancels.';
    this.renderToTerminal();
  }

  private showFooter(message: string): void {
    this.footerMessage = message;
    this.renderToTerminal();
  }

  private commandSelectedRun(action: 'apply' | 'diff' | 'review' | 'status' | 'test' | 'fix' | 'discard' | 'undo'): void {
    const runId = this.state.selected?.id;
    if (!runId) { this.showFooter('No run selected yet.'); return; }
    this.result = { kind: 'operator', command: { action, runId } };
    this.shutdown();
  }

  private renderLines(width: number): string[] {
    const selected = this.state.selected;
    if (!selected) {
      const lines = emptyCockpitLines(width, this.prompt);
      return this.promptError || this.footerMessage ? [...lines, this.promptError ? red(this.promptError) : dim(this.footerMessage)] : lines;
    }
    const totalWidth = Math.max(96, width);
    const leftWidth = Math.max(28, Math.floor(totalWidth * 0.25));
    const rightWidth = Math.max(36, Math.floor(totalWidth * 0.32));
    const midWidth = Math.max(38, totalWidth - leftWidth - rightWidth);
    const bodyHeight = 18;
    const agentContent = agentsFromState(this.state).flatMap((agent) => [
      `${magenta(agent.id)} ${agent.status === 'blocked' ? red(agent.status) : green(agent.status)}`,
      dim(agent.role),
      agent.last,
      '',
    ]);
    const transcript = [
      ...collaborationLines(this.state).map((line) => `${cyan('[shared-room]')} ${line}`),
      '',
      ...(this.state.timeline.length ? this.state.timeline : [{ type: 'waiting', by: 'xdou', time: undefined, verdict: undefined, status: undefined, phase: undefined, ok: undefined }]).slice(-10).flatMap((event) => [
        `${dim(event.time ? event.time.slice(11, 19) : '--:--:--')} ${yellow(`[${event.type ?? 'event'}]`)} ${cyan(event.by ?? 'system')}`,
        event.verdict ?? event.status ?? event.phase ?? (event.ok === undefined ? 'event recorded' : event.ok ? 'ok' : 'failed'),
        '',
      ]),
    ];

    return [
      `${bold('xdou visual cockpit')} ${dim('mission control for multi-agent co-development')}`,
      `${cyan('Run')} ${selected.id}  ${cyan('Status')} ${selected.status}/${selected.phase}  ${cyan('Mission')} ${truncate(selected.mission, totalWidth - 60)}`,
      ...hjoin([
        panel('Agents', agentContent, leftWidth, bodyHeight, this.focus === 0),
        panel('Live Council Transcript', transcript, midWidth, bodyHeight, this.focus === 1),
        panel('Current Artifact', artifactLines(this.state), rightWidth, bodyHeight, this.focus === 2),
      ]),
      ...panel('Decision Summary', decisionSummaryLines(this.state), totalWidth, 8, false),
      ...promptComposerLines(totalWidth, this.prompt),
      ...(this.promptError ? [red(this.promptError)] : []),
      ...(this.footerMessage ? [dim(this.footerMessage)] : []),
      actionBarLine(totalWidth),
    ];
  }

  private renderToTerminal(): void {
    const width = this.stdout.columns || Number(process.env.COLUMNS) || 120;
    const height = this.stdout.rows || Number(process.env.LINES) || 30;
    const lines = this.renderLines(width).slice(0, Math.max(1, height - 1));
    this.stdout.write(`\x1b[2J\x1b[H${lines.join('\r\n')}`);
  }

  private shutdown(): void {
    this.stdin.off('data', this.inputHandler);
    this.stdout.off('resize', this.resizeHandler);
    if (this.stdin.setRawMode) this.stdin.setRawMode(this.wasRaw);
    this.stdout.write('\x1b[?25h\r\n');
    this.onExit(this.result);
  }
}

export async function launchCockpit(state: CockpitState): Promise<CockpitLaunchResult> {
  return new Promise<CockpitLaunchResult>((resolve) => {
    const app = new VisualCockpit(state, resolve);
    app.start();
  });
}

