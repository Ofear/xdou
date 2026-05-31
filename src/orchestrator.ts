import pc from 'picocolors';
import fs from 'fs-extra';
import { join } from 'node:path';
import { ArtifactStore } from './core/artifact-store.js';
import { compileContextPacket } from './core/context-compiler.js';
import { applyPatch, createProjectSnapshot, createRunWorktree, ensureCleanWorkingTree, ensureGitRepo, gitDiff, repoSummary } from './core/repo.js';
import { checkMissionCompletion } from './core/mission-check.js';
import { runGeneratedAcceptanceTests } from './core/acceptance-tests.js';
import { extractReviewVerdict, reviewVerdictBlocks } from './core/review-verdict.js';
import { runValidation } from './core/validation.js';
import { defaultAgents, selectAgents } from './agents/registry.js';
import type { AgentAdapter, AgentRunResult, ValidationResult } from './types.js';
import type { ReviewVerdict } from './core/review-verdict.js';
import type { AgentDefinition } from './agents/registry.js';

export interface RunOptions {
  cwd: string;
  mission: string;
  artifactDir?: string;
  team?: string[];
  brainstormers?: string[];
  critics?: string[];
  reviewers?: string[];
  fixer?: string;
  maxFixAttempts?: number;
  isolated?: boolean;
  execute?: boolean;
  timeoutMs?: number;
}

