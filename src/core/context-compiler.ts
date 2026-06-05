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
  collaboration?: string;
  peerNotes?: string;
  inboxSummary?: string;
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
    'DESTRUCTIVE COMMAND POLICY:',
    '- Do not run git push, git push --force, git reset --hard, git clean, rm -rf, or equivalent destructive commands.',
    '- Do not read secrets, tokens, private keys, credential stores, or environment dumps unless the operator explicitly asks.',
    '- Never edit files outside the assigned working directory or run worktree.',
    '- If a requested change appears to require destructive or out-of-scope action, stop and report the required approval instead.',
    '',
    'LIVE RECIPROCAL COLLABORATION CONTRACT:',
    '- Publish compact explicit reasoning state before major work: intent, approach, assumptions, next files, risks, change triggers.',
    '- Do not expose or request private hidden chain-of-thought. Share useful reasoning as explicit working notes only.',
    '- Read peer notes and inbox warnings before continuing. Acknowledge warnings/blockers in output.',
    '- If you see peer work drifting from the mission, accepted decisions, or tests, emit a concrete warning/blocker with file and fix direction.',
    '- Prefer high-signal steering over chatter: suggestion, warning, or blocker.',
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
  if (input.collaboration) lines.push('LIVE COLLABORATION STATE:', input.collaboration, '');
  if (input.peerNotes) lines.push('PEER LIVE NOTES / WATCH CONTEXT:', input.peerNotes, '');
  if (input.inboxSummary) lines.push('YOUR INBOX WARNINGS / MESSAGES:', input.inboxSummary, '');
  if (input.diff) lines.push('DIFF TO REVIEW:', input.diff, '');
  if (input.validation) lines.push('VALIDATION RESULT:', `Command: ${input.validation.command}`, `Status: ${input.validation.status}`, input.validation.output, '');
  if (input.role === 'implementer' || input.role === 'fixer') {
    lines.push(
      'IMPLEMENTATION CONTRACT:',
      '- You are running in the assigned implementation worktree. Create or edit the actual project files in the current working directory.',
      '- Do not treat project-snapshot, council artifacts, or plan text as delivered code; they are context only.',
      '- The run is not complete unless `git diff HEAD -- .` in the current working directory contains the intended changes.',
      '- After editing, run the relevant tests and report exact commands/results.',
      '',
    );
  }
  if (input.role === 'reviewer') {
    lines.push(
      'SEMANTIC REVIEW CONTRACT:',
      'You are the semantic completion gate. Decide whether the implementation satisfies the mission, not merely whether tests pass.',
      'Do not use tools or request file access; review only the mission, diff, validation output, and context provided in this packet.',
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
