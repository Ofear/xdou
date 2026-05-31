import type { ContextBudget, TaskSpec, ValidationResult } from '../types.js';

export interface ContextInput {
  runId: string;
  agent: string;
  role: string;
  mission: string;
  projectContext?: string;
  plan?: string;
  task?: TaskSpec;
  decisions?: string[];
  rejected?: string[];
  risks?: string[];
  diff?: string;
  validation?: ValidationResult;
  transcript?: string;
  budget?: ContextBudget;
}

function list(title: string, items?: string[]): string[] {
  if (!items?.length) return [];
  return [title, ...items.map((item) => `- ${item}`), ''];
}

export function compileContextPacket(input: ContextInput): string {
  const lines: string[] = [
    `XDOU CONTEXT PACKET`,
    `RUN: ${input.runId}`,
    `AGENT: ${input.agent}`,
    `ROLE: ${input.role}`,
    `BUDGET: ${input.budget ?? 'balanced'}`,
    '',
    'MISSION:',
    input.mission,
    '',
  ];

  if (input.projectContext && input.budget !== 'minimal') lines.push('PROJECT CONTEXT:', input.projectContext, '');
  if (input.plan) lines.push('CANONICAL PLAN:', input.plan, '');
  if (input.task) {
    lines.push(`TASK ${input.task.id}: ${input.task.title}`, input.task.objective);
    if (input.task.files?.length) lines.push('Files:', ...input.task.files.map((f) => `- ${f}`));
    if (input.task.validation?.length) lines.push('Validation:', ...input.task.validation.map((v) => `- ${v}`));
    lines.push('');
  }
  lines.push(...list('ACCEPTED DECISIONS:', input.decisions));
  lines.push(...list('REJECTED APPROACHES:', input.rejected));
  lines.push(...list('KNOWN RISKS:', input.risks));
  if (input.diff) lines.push('DIFF TO REVIEW:', input.diff, '');
  if (input.validation) lines.push('VALIDATION RESULT:', `Command: ${input.validation.command}`, `Status: ${input.validation.status}`, input.validation.output, '');
  if (input.role === 'reviewer') {
    lines.push(
      'SEMANTIC REVIEW CONTRACT:',
      'You are the semantic completion gate. Decide whether the implementation satisfies the mission, not merely whether tests pass.',
      'End your response with exactly one machine-readable verdict block:',
      'REVIEW_VERDICT:',
      '{"verdict":"approve|request_changes|blocked","confidence":0.0,"reason":"one sentence","missingRequirements":["requirement not satisfied"]}',
      'Use request_changes when the diff/tests are green but the mission is semantically incomplete or incorrect.',
      '',
    );
  }
  if (input.budget === 'full' && input.transcript) lines.push('RAW TRANSCRIPT FOR DEBUGGING ONLY:', input.transcript, '');
  lines.push('OUTPUT CONTRACT:', 'Return concise structured markdown with: Summary, Files changed/reviewed, Tests run, Issues/risks, Recommended next step.');
  return lines.join('\n');
}
