import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { generateAcceptanceTests, runGeneratedAcceptanceTests } from '../src/core/acceptance-tests.js';

describe('generated acceptance tests', () => {
  it('generates executable behavior tests for common requested JS functions', () => {
    const generated = generateAcceptanceTests('Add a divide(a, b) function exported from math.js');

    expect(generated.status).toBe('generated');
    expect(generated.command).toContain('xdou-acceptance');
    expect(generated.tests[0]?.symbol).toBe('divide');
    expect(generated.tests[0]?.expected).toBe(4);
  });

  it('fails a symbol-present implementation with wrong behavior', async () => {
    const cwd = temporaryDirectory();
    await execa('git', ['init'], { cwd });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
    writeFileSync(join(cwd, 'math.js'), 'export function divide(a,b){ return a*b; }\n');

    const result = await runGeneratedAcceptanceTests(cwd, 'Add a divide(a, b) function exported from math.js');

    expect(result.status).toBe('failed');
    expect(result.command).toContain('xdou-acceptance');
    expect(result.output).toContain('divide(8, 2) expected 4 but got 16');
  });
});
