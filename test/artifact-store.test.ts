import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore } from '../src/core/artifact-store.js';

describe('ArtifactStore', () => {
  it('creates durable run artifacts and appends event timeline', async () => {
    const root = temporaryDirectory();
    const store = new ArtifactStore(root);
    const run = await store.createRun('Add OAuth');
    await store.writeText(run.id, 'mission.md', 'Add OAuth');
    await store.appendEvent(run.id, { type: 'mission.created', by: 'operator' });
    await store.updateManifest(run.id, { status: 'running', phase: 'planning' });

    expect(run.id).toMatch(/^\d{14}-[a-f0-9]{8}$/);
    expect(existsSync(join(root, 'runs', run.id, 'mission.md'))).toBe(true);
    const events = readFileSync(join(root, 'runs', run.id, 'timeline.ndjson'), 'utf8');
    expect(events).toContain('mission.created');
    const manifest = JSON.parse(readFileSync(join(root, 'runs', run.id, 'manifest.json'), 'utf8')) as { status: string; phase: string };
    expect(manifest.status).toBe('running');
    expect(manifest.phase).toBe('planning');
  });

  it('rejects artifact path traversal', async () => {
    const root = temporaryDirectory();
    const store = new ArtifactStore(root);
    const run = await store.createRun('Safe');
    await expect(store.writeText(run.id, '../escape.txt', 'bad')).rejects.toThrow(/escapes run directory/);
  });
});
