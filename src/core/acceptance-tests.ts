import { execa } from 'execa';
import { pathToFileURL } from 'node:url';
import { join, normalize } from 'node:path';
import type { ValidationResult } from '../types.js';

type KnownOperation = 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo';

export interface GeneratedAcceptanceCase {
  symbol: string;
  args: number[];
  expected: number;
}

export interface GeneratedAcceptancePlan {
  status: 'generated' | 'skipped';
  command: string;
  targetFile?: string;
  tests: GeneratedAcceptanceCase[];
  reason?: string;
}

const OPERATION_CASES: Record<KnownOperation, Array<{ args: number[]; expected: number }>> = {
  add: [{ args: [2, 3], expected: 5 }, { args: [-1, 4], expected: 3 }],
  subtract: [{ args: [9, 4], expected: 5 }, { args: [1, 5], expected: -4 }],
  multiply: [{ args: [3, 4], expected: 12 }, { args: [-2, 5], expected: -10 }],
  divide: [{ args: [8, 2], expected: 4 }, { args: [9, 3], expected: 3 }],
  modulo: [{ args: [9, 4], expected: 1 }, { args: [10, 5], expected: 0 }],
};

export function generateAcceptanceTests(mission: string): GeneratedAcceptancePlan {
  const targetFile = extractTargetFile(mission);
  const symbols = extractKnownOperationSymbols(mission);
  if (!targetFile) return { status: 'skipped', command: 'xdou generated-acceptance', tests: [], reason: 'No target source file detected in mission.' };
  if (!symbols.length) return { status: 'skipped', command: 'xdou generated-acceptance', targetFile, tests: [], reason: 'No known behavior template detected in mission.' };

  const tests = symbols.flatMap((symbol) => OPERATION_CASES[symbol].map((testCase) => ({ symbol, ...testCase })));
  return { status: 'generated', command: `xdou-acceptance ${targetFile}`, targetFile, tests };
}

export async function runGeneratedAcceptanceTests(cwd: string, mission: string): Promise<ValidationResult> {
  const plan = generateAcceptanceTests(mission);
  if (plan.status === 'skipped') return { command: plan.command, status: 'skipped', output: plan.reason ?? 'No generated acceptance tests.' };

  const script = buildAcceptanceScript(cwd, plan);
  const result = await execa('node', ['--input-type=module', '--eval', script], { cwd, reject: false, timeout: 2 * 60_000, all: true });
  return {
    command: plan.command,
    status: result.exitCode === 0 ? 'passed' : 'failed',
    output: (result.all ?? '').slice(-20_000),
    ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
  };
}

function extractTargetFile(mission: string): string | undefined {
  const match = /export(?:ed)?\s+from\s+([\w./\\-]+\.(?:mjs|js|cjs|ts))/i.exec(mission);
  if (!match?.[1]) return undefined;
  return normalize(match[1]).replace(/\\/g, '/');
}

function extractKnownOperationSymbols(mission: string): KnownOperation[] {
  const found = new Set<KnownOperation>();
  for (const symbol of Object.keys(OPERATION_CASES) as KnownOperation[]) {
    const pattern = new RegExp(`\\b${symbol}\\s*\\(`, 'i');
    if (pattern.test(mission)) found.add(symbol);
  }
  return [...found];
}

function buildAcceptanceScript(cwd: string, plan: GeneratedAcceptancePlan): string {
  const moduleUrl = pathToFileURL(join(cwd, plan.targetFile!)).href;
  return `
const mod = await import(${JSON.stringify(moduleUrl)});
const tests = ${JSON.stringify(plan.tests)};
let failures = 0;
for (const test of tests) {
  const fn = mod[test.symbol];
  if (typeof fn !== 'function') {
    console.error(test.symbol + ' is not exported as a function');
    failures += 1;
    continue;
  }
  const actual = fn(...test.args);
  if (!Object.is(actual, test.expected)) {
    console.error(test.symbol + '(' + test.args.join(', ') + ') expected ' + test.expected + ' but got ' + actual);
    failures += 1;
  }
}
if (failures > 0) process.exit(1);
console.log('generated acceptance tests passed: ' + tests.length);
`;
}
