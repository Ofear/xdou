import fs from 'fs-extra';
import writeFileAtomic from 'write-file-atomic';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunManifest } from '../types.js';

export class ArtifactStore {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  runDir(runId: string): string { return join(this.root, 'runs', runId); }

  async createRun(mission: string): Promise<RunManifest> {
    const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const dir = this.runDir(id);
    await fs.ensureDir(dir);
    const manifest: RunManifest = { id, mission, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'created', phase: 'created', artifactDir: dir, events: 0 };
    await this.writeJson(id, 'manifest.json', manifest);
    await this.writeText(id, 'mission.md', `# Mission\n\n${mission}\n`);
    await this.appendEvent(id, { type: 'run.created', by: 'xdou', mission });
    return manifest;
  }

  private artifactPath(runId: string, relativePath: string): string {
    const root = resolve(this.runDir(runId));
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) throw new Error(`Artifact path escapes run directory: ${relativePath}`);
    return target;
  }

  async writeText(runId: string, relativePath: string, content: string): Promise<string> {
    const path = this.artifactPath(runId, relativePath);
    await fs.ensureDir(join(path, '..'));
    await writeFileAtomic(path, content, 'utf8');
    return path;
  }

  async writeJson(runId: string, relativePath: string, value: unknown): Promise<string> {
    return this.writeText(runId, relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async readManifest(runId: string): Promise<RunManifest> {
    return fs.readJson(join(this.runDir(runId), 'manifest.json')) as Promise<RunManifest>;
  }

  async updateManifest(runId: string, patch: Partial<RunManifest>): Promise<RunManifest> {
    const current = await this.readManifest(runId);
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.writeJson(runId, 'manifest.json', next);
    return next;
  }

  async appendEvent(runId: string, event: Record<string, unknown>): Promise<void> {
    const path = join(this.runDir(runId), 'timeline.ndjson');
    await fs.ensureDir(join(path, '..'));
    const enriched = { time: new Date().toISOString(), ...event };
    await fs.appendFile(path, `${JSON.stringify(enriched)}\n`, 'utf8');
    if (event.type !== 'run.created') {
      const manifestPath = join(this.runDir(runId), 'manifest.json');
      if (await fs.pathExists(manifestPath)) {
        const manifest = await this.readManifest(runId);
        await this.writeJson(runId, 'manifest.json', { ...manifest, events: manifest.events + 1, updatedAt: new Date().toISOString() });
      }
    }
  }

  async latestRunId(): Promise<string | undefined> {
    const runsDir = join(this.root, 'runs');
    if (!(await fs.pathExists(runsDir))) return undefined;
    const entries = await fs.readdir(runsDir);
    return entries.sort().at(-1);
  }
}
