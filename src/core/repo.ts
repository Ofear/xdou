import { execa } from 'execa';
import fs from 'fs-extra';
import { join, dirname } from 'node:path';

export interface RunWorkspace { cwd: string; worktreePath?: string; baseRef?: string }

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd, reject: false });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}
export async function hasGitHead(cwd: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--verify', 'HEAD'], { cwd, reject: false });
  return result.exitCode === 0;
}
export async function ensureGitRepo(cwd: string): Promise<void> { if (!(await isGitRepo(cwd))) throw new Error('xdou must run inside a git repository. Run git init first.'); }
export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const result = await execa('git', ['status', '--porcelain'], { cwd, reject: false });
  return result.exitCode === 0 && result.stdout.trim().length === 0;
}
export async function ensureCleanWorkingTree(cwd: string): Promise<void> {
  if (!(await isWorkingTreeClean(cwd))) throw new Error('Refusing to run coding agents on a dirty working tree. Commit/stash changes first, or run planning/brainstorming only.');
}
export async function gitDiff(cwd: string): Promise<string> {
  const tracked = await execa('git', ['diff', 'HEAD', '--', '.'], { cwd, reject: false });
  const untracked = await execa('git', ['ls-files', '--others', '--exclude-standard'], { cwd, reject: false });
  const patches: string[] = [tracked.stdout].filter(Boolean);
  for (const file of untracked.stdout.split(/\r?\n/).filter(Boolean)) {
    const path = join(cwd, file);
    const content = await fs.readFile(path, 'utf8').catch(() => undefined);
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    patches.push([
      `diff --git a/${file} b/${file}`,
      'new file mode 100644',
      'index 0000000..0000000',
      '--- /dev/null',
      `+++ b/${file}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join('\n'));
  }
  return patches.join('\n\n');
}
export async function currentHead(cwd: string): Promise<string> { const r = await execa('git', ['rev-parse', 'HEAD'], { cwd }); return r.stdout.trim(); }
export async function createRunWorktree(repoRoot: string, runId: string, artifactDir = '.xdou'): Promise<RunWorkspace> {
  const baseRef = await currentHead(repoRoot);
  const worktreePath = join(repoRoot, artifactDir, 'worktrees', runId);
  await fs.remove(worktreePath);
  await fs.ensureDir(join(worktreePath, '..'));
  await execa('git', ['worktree', 'add', '--detach', worktreePath, baseRef], { cwd: repoRoot });
  return { cwd: worktreePath, worktreePath, baseRef };
}
export async function createProjectSnapshot(repoRoot: string, snapshotPath: string): Promise<string> {
  await fs.remove(snapshotPath);
  await fs.ensureDir(snapshotPath);
  const tracked = await execa('git', ['ls-files', '-z'], { cwd: repoRoot });
  const files = tracked.stdout.split('\0').filter(Boolean);
  for (const file of files) {
    const source = join(repoRoot, file);
    const target = join(snapshotPath, file);
    await fs.ensureDir(dirname(target));
    await fs.copyFile(source, target).catch(() => undefined);
  }
  return snapshotPath;
}
export interface ApplyPatchResult { filesChanged: number; files: string[] }

function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)].map((match) => match[2]).filter((file): file is string => Boolean(file));
}

export async function applyPatch(cwd: string, patch: string): Promise<ApplyPatchResult> {
  if (!patch.trim() || patch.trim() === 'No diff produced.') throw new Error('Run has no diff to apply.');
  await ensureCleanWorkingTree(cwd);
  const files = patchFiles(patch);
  const normalizedPatch = patch.endsWith('\n') ? patch : `${patch}\n`;
  await execa('git', ['apply', '--check', '-'], { cwd, input: normalizedPatch });
  await execa('git', ['apply', '-'], { cwd, input: normalizedPatch });
  return { filesChanged: new Set(files).size, files: [...new Set(files)] };
}

export async function reversePatch(cwd: string, patch: string): Promise<ApplyPatchResult> {
  if (!patch.trim() || patch.trim() === 'No diff produced.') throw new Error('Run has no diff to reverse.');
  const files = patchFiles(patch);
  const patchFileSet = new Set(files);
  const status = await execa('git', ['status', '--porcelain'], { cwd, reject: false });
  const unrelatedDirty = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, '')).filter((file) => !patchFileSet.has(file));
  if (unrelatedDirty.length) throw new Error(`Refusing to undo with unrelated dirty working tree files: ${unrelatedDirty.join(', ')}. Commit/stash changes first.`);
  const normalizedPatch = patch.endsWith('\n') ? patch : `${patch}\n`;
  await execa('git', ['apply', '--reverse', '--check', '-'], { cwd, input: normalizedPatch });
  await execa('git', ['apply', '--reverse', '-'], { cwd, input: normalizedPatch });
  return { filesChanged: new Set(files).size, files: [...new Set(files)] };
}

export async function removeRunWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  const listed = await execa('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot, reject: false });
  const normalized = worktreePath.replace(/\\/g, '/');
  const isRegistered = listed.stdout.split(/\r?\n/).some((line) => line.startsWith('worktree ') && line.slice('worktree '.length).replace(/\\/g, '/') === normalized);
  if (isRegistered) await execa('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot, reject: false });
  await fs.remove(worktreePath);
}

export async function repoSummary(cwd: string): Promise<string> {
  const files = ['package.json','pyproject.toml','Cargo.toml','go.mod','README.md'];
  const parts: string[] = [];
  for (const file of files) if (await fs.pathExists(join(cwd, file))) parts.push(`## ${file}\n${await fs.readFile(join(cwd, file), 'utf8')}`);
  return parts.join('\n\n').slice(0, 24_000);
}
