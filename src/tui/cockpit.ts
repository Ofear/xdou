import fs from 'fs-extra';
import { join } from 'node:path';
import { ProcessTerminal, TUI, matchesKey, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';
import stripAnsi from 'strip-ansi';
import type { ArtifactStore } from '../core/artifact-store.js';
import type { RunManifest } from '../types.js';

interface TimelineEvent { time: string | undefined; type: string | undefined; by: string | undefined; verdict: string | undefined; status: string | undefined; phase: string | undefined; ok: boolean | undefined }
interface ReviewVerdictSummary { agent: string; verdict: string; reason: string; confidence: number | undefined; missingRequirements: string[] }
interface ArtifactPreview { plan: string[]; diff: string[]; review: string[]; summary: string[] }
interface AgentCard { id: string; role: string; status: string; last: string }
export interface CockpitState { runs: RunManifest[]; selected: RunManifest | undefined; timeline: TimelineEvent[]; verdicts: ReviewVerdictSummary[]; artifacts: ArtifactPreview }

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
  return { runs, selected, timeline, verdicts, artifacts };
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

function rule(width: number): string { return '─'.repeat(width); }

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

export function renderCockpitSnapshot(state: CockpitState, width = 100): string {
  const selected = state.selected;
  if (!selected) return 'xdou cockpit\n\nNo runs found. Start with: xdou run "mission"\n';
  const verdictLines = state.verdicts.length
    ? state.verdicts.map((verdict) => `${verdict.agent}: ${verdict.verdict}${verdict.reason ? ` — ${verdict.reason}` : ''}`)
    : ['no structured review verdicts yet'];
  const timeline = state.timeline.slice(-8).map(fmtEvent);
  const agents = agentsFromState(state).map((agent) => `${agent.id}: ${agent.status} — ${agent.last}`);
  return [
    'xdou cockpit — visual mission control',
    rule(width),
    `Run: ${selected.id}`,
    `Status: ${selected.status}/${selected.phase}`,
    `Mission: ${truncate(selected.mission, width - 9)}`,
    `Artifacts: ${selected.artifactDir}`,
    selected.worktreePath ? `Worktree: ${selected.worktreePath}` : undefined,
    rule(width),
    'Agents:',
    ...agents.map((item) => `  ${item}`),
    rule(width),
    'Review verdicts:',
    ...verdictLines.map((item) => `  ${item}`),
    rule(width),
    'Timeline:',
    ...(timeline.length ? timeline.map((item) => `  ${item}`) : ['  no timeline events yet']),
    rule(width),
    'Artifacts preview:',
    ...artifactLines(state).slice(0, 16).map((item) => `  ${stripAnsi(item)}`),
    rule(width),
    '[tab] switch pane  [n] new mission  [v] diff  [p] plan  [r] review  [a] apply  [q] quit',
  ].filter((linePart): linePart is string => Boolean(linePart)).join('\n');
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

class VisualCockpit implements Component {
  private focus = 1;
  constructor(private readonly state: CockpitState, private readonly tui: TUI, private readonly onExit: () => void) {}
  invalidate(): void {}
  handleInput(data: string): void {
    if (matchesKey(data, 'q') || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.shutdown();
    if (matchesKey(data, 'tab')) { this.focus = (this.focus + 1) % 3; this.tui.requestRender(); }
    if (matchesKey(data, 'a')) this.printAction(`xdou apply ${this.state.selected?.id ?? '<run-id>'}`);
    if (matchesKey(data, 'v')) this.printAction(this.state.selected ? join(this.state.selected.artifactDir, 'diff.patch') : 'No run selected.');
    if (matchesKey(data, 'p')) this.printAction(this.state.selected ? join(this.state.selected.artifactDir, 'plan.md') : 'No run selected.');
    if (matchesKey(data, 'r')) this.printAction(this.state.selected ? join(this.state.selected.artifactDir, 'review.md') : 'No run selected.');
  }
  private printAction(message: string): void {
    this.tui.showOverlay({ invalidate() {}, render: (width: number) => [bold('Action'), truncate(message, Math.max(20, width - 2)), dim('press q/esc to close cockpit')] }, { width: '70%', maxHeight: 5, anchor: 'bottom-center' });
    this.tui.requestRender(true);
  }
  private shutdown(): void { this.tui.stop(); this.onExit(); }
  render(width: number): string[] {
    const selected = this.state.selected;
    if (!selected) return [bold('xdou cockpit'), '', 'No runs found.', dim('Start with: xdou run "mission"')];
    const totalWidth = Math.max(96, width);
    const leftWidth = Math.max(28, Math.floor(totalWidth * 0.25));
    const rightWidth = Math.max(36, Math.floor(totalWidth * 0.32));
    const midWidth = Math.max(38, totalWidth - leftWidth - rightWidth);
    const bodyHeight = 22;
    const agentContent = agentsFromState(this.state).flatMap((agent) => [
      `${magenta(agent.id)} ${agent.status === 'blocked' ? red(agent.status) : green(agent.status)}`,
      dim(agent.role),
      agent.last,
      '',
    ]);
    const transcript = (this.state.timeline.length ? this.state.timeline : [{ type: 'waiting', by: 'xdou', time: undefined, verdict: undefined, status: undefined, phase: undefined, ok: undefined }]).slice(-18).flatMap((event) => [
      `${dim(event.time ? event.time.slice(11, 19) : '--:--:--')} ${yellow(`[${event.type ?? 'event'}]`)} ${cyan(event.by ?? 'system')}`,
      event.verdict ?? event.status ?? event.phase ?? (event.ok === undefined ? 'event recorded' : event.ok ? 'ok' : 'failed'),
      '',
    ]);
    return [
      `${bold('xdou visual cockpit')} ${dim('mission control for multi-agent co-development')}`,
      `${cyan('Run')} ${selected.id}  ${cyan('Status')} ${selected.status}/${selected.phase}  ${cyan('Mission')} ${truncate(selected.mission, totalWidth - 60)}`,
      ...hjoin([
        panel('Agents', agentContent, leftWidth, bodyHeight, this.focus === 0),
        panel('Live Council Transcript', transcript, midWidth, bodyHeight, this.focus === 1),
        panel('Current Artifact', artifactLines(this.state), rightWidth, bodyHeight, this.focus === 2),
      ]),
      dim('[tab] switch pane  [n] new mission  [v] diff  [p] plan  [r] review  [a] apply  [q] quit'),
    ];
  }
}

export async function launchCockpit(state: CockpitState): Promise<void> {
  await new Promise<void>((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);
    const app = new VisualCockpit(state, tui, resolve);
    tui.addChild(app);
    tui.setFocus(app);
    tui.start();
  });
}
