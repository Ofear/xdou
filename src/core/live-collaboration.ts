import fs from 'fs-extra';
import { join } from 'node:path';
import type { ArtifactStore } from './artifact-store.js';

export type CollaborationSeverity = 'info' | 'suggestion' | 'warning' | 'blocker';
export type CollaborationEventType =
  | 'collaboration.initialized'
  | 'agent.live_note'
  | 'agent.message'
  | 'agent.acknowledged'
  | 'agent.round.started'
  | 'agent.round.finished'
  | 'file.patch.delta'
  | 'review.live_warning'
  | 'review.live_blocker'
  | 'decision.proposed'
  | 'decision.accepted';

export interface LiveReasoningState {
  intent: string;
  approach: string;
  assumptions?: string[];
  nextFiles?: string[];
  risks?: string[];
  changeTriggers?: string[];
}

export interface CollaborationEvent {
  type: CollaborationEventType;
  from: string;
  to?: string;
  role?: string;
  severity?: CollaborationSeverity;
  message?: string;
  requiresResponse?: boolean;
  file?: string;
  diffPreview?: string;
  round?: number;
  state?: LiveReasoningState;
  time?: string;
}

export interface AgentCollaborationState {
  id: string;
  liveNotes: string[];
  inbox: CollaborationEvent[];
  outbox: CollaborationEvent[];
  warnings: CollaborationEvent[];
}

export interface CollaborationState {
  events: CollaborationEvent[];
  agents: AgentCollaborationState[];
  latestPatchDeltas: CollaborationEvent[];
  blockers: CollaborationEvent[];
  warnings: CollaborationEvent[];
}

export function renderLiveReasoningState(state: LiveReasoningState): string {
  const lines = [
    'LIVE REASONING STATE (explicit, shareable; not private chain-of-thought)',
    `Intent: ${state.intent}`,
    `Approach: ${state.approach}`,
  ];
  if (state.assumptions?.length) lines.push('Assumptions:', ...state.assumptions.map((item) => `- ${item}`));
  if (state.nextFiles?.length) lines.push('Next files:', ...state.nextFiles.map((item) => `- ${item}`));
  if (state.risks?.length) lines.push('Risks:', ...state.risks.map((item) => `- ${item}`));
  if (state.changeTriggers?.length) lines.push('Change triggers:', ...state.changeTriggers.map((item) => `- ${item}`));
  return `${lines.join('\n')}\n`;
}

export function diffToPatchDeltas(diff: string, from: string, maxFiles = 20): CollaborationEvent[] {
  const files = diff.match(/^diff --git a\/(.*?) b\/(.*?)$/gm) ?? [];
  const events: CollaborationEvent[] = [];
  for (const line of files.slice(0, maxFiles)) {
    const matched = line.match(/^diff --git a\/(.*?) b\/(.*?)$/);
    const file = matched?.[2] ?? matched?.[1];
    if (!file) continue;
    const start = diff.indexOf(line);
    const next = diff.indexOf('\ndiff --git ', start + 1);
    const fileDiff = diff.slice(start, next >= 0 ? next : undefined);
    events.push({ type: 'file.patch.delta', from, file, diffPreview: fileDiff.split(/\r?\n/).slice(0, 80).join('\n'), severity: 'info' });
  }
  return events;
}

export async function initializeCollaboration(store: ArtifactStore, runId: string, agents: Array<{ id: string; role: string }>): Promise<void> {
  await store.writeJson(runId, 'collaboration/protocol.json', {
    version: 1,
    model: 'live reciprocal co-development',
    rule: 'Agents do not expose private hidden chain-of-thought. They publish compact explicit reasoning state, live code/output events, inbox/outbox messages, warnings, blockers, and acknowledgements.',
    interruptLevels: ['info', 'suggestion', 'warning', 'blocker'],
    agents,
  });
  await store.writeText(runId, 'collaboration/decisions.md', '# Accepted Decisions\n\n');
  await store.writeText(runId, 'collaboration/open-questions.md', '# Open Questions\n\n');
  await store.writeText(runId, 'collaboration/risks.md', '# Live Risks\n\n');
  for (const agent of agents) {
    await store.writeText(runId, `agents/${agent.id}/live-notes.md`, renderLiveReasoningState({
      intent: 'Waiting for assigned work.',
      approach: 'Read the shared collaboration protocol, publish explicit notes before major steps, and inspect inbox warnings before continuing.',
    }));
    await store.writeText(runId, `agents/${agent.id}/inbox.jsonl`, '');
    await store.writeText(runId, `agents/${agent.id}/outbox.jsonl`, '');
  }
  await appendCollaborationEvent(store, runId, { type: 'collaboration.initialized', from: 'xdou', message: 'Live reciprocal collaboration bus initialized.' });
}

