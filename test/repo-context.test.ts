import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { buildMissionContext, extractQueryTerms } from '../src/core/repo-context.js';

async function gitRepo(): Promise<string> {
  const cwd = temporaryDirectory();
  await execa('git', ['init'], { cwd });
  await execa('git', ['config', 'user.email', 't@t'], { cwd });
  await execa('git', ['config', 'user.name', 't'], { cwd });
  return cwd;
}

describe('mission query terms', () => {
  it('keeps identifiers/paths/quoted phrases and drops filler words', () => {
    const terms = extractQueryTerms('fix the off-by-one in buildInvocation in src/agents/base.ts');
    expect(terms).toContain('buildInvocation');     // camelCase identifier
    expect(terms).toContain('src/agents/base.ts');  // path
    expect(terms).toContain('off-by-one');          // kebab token
    expect(terms).not.toContain('fix');             // stopword
    expect(terms).not.toContain('the');             // stopword
  });

  it('captures quoted phrases verbatim', () => {
    expect(extractQueryTerms('handle the "Refusing to run" error')).toContain('Refusing to run');
  });
});

describe('buildMissionContext', () => {
  it('returns mission-targeted file:line matches for a specific mission', async () => {
    const cwd = await gitRepo();
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'auth.ts'), 'export function validateToken(t: string) {\n  return t.length > 0;\n}\n');
    writeFileSync(join(cwd, 'src', 'misc.ts'), 'export const unrelated = 1;\n');
    await execa('git', ['add', '.'], { cwd });
    await execa('git', ['commit', '-m', 'init'], { cwd });

    const ctx = await buildMissionContext(cwd, 'fix validateToken to reject empty tokens');
    expect(ctx).toContain('REPO MAP');
    expect(ctx).toContain('RELEVANT CODE');
    expect(ctx).toContain('src/auth.ts:1');     // the matched location is surfaced
    expect(ctx).not.toContain('src/misc.ts');   // unrelated file not pulled in
  });

  it('returns just the repo map for a generic mission with no targetable terms', async () => {
    const cwd = await gitRepo();
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 1;\n');
    await execa('git', ['add', '.'], { cwd });
    await execa('git', ['commit', '-m', 'init'], { cwd });

    const ctx = await buildMissionContext(cwd, 'go over the project and find possible bugs');
    expect(ctx).toContain('REPO MAP');
    expect(ctx).not.toContain('RELEVANT CODE'); // nothing specific to target
  });

  it('returns empty (falls back to metadata) outside a git repo', async () => {
    expect(await buildMissionContext(temporaryDirectory(), 'fix validateToken')).toBe('');
  });
});
