import pc from 'picocolors';
import fs from 'fs-extra';
import { join } from 'node:path';
import { ArtifactStore } from './core/artifact-store.js';
import { compileContextPacket } from './core/context-compiler.js';
import { applyPatch, createProjectSnapshot, createRunWorktree, currentHead, ensureCleanWorkingTree, ensureGitRepo, gitDiff, isGitRepo, removeRunWorktree, repoSummary, reversePatch, withRepoLock } from './core/repo.js';
import { checkMissionCompletion } from './core/mission-check.js';
import { runGeneratedAcceptanceTests } from './core/acceptance-tests.js';
import { extractReviewVerdict, reviewVerdictBlocks } from './core/review-verdict.js';
import { runValidation } from './core/validation.js';
import { appendCollaborationEvent, initializeCollaboration, publishLiveNote, readCollaborationState, recordPatchDeltas, sendAgentMessage } from './core/live-collaboration.js';
import { defaultAgents, selectAgents } from './agents/registry.js';
import { killInFlightAgents } from './agents/base.js';
import type { AgentAdapter, AgentRunResult, RunManifest, ValidationResult } from './types.js';
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

const DEFAULT_AGENT_TIMEOUT_MS = 180_000;

function agentTimeout(timeoutMs?: number): number {
  return timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
}

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
    await initializeCollaboration(this.store, run.id, names.map((id) => ({ id, role: 'brainstormer' })));
    const council = await this.runCouncil(run.id, mission, project, snapshotCwd, names, []);
    const councilText = this.formatCouncil(council);
    await this.store.writeText(run.id, 'brainstorm.md', councilText);
    await this.store.writeText(run.id, 'council.md', councilText);
    await this.store.updateManifest(run.id, { status: 'completed', phase: 'brainstormed' });
    return run.id;
  }

  async run(options: RunOptions): Promise<string> {
    // In-place mode edits the working directory directly: no git/clean-tree requirement, so missions
    // can act on uncommitted work or a non-git folder. Isolated mode keeps the safe worktree flow.
    const inPlace = options.isolated === false;
    if (!inPlace) {
      await ensureGitRepo(this.cwd);
      if (options.execute !== false) await ensureCleanWorkingTree(this.cwd);
    }
    const run = await this.store.createRun(options.mission);
    const cleanupSignals = this.installAbortSignalHandlers(run.id);
    try {
      return await this.runPipeline(run, options, cleanupSignals);
    } catch (error) {
      // Never leave a run stuck in `running`: any unexpected failure marks it blocked so it can be
      // inspected/discarded instead of looking active forever.
      await this.store.updateManifest(run.id, { status: 'blocked', phase: 'failed' }).catch(() => { /* best-effort */ });
      await this.store.appendEvent(run.id, { type: 'run.failed', by: 'xdou', error: error instanceof Error ? error.message : String(error) }).catch(() => { /* best-effort */ });
      throw error;
    } finally {
      cleanupSignals();
    }
  }

  private async runPipeline(run: RunManifest, options: RunOptions, cleanupSignals: () => void): Promise<string> {
    const inPlace = options.isolated === false;
    const isRepo = await isGitRepo(this.cwd);
    // A diff is only meaningful with git; in-place/no-git runs apply changes live and report no patch.
    const computeDiff = async (cwd: string): Promise<string> => (isRepo ? gitDiff(cwd) : '');
    await this.store.updateManifest(run.id, { status: 'running', phase: 'council', processPid: process.pid });
    const project = await repoSummary(this.cwd);
    // Council/planning agents read a snapshot in isolated git runs; in-place runs just read the cwd.
    const snapshotCwd = inPlace || !isRepo ? this.cwd : await createProjectSnapshot(this.cwd, join(this.store.runDir(run.id), 'project-snapshot'));
    await this.store.writeText(run.id, 'project.md', project || 'No common project metadata found.');
    const selected = selectAgents(options.team ?? ['claude', 'codex', 'claude'], this.agents);
    const architect = selected[0];
    const implementer = selected[1];
    const fallbackReviewer = selected[2] ?? selected[0];
    if (!architect || !implementer || !fallbackReviewer) throw new Error('A run needs at least architect, implementer, and reviewer agents.');

    const brainstormers = options.brainstormers ?? [architect.id, implementer.id];
    const critics = options.critics ?? [];
    const reviewerNames = options.reviewers ?? [fallbackReviewer.id];
    const collaborationAgents = [
      { id: architect.id, role: 'architect' },
      { id: implementer.id, role: 'implementer' },
      ...reviewerNames.map((id) => ({ id, role: 'reviewer' })),
      ...brainstormers.map((id) => ({ id, role: 'brainstormer' })),
      ...critics.map((id) => ({ id, role: 'critic' })),
    ].filter((agent, index, all) => all.findIndex((other) => other.id === agent.id && other.role === agent.role) === index);
    await initializeCollaboration(this.store, run.id, collaborationAgents);
    const council = await this.runCouncil(run.id, options.mission, project, snapshotCwd, brainstormers, critics, options.timeoutMs);
    const councilText = this.formatCouncil(council);
    await this.store.writeText(run.id, 'council.md', councilText || 'No council agents configured.');

    await this.store.updateManifest(run.id, { phase: 'planning' });
    await publishLiveNote(this.store, run.id, architect.id, 'architect', {
      intent: 'Synthesize reciprocal council outputs into one canonical implementation direction.',
      approach: 'Compare peer proposals, promote accepted decisions, record rejected approaches, and prepare implementer steering context.',
      assumptions: ['Council outputs are explicit artifacts, not hidden reasoning.'],
      risks: ['Weak synthesis can let implementer drift from peer warnings.'],
      changeTriggers: ['Peer critique identifies a safer or simpler architecture.'],
    });
    const collaborationBeforePlan = await this.collaborationBrief(run.id);
    const synthesisPrompt = [
      compileContextPacket({ runId: run.id, agent: architect.id, role: 'architect', mission: options.mission, projectContext: project, budget: 'balanced', collaboration: collaborationBeforePlan }),
      '',
      'CO-DEVELOPMENT COUNCIL INPUTS:',
      councilText || 'No council inputs.',
      '',
      'SYNTHESIS CONTRACT:',
      'Create one canonical plan that selects the strongest ideas, resolves disagreements, lists risks, and gives the implementer precise execution steps.',
    ].join('\n');
    const planInput = { cwd: snapshotCwd, runDir: this.store.runDir(run.id), prompt: synthesisPrompt, timeoutMs: agentTimeout(options.timeoutMs) };
    const planResult = await architect.run(planInput);
    const rawPlan = planResult.stdout || planResult.stderr;
    const synthesis = this.formatSynthesis(architect.id, rawPlan, council);
    await this.store.writeText(run.id, 'plan.md', rawPlan);
    await this.store.writeText(run.id, 'synthesis.md', synthesis);
    await this.store.writeJson(run.id, `agents/${architect.id}/plan-result.json`, planResult);
    await this.store.appendEvent(run.id, { type: 'plan.created', by: architect.id, ok: planResult.ok });
    // A clean exit with no plan text is a silent failure — don't feed an empty plan to the implementer.
    if (!planResult.ok || !rawPlan.trim()) { await this.store.updateManifest(run.id, { status: 'blocked', phase: 'planning_failed' }); throw new Error(`Architect produced no usable plan: ${planResult.stderr || 'empty output'}`); }
    if (options.execute === false) { cleanupSignals(); await this.store.updateManifest(run.id, { status: 'completed', phase: 'planned' }); return run.id; }

    const workspace = options.isolated === false ? { cwd: this.cwd } : await withRepoLock(this.store.root, () => createRunWorktree(this.cwd, run.id));
    await this.store.updateManifest(run.id, { phase: 'implementation', ...(workspace.worktreePath ? { worktreePath: workspace.worktreePath, baseRef: workspace.baseRef } : {}) });
    await publishLiveNote(this.store, run.id, implementer.id, 'implementer', {
      intent: 'Implement the canonical plan while exposing live direction and planned file touches for peer review.',
      approach: 'Follow synthesis, keep edits scoped to the worktree, read inbox warnings, and report any deviations.',
      assumptions: ['Reviewers may inspect live notes and patch deltas before final review.'],
      nextFiles: ['See canonical plan and generated diff.'],
      risks: ['Changing files outside the plan or missing tests.'],
      changeTriggers: ['Reviewer emits warning/blocker, validation fails, or implementation conflicts with accepted decisions.'],
    });
    await appendCollaborationEvent(this.store, run.id, { type: 'agent.round.started', from: implementer.id, role: 'implementer', message: 'Implementation round started; peers can watch live notes and patch deltas.' });
    const implPrompt = compileContextPacket({ runId: run.id, agent: implementer.id, role: 'implementer', mission: options.mission, projectContext: project, plan: synthesis, budget: 'balanced', collaboration: await this.collaborationBrief(run.id) });
    const implInput = { cwd: workspace.cwd, runDir: this.store.runDir(run.id), prompt: implPrompt, timeoutMs: agentTimeout(options.timeoutMs) };
    const implResult = await implementer.run(implInput);
    await this.store.writeJson(run.id, `agents/${implementer.id}/implementation-result.json`, implResult);
    await this.store.appendEvent(run.id, { type: 'implementation.finished', by: implementer.id, ok: implResult.ok });

    let diff = await computeDiff(workspace.cwd);
    await this.store.writeText(run.id, 'diff.patch', diff || 'No diff produced.');
    await recordPatchDeltas(this.store, run.id, implementer.id, diff);
    await appendCollaborationEvent(this.store, run.id, { type: 'agent.round.finished', from: implementer.id, role: 'implementer', message: diff ? 'Implementation produced patch deltas for live peer review.' : 'Implementation finished without a diff.', severity: diff ? 'info' : 'warning' });
    let validation = await this.validateWorkspace(run.id, options.mission, workspace.cwd, diff, isRepo);
    await this.store.appendEvent(run.id, { type: 'validation.finished', ok: !validation.some((v) => v.status === 'failed') });

    await this.store.updateManifest(run.id, { phase: 'review' });
    const reviewSnapshotCwd = (inPlace || !isRepo ? workspace.cwd : await createProjectSnapshot(workspace.cwd, join(this.store.runDir(run.id), "review-snapshot")));
    let reviewResults = await this.runReviews(run.id, reviewSnapshotCwd, options.mission, synthesis, diff, validation, reviewerNames, options.timeoutMs);
    let failed = this.hasBlockers(implResult, validation, reviewResults);

    const maxFixAttempts = options.maxFixAttempts ?? 1;
    const fixerName = options.fixer ?? implementer.id;
    // Resolve the fixer once (selectAgents throws on unknown ids — never inside the loop).
    const fixer = this.agents[fixerName];
    if (failed && maxFixAttempts > 0 && !fixer) await this.store.appendEvent(run.id, { type: 'fix.skipped', by: 'xdou', reason: `unknown fixer "${fixerName}"` });
    for (let attempt = 1; failed && fixer && attempt <= maxFixAttempts; attempt += 1) {
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
      const fixInput = { cwd: workspace.cwd, runDir: this.store.runDir(run.id), prompt: fixPrompt, timeoutMs: agentTimeout(options.timeoutMs) };
      const fixResult = await fixer.run(fixInput);
      await this.store.writeJson(run.id, `fixes/attempt-${attempt}/result.json`, fixResult);
      await this.store.appendEvent(run.id, { type: 'fix.finished', by: fixer.id, attempt, ok: fixResult.ok });
      diff = await computeDiff(workspace.cwd);
      await this.store.writeText(run.id, `fixes/attempt-${attempt}/diff.patch`, diff || 'No diff produced.');
      await this.store.writeText(run.id, 'diff.patch', diff || 'No diff produced.');
      await recordPatchDeltas(this.store, run.id, fixer.id, diff);
      validation = await this.validateWorkspace(run.id, options.mission, workspace.cwd, diff, isRepo);
      await this.store.writeJson(run.id, `fixes/attempt-${attempt}/validation.json`, validation);
      await this.store.appendEvent(run.id, { type: 'validation.finished', attempt, ok: !validation.some((v) => v.status === 'failed') });
      const fixReviewSnapshotCwd = inPlace || !isRepo ? workspace.cwd : await createProjectSnapshot(workspace.cwd, join(this.store.runDir(run.id), `fixes/attempt-${attempt}/review-snapshot`));
      reviewResults = await this.runReviews(run.id, fixReviewSnapshotCwd, options.mission, synthesis, diff, validation, reviewerNames, options.timeoutMs);
      failed = this.hasBlockers(fixResult, validation, reviewResults);
    }
    if (failed && maxFixAttempts > 0) await this.store.appendEvent(run.id, { type: 'fix.exhausted', attempts: maxFixAttempts });
    await this.store.writeText(run.id, 'final-summary.md', this.formatFinalSummary(options.mission, run.id, synthesis, validation, reviewResults, failed, workspace.worktreePath));
    // In-place edits are already live in the working directory (nothing to /apply); record that.
    const finalManifest = await this.store.updateManifest(run.id, { status: failed ? 'blocked' : 'completed', phase: failed ? 'needs_attention' : 'done', ...(inPlace ? { inPlace: true, appliedAt: new Date().toISOString() } : {}) });
    await this.store.writeJson(run.id, 'result.json', { runId: run.id, status: finalManifest.status, phase: finalManifest.phase, artifactDir: finalManifest.artifactDir, worktreePath: finalManifest.worktreePath, validation, reviews: reviewResults.map((review) => ({ agent: review.agent, ok: review.result.ok, verdict: review.verdict })) });
    cleanupSignals();
    if (failed) console.error(pc.yellow(`xdou run ${run.id} completed with blockers; inspect ${this.store.runDir(run.id)}`));
    return run.id;
  }

  async applyRun(runId: string): Promise<{ runId: string; applied: true; filesChanged: number; files: string[]; artifactDir: string }> {
    await ensureGitRepo(this.cwd);
    const manifest = await this.store.readManifest(runId);
    if (manifest.status !== 'completed') throw new Error(`Refusing to apply run ${runId} with status ${manifest.status}.`);
    if (manifest.baseRef) {
      const head = await currentHead(this.cwd);
      if (head !== manifest.baseRef) throw new Error(`Run ${runId} was based on ${manifest.baseRef}, but current HEAD is ${head}. Review/re-run before applying stale worktree output.`);
    }
    const diffPath = join(this.store.runDir(runId), 'diff.patch');
    const diff = await fs.readFile(diffPath, 'utf8');
    const applied = await withRepoLock(this.store.root, () => applyPatch(this.cwd, diff));
    // Snapshot the exact bytes applied so undo reverses precisely this, even if diff.patch changes later.
    await this.store.writeText(runId, 'applied.patch', diff);
    const result = { runId, applied: true as const, filesChanged: applied.filesChanged, files: applied.files, artifactDir: manifest.artifactDir };
    await this.store.writeJson(runId, 'apply-result.json', result);
    await this.store.appendEvent(runId, { type: 'run.applied', by: 'xdou', filesChanged: applied.filesChanged });
    await this.store.updateManifest(runId, { appliedAt: new Date().toISOString() });
    return result;
  }

  async undoRun(runId: string): Promise<{ runId: string; undone: true; filesChanged: number; files: string[]; artifactDir: string }> {
    await ensureGitRepo(this.cwd);
    const manifest = await this.store.readManifest(runId);
    if (!manifest.appliedAt) throw new Error(`Run ${runId} has not been applied; nothing to undo.`);
    // Reverse the exact patch that was applied (snapshotted at apply time); fall back to diff.patch
    // for runs applied before applied.patch existed.
    const appliedPath = join(this.store.runDir(runId), 'applied.patch');
    const diffPath = join(this.store.runDir(runId), 'diff.patch');
    const diff = await fs.readFile(await fs.pathExists(appliedPath) ? appliedPath : diffPath, 'utf8');
    const undone = await withRepoLock(this.store.root, () => reversePatch(this.cwd, diff));
    const result = { runId, undone: true as const, filesChanged: undone.filesChanged, files: undone.files, artifactDir: manifest.artifactDir };
    await this.store.writeJson(runId, 'undo-result.json', result);
    await this.store.appendEvent(runId, { type: 'run.undone', by: 'xdou', filesChanged: undone.filesChanged });
    const updated = await this.store.readManifest(runId);
    delete updated.appliedAt;
    await this.store.writeJson(runId, 'manifest.json', { ...updated, updatedAt: new Date().toISOString() });
    return result;
  }

  async discardRun(runId: string): Promise<{ runId: string; discarded: true; worktreePath?: string; artifactDir: string }> {
    await ensureGitRepo(this.cwd);
    const manifest = await this.store.readManifest(runId);
    if (manifest.worktreePath) await withRepoLock(this.store.root, () => removeRunWorktree(this.cwd, manifest.worktreePath as string));
    const result = { runId, discarded: true as const, ...(manifest.worktreePath ? { worktreePath: manifest.worktreePath } : {}), artifactDir: manifest.artifactDir };
    await this.store.writeJson(runId, 'discard-result.json', result);
    await this.store.appendEvent(runId, { type: 'run.discarded', by: 'xdou' });
    const updated = await this.store.readManifest(runId);
    delete updated.worktreePath;
    await this.store.writeJson(runId, 'manifest.json', { ...updated, phase: 'discarded', updatedAt: new Date().toISOString() });
    return result;
  }

  async rerunValidation(runId: string): Promise<{ runId: string; validation: ValidationResult[]; artifactDir: string }> {
    const manifest = await this.store.readManifest(runId);
    const validationCwd = manifest.worktreePath && await fs.pathExists(manifest.worktreePath) ? manifest.worktreePath : this.cwd;
    const validation = await runValidation(validationCwd);
    const result = { runId, validation, artifactDir: manifest.artifactDir };
    await this.store.writeJson(runId, 'validation-rerun.json', validation);
    await this.store.appendEvent(runId, { type: 'validation.rerun', by: 'xdou', ok: !validation.some((item) => item.status === 'failed') });
    return result;
  }

  async collaboration(runId: string): Promise<Awaited<ReturnType<typeof readCollaborationState>>> {
    return readCollaborationState(this.store, runId);
  }

  async messageAgent(runId: string, from: string, to: string, message: string, severity: 'info' | 'suggestion' | 'warning' | 'blocker' = 'suggestion'): Promise<void> {
    await sendAgentMessage(this.store, runId, from, to, message, severity);
  }

  private async runCouncil(runId: string, mission: string, project: string, cwd: string, brainstormers: string[], critics: string[], timeoutMs?: number): Promise<CouncilOutput[]> {
    const specs = [
      ...brainstormers.map((name) => ({ name, role: 'brainstormer' as const })),
      ...critics.map((name) => ({ name, role: 'critic' as const })),
    ].filter((spec, index, all) => all.findIndex((other) => other.name === spec.name && other.role === spec.role) === index);
    const outputs = await Promise.all(specs.map(async (spec): Promise<CouncilOutput | undefined> => {
      const [agent] = selectAgents([spec.name], this.agents);
      if (!agent) return undefined;
      const prompt = compileContextPacket({ runId, agent: agent.id, role: spec.role, mission, projectContext: project, budget: 'balanced' });
      await this.store.writeText(runId, `agents/${agent.id}/${spec.role}-inbox.md`, prompt);
      const input = { cwd, runDir: this.store.runDir(runId), prompt, timeoutMs: agentTimeout(timeoutMs) };
      const result = await agent.run(input);
      await this.store.writeJson(runId, `agents/${agent.id}/${spec.role}-result.json`, result);
      await this.store.appendEvent(runId, { type: 'council.finished', by: agent.id, role: spec.role, ok: result.ok, exitCode: result.exitCode });
      return { agent: agent.id, role: spec.role, result };
    }));
    const firstRound = outputs.filter((output): output is CouncilOutput => Boolean(output));
    if (firstRound.length > 1) {
      await appendCollaborationEvent(this.store, runId, { type: 'agent.round.started', from: 'xdou', role: 'council', round: 2, message: 'Reciprocal council response round started.' });
      const peerText = this.formatCouncil(firstRound);
      const secondRound = await Promise.all(firstRound.map(async (entry): Promise<CouncilOutput | undefined> => {
        const [agent] = selectAgents([entry.agent], this.agents);
        if (!agent) return undefined;
        const prompt = compileContextPacket({
          runId,
          agent: agent.id,
          role: 'council-responder',
          mission,
          projectContext: project,
          budget: 'balanced',
          collaboration: await this.collaborationBrief(runId),
          peerNotes: [
            'RECIPROCAL CO-BRAINSTORMING ROUND:',
            'Read the other agents explicit proposals below. Respond with: agreements, disagreements, missed risks, better direction, and what should be promoted into canonical decisions.',
            '',
            peerText,
          ].join('\n'),
        });
        await this.store.writeText(runId, `agents/${agent.id}/${entry.role}-reciprocal-inbox.md`, prompt);
        const result = await agent.run({ cwd, runDir: this.store.runDir(runId), prompt, timeoutMs: agentTimeout(timeoutMs) });
        await this.store.writeJson(runId, `agents/${agent.id}/${entry.role}-reciprocal-result.json`, result);
        await appendCollaborationEvent(this.store, runId, { type: 'agent.round.finished', from: agent.id, role: entry.role, round: 2, message: 'Reciprocal council response finished.', severity: result.ok ? 'info' : 'warning' });
        return { agent: agent.id, role: entry.role, result };
      }));
      return [...firstRound, ...secondRound.filter((output): output is CouncilOutput => Boolean(output))];
    }
    return firstRound;
  }

  private async runReviews(runId: string, cwd: string, mission: string, plan: string, diff: string, validation: ValidationResult[], reviewers: string[], timeoutMs?: number): Promise<ReviewOutput[]> {
    const lastValidation = validation.at(-1);
    const outputs = await Promise.all(selectAgents(reviewers, this.agents).map(async (reviewer): Promise<ReviewOutput> => {
      const reviewContext = { runId, agent: reviewer.id, role: 'reviewer', mission, plan, diff, budget: 'minimal' as const, collaboration: await this.collaborationBrief(runId), peerNotes: 'Watch live patch deltas and implementer live notes before issuing final verdict. Convert drift into warning/blocker with concrete file-level guidance.', ...(lastValidation ? { validation: lastValidation } : {}) };
      const prompt = compileContextPacket(reviewContext);
      await this.store.writeText(runId, `agents/${reviewer.id}/review-inbox.md`, prompt);
      const input = { cwd, runDir: this.store.runDir(runId), prompt, timeoutMs: agentTimeout(timeoutMs) };
      const result = await reviewer.run(input);
      const verdict = extractReviewVerdict(result.stdout || result.stderr);
      await this.store.writeJson(runId, `agents/${reviewer.id}/review-result.json`, result);
      await this.store.writeJson(runId, `agents/${reviewer.id}/review-verdict.json`, verdict);
      await this.store.appendEvent(runId, { type: 'review.finished', by: reviewer.id, ok: result.ok, verdict: verdict.verdict });
      if (verdict.verdict === 'blocked') await sendAgentMessage(this.store, runId, reviewer.id, 'implementer', verdict.reason, 'blocker');
      else if (verdict.verdict === 'request_changes') await sendAgentMessage(this.store, runId, reviewer.id, 'implementer', verdict.reason, 'warning');
      return { agent: reviewer.id, result, verdict };
    }));
    await this.store.writeText(runId, 'review.md', outputs.map((review) => `## ${review.agent}\n\n${review.result.stdout || review.result.stderr}`).join('\n\n---\n\n'));
    await this.store.writeJson(runId, 'review-verdicts.json', outputs.map((review) => ({ agent: review.agent, ...review.verdict })));
    return outputs;
  }

  private async collaborationBrief(runId: string): Promise<string> {
    const state = await readCollaborationState(this.store, runId);
    const events = state.events.slice(-12).map((event) => {
      const to = event.to ? ` -> ${event.to}` : '';
      const severity = event.severity ? ` [${event.severity}]` : '';
      const file = event.file ? ` ${event.file}` : '';
      return `- ${event.type}${severity}: ${event.from}${to}${file}${event.message ? ` — ${event.message}` : ''}`;
    });
    const agentNotes = state.agents.slice(0, 8).flatMap((agent) => [
      `## ${agent.id}`,
      ...agent.liveNotes.slice(0, 8).map((line) => `  ${line}`),
      ...agent.warnings.slice(-3).map((warning) => `  WARNING from ${warning.from}: ${warning.message ?? warning.type}`),
    ]);
    return [
      'Shared room: agents collaborate via explicit notes, live patch deltas, warnings/blockers, and inbox/outbox messages.',
      'Recent events:',
      ...(events.length ? events : ['- none yet']),
      '',
      'Agent live notes:',
      ...(agentNotes.length ? agentNotes : ['- none yet']),
    ].join('\n');
  }

  private async validateWorkspace(runId: string, mission: string, cwd: string, diff: string, diffAvailable = true): Promise<ValidationResult[]> {
    const validation = await runValidation(cwd);
    const generatedAcceptance = await runGeneratedAcceptanceTests(cwd, mission);
    await this.store.writeJson(runId, 'generated-acceptance.json', generatedAcceptance);
    const missionCheck = checkMissionCompletion(mission, diff || 'No diff produced.');
    await this.store.writeJson(runId, 'mission-check.json', missionCheck);
    // Without git there is no diff to inspect, so the diff-based gates can't run — skip them rather
    // than fail an in-place run that legitimately edited files.
    const diffRequired: ValidationResult = diffAvailable
      ? { command: 'xdou diff-required-check', status: diff.trim() ? 'passed' : 'failed', output: diff.trim() ? 'Worktree diff produced.' : 'No worktree diff was produced; refusing to mark a mutating run completed because there is nothing to apply.', exitCode: diff.trim() ? 0 : 1 }
      : { command: 'xdou diff-required-check', status: 'skipped', output: 'No git repo — changes applied in place; diff check skipped.', exitCode: 0 };
    const missionCompletion: ValidationResult = diffAvailable
      ? { command: 'xdou mission-completion-check', status: missionCheck.status === 'failed' ? 'failed' : 'passed', output: missionCheck.message, exitCode: missionCheck.status === 'failed' ? 1 : 0 }
      : { command: 'xdou mission-completion-check', status: 'skipped', output: 'No git diff to verify mission symbols against (in-place run).', exitCode: 0 };
    const combined: ValidationResult[] = [...validation, generatedAcceptance, diffRequired, missionCompletion];
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
    // The parsed verdict is authoritative: a crashed/empty reviewer already maps to a `blocked`
    // verdict, so a noisy non-zero exit alongside a valid `approve` must not discard the green review.
    return !lastMutation.ok || validation.some((v) => v.status === 'failed') || reviews.some((review) => reviewVerdictBlocks(review.verdict));
  }

  private installAbortSignalHandlers(runId: string): () => void {
    const handle = (signal: NodeJS.Signals): void => {
      killInFlightAgents(); // terminate running agent CLIs before exiting so none are orphaned
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
