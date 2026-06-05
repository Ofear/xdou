import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { diffToPatchDeltas, initializeCollaboration, publishLiveNote, readCollaborationState, recordPatchDeltas, sendAgentMessage } from '../src/core/live-collaboration.js';

describe('live reciprocal collaboration', () => {
  it('creates a shared room with explicit live notes, inbox/outbox, warnings, and patch deltas', async () => {
    const root = temporaryDirectory();
    const store = new ArtifactStore(root);
    const run = await store.createRun('build live reciprocal peer review');

    await initializeCollaboration(store, run.id, [
      { id: 'agent-a', role: 'implementer' },
      { id: 'agent-b', role: 'reviewer' },
    ]);
    await publishLiveNote(store, run.id, 'agent-a', 'implementer', {
      intent: 'Change cockpit parser',
      approach: 'Extract shared command grammar',
      nextFiles: ['src/tui/cockpit.ts'],
      risks: ['duplicating CLI grammar'],
    });
    await sendAgentMessage(store, run.id, 'agent-b', 'agent-a', 'Do not duplicate CLI grammar; extract shared parser.', 'warning');
    await recordPatchDeltas(store, run.id, 'agent-a', 'diff --git a/src/tui/cockpit.ts b/src/tui/cockpit.ts\n+shared room\n');

    const state = await readCollaborationState(store, run.id);
    expect(state.events.map((event) => event.type)).toContain('agent.live_note');
    expect(state.warnings[0]?.message).toContain('Do not duplicate');
    expect(state.latestPatchDeltas[0]?.file).toBe('src/tui/cockpit.ts');
    expect(state.agents.find((agent) => agent.id === 'agent-a')?.inbox[0]?.severity).toBe('warning');
    expect(existsSync(join(root, 'runs', run.id, 'agents', 'agent-a', 'live-notes.md'))).toBe(true);
    expect(readFileSync(join(root, 'runs', run.id, 'collaboration', 'protocol.json'), 'utf8')).toContain('explicit reasoning state');
  });

  it('converts git diffs into file-level live patch delta events', () => {
    const events = diffToPatchDeltas('diff --git a/a.ts b/a.ts\n+a\ndiff --git a/b.ts b/b.ts\n+b\n', 'codex');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.file)).toEqual(['a.ts', 'b.ts']);
  });
});
