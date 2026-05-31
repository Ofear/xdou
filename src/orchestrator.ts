import pc from 'picocolors';
import { join } from 'node:path';
import { ArtifactStore } from './core/artifact-store.js';
import { compileContextPacket } from './core/context-compiler.js';
import { ensureCleanWorkingTree, ensureGitRepo, gitDiff, repoSummary } from './core/repo.js';
import { runValidation } from './core/validation.js';
import { defaultAgents, selectAgents } from './agents/registry.js';
import type { AgentAdapter, AgentRunResult, ValidationResult } from './types.js';
import type { AgentDefinition } from './agents/registry.js';

export interface RunOptions {
  cwd: string;
  mission: string;
  artifactDir?: string;
  team?: string[];
  brainstormers?: string[];
  critics?: string[];
  reviewers?: string[];
  execute?: boolean;
  timeoutMs?: number;
}

interface CouncilOutput { agent: string; role: 'brainstormer' | 'critic'; result: AgentRunResult }

export class XdouOrchestrator {
  readonly cwd: string;
  readonly store: ArtifactStore;
  readonly agents: Record<string, AgentAdapter>;

  constructor(
    cwd: string,
    artifactDir = '.xdou',
    agentDefinitions: Record<string, AgentDefinition> = {},
    agentOverrides: Record<string, AgentAdapter> = {},
  ) {
    this.cwd = cwd;
    this.store = new ArtifactStore(join(cwd, artifactDir));
    this.agents = { ...defaultAgents(agentDefinitions), ...agentOverrides };
  }

  async detectAgents(): Promise<Record<string, Awaited<ReturnType<AgentAdapter['detect']>>>> {
    const entries = await Promise.all(Object.entries(this.agents).map(async ([name, agent]) => [name, await agent.detect()] as const));
    return Object.fromEntries(entries);
  }

  async brainstorm(mission: string, names = ['claude', 'codex']): Promise<string> {
    await ensureGitRepo(this.cwd);
    const run = await this.store.createRun(mission);
    await this.store.updateManifest(run.id, { status: 'running', phase: 'brainstorm' });
    const project = await repoSummary(this.cwd);
    await this.store.writeText(run.id, 'project.md', project || 'No common project metadata found.');
    const council = await this.runCouncil(run.id, mission, project, names, []);
    await this.store.writeText(run.id, 'brainstorm.md', this.formatCouncil(council));
    await this.store.writeText(run.id, 'council.md', this.formatCouncil(council));
    await this.store.updateManifest(run.id, { status: 'completed', phase: 'brainstormed' });
    return run.id;
  }

