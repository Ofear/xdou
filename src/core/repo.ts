import { execa } from 'execa';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { join, dirname } from 'node:path';

export interface RunWorkspace { cwd: string; worktreePath?: string; baseRef?: string }

// Serialize index-mutating git operations (worktree add/remove, apply, reverse) on the same repo so
// concurrent runs/applies don't collide on git's index.lock. Agent execution stays outside the lock.
export async function withRepoLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  await fs.ensureDir(lockDir);
  const release = await lockfile.lock(lockDir, {
    retries: { retries: 40, factor: 1.4, minTimeout: 100, maxTimeout: 2000 },
    stale: 60_000,
    realpath: false,
  });
  try {
    return await fn();
  } finally {
    await release().catch(() => { /* lock already released/expired */ });
  }
}

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
// Pathspec that excludes the xdou artifact dir so run worktrees/snapshots never leak into a diff
// even if a consumer repo forgot to gitignore it.
const DIFF_PATHSPEC = ['.', ':(exclude).xdou', ':(exclude).xdou/**'];

export async function gitDiff(cwd: string, artifactDir = '.xdou'): Promise<string> {
  const pathspec = artifactDir === '.xdou' ? DIFF_PATHSPEC : ['.', `:(exclude)${artifactDir}`, `:(exclude)${artifactDir}/**`];
  // Stage untracked files as intent-to-add so git itself generates correct diffs for them — handling
  // empty files, binary files, and missing-trailing-newline exactly right — then restore the index.
  const untracked = (await execa('git', ['ls-files', '--others', '--exclude-standard', '--', ...pathspec], { cwd, reject: false }))
    .stdout.split(/\r?\n/).filter(Boolean);
  if (untracked.length) await execa('git', ['add', '-N', '--', ...untracked], { cwd, reject: false });
  try {
    const diff = await execa('git', ['diff', 'HEAD', '--binary', '--', ...pathspec], { cwd, reject: false });
    return diff.stdout;
  } finally {
    if (untracked.length) await execa('git', ['reset', '-q', '--', ...untracked], { cwd, reject: false });
  }
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
  // Capture both sides so renames (a/old -> b/new) register both paths.
  const files = new Set<string>();
  for (const match of patch.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)) {
    if (match[1]) files.add(match[1]);
    if (match[2]) files.add(match[2]);
  }
  return [...files];
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

// Parse `git status --porcelain -z` into the set of affected paths. NUL-delimited output avoids
// quoting of special chars, and rename/copy entries (R/C) carry a trailing source path.
function parsePorcelainPaths(out: string): string[] {
  const tokens = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const xy = token.slice(0, 2);
    paths.push(token.slice(3));
    if (xy.includes('R') || xy.includes('C')) { i += 1; if (i < tokens.length) paths.push(tokens[i] ?? ''); }
  }
  return paths.filter(Boolean);
}

export async function reversePatch(cwd: string, patch: string): Promise<ApplyPatchResult> {
  if (!patch.trim() || patch.trim() === 'No diff produced.') throw new Error('Run has no diff to reverse.');
  const files = patchFiles(patch);
  const patchFileSet = new Set(files);
  const status = await execa('git', ['status', '--porcelain', '-z'], { cwd, reject: false });
  const unrelatedDirty = parsePorcelainPaths(status.stdout).filter((file) => !patchFileSet.has(file));
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
