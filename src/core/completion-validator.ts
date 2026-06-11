import { selectAgents, defaultAgents } from '../agents/registry.js';
import type { AgentDefinition, AgentAdapter } from '../agents/registry.js';
import { checkMissionCompletion } from './mission-check.js';
import type { ValidationResult } from '../types.js';

export interface GoalCondition {
  type: 'tests_pass' | 'lint_clean' | 'build_pass' | 'custom' | 'file_exists' | 'metric_threshold' | 'all_checks';
  description: string;
  params?: Record<string, unknown>;
}

export interface CompletionEvaluation {
  satisfied: boolean;
  evidence: string;
  confidence: number;
  validation?: ValidationResult[];
  details?: Record<string, unknown>;
}

export interface CheckerConfig {
  cwd: string;
  agentDefs: Record<string, AgentAdapter>;
  checkerAgent?: string;
  useSeparateChecker: boolean;
}

function parseGoalCondition(condition: string): GoalCondition[] {
  const lower = condition.toLowerCase().trim();
  const conditions: GoalCondition[] = [];

  if (lower.includes('test') && (lower.includes('pass') || lower.includes('green'))) {
    conditions.push({ type: 'tests_pass', description: 'All tests pass' });
  }
  if (lower.includes('lint') && (lower.includes('clean') || lower.includes('pass'))) {
    conditions.push({ type: 'lint_clean', description: 'Lint passes' });
  }
  if (lower.includes('build') && (lower.includes('pass') || lower.includes('clean'))) {
    conditions.push({ type: 'build_pass', description: 'Build passes' });
  }
  if (lower.includes('all') && (lower.includes('check') || lower.includes('pass') || lower.includes('green'))) {
    conditions.push({ type: 'all_checks', description: 'All checks (tests, lint, build) pass' });
  }
  if (lower.includes('file') && lower.includes('exist')) {
    const match = lower.match(/file\s+["']?(.*?)["']?\s+exist/);
    if (match) {
      conditions.push({ type: 'file_exists', description: `File exists: ${match[1]}`, params: { pattern: match[1] } });
    }
  }
  if (lower.includes('coverage') || lower.includes('metric')) {
    conditions.push({ type: 'metric_threshold', description: 'Metric threshold met', params: { condition } });
  }

  if (conditions.length === 0) {
    conditions.push({ type: 'custom', description: condition });
  }

  return conditions;
}

async function evaluateWithSeparateChecker(
  config: CheckerConfig,
  condition: string,
  conditions: GoalCondition[],
  runArtifacts: { diff?: string; validation?: ValidationResult[]; mission?: string; worktreePath?: string }
): Promise<CompletionEvaluation> {
  const orchestrator = selectAgents([config.checkerAgent ?? 'critic'], config.agentDefs);
  if (!orchestrator.length) {
    return evaluateDeterministically(conditions, runArtifacts);
  }

  const checker = orchestrator[0]!;
  const prompt = [
    'You are a SEPARATE CHECKER agent evaluating whether a goal has been satisfied.',
    'You did NOT write the code. You are an independent evaluator.',
    '',
    `ORIGINAL GOAL: ${condition}`,
    '',
    'RECENT VALIDATION RESULTS:',
    runArtifacts.validation?.map((v) => `- ${v.command}: ${v.status} ${v.output.slice(0, 200)}`).join('\n') ?? 'No validation results available.',
    '',
    'DIFF PRODUCED:',
    runArtifacts.diff ? runArtifacts.diff.slice(0, 3000) : 'No diff produced.',
    '',
    'EVALUATION INSTRUCTIONS:',
    '1. Read the goal condition carefully',
    '2. Examine the validation results and diff',
    '3. Determine if the goal is SATISFIED - be strict, do not be generous',
    '4. Provide evidence and confidence (0-1)',
    '',
    'Respond with JSON only:',
    '{ "satisfied": boolean, "evidence": "string", "confidence": number }',
  ].join('\n');

  const result = await checker.run({
    cwd: runArtifacts.worktreePath ?? config.cwd,
    runDir: config.cwd,
    prompt,
    timeoutMs: 60_000,
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const evaluation = JSON.parse(result.stdout || result.stderr || '{}');
    return {
      satisfied: Boolean(evaluation.satisfied), // eslint-disable-line @typescript-eslint/no-unsafe-member-access
      evidence: String(evaluation.evidence ?? 'No evidence provided'), // eslint-disable-line @typescript-eslint/no-unsafe-member-access
      confidence: Number(evaluation.confidence ?? 0.5), // eslint-disable-line @typescript-eslint/no-unsafe-member-access
    };
  } catch {
    return evaluateDeterministically(conditions, runArtifacts);
  }
}

function evaluateDeterministically(
  conditions: GoalCondition[],
  runArtifacts: { validation?: ValidationResult[] }
): CompletionEvaluation {
  const validation = runArtifacts.validation ?? [];
  const failed = validation.filter((v) => v.status === 'failed');
  const passed = validation.filter((v) => v.status === 'passed');

  let allSatisfied = true;
  const evidenceParts: string[] = [];

  for (const cond of conditions) {
    let satisfied = false;
    let evidence = '';

    switch (cond.type) {
      case 'tests_pass':
      case 'all_checks':
        satisfied = failed.length === 0 && passed.length > 0;
        evidence = satisfied
          ? `All ${passed.length} validation command(s) passed.`
          : `${failed.length} failure(s): ${failed.map((f) => f.command).join(', ')}`;
        break;

      case 'lint_clean':
        const lintFailed = failed.filter((f) => f.command.includes('lint') || f.command.includes('eslint'));
        const lintPassed = passed.filter((p) => p.command.includes('lint') || p.command.includes('eslint'));
        satisfied = lintFailed.length === 0 && lintPassed.length > 0;
        evidence = satisfied
          ? 'Lint passed.'
          : `Lint failures: ${lintFailed.map((f) => f.command).join(', ')}`;
        break;

      case 'build_pass':
        const buildFailed = failed.filter((f) => f.command.includes('build') || f.command.includes('compile') || f.command.includes('tsc') || f.command.includes('tsup'));
        const buildPassed = passed.filter((p) => p.command.includes('build') || p.command.includes('compile') || p.command.includes('tsc') || p.command.includes('tsup'));
        satisfied = buildFailed.length === 0 && buildPassed.length > 0;
        evidence = satisfied
          ? 'Build passed.'
          : `Build failures: ${buildFailed.map((f) => f.command).join(', ')}`;
        break;

      case 'file_exists':
        satisfied = false;
        evidence = 'File existence check not implemented in deterministic mode';
        break;

      case 'metric_threshold':
        satisfied = false;
        evidence = 'Metric threshold check not implemented in deterministic mode';
        break;

      case 'custom':
        satisfied = failed.length === 0 && passed.length > 0;
        evidence = satisfied
          ? 'All validations passed (custom condition).'
          : failed.length
            ? `Failures: ${failed.map((f) => f.command).join(', ')}`
            : 'No validation commands detected';
        break;
    }

    allSatisfied = allSatisfied && satisfied;
    evidenceParts.push(`${cond.description}: ${evidence}`);
  }

  return {
    satisfied: allSatisfied,
    evidence: evidenceParts.join('; '),
    confidence: allSatisfied ? 1 : 0.5,
    validation,
  };
}

export async function evaluateGoalCompletion(
  config: CheckerConfig,
  condition: string,
  runArtifacts: { diff?: string; validation?: ValidationResult[]; mission?: string; worktreePath?: string }
): Promise<CompletionEvaluation> {
  const conditions = parseGoalCondition(condition);

  if (config.useSeparateChecker && config.checkerAgent) {
    return evaluateWithSeparateChecker(config, condition, conditions, runArtifacts);
  }

  return evaluateDeterministically(conditions, runArtifacts);
}

export async function evaluateMissionCompletion(
  mission: string,
  diff: string,
  config: { agentDefs: Record<string, AgentDefinition>; checkerAgent?: string; cwd: string }
): Promise<CompletionEvaluation> {
  const agents = defaultAgents(config.agentDefs);
  const orchestrator = selectAgents([config.checkerAgent ?? 'critic'], agents);
  if (!orchestrator.length) {
    const missionCheck = checkMissionCompletion(mission, diff);
    return {
      satisfied: missionCheck.status !== 'failed',
      evidence: missionCheck.message,
      confidence: missionCheck.status === 'passed' ? 1 : 0.5,
    };
  }

  const checker = orchestrator[0]!;
  const prompt = [
    'You are a SEPARATE CHECKER agent evaluating whether a mission has been completed.',
    'You did NOT write the code. You are an independent evaluator.',
    '',
    `ORIGINAL MISSION: ${mission}`,
    '',
    'FINAL DIFF:',
    diff.slice(0, 4000) || 'No diff produced.',
    '',
    'EVALUATION INSTRUCTIONS:',
    '1. Read the mission carefully',
    '2. Examine the diff - does it address the mission requirements?',
    '3. Be strict: incomplete, partial, or incorrect implementations should NOT pass',
    '4. Provide evidence and confidence (0-1)',
    '',
    'Respond with JSON only:',
    '{ "satisfied": boolean, "evidence": "string", "confidence": number }',
  ].join('\n');

  const result = await checker.run({
    cwd: config.cwd,
    runDir: config.cwd,
    prompt,
    timeoutMs: 60_000,
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const evaluation = JSON.parse(result.stdout || result.stderr || '{}');
    return {
      satisfied: Boolean(evaluation.satisfied), // eslint-disable-line @typescript-eslint/no-unsafe-member-access
      evidence: String(evaluation.evidence ?? 'No evidence provided'), // eslint-disable-line @typescript-eslint/no-unsafe-member-access
      confidence: Number(evaluation.confidence ?? 0.5), // eslint-disable-line @typescript-eslint/no-unsafe-member-access
    };
  } catch {
    const missionCheck = checkMissionCompletion(mission, diff);
    return {
      satisfied: missionCheck.status !== 'failed',
      evidence: missionCheck.message,
      confidence: 0.5,
    };
  }
}

export { parseGoalCondition };