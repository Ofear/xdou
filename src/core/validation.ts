import { execa } from 'execa';
import fs from 'fs-extra';
import { join } from 'node:path';
import type { ValidationResult } from '../types.js';
import { detectUnsafeShellCommand } from './command-safety.js';

export { detectUnsafeShellCommand } from './command-safety.js';

export async function detectValidationCommands(cwd: string): Promise<string[]> {
  const commands: string[] = [];
  if (await fs.pathExists(join(cwd, 'package.json'))) {
    const pkg = await fs.readJson(join(cwd, 'package.json')) as { scripts?: Record<string,string> };
    if (pkg.scripts?.test) commands.push('npm test');
    if (pkg.scripts?.typecheck) commands.push('npm run typecheck');
    if (pkg.scripts?.build) commands.push('npm run build');
  }
  if (await fs.pathExists(join(cwd, 'pyproject.toml')) || await fs.pathExists(join(cwd, 'pytest.ini'))) commands.push('python -m pytest -q');
  if (await fs.pathExists(join(cwd, 'Cargo.toml'))) commands.push('cargo test');
  if (await fs.pathExists(join(cwd, 'go.mod'))) commands.push('go test ./...');
  return commands;
}

export async function runValidation(cwd: string, commands?: string[]): Promise<ValidationResult[]> {
  const commandsToRun = commands ?? await detectValidationCommands(cwd);
  const results: ValidationResult[] = [];
  const pkg = await fs.readJson(join(cwd, 'package.json')).catch(() => undefined) as { scripts?: Record<string,string> } | undefined;
  for (const command of commandsToRun) {
    const scriptName = command === 'npm test' ? 'test' : command.startsWith('npm run ') ? command.slice('npm run '.length).trim() : undefined;
    const scriptCommand = scriptName ? pkg?.scripts?.[scriptName] : undefined;
    const unsafe = detectUnsafeShellCommand(scriptCommand ?? command);
    if (unsafe) {
      results.push({ command, status: 'failed', output: `Blocked unsafe command (${unsafe}): ${scriptCommand ?? command}`, exitCode: 126 });
      continue;
    }
    const result = await execa(command, { cwd, shell: true, reject: false, timeout: 10 * 60_000, all: true });
    const validationResult: ValidationResult = { command, status: result.exitCode === 0 ? 'passed' : 'failed', output: (result.all ?? '').slice(-20_000) };
    if (typeof result.exitCode === 'number') validationResult.exitCode = result.exitCode;
    results.push(validationResult);
  }
  if (!results.length) results.push({ command: 'auto-detect', status: 'skipped', output: 'No validation command detected.' });
  return results;
}
