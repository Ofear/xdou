import { execa } from 'execa';
import fs from 'fs-extra';
import { join } from 'node:path';

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd, reject: false });
  return result.exitCode === 0 && result.stdout.trim() === 'true';
}
export async function ensureGitRepo(cwd: string): Promise<void> { if (!(await isGitRepo(cwd))) throw new Error('xdou must run inside a git repository. Run git init first.'); }
export async function isWorkingTreeClean(cwd: string): Promise<boolean> {
  const result = await execa('git', ['status', '--porcelain'], { cwd, reject: false });
  return result.exitCode === 0 && result.stdout.trim().length === 0;
}
export async function ensureCleanWorkingTree(cwd: string): Promise<void> {
  if (!(await isWorkingTreeClean(cwd))) throw new Error('Refusing to run coding agents on a dirty working tree. Commit/stash changes first, or run planning/brainstorming only.');
}
export async function gitDiff(cwd: string): Promise<string> { const r = await execa('git', ['diff', '--', '.'], { cwd, reject: false }); return r.stdout; }
export async function repoSummary(cwd: string): Promise<string> {
  const files = ['package.json','pyproject.toml','Cargo.toml','go.mod','README.md'];
  const parts: string[] = [];
  for (const file of files) if (await fs.pathExists(join(cwd, file))) parts.push(`## ${file}\n${await fs.readFile(join(cwd, file), 'utf8')}`);
  return parts.join('\n\n').slice(0, 24_000);
}