  async run(options: RunOptions): Promise<string> {
    await ensureGitRepo(this.cwd);
    if (options.execute !== false) await ensureCleanWorkingTree(this.cwd);
    const run = await this.store.createRun(options.mission);
    await this.store.updateManifest(run.id, { status: 'running', phase: 'council' });
    const project = await repoSummary(this.cwd);
    await this.store.writeText(run.id, 'project.md', project || 'No common project metadata found.');
    const selected = selectAgents(options.team ?? ['claude', 'codex', 'claude'], this.agents);
    const architect = selected[0];
    const implementer = selected[1];
    const fallbackReviewer = selected[2] ?? selected[0];
    if (!architect || !implementer || !fallbackReviewer) throw new Error('A run needs at least architect, implementer, and reviewer agents.');

    const brainstormers = options.brainstormers ?? [architect.id, implementer.id];
    const critics = options.critics ?? [];
    const reviewerNames = options.reviewers ?? [fallbackReviewer.id];
    const council = await this.runCouncil(run.id, options.mission, project, brainstormers, critics, options.timeoutMs);
    const councilText = this.formatCouncil(council);
    await this.store.writeText(run.id, 'council.md', councilText || 'No council agents configured.');

    await this.store.updateManifest(run.id, { phase: 'planning' });
    const synthesisPrompt = [
      compileContextPacket({ runId: run.id, agent: architect.id, role: 'architect', mission: options.mission, projectContext: project, budget: 'balanced' }),
      '',
      'CO-DEVELOPMENT COUNCIL INPUTS:',
      councilText || 'No council inputs.',
      '',
      'SYNTHESIS CONTRACT:',
      'Create one canonical plan that selects the strongest ideas, resolves disagreements, lists risks, and gives the implementer precise execution steps.',
    ].join('\n');
    const planInput = { cwd: this.cwd, runDir: this.store.runDir(run.id), prompt: synthesisPrompt, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
    const planResult = await architect.run(planInput);
    const rawPlan = planResult.stdout || planResult.stderr;
    const synthesis = this.formatSynthesis(architect.id, rawPlan, council);
    await this.store.writeText(run.id, 'plan.md', rawPlan);
    await this.store.writeText(run.id, 'synthesis.md', synthesis);
    await this.store.writeJson(run.id, `agents/${architect.id}/plan-result.json`, planResult);
    await this.store.appendEvent(run.id, { type: 'plan.created', by: architect.id, ok: planResult.ok });
    if (!planResult.ok) { await this.store.updateManifest(run.id, { status: 'blocked', phase: 'planning_failed' }); throw new Error(`Architect failed: ${planResult.stderr}`); }
    if (options.execute === false) { await this.store.updateManifest(run.id, { status: 'completed', phase: 'planned' }); return run.id; }

    await this.store.updateManifest(run.id, { phase: 'implementation' });
    const implPrompt = compileContextPacket({ runId: run.id, agent: implementer.id, role: 'implementer', mission: options.mission, projectContext: project, plan: synthesis, budget: 'balanced' });
    const implInput = { cwd: this.cwd, runDir: this.store.runDir(run.id), prompt: implPrompt, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
    const implResult = await implementer.run(implInput);
    await this.store.writeJson(run.id, `agents/${implementer.id}/implementation-result.json`, implResult);
    await this.store.appendEvent(run.id, { type: 'implementation.finished', by: implementer.id, ok: implResult.ok });

    const diff = await gitDiff(this.cwd);
    await this.store.writeText(run.id, 'diff.patch', diff || 'No diff produced.');
    const validation = await runValidation(this.cwd);
    await this.store.writeJson(run.id, 'validation.json', validation);

    await this.store.updateManifest(run.id, { phase: 'review' });
    const reviewResults = await this.runReviews(run.id, options.mission, synthesis, diff, validation, reviewerNames, options.timeoutMs);
    const failed = !implResult.ok || validation.some((v) => v.status === 'failed') || reviewResults.some((review) => !review.result.ok);
    await this.store.writeText(run.id, 'final-summary.md', this.formatFinalSummary(options.mission, run.id, synthesis, validation, reviewResults, failed));
    await this.store.updateManifest(run.id, { status: failed ? 'blocked' : 'completed', phase: failed ? 'needs_attention' : 'done' });
    if (failed) console.error(pc.yellow(`xdou run ${run.id} completed with blockers; inspect ${this.store.runDir(run.id)}`));
    return run.id;
  }

  private async runCouncil(runId: string, mission: string, project: string, brainstormers: string[], critics: string[], timeoutMs?: number): Promise<CouncilOutput[]> {
    const specs = [
      ...brainstormers.map((name) => ({ name, role: 'brainstormer' as const })),
      ...critics.map((name) => ({ name, role: 'critic' as const })),
    ];
    const outputs: CouncilOutput[] = [];
    for (const spec of specs) {
      const [agent] = selectAgents([spec.name], this.agents);
      if (!agent) continue;
      const prompt = compileContextPacket({ runId, agent: agent.id, role: spec.role, mission, projectContext: project, budget: 'balanced' });
      await this.store.writeText(runId, `agents/${agent.id}/${spec.role}-inbox.md`, prompt);
      const input = { cwd: this.cwd, runDir: this.store.runDir(runId), prompt, ...(timeoutMs ? { timeoutMs } : {}) };
      const result = await agent.run(input);
      await this.store.writeJson(runId, `agents/${agent.id}/${spec.role}-result.json`, result);
      await this.store.appendEvent(runId, { type: 'council.finished', by: agent.id, role: spec.role, ok: result.ok, exitCode: result.exitCode });
      outputs.push({ agent: agent.id, role: spec.role, result });
    }
    return outputs;
  }

  private async runReviews(runId: string, mission: string, plan: string, diff: string, validation: ValidationResult[], reviewers: string[], timeoutMs?: number): Promise<Array<{ agent: string; result: AgentRunResult }>> {
    const outputs: Array<{ agent: string; result: AgentRunResult }> = [];
    const lastValidation = validation.at(-1);
    for (const reviewer of selectAgents(reviewers, this.agents)) {
      const reviewContext = { runId, agent: reviewer.id, role: 'reviewer', mission, plan, diff, budget: 'minimal' as const, ...(lastValidation ? { validation: lastValidation } : {}) };
      const prompt = compileContextPacket(reviewContext);
      await this.store.writeText(runId, `agents/${reviewer.id}/review-inbox.md`, prompt);
      const input = { cwd: this.cwd, runDir: this.store.runDir(runId), prompt, ...(timeoutMs ? { timeoutMs } : {}) };
      const result = await reviewer.run(input);
      await this.store.writeJson(runId, `agents/${reviewer.id}/review-result.json`, result);
      await this.store.appendEvent(runId, { type: 'review.finished', by: reviewer.id, ok: result.ok });
      outputs.push({ agent: reviewer.id, result });
    }
    await this.store.writeText(runId, 'review.md', outputs.map((review) => `## ${review.agent}\n\n${review.result.stdout || review.result.stderr}`).join('\n\n---\n\n'));
    return outputs;
  }

  private formatCouncil(council: CouncilOutput[]): string {
    return council.map((entry) => `## ${entry.agent} (${entry.role})\n\n${entry.result.stdout || entry.result.stderr}`).join('\n\n---\n\n');
  }

  private formatSynthesis(architect: string, plan: string, council: CouncilOutput[]): string {
    const participants = council.map((entry) => `${entry.agent}:${entry.role}`).join(', ') || 'none';
    return [`# Synthesis`, '', `Architect: ${architect}`, `Council: ${participants}`, '', '## Selected implementation direction', '', plan, '', '## Collaboration rule', '', 'Implementation follows this synthesized plan, then independent reviewers inspect the resulting diff and validation output.'].join('\n');
  }

  private formatFinalSummary(mission: string, runId: string, synthesis: string, validation: ValidationResult[], reviews: Array<{ agent: string; result: AgentRunResult }>, failed: boolean): string {
    return [
      '# XDOU Run Summary',
      '',
      `Run: ${runId}`,
      `Mission: ${mission}`,
      `Status: ${failed ? 'blocked' : 'completed'}`,
      `Reviewers: ${reviews.map((review) => review.agent).join(', ') || 'none'}`,
      '',
      '## Validation',
      ...validation.map((result) => `- ${result.status}: ${result.command}`),
      '',
      '## Synthesis',
      synthesis,
      '',
      '## Review outcomes',
      ...reviews.map((review) => `- ${review.agent}: ${review.result.ok ? 'ok' : 'failed'}`),
    ].join('\n');
  }
}