interface CouncilOutput { agent: string; role: 'brainstormer' | 'critic'; result: AgentRunResult }
interface ReviewOutput { agent: string; result: AgentRunResult; verdict: ReviewVerdict }

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
    const snapshotCwd = await createProjectSnapshot(this.cwd, join(this.store.runDir(run.id), 'project-snapshot'));
    await this.store.writeText(run.id, 'project.md', project || 'No common project metadata found.');
    const council = await this.runCouncil(run.id, mission, project, snapshotCwd, names, []);
    const councilText = this.formatCouncil(council);
    await this.store.writeText(run.id, 'brainstorm.md', councilText);
    await this.store.writeText(run.id, 'council.md', councilText);
    await this.store.updateManifest(run.id, { status: 'completed', phase: 'brainstormed' });
    return run.id;
  }

  async run(options: RunOptions): Promise<string> {
    await ensureGitRepo(this.cwd);
    if (options.execute !== false) await ensureCleanWorkingTree(this.cwd);
    const run = await this.store.createRun(options.mission);
    const cleanupSignals = this.installAbortSignalHandlers(run.id);
    await this.store.updateManifest(run.id, { status: 'running', phase: 'council', processPid: process.pid });
    const project = await repoSummary(this.cwd);
    const snapshotCwd = await createProjectSnapshot(this.cwd, join(this.store.runDir(run.id), 'project-snapshot'));
    await this.store.writeText(run.id, 'project.md', project || 'No common project metadata found.');
    const selected = selectAgents(options.team ?? ['claude', 'codex', 'claude'], this.agents);
    const architect = selected[0];
    const implementer = selected[1];
    const fallbackReviewer = selected[2] ?? selected[0];
    if (!architect || !implementer || !fallbackReviewer) throw new Error('A run needs at least architect, implementer, and reviewer agents.');

    const brainstormers = options.brainstormers ?? [architect.id, implementer.id];
    const critics = options.critics ?? [];
    const reviewerNames = options.reviewers ?? [fallbackReviewer.id];
    const council = await this.runCouncil(run.id, options.mission, project, snapshotCwd, brainstormers, critics, options.timeoutMs);
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
    const planInput = { cwd: snapshotCwd, runDir: this.store.runDir(run.id), prompt: synthesisPrompt, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
    const planResult = await architect.run(planInput);
    const rawPlan = planResult.stdout || planResult.stderr;
    const synthesis = this.formatSynthesis(architect.id, rawPlan, council);
    await this.store.writeText(run.id, 'plan.md', rawPlan);
    await this.store.writeText(run.id, 'synthesis.md', synthesis);
    await this.store.writeJson(run.id, `agents/${architect.id}/plan-result.json`, planResult);
    await this.store.appendEvent(run.id, { type: 'plan.created', by: architect.id, ok: planResult.ok });
    if (!planResult.ok) { await this.store.updateManifest(run.id, { status: 'blocked', phase: 'planning_failed' }); throw new Error(`Architect failed: ${planResult.stderr}`); }
    if (options.execute === false) { cleanupSignals(); await this.store.updateManifest(run.id, { status: 'completed', phase: 'planned' }); return run.id; }

    const workspace = options.isolated === false ? { cwd: this.cwd } : await createRunWorktree(this.cwd, run.id);
    await this.store.updateManifest(run.id, { phase: 'implementation', ...(workspace.worktreePath ? { worktreePath: workspace.worktreePath, baseRef: workspace.baseRef } : {}) });
    const implPrompt = compileContextPacket({ runId: run.id, agent: implementer.id, role: 'implementer', mission: options.mission, projectContext: project, plan: synthesis, budget: 'balanced' });
    const implInput = { cwd: workspace.cwd, runDir: this.store.runDir(run.id), prompt: implPrompt, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
    const implResult = await implementer.run(implInput);
    await this.store.writeJson(run.id, `agents/${implementer.id}/implementation-result.json`, implResult);
    await this.store.appendEvent(run.id, { type: 'implementation.finished', by: implementer.id, ok: implResult.ok });

    let diff = await gitDiff(workspace.cwd);
    await this.store.writeText(run.id, 'diff.patch', diff || 'No diff produced.');
    let validation = await this.validateWorkspace(run.id, options.mission, workspace.cwd, diff);
    await this.store.appendEvent(run.id, { type: 'validation.finished', ok: !validation.some((v) => v.status === 'failed') });

    await this.store.updateManifest(run.id, { phase: 'review' });
    let reviewResults = await this.runReviews(run.id, snapshotCwd, options.mission, synthesis, diff, validation, reviewerNames, options.timeoutMs);
    let failed = this.hasBlockers(implResult, validation, reviewResults);

    const maxFixAttempts = options.maxFixAttempts ?? 1;
    const fixerName = options.fixer ?? implementer.id;
    for (let attempt = 1; failed && attempt <= maxFixAttempts; attempt += 1) {
      const [fixer] = selectAgents([fixerName], this.agents);
      if (!fixer) break;
      await this.store.updateManifest(run.id, { phase: `fix_${attempt}`, fixAttempts: attempt });
      await this.store.appendEvent(run.id, { type: 'fix.started', by: fixer.id, attempt });
      const lastValidation = validation.at(-1);
      const fixPrompt = compileContextPacket({
        runId: run.id,
        agent: fixer.id,
        role: 'fixer',
        mission: options.mission,
        projectContext: project,
        plan: synthesis,
        diff,
        budget: 'balanced',
        ...(lastValidation ? { validation: lastValidation } : {}),
      });
      await this.store.writeText(run.id, `fixes/attempt-${attempt}/inbox.md`, fixPrompt);
      const fixInput = { cwd: workspace.cwd, runDir: this.store.runDir(run.id), prompt: fixPrompt, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) };
      const fixResult = await fixer.run(fixInput);
      await this.store.writeJson(run.id, `fixes/attempt-${attempt}/result.json`, fixResult);
      await this.store.appendEvent(run.id, { type: 'fix.finished', by: fixer.id, attempt, ok: fixResult.ok });
      diff = await gitDiff(workspace.cwd);
      await this.store.writeText(run.id, `fixes/attempt-${attempt}/diff.patch`, diff || 'No diff produced.');
      await this.store.writeText(run.id, 'diff.patch', diff || 'No diff produced.');
      validation = await this.validateWorkspace(run.id, options.mission, workspace.cwd, diff);
      await this.store.writeJson(run.id, `fixes/attempt-${attempt}/validation.json`, validation);
      await this.store.appendEvent(run.id, { type: 'validation.finished', attempt, ok: !validation.some((v) => v.status === 'failed') });
      reviewResults = await this.runReviews(run.id, snapshotCwd, options.mission, synthesis, diff, validation, reviewerNames, options.timeoutMs);
      failed = this.hasBlockers(fixResult, validation, reviewResults);
    }
    if (failed && maxFixAttempts > 0) await this.store.appendEvent(run.id, { type: 'fix.exhausted', attempts: maxFixAttempts });
    await this.store.writeText(run.id, 'final-summary.md', this.formatFinalSummary(options.mission, run.id, synthesis, validation, reviewResults, failed, workspace.worktreePath));
    const finalManifest = await this.store.updateManifest(run.id, { status: failed ? 'blocked' : 'completed', phase: failed ? 'needs_attention' : 'done' });
    await this.store.writeJson(run.id, 'result.json', { runId: run.id, status: finalManifest.status, phase: finalManifest.phase, artifactDir: finalManifest.artifactDir, worktreePath: finalManifest.worktreePath, validation, reviews: reviewResults.map((review) => ({ agent: review.agent, ok: review.result.ok, verdict: review.verdict })) });
    cleanupSignals();
    if (failed) console.error(pc.yellow(`xdou run ${run.id} completed with blockers; inspect ${this.store.runDir(run.id)}`));
    return run.id;
  }

  async applyRun(runId: string): Promise<{ runId: string; applied: true; filesChanged: number; files: string[]; artifactDir: string }> {
    await ensureGitRepo(this.cwd);
    const manifest = await this.store.readManifest(runId);
    if (manifest.status !== 'completed') throw new Error(`Refusing to apply run ${runId} with status ${manifest.status}.`);
    const diffPath = join(this.store.runDir(runId), 'diff.patch');
    const diff = await fs.readFile(diffPath, 'utf8');
    const applied = await applyPatch(this.cwd, diff);
    const result = { runId, applied: true as const, filesChanged: applied.filesChanged, files: applied.files, artifactDir: manifest.artifactDir };
    await this.store.writeJson(runId, 'apply-result.json', result);
    await this.store.appendEvent(runId, { type: 'run.applied', by: 'xdou', filesChanged: applied.filesChanged });
    await this.store.updateManifest(runId, { appliedAt: new Date().toISOString() });
    return result;
  }

  private async runCouncil(runId: string, mission: string, project: string, cwd: string, brainstormers: string[], critics: string[], timeoutMs?: number): Promise<CouncilOutput[]> {
    const specs = [
      ...brainstormers.map((name) => ({ name, role: 'brainstormer' as const })),
      ...critics.map((name) => ({ name, role: 'critic' as const })),
    ];
    const outputs = await Promise.all(specs.map(async (spec): Promise<CouncilOutput | undefined> => {
      const [agent] = selectAgents([spec.name], this.agents);
      if (!agent) return undefined;
      const prompt = compileContextPacket({ runId, agent: agent.id, role: spec.role, mission, projectContext: project, budget: 'balanced' });
      await this.store.writeText(runId, `agents/${agent.id}/${spec.role}-inbox.md`, prompt);
      const input = { cwd, runDir: this.store.runDir(runId), prompt, ...(timeoutMs ? { timeoutMs } : {}) };
      const result = await agent.run(input);
      await this.store.writeJson(runId, `agents/${agent.id}/${spec.role}-result.json`, result);
      await this.store.appendEvent(runId, { type: 'council.finished', by: agent.id, role: spec.role, ok: result.ok, exitCode: result.exitCode });
      return { agent: agent.id, role: spec.role, result };
    }));
    return outputs.filter((output): output is CouncilOutput => Boolean(output));
  }

  private async runReviews(runId: string, cwd: string, mission: string, plan: string, diff: string, validation: ValidationResult[], reviewers: string[], timeoutMs?: number): Promise<ReviewOutput[]> {
    const lastValidation = validation.at(-1);
    const outputs = await Promise.all(selectAgents(reviewers, this.agents).map(async (reviewer): Promise<ReviewOutput> => {
      const reviewContext = { runId, agent: reviewer.id, role: 'reviewer', mission, plan, diff, budget: 'minimal' as const, ...(lastValidation ? { validation: lastValidation } : {}) };
      const prompt = compileContextPacket(reviewContext);
      await this.store.writeText(runId, `agents/${reviewer.id}/review-inbox.md`, prompt);
      const input = { cwd, runDir: this.store.runDir(runId), prompt, ...(timeoutMs ? { timeoutMs } : {}) };
      const result = await reviewer.run(input);
      const verdict = extractReviewVerdict(result.stdout || result.stderr);
      await this.store.writeJson(runId, `agents/${reviewer.id}/review-result.json`, result);
      await this.store.writeJson(runId, `agents/${reviewer.id}/review-verdict.json`, verdict);
      await this.store.appendEvent(runId, { type: 'review.finished', by: reviewer.id, ok: result.ok, verdict: verdict.verdict });
      return { agent: reviewer.id, result, verdict };
    }));
    await this.store.writeText(runId, 'review.md', outputs.map((review) => `## ${review.agent}\n\n${review.result.stdout || review.result.stderr}`).join('\n\n---\n\n'));
    await this.store.writeJson(runId, 'review-verdicts.json', outputs.map((review) => ({ agent: review.agent, ...review.verdict })));
    return outputs;
  }

  private async validateWorkspace(runId: string, mission: string, cwd: string, diff: string): Promise<ValidationResult[]> {
    const validation = await runValidation(cwd);
    const generatedAcceptance = await runGeneratedAcceptanceTests(cwd, mission);
    await this.store.writeJson(runId, 'generated-acceptance.json', generatedAcceptance);
    const missionCheck = checkMissionCompletion(mission, diff || 'No diff produced.');
    await this.store.writeJson(runId, 'mission-check.json', missionCheck);
    const combined: ValidationResult[] = [
      ...validation,
      generatedAcceptance,
      {
        command: 'xdou mission-completion-check',
        status: missionCheck.status === 'failed' ? 'failed' : 'passed',
        output: missionCheck.message,
        exitCode: missionCheck.status === 'failed' ? 1 : 0,
      },
    ];
    await this.store.writeJson(runId, 'validation.json', combined);
    return combined;
  }

  private formatCouncil(council: CouncilOutput[]): string {
    return council.map((entry) => `## ${entry.agent} (${entry.role})\n\n${entry.result.stdout || entry.result.stderr}`).join('\n\n---\n\n');
  }

  private formatSynthesis(architect: string, plan: string, council: CouncilOutput[]): string {
    const participants = council.map((entry) => `${entry.agent}:${entry.role}`).join(', ') || 'none';
    return [`# Synthesis`, '', `Architect: ${architect}`, `Council: ${participants}`, '', '## Selected implementation direction', '', plan, '', '## Collaboration rule', '', 'Implementation follows this synthesized plan, then independent reviewers inspect the resulting diff and validation output.'].join('\n');
  }

  private hasBlockers(lastMutation: AgentRunResult, validation: ValidationResult[], reviews: ReviewOutput[]): boolean {
    return !lastMutation.ok || validation.some((v) => v.status === 'failed') || reviews.some((review) => !review.result.ok || reviewVerdictBlocks(review.verdict));
  }

  private installAbortSignalHandlers(runId: string): () => void {
    const handle = (signal: NodeJS.Signals): void => {
      void this.store.abortRun(runId, `received ${signal}`).finally(() => process.exit(130));
    };
    process.once('SIGINT', handle);
    process.once('SIGTERM', handle);
    return () => {
      process.off('SIGINT', handle);
      process.off('SIGTERM', handle);
    };
  }

  private formatFinalSummary(mission: string, runId: string, synthesis: string, validation: ValidationResult[], reviews: ReviewOutput[], failed: boolean, worktreePath?: string): string {
    return [
      '# XDOU Run Summary',
      '',
      `Run: ${runId}`,
      `Mission: ${mission}`,
      `Status: ${failed ? 'blocked' : 'completed'}`,
      ...(worktreePath ? [`Worktree: ${worktreePath}`] : []),
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
