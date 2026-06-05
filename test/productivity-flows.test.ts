import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { shouldAnswerAskLocally } from '../src/core/ask-routing.js';

const repoRoot = resolve(__dirname, '..');
const cli = [join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(repoRoot, 'src', 'cli.ts')];

async function runCli(args: string[], reject = true) {
  return execa(process.execPath, [...cli, ...args], { cwd: repoRoot, reject });
}

function cleanOutput(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('productivity flows', () => {
  it('supports top-level conversational ask without requiring git or creating project folders', async () => {
    const cwd = temporaryDirectory();

    const result = await runCli(['ask', 'hi', '--cwd', cwd]);

    expect(result.stdout.toLowerCase()).toContain('hi');
    expect(result.stdout.toLowerCase()).toContain('help');
    expect(existsSync(join(cwd, '.git'))).toBe(false);
    expect(existsSync(join(cwd, '.xdou'))).toBe(false);
  });

  it('routes greetings locally but sends substantive thinking questions to an assistant', () => {
    expect(shouldAnswerAskLocally('hi')).toBe(true);
    expect(shouldAnswerAskLocally('thanks')).toBe(true);
    expect(shouldAnswerAskLocally('Think with me about a tiny project: a mood journal CLI')).toBe(false);
    expect(shouldAnswerAskLocally('What should the smallest useful version do?')).toBe(false);
  });

  it('supports read-only file search outside git repositories', async () => {
    const cwd = temporaryDirectory();
    writeFileSync(join(cwd, 'README.md'), '# temp\n');

    const result = await runCli(['find', 'readme', '--cwd', cwd]);

    expect(result.stdout).toContain('README.md');
    expect(existsSync(join(cwd, '.git'))).toBe(false);
  });

  it('lets non-interactive coding missions choose an explicit project folder', async () => {
    const home = temporaryDirectory();
    const project = join(home, 'projects', 'explicit-app');

    const result = await runCli(['run', 'build', 'todo', 'app', '--cwd', home, '--project', project, '--dry-run'], false);

    expect(cleanOutput(result.stdout)).toContain(`run preflight ok cwd=${project}`);
    expect(existsSync(join(project, '.git'))).toBe(false);
    expect(result.stderr + result.stdout).not.toContain('Suggested project folder:');
  });

  it('lets non-interactive coding missions approve the suggested folder with --yes', async () => {
    const home = temporaryDirectory();

    const result = await runCli(['run', 'build', 'todo', 'app', '--cwd', home, '--yes', '--dry-run'], false);

    const expected = join(home, 'projects', 'build-todo-app');
    expect(cleanOutput(result.stdout)).toContain(`run preflight ok cwd=${expected}`);
    expect(existsSync(join(expected, '.git'))).toBe(false);
  });

  it('emits machine-readable JSON errors when --json is provided', async () => {
    const cwd = temporaryDirectory();

    const result = await runCli(['status', '../../escape', '--cwd', cwd, '--json'], false);

    expect(result.exitCode).toBe(1);
    const jsonStart = result.stderr.lastIndexOf('{\n  "ok"');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const payload = JSON.parse(result.stderr.slice(jsonStart)) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('Invalid run id');
  });

  it('has a local release pipeline script for validated packaging without storing tokens', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

    expect(pkg.scripts['release:local']).toContain('npm run lint');
    expect(pkg.scripts['release:local']).toContain('npm run typecheck');
    expect(pkg.scripts['release:local']).toContain('npm test');
    expect(pkg.scripts['release:local']).toContain('npm pack --dry-run');
    expect(pkg.scripts['release:local']).not.toContain('NODE_AUTH_TOKEN=');
  });
});
