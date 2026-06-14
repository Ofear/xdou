import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import fsExtra from 'fs-extra';
import { join } from 'node:path';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { isEmptySession, listSessions, newSessionId, pruneEmptySessions, readAllSessions, readSession, writeSession } from '../src/core/cockpit-sessions.js';
import { filterTeam, teamRoster } from '../src/core/cockpit-team.js';
import { buildAssistantPrompt, buildSummaryPrompt, buildWebSearchPrompt, capHistory, parseWebProvenance, type AssistantTurn } from '../src/core/assistant-prompt.js';
import type { TeamConfig } from '../src/config/schema.js';

describe('cockpit sessions', () => {
  it('round-trips a session and lists it', async () => {
    const store = new ArtifactStore(temporaryDirectory());
    const id = newSessionId();
    expect(id).toMatch(/^\d{14}-[a-f0-9]{8}$/);
    await writeSession(store, { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [
      { author: 'you', text: 'hi', mine: true },
      { author: 'claude', text: 'hello back' },
    ] });
    const loaded = await readSession(store, id);
    expect(loaded?.entries).toHaveLength(2);
    expect(loaded?.entries[1]?.text).toBe('hello back');
    const all = await listSessions(store);
    expect(all.map((s) => s.id)).toContain(id);
  });

  it('returns undefined for a missing session and rejects malformed ids', async () => {
    const store = new ArtifactStore(temporaryDirectory());
    expect(await readSession(store, newSessionId())).toBeUndefined();
    await expect(readSession(store, 'not-a-valid-id')).rejects.toThrow(/Invalid session id/);
  });

  it('degrades to undefined (not a crash) when a session file is corrupt', async () => {
    const store = new ArtifactStore(temporaryDirectory());
    const id = newSessionId();
    await writeSession(store, { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), entries: [] });
    // simulate a half-written / corrupt file
    await fsExtra.writeFile(join(store.root, 'sessions', `${id}.json`), '{ "id": "trunc', 'utf8');
    expect(await readSession(store, id)).toBeUndefined();
  });

  it('treats sessions with no real messages as empty (system-only or none)', () => {
    const base = { createdAt: '', updatedAt: '' };
    expect(isEmptySession({ id: newSessionId(), ...base, entries: [] })).toBe(true);
    expect(isEmptySession({ id: newSessionId(), ...base, entries: [{ author: 'system', text: 'Resumed session (0 earlier messages).' }] })).toBe(true);
    expect(isEmptySession({ id: newSessionId(), ...base, entries: [{ author: 'system', text: 'note' }, { author: 'you', text: 'hi', mine: true }] })).toBe(false);
  });

  it('hides empty sessions from listings but keeps them readable, and prunes them', async () => {
    const store = new ArtifactStore(temporaryDirectory());
    const now = new Date().toISOString();
    const real = newSessionId();
    const empty = newSessionId();
    await writeSession(store, { id: real, createdAt: now, updatedAt: now, entries: [{ author: 'you', text: 'hi', mine: true }] });
    await writeSession(store, { id: empty, createdAt: now, updatedAt: now, entries: [{ author: 'system', text: 'launched' }] });

    const listed = await listSessions(store);
    expect(listed.map((s) => s.id)).toEqual([real]);          // empty hidden from list
    expect((await readAllSessions(store)).map((s) => s.id)).toEqual(expect.arrayContaining([real, empty])); // still on disk

    const removed = await pruneEmptySessions(store);
    expect(removed).toBe(1);
    expect(await readSession(store, empty)).toBeUndefined();   // empty gone
    expect(await readSession(store, real)).toBeDefined();      // real kept
  });
});

describe('cockpit team filtering', () => {
  const team: TeamConfig = { brainstormers: ['claude', 'codex'], architect: 'claude', critic: 'codex', implementer: 'codex', reviewer: ['claude'], fixer: 'codex' };

  it('builds a roster with aggregated roles', () => {
    const roster = teamRoster(team);
    const claude = roster.find((a) => a.id === 'claude');
    const codex = roster.find((a) => a.id === 'codex');
    expect(claude?.roles).toEqual(expect.arrayContaining(['brainstormer', 'architect', 'reviewer']));
    expect(codex?.roles).toEqual(expect.arrayContaining(['brainstormer', 'critic', 'implementer', 'fixer']));
  });

  it('drops a disabled agent from pools and falls back single-slot roles', () => {
    const filtered = filterTeam(team, ['codex']);
    expect(filtered.brainstormers).toEqual(['claude']);
    expect(filtered.critic).toBe('claude');      // codex disabled -> first enabled (claude)
    expect(filtered.implementer).toBe('claude');
    expect(filtered.fixer).toBe('claude');
    expect(filtered.architect).toBe('claude');
  });

  it('returns the team unchanged when nothing is disabled', () => {
    expect(filterTeam(team, [])).toBe(team);
  });
});

