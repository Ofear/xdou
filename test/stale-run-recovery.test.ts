import { describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/core/artifact-store.js';
import { temporaryDirectory } from 'tempy';

describe('stale run recovery', () => {
  it('marks old running manifests without a live pid as aborted', async () => {
    const store = new ArtifactStore(temporaryDirectory());
    const run = await store.createRun('stale mission');
    await store.updateManifest(run.id, { status: 'running', phase: 'review' });
    const manifest = await store.readManifest(run.id);
    await store.writeJson(run.id, 'manifest.json', {
      ...manifest,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const recovered = await store.recoverStaleRuns(1);
    const finalManifest = await store.readManifest(run.id);

    expect(recovered.map((item) => item.id)).toContain(run.id);
    expect(finalManifest.status).toBe('aborted');
    expect(finalManifest.phase).toBe('aborted');
  });
});
