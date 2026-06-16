import { execa } from 'execa';
import { isGitRepo } from './repo.js';

// Mission-targeted repo exploration, done deterministically by xdou itself (real git grep + glob) —
// the FastContext idea without a model or extra agent. Instead of dumping generic project metadata
// into every agent prompt, we locate the code relevant to THIS mission and hand back a compact
// "repo map + matched file:line" bundle, so the solver's context is small and on-point.

export interface MissionContextOptions {
  maxFiles?: number;       // how many matched files to include
  maxHitsPerFile?: number; // matched lines shown per file
  maxTotalChars?: number;  // hard cap on the whole bundle
}

// Filler words that carry no search signal in a coding mission. High-signal tokens (identifiers,
// paths, camelCase/snake/kebab) bypass this list entirely.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'with', 'that', 'this', 'it', 'is',
  'are', 'be', 'please', 'can', 'you', 'we', 'add', 'fix', 'make', 'build', 'create', 'implement',
  'update', 'change', 'improve', 'find', 'possible', 'code', 'project', 'file', 'files', 'bug', 'bugs',
  'issue', 'issues', 'go', 'over', 'look', 'review', 'should', 'need', 'want', 'also', 'some', 'any',
  'all', 'using', 'use', 'into', 'across', 'their', 'them', 'from', 'about', 'where', 'how', 'what',
]);

// Pull search terms out of a mission sentence: quoted phrases (exact), high-signal identifiers/paths,
// and meaningful bare words (stopwords dropped).
export function extractQueryTerms(mission: string): string[] {
  const terms = new Set<string>();
  for (const match of mission.matchAll(/["'`]([^"'`\n]{2,40})["'`]/g)) {
    const quoted = match[1]?.trim();
    if (quoted) terms.add(quoted);
  }
  // Split on whitespace + punctuation, but NOT on . / _ - so file paths and dotted/snake/kebab names
  // stay whole; then trim any stray leading/trailing punctuation off each token.
  for (const raw of mission.split(/[\s,;:!?()[\]{}<>"'`]+/)) {
    const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (token.length < 3) continue;
    const highSignal = /[./_-]/.test(token) || /[a-z][A-Z]/.test(token); // path / snake / kebab / camelCase
    if (highSignal) { terms.add(token); continue; }
    if (!STOPWORDS.has(token.toLowerCase())) terms.add(token.toLowerCase());
  }
  return [...terms].slice(0, 12);
}

// src code is more relevant than tests/config; our own artifacts and lockfiles are noise.
function pathScore(file: string): number {
  if (/^(src|lib|app|packages)\//.test(file)) return 2;
  if (/(^|\/)(test|tests|__tests__|spec)\//.test(file) || /\.(test|spec)\./.test(file)) return -2;
  if (/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.)/.test(file)) return -5;
  return 0;
}

// Compact repo map: tracked-file counts grouped by top-level directory. Gives agents orientation
// without dumping the tree.
async function repoMap(cwd: string): Promise<string> {
  const result = await execa('git', ['ls-files'], { cwd, reject: false });
  const files = result.stdout.split('\n').filter(Boolean).filter((file) => !file.startsWith('.xdou/'));
  if (!files.length) return '';
  const byDir = new Map<string, number>();
  for (const file of files) {
    const top = file.includes('/') ? `${file.split('/')[0]}/` : '(root)';
    byDir.set(top, (byDir.get(top) ?? 0) + 1);
  }
  const dirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([dir, n]) => `${dir} (${n})`);
  return `REPO MAP — ${files.length} tracked files: ${dirs.join(', ')}`;
}

export async function buildMissionContext(cwd: string, mission: string, opts: MissionContextOptions = {}): Promise<string> {
  // Deterministic search relies on git's tracked-file index; without a repo we have nothing to scope to.
  if (!(await isGitRepo(cwd))) return '';
  const maxFiles = opts.maxFiles ?? 8;
  const maxHitsPerFile = opts.maxHitsPerFile ?? 6;
  const maxTotalChars = opts.maxTotalChars ?? 4000;

  const map = await repoMap(cwd);
  const terms = extractQueryTerms(mission);
  if (!terms.length) return map; // generic mission (no targetable terms) → orientation map only

  const args = ['grep', '-n', '-I', '-i', '--no-color'];
  for (const term of terms) args.push('-e', term);
  const result = await execa('git', args, { cwd, reject: false }); // exit 1 = no matches; stdout empty
  if (!result.stdout.trim()) return map;

  const perFile = new Map<string, { line: number; text: string }[]>();
  for (const line of result.stdout.split('\n')) {
    const match = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    const [, file, lineNo, text] = match as unknown as [string, string, string, string];
    if (file.startsWith('.xdou/')) continue;
    const hits = perFile.get(file) ?? [];
    hits.push({ line: Number(lineNo), text: text.trim() });
    perFile.set(file, hits);
  }
  if (!perFile.size) return map;

  const ranked = [...perFile.entries()]
    .map(([file, hits]) => ({ file, hits, score: hits.length + pathScore(file) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles);

  const sections: string[] = [];
  let total = map.length;
  for (const { file, hits } of ranked) {
    const shown = hits.slice(0, maxHitsPerFile);
    const block = [
      `### ${file} — ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
      ...shown.map((hit) => `  ${file}:${hit.line}: ${hit.text.slice(0, 120)}`),
    ].join('\n');
    if (total + block.length > maxTotalChars) break;
    total += block.length;
    sections.push(block);
  }
  if (!sections.length) return map;
  return [map, '', `RELEVANT CODE — mission-targeted matches for: ${terms.join(', ')}`, ...sections].join('\n');
}