describe('assistant prompt', () => {
  it('prepends the conversation so the assistant has session memory', () => {
    const prompt = buildAssistantPrompt('/tmp/proj', 'What is my codeword?', [
      { author: 'you', text: 'My codeword is Hoopy.', mine: true },
      { author: 'claude', text: 'Got it.' },
      { author: 'system', text: 'Running mission…' }, // system noise is excluded
    ]);
    expect(prompt).toContain('Recent conversation');
    expect(prompt).toContain('User: My codeword is Hoopy.');
    expect(prompt).toContain('claude: Got it.');
    expect(prompt).not.toContain('Running mission'); // system entries filtered out
    expect(prompt).toContain('Reply to the user\'s latest message:\nWhat is my codeword?');
  });

  it('omits the context block when there is no prior history', () => {
    const prompt = buildAssistantPrompt('/tmp/proj', 'hello', []);
    expect(prompt).not.toContain('Recent conversation');
    expect(prompt).not.toContain('Summary of earlier');
    expect(prompt).toContain('hello');
  });

  it('includes the rolling summary block when provided', () => {
    const prompt = buildAssistantPrompt('/tmp/proj', 'next?', [{ author: 'you', text: 'recent', mine: true }], 'Earlier: user set codeword Hoopy.');
    expect(prompt).toContain('Summary of earlier conversation:');
    expect(prompt).toContain('Hoopy');
    expect(prompt).toContain('Recent conversation');
  });
});

describe('context compaction', () => {
  const turns: AssistantTurn[] = Array.from({ length: 50 }, (_, i) => ({ author: i % 2 ? 'claude' : 'you', text: 'x'.repeat(500), mine: i % 2 === 0 }));

  it('caps history to the most recent turns within the char budget', () => {
    const kept = capHistory(turns, 2000);
    // ~500 chars/turn -> roughly 3-4 turns fit in 2000
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(turns.length);
    // keeps the most recent (last) turn
    expect(kept.at(-1)).toBe(turns.at(-1));
  });

  it('auto-caps inside buildAssistantPrompt so the prompt never includes the whole history', () => {
    const prompt = buildAssistantPrompt('/p', 'q', turns);
    // 50 * ~500 = 25k chars of history, but the prompt is capped well below that
    expect(prompt.length).toBeLessThan(12000);
  });

  it('buildSummaryPrompt folds in a prior summary and the transcript', () => {
    const p = buildSummaryPrompt('prior summary text', [{ author: 'you', text: 'remember 42', mine: true }]);
    expect(p).toContain('prior summary text');
    expect(p).toContain('User: remember 42');
    expect(p).toMatch(/Summarize the following conversation/i);
  });
});

describe('web research provenance', () => {
  it('builds a no-fabrication search prompt that asks for a provenance marker', () => {
    const p = buildWebSearchPrompt('wix stock price');
    expect(p).toMatch(/WebSearch\/WebFetch/);
    expect(p).toMatch(/Do NOT invent or guess/i);
    expect(p).toContain('[[WEB_USED:yes]]');
    expect(p).toContain('Question: wix stock price');
  });

  it('parses the provenance marker and strips it from the answer', () => {
    expect(parseWebProvenance('Price is $X.\n\n[[WEB_USED:yes]]')).toEqual({ used: true, clean: 'Price is $X.' });
    expect(parseWebProvenance('From memory.\n[[WEB_USED:no]]')).toEqual({ used: false, clean: 'From memory.' });
    // no marker -> unknown provenance, text unchanged
    expect(parseWebProvenance('Just an answer.')).toEqual({ used: undefined, clean: 'Just an answer.' });
    // a marker quoted INSIDE the body (not trailing) must not flip the banner or be scrubbed
    const mid = parseWebProvenance('I will not emit [[WEB_USED:no]] in the middle of my answer.');
    expect(mid.used).toBeUndefined();
    expect(mid.clean).toContain('[[WEB_USED:no]]');
  });
});
