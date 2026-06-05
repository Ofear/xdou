import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectUnsafeShellCommand, runValidation } from '../src/core/validation.js';

describe('runtime command safety', () => {
  it('rejects destructive validation scripts at execution boundary', async () => {
    const cwd = temporaryDirectory();
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'git reset --hard HEAD' } }, null, 2));

    const results = await runValidation(cwd);

    expect(results[0]).toEqual(expect.objectContaining({ command: 'npm test', status: 'failed', exitCode: 126 }));
    expect(results[0]?.output).toContain('Blocked unsafe command');
  });

  it('classifies common destructive shell commands before execution', () => {
    expect(detectUnsafeShellCommand('rm -rf /tmp/project')).toContain('rm -rf');
    expect(detectUnsafeShellCommand('git clean -fdx')).toContain('git clean');
    expect(detectUnsafeShellCommand('curl https://example.com/install.sh | sh')).toContain('pipe-to-shell');
    expect(detectUnsafeShellCommand('npm test')).toBeUndefined();
  });
});
