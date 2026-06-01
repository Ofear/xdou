import fs from 'fs-extra';
import React, { useEffect, useState } from 'react';
import { Box, render, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { join } from 'node:path';
import type { ArtifactStore } from '../core/artifact-store.js';
import type { RunManifest } from '../types.js';

interface TimelineEvent { time: string | undefined; type: string | undefined; by: string | undefined; verdict: string | undefined; status: string | undefined; phase: string | undefined }
interface ReviewVerdictSummary { agent: string; verdict: string; reason: string; confidence: number | undefined; missingRequirements: string[] }
export interface CockpitState { runs: RunManifest[]; selected: RunManifest | undefined; timeline: TimelineEvent[]; verdicts: ReviewVerdictSummary[] }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
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

export async function readCockpitState(store: ArtifactStore, runId?: string): Promise<CockpitState> {
  await store.recoverStaleRuns();
  const runs = await store.listRuns();
  const selectedId = runId ?? runs.at(-1)?.id;
  const selected = selectedId ? runs.find((run) => run.id === selectedId) ?? await store.readManifest(selectedId) : undefined;
  const timeline = selected ? await readTimeline(store.runDir(selected.id)) : [];
  const verdicts = selected ? await readVerdicts(store.runDir(selected.id)) : [];
  return { runs, selected, timeline, verdicts };
}

function fmtEvent(event: TimelineEvent): string {
  const time = event.time ? event.time.slice(11, 19) : '--:--:--';
  const actor = event.by ? ` by ${event.by}` : '';
  const verdict = event.verdict ? ` ${event.verdict}` : '';
  return `${time} ${event.type ?? 'event'}${actor}${verdict}`;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function renderCockpitSnapshot(state: CockpitState, width = 92): string {
  const selected = state.selected;
  if (!selected) return 'xdou cockpit\n\nNo runs found. Start with: xdou run "mission"\n';
  const line = '─'.repeat(width);
  const verdictLines = state.verdicts.length
    ? state.verdicts.map((verdict) => `${verdict.agent}: ${verdict.verdict}${verdict.reason ? ` — ${verdict.reason}` : ''}`)
    : ['no structured review verdicts yet'];
  const timeline = state.timeline.slice(-8).map(fmtEvent);
  const runs = state.runs.slice(-5).map((run) => `${run.id} ${run.status}/${run.phase}`);
  return [
    `xdou cockpit — mission control`,
    line,
    `Run: ${selected.id}`,
    `Status: ${selected.status}/${selected.phase}`,
    `Mission: ${truncate(selected.mission, width - 9)}`,
    `Artifacts: ${selected.artifactDir}`,
    selected.worktreePath ? `Worktree: ${selected.worktreePath}` : undefined,
    line,
    'Agents / Verdicts:',
    ...verdictLines.map((item) => `  ${item}`),
    line,
    'Timeline:',
    ...(timeline.length ? timeline.map((item) => `  ${item}`) : ['  no timeline events yet']),
    line,
    'Recent Runs:',
    ...(runs.length ? runs.map((item) => `  ${item}`) : ['  none']),
    line,
    '[a] apply  [r] rerun  [v] view diff  [l] logs  [c] context  [q] quit',
  ].filter((linePart): linePart is string => Boolean(linePart)).join('\n');
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  const color = status === 'completed' ? 'green' : status === 'blocked' || status === 'failed' ? 'red' : status === 'running' ? 'yellow' : 'gray';
  return React.createElement(Text, { color }, status);
}

function CockpitApp({ initial }: { initial: CockpitState }): React.ReactElement {
  const { exit } = useApp();
  const [state] = useState(initial);
  const selected = state.selected;
  useInput((input) => {
    if (input === 'q') exit();
    if (input === 'a') console.log(`Run apply command: xdou apply ${selected?.id ?? '<run-id>'}`);
    if (input === 'c') console.log(selected ? join(selected.artifactDir, 'agents') : 'No run selected.');
    if (input === 'l') console.log(selected ? join(selected.artifactDir, 'timeline.ndjson') : 'No run selected.');
    if (input === 'v') console.log(selected ? join(selected.artifactDir, 'diff.patch') : 'No run selected.');
  });
  useEffect(() => { if (!selected) return; }, [selected]);
  if (!selected) return React.createElement(Box, { flexDirection: 'column' }, React.createElement(Text, null, 'xdou cockpit'), React.createElement(Text, null, 'No runs found.'));
  return React.createElement(Box, { flexDirection: 'column', paddingX: 1 },
    React.createElement(Text, { bold: true }, 'xdou cockpit — mission control'),
    React.createElement(Text, null, 'Run: ', selected.id, '  Status: ', React.createElement(StatusBadge, { status: selected.status }), '/', selected.phase),
    React.createElement(Text, null, 'Mission: ', selected.mission),
    React.createElement(Text, null, 'Artifacts: ', selected.artifactDir),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, { bold: true }, 'Review verdicts'),
      ...(state.verdicts.length ? state.verdicts.map((verdict) => React.createElement(Text, { key: verdict.agent }, `${verdict.agent}: ${verdict.verdict}${verdict.reason ? ` — ${verdict.reason}` : ''}`)) : [React.createElement(Text, { key: 'none' }, 'no structured review verdicts yet')]),
    ),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, { bold: true }, 'Timeline'),
      ...(state.timeline.slice(-8).map((event, index) => React.createElement(Text, { key: `${event.type ?? 'event'}-${index}` }, fmtEvent(event)))),
      state.timeline.length ? undefined : React.createElement(Text, null, React.createElement(Spinner, { type: 'dots' }), ' waiting for events'),
    ),
    React.createElement(Box, { marginTop: 1, flexDirection: 'column' },
      React.createElement(Text, { bold: true }, 'Actions'),
      React.createElement(Text, null, '[a] print apply command'),
      React.createElement(Text, null, '[v] print diff path'),
      React.createElement(Text, null, '[l] print timeline log path'),
      React.createElement(Text, null, '[c] print context path'),
    ),
    React.createElement(Text, { dimColor: true }, '[q] quit   CLI actions are printed for safety; apply still runs through xdou apply.'),
  );
}

export async function launchCockpit(state: CockpitState): Promise<void> {
  const instance = render(React.createElement(CockpitApp, { initial: state }));
  await instance.waitUntilExit();
}
