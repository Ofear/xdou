import fs from 'fs-extra';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactStore } from './artifact-store.js';

// One persisted cockpit chat. Sessions are independent of runs: a single session can spawn many
// runs over its lifetime. They let the operator close xdou and resume the same conversation later.
export interface CockpitSessionEntry { author: string; text: string; mine?: boolean }
export interface CockpitSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  entries: CockpitSessionEntry[];
  summary?: string;          // rolling LLM summary of older turns (context compaction)
  summarizedCount?: number;  // number of leading entries folded into `summary`
}

const SESSION_ID = /^\d{14}-[a-f0-9]{8}$/;

export function newSessionId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function sessionsDir(store: ArtifactStore): string { return join(store.root, 'sessions'); }

function sessionPath(store: ArtifactStore, id: string): string {
  if (!SESSION_ID.test(id)) throw new Error(`Invalid session id "${id}". Expected YYYYMMDDHHMMSS-xxxxxxxx.`);
  return join(sessionsDir(store), `${id}.json`);
}

export async function readSession(store: ArtifactStore, id: string): Promise<CockpitSession | undefined> {
  const path = sessionPath(store, id);
  if (!(await fs.pathExists(path))) return undefined;
  // A truncated/corrupt session file must not crash resume — degrade to "not found".
  try {
    return await fs.readJson(path) as CockpitSession;
  } catch {
    return undefined;
  }
}

// A session is "empty" until the operator has exchanged at least one real message. `system` entries
// (launch/resume banners, status notes) are housekeeping and don't count as a conversation. Empty
// sessions are hidden from listings and pruned on exit so quick open-and-quit launches don't pile up.
export function isEmptySession(session: CockpitSession): boolean {
  return !session.entries.some((entry) => entry.author !== 'system');
}

export async function deleteSession(store: ArtifactStore, id: string): Promise<void> {
  await fs.remove(sessionPath(store, id));
}

export async function writeSession(store: ArtifactStore, session: CockpitSession): Promise<void> {
  await fs.ensureDir(sessionsDir(store));
  // Write to a temp file then rename so a kill mid-write can't leave a half-written (corrupt) session.
  const path = sessionPath(store, session.id);
  const tmp = `${path}.tmp`;
  await fs.writeJson(tmp, { ...session, updatedAt: new Date().toISOString() }, { spaces: 2 });
  await fs.move(tmp, path, { overwrite: true });
}

// All readable sessions, newest first — including empty ones (used by prune). Most callers want
// listSessions(), which hides empties.
export async function readAllSessions(store: ArtifactStore): Promise<CockpitSession[]> {
  const dir = sessionsDir(store);
  if (!(await fs.pathExists(dir))) return [];
  const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json'));
  const sessions: CockpitSession[] = [];
  for (const file of files) {
    try { sessions.push(await fs.readJson(join(dir, file)) as CockpitSession); } catch { /* skip unreadable session */ }
  }
  return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function listSessions(store: ArtifactStore): Promise<CockpitSession[]> {
  return (await readAllSessions(store)).filter((session) => !isEmptySession(session));
}

// Remove every empty (no real conversation) session file. Returns the count removed.
export async function pruneEmptySessions(store: ArtifactStore): Promise<number> {
  const empties = (await readAllSessions(store)).filter(isEmptySession);
  for (const session of empties) await deleteSession(store, session.id);
  return empties.length;
}