export async function appendCollaborationEvent(store: ArtifactStore, runId: string, event: CollaborationEvent): Promise<void> {
  const enriched = { time: new Date().toISOString(), ...event };
  await fs.ensureDir(join(store.runDir(runId), 'collaboration'));
  await fs.appendFile(join(store.runDir(runId), 'collaboration', 'events.jsonl'), `${JSON.stringify(enriched)}\n`, 'utf8');
  await store.appendEvent(runId, { type: event.type, by: event.from, to: event.to, severity: event.severity, file: event.file, ok: event.severity !== 'blocker' });
  if (event.to) {
    await fs.ensureDir(join(store.runDir(runId), 'agents', event.to));
    await fs.appendFile(join(store.runDir(runId), 'agents', event.to, 'inbox.jsonl'), `${JSON.stringify(enriched)}\n`, 'utf8');
  }
  await fs.ensureDir(join(store.runDir(runId), 'agents', event.from));
  await fs.appendFile(join(store.runDir(runId), 'agents', event.from, 'outbox.jsonl'), `${JSON.stringify(enriched)}\n`, 'utf8');
}

export async function publishLiveNote(store: ArtifactStore, runId: string, agent: string, role: string, state: LiveReasoningState): Promise<void> {
  await store.writeText(runId, `agents/${agent}/live-notes.md`, renderLiveReasoningState(state));
  await appendCollaborationEvent(store, runId, { type: 'agent.live_note', from: agent, role, message: state.intent, state, severity: 'info' });
}

export async function sendAgentMessage(store: ArtifactStore, runId: string, from: string, to: string, message: string, severity: CollaborationSeverity = 'suggestion', requiresResponse = severity === 'warning' || severity === 'blocker'): Promise<void> {
  await appendCollaborationEvent(store, runId, { type: severity === 'blocker' ? 'review.live_blocker' : severity === 'warning' ? 'review.live_warning' : 'agent.message', from, to, message, severity, requiresResponse });
}

export async function recordPatchDeltas(store: ArtifactStore, runId: string, from: string, diff: string): Promise<void> {
  for (const delta of diffToPatchDeltas(diff, from)) await appendCollaborationEvent(store, runId, delta);
}

async function readJsonLines(path: string): Promise<CollaborationEvent[]> {
  if (!(await fs.pathExists(path))) return [];
  const lines = (await fs.readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean);
  const events: CollaborationEvent[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line) as CollaborationEvent); } catch { /* ignore malformed rows */ }
  }
  return events;
}

export async function readCollaborationState(store: ArtifactStore, runId: string): Promise<CollaborationState> {
  const runDir = store.runDir(runId);
  const events = await readJsonLines(join(runDir, 'collaboration', 'events.jsonl'));
  const agentIds = new Set<string>();
  for (const event of events) {
    agentIds.add(event.from);
    if (event.to) agentIds.add(event.to);
  }
  const agents: AgentCollaborationState[] = [];
  for (const id of [...agentIds].sort()) {
    const liveNotesPath = join(runDir, 'agents', id, 'live-notes.md');
    const liveNotes = (await fs.pathExists(liveNotesPath)) ? (await fs.readFile(liveNotesPath, 'utf8')).split(/\r?\n/).filter(Boolean).slice(0, 20) : [];
    const inbox = await readJsonLines(join(runDir, 'agents', id, 'inbox.jsonl'));
    const outbox = await readJsonLines(join(runDir, 'agents', id, 'outbox.jsonl'));
    const warnings = inbox.filter((event) => event.severity === 'warning' || event.severity === 'blocker');
    agents.push({ id, liveNotes, inbox, outbox, warnings });
  }
  return {
    events,
    agents,
    latestPatchDeltas: events.filter((event) => event.type === 'file.patch.delta').slice(-20),
    blockers: events.filter((event) => event.severity === 'blocker'),
    warnings: events.filter((event) => event.severity === 'warning'),
  };
}
