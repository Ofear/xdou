import fs from 'fs-extra';
import writeFileAtomic from 'write-file-atomic';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { XdouOrchestrator } from '../orchestrator.js';
import { runValidation } from './validation.js';
import type { AgentDefinition } from '../agents/registry.js';
import { defaultAgents } from '../agents/registry.js';
import type { ValidationResult } from '../types.js';
import { evaluateGoalCompletion, type CheckerConfig } from './completion-validator.js';
import { loadMcpPlugins, type McpTool } from './mcp-plugins.js';

export type LoopMode = 'loop' | 'goal';
export type LoopStatus = 'running' | 'paused' | 'stopped' | 'completed' | 'failed';

export const LOOP_ID_PATTERN = /^\d{14}-[a-f0-9]{8}$/;
const MAX_CONSECUTIVE_ERRORS = 5;
const MIN_POLL_MS = 250;
const DEFAULT_POLL_MS = 15_000;

export interface LoopManifest {
  id: string;
  mode: LoopMode;
  prompt: string;
  status: LoopStatus;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  ticks: number;
  pollIntervalMs: number;
  intervalMs: number;
  consecutiveErrors: number;
  nextRunAt: string;
  cadence?: string;
  condition?: string;
  cron?: string;
  team?: string[];
  maxTicks?: number;
  pid?: number;
  lastTickAt?: string;
  lastRunId?: string;
  completedReason?: string;
}

export interface TickRun { runId?: string; status?: string; worktreePath?: string; ok: boolean }
export interface GoalEvaluation { satisfied: boolean; evidence: string; confidence: number; validation?: ValidationResult[] }
interface TickRecord { tick: number; at: string; run: TickRun; goal?: GoalEvaluation }

export interface DaemonInvocation { execPath: string; argv: string[] }
export interface LoopHooks {
  runMission?: (loop: LoopManifest) => Promise<TickRun>;
  evaluateGoal?: (loop: LoopManifest, run: TickRun) => Promise<GoalEvaluation>;
  discoverWork?: (loop: LoopManifest) => Promise<string>;
}

export interface LoopEngineConfig {
  cwd: string;
  artifactDir?: string;
  agentDefs?: Record<string, AgentDefinition>;
  daemonInvocation?: DaemonInvocation;
  hooks?: LoopHooks;
  checkerAgent?: string;
  useSeparateChecker?: boolean;
  mcpPlugins?: {
    configPath?: string;
    tools?: McpTool[];
  };
}

export interface StartLoopOptions {
  mode: LoopMode;
  prompt: string;
  cadence?: string;
  condition?: string;
  intervalMs?: number;
  pollIntervalMs?: number;
  team?: string[];
  maxTicks?: number;
  detached?: boolean;
}

export interface ParsedCadence { intervalMs?: number; cron?: string; label: string }

const NAMED_CADENCE: Record<string, number> = {
  minutely: 60_000,
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function parseInterval(value: string): number | undefined {
  const match = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const multiplier = unit.startsWith('s') ? 1_000 : unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
  return amount * multiplier;
}

function cronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/') as [string, string | undefined];
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step in "${field}".`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') { lo = min; hi = max; }
    else if (rangePart.includes('-')) { const [a, b] = rangePart.split('-') as [string, string]; lo = Number(a); hi = Number(b); }
    else { lo = Number(rangePart); hi = lo; }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`Invalid cron field "${field}" for range ${min}-${max}.`);
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return values;
}

const CRON_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

export function isCronExpression(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  try {
    parts.forEach((part, index) => { const range = CRON_RANGES[index]!; cronField(part, range[0], range[1]); });
    return true;
  } catch { return false; }
}

export function nextCronTime(expr: string, from: Date): Date {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression "${expr}". Expected 5 fields.`);
  const [minF, hourF, domF, monF, dowF] = parts as [string, string, string, string, string];
  const minutes = cronField(minF, 0, 59);
  const hours = cronField(hourF, 0, 23);
  const doms = cronField(domF, 1, 31);
  const months = cronField(monF, 1, 12);
  const dows = cronField(dowF, 0, 6);
  const domRestricted = domF.trim() !== '*';
  const dowRestricted = dowF.trim() !== '*';
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    const dayOk = domRestricted && dowRestricted
      ? doms.has(cursor.getDate()) || dows.has(cursor.getDay())
      : doms.has(cursor.getDate()) && dows.has(cursor.getDay());
    if (minutes.has(cursor.getMinutes()) && hours.has(cursor.getHours()) && months.has(cursor.getMonth() + 1) && dayOk) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error(`Could not compute a next run time for cron "${expr}" within a year.`);
}

export function parseCadence(input: string): ParsedCadence {
  const value = input.trim();
  if (!value) throw new Error('Cadence is required.');
  const lower = value.toLowerCase();
  const named = NAMED_CADENCE[lower];
  if (named !== undefined) return { intervalMs: named, label: lower };
  const interval = parseInterval(lower);
  if (interval !== undefined) return { intervalMs: interval, label: lower };
  if (isCronExpression(value)) return { cron: value, label: value };
  throw new Error(`Unrecognized cadence "${input}". Use minutely|hourly|daily|weekly, an interval like 30s|5m|2h|1d, or a 5-field cron like "*/30 * * * *".`);
}

export function newLoopId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

export class LoopEngine {
  readonly cwd: string;
  private readonly artifactDir: string;
  private readonly loopsDir: string;
  private readonly agentDefs: Record<string, AgentDefinition>;
  private readonly daemonInvocation: DaemonInvocation | undefined;
  private readonly hooks: LoopHooks;
  private readonly checkerAgent: string | undefined;
  private readonly useSeparateChecker: boolean;
  private readonly mcpTools: McpTool[];
  private readonly mcpConfigPath: string | undefined;
  private mcpInitialized = false;

  constructor(config: LoopEngineConfig) {
    this.cwd = config.cwd;
    this.artifactDir = config.artifactDir ?? '.xdou';
    this.loopsDir = join(this.cwd, this.artifactDir, 'loops');
    this.agentDefs = config.agentDefs ?? {};
    this.daemonInvocation = config.daemonInvocation;
    this.hooks = config.hooks ?? {};
    this.checkerAgent = config.checkerAgent ?? undefined;
    this.useSeparateChecker = config.useSeparateChecker ?? false;
    this.mcpTools = config.mcpPlugins?.tools ?? [];
    this.mcpConfigPath = config.mcpPlugins?.configPath;
  }

  private async ensureMcpInitialized(): Promise<void> {
    if (this.mcpInitialized) return;
    this.mcpInitialized = true;
    if (this.mcpTools.length > 0) return;

    try {
      const loadedTools = await loadMcpPlugins(this.cwd, this.mcpConfigPath);
      this.mcpTools.push(...loadedTools);
    } catch (err) {
      console.error('[mcp] Failed to initialize plugins:', err);
    }
  }

  getMcpTools(): McpTool[] {
    return this.mcpTools;
  }

  async startLoop(options: StartLoopOptions): Promise<LoopManifest> {
    if (!options.prompt.trim()) throw new Error('A loop needs a prompt or condition.');
    const pollIntervalMs = Math.max(MIN_POLL_MS, options.pollIntervalMs ?? DEFAULT_POLL_MS);
    let cron: string | undefined;
    let intervalMs = options.intervalMs ?? 0;
    if (options.cadence) {
      const parsed = parseCadence(options.cadence);
      if (parsed.cron) cron = parsed.cron;
      else intervalMs = parsed.intervalMs ?? 0;
    }
    const now = new Date().toISOString();
    const id = newLoopId();
    const manifest: LoopManifest = {
      id,
      mode: options.mode,
      prompt: options.prompt,
      status: 'running',
      cwd: this.cwd,
      createdAt: now,
      updatedAt: now,
      ticks: 0,
      pollIntervalMs,
      intervalMs,
      consecutiveErrors: 0,
      nextRunAt: now,
      ...(options.cadence ? { cadence: options.cadence } : {}),
      ...(cron ? { cron } : {}),
      ...(options.condition ? { condition: options.condition } : {}),
      ...(options.team && options.team.length ? { team: options.team } : {}),
      ...(options.maxTicks ? { maxTicks: options.maxTicks } : {}),
    };
    await this.writeManifest(manifest);
    await this.appendLog(id, `created mode=${options.mode} cadence=${options.cadence ?? `${intervalMs}ms`} prompt=${options.prompt.slice(0, 120)}`);
    if (options.detached === false) return manifest;
    const pid = this.spawnDaemon(id);
    return pid === undefined ? manifest : this.patchManifest(id, { pid });
  }

  async getLoopStatus(id: string): Promise<LoopManifest> {
    const path = this.manifestPath(id);
    if (!(await fs.pathExists(path))) throw new Error(`Loop "${id}" not found.`);
    return await fs.readJson(path) as LoopManifest;
  }

  async listLoops(): Promise<LoopManifest[]> {
    if (!(await fs.pathExists(this.loopsDir))) return [];
    const entries = await fs.readdir(this.loopsDir);
    const loops: LoopManifest[] = [];
    for (const entry of entries.sort()) {
      const path = join(this.loopsDir, entry, 'manifest.json');
      if (await fs.pathExists(path)) loops.push(await fs.readJson(path) as LoopManifest);
    }
    return loops;
  }

  async pauseLoop(id: string): Promise<LoopManifest> {
    const loop = await this.getLoopStatus(id);
    if (loop.status === 'completed' || loop.status === 'stopped') throw new Error(`Loop "${id}" is ${loop.status}; cannot pause.`);
    const updated = await this.patchManifest(id, { status: 'paused' });
    await this.appendLog(id, 'paused by operator');
    return updated;
  }

  async resumeLoop(id: string): Promise<LoopManifest> {
    const loop = await this.getLoopStatus(id);
    if (loop.status === 'completed') throw new Error(`Loop "${id}" already completed; cannot resume.`);
    let updated = await this.patchManifest(id, { status: 'running', nextRunAt: new Date().toISOString() });
    if ((!loop.pid || !this.isPidAlive(loop.pid)) && this.daemonInvocation) {
      const pid = this.spawnDaemon(id);
      if (pid !== undefined) updated = await this.patchManifest(id, { pid });
    }
    await this.appendLog(id, 'resumed by operator');
    return updated;
  }

  async stopLoop(id: string): Promise<LoopManifest> {
    const loop = await this.getLoopStatus(id);
    const updated = await this.patchManifest(id, { status: 'stopped', completedReason: 'stopped by operator' });
    this.killPid(loop.pid);
    await this.appendLog(id, 'stopped by operator');
    return updated;
  }

  async readLogs(id: string, tail = 200): Promise<string> {
    await this.getLoopStatus(id);
    const content = await fs.readFile(this.logPath(id), 'utf8').catch(() => '');
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-tail).join('\n');
  }

  /** Mark daemonized loops whose process has died as failed. */
  async reconcile(): Promise<LoopManifest[]> {
    const updated: LoopManifest[] = [];
    for (const loop of await this.listLoops()) {
      if (loop.status !== 'running' && loop.status !== 'paused') continue;
      if (!loop.pid || this.isPidAlive(loop.pid)) continue;
      updated.push(await this.patchManifest(loop.id, { status: 'failed', completedReason: 'daemon process is no longer running' }));
    }
    return updated;
  }

  /** Long-running background body invoked by `xdou loops _run <id>`. */
  async runDaemon(id: string): Promise<void> {
    await this.patchManifest(id, { pid: process.pid });
    await this.appendLog(id, `daemon started pid=${process.pid}`);
    for (;;) {
      let loop: LoopManifest;
      try { loop = await this.getLoopStatus(id); }
      catch { return; }
      if (loop.status === 'stopped' || loop.status === 'completed' || loop.status === 'failed') {
        await this.appendLog(id, `daemon exiting: status=${loop.status}`);
        return;
      }
      if (loop.status === 'paused') { await sleep(loop.pollIntervalMs); continue; }
      const now = Date.now();
      const nextRun = Date.parse(loop.nextRunAt);
      if (!Number.isFinite(nextRun) || now >= nextRun) { await this.runTick(id, loop); continue; }
      await sleep(Math.max(MIN_POLL_MS, Math.min(loop.pollIntervalMs, nextRun - now)));
    }
  }

  /** Execute exactly one tick. Exposed for testing and inline drivers. */
  async runTick(id: string, loop?: LoopManifest): Promise<LoopManifest> {
    const current = loop ?? await this.getLoopStatus(id);
    const tickNumber = current.ticks + 1;
    await this.appendLog(id, `tick ${tickNumber} starting (mode=${current.mode})`);
    try {
      let missionPrompt = current.prompt;

      // For goal mode, discover work and augment the mission
      if (current.mode === 'goal' && this.hooks.discoverWork) {
        const discoveredWork = await this.hooks.discoverWork(current);
        if (discoveredWork && discoveredWork.trim() !== 'No discoverable work found. Project appears healthy.') {
          missionPrompt = `${current.prompt}\n\n${discoveredWork}`;
          await this.appendLog(id, 'work discovery completed - mission augmented');
        }
      }

      const run = await this.invokeRunMission({ ...current, prompt: missionPrompt });
      const record: TickRecord = { tick: tickNumber, at: new Date().toISOString(), run };
      let completed = false;
      let reason: string | undefined;
      if (current.mode === 'goal') {
        const evaluation = await this.invokeEvaluateGoal(current, run);
        record.goal = evaluation;
        if (evaluation.satisfied) { completed = true; reason = evaluation.evidence; }
      }
      await this.writeTick(id, tickNumber, record);
      const latest = await this.getLoopStatus(id);
      if (latest.status === 'stopped') return latest;
      const patch: Partial<LoopManifest> = { ticks: tickNumber, lastTickAt: new Date().toISOString(), consecutiveErrors: 0 };
      if (run.runId) patch.lastRunId = run.runId;
      if (completed) { patch.status = 'completed'; patch.completedReason = reason ?? 'goal satisfied'; }
      else if (current.maxTicks && tickNumber >= current.maxTicks) { patch.status = 'completed'; patch.completedReason = `reached maxTicks=${current.maxTicks}`; }
      else patch.nextRunAt = this.computeNextRun(current, new Date()).toISOString();
      const updated = await this.patchManifest(id, patch);
      await this.appendLog(id, `tick ${tickNumber} done run=${run.runId ?? 'n/a'} status=${run.status ?? 'n/a'}${completed ? ' [goal satisfied]' : ''}`);
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const consecutiveErrors = current.consecutiveErrors + 1;
      await this.appendLog(id, `tick ${tickNumber} error: ${message}`);
      const patch: Partial<LoopManifest> = { consecutiveErrors };
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { patch.status = 'failed'; patch.completedReason = `aborted after ${consecutiveErrors} consecutive errors: ${message}`; }
      else patch.nextRunAt = this.computeNextRun(current, new Date()).toISOString();
      return this.patchManifest(id, patch);
    }
  }

  private computeNextRun(loop: LoopManifest, from: Date): Date {
    if (loop.cron) return nextCronTime(loop.cron, from);
    return new Date(from.getTime() + loop.intervalMs);
  }

  private invokeRunMission(loop: LoopManifest): Promise<TickRun> {
    return this.hooks.runMission ? this.hooks.runMission(loop) : this.defaultRunMission(loop);
  }

  private invokeEvaluateGoal(loop: LoopManifest, run: TickRun): Promise<GoalEvaluation> {
    return this.hooks.evaluateGoal ? this.hooks.evaluateGoal(loop, run) : this.defaultEvaluateGoal(loop, run);
  }

  private async defaultRunMission(loop: LoopManifest): Promise<TickRun> {
    const orchestrator = new XdouOrchestrator(loop.cwd, this.artifactDir, this.agentDefs);
    const runId = await orchestrator.run({
      cwd: loop.cwd,
      mission: loop.prompt,
      maxFixAttempts: 1,
      ...(loop.team && loop.team.length ? { team: loop.team } : {}),
    });
    const manifest = await orchestrator.store.readManifest(runId);
    return {
      runId,
      status: manifest.status,
      ok: manifest.status === 'completed',
      ...(manifest.worktreePath ? { worktreePath: manifest.worktreePath } : {}),
    };
  }

  private async defaultEvaluateGoal(loop: LoopManifest, run: TickRun): Promise<GoalEvaluation> {
    if (this.useSeparateChecker && this.checkerAgent && loop.condition) {
      const checkerConfig: CheckerConfig = {
        cwd: loop.cwd,
        agentDefs: defaultAgents(this.agentDefs),
        checkerAgent: this.checkerAgent,
        useSeparateChecker: true,
      };
      return evaluateGoalCompletion(checkerConfig, loop.condition, {
        mission: loop.prompt,
        ...(run.worktreePath ? { worktreePath: run.worktreePath } : {}),
      });
    }

    // Phase 1 uses deterministic build/test/lint validation as the completion signal.
    // The natural-language "separate checker" agent arrives with the Phase 3 completion validator.
    const checkCwd = run.worktreePath && await fs.pathExists(run.worktreePath) ? run.worktreePath : loop.cwd;
    const validation = await runValidation(checkCwd);
    const failures = validation.filter((result) => result.status === 'failed');
    const passed = validation.filter((result) => result.status === 'passed');
    const satisfied = failures.length === 0 && passed.length > 0;
    const evidence = satisfied
      ? `All ${passed.length} validation command(s) passed in ${checkCwd}.`
      : failures.length
        ? `${failures.length} validation failure(s): ${failures.map((result) => result.command).join(', ')}`
        : 'No validation commands detected; goal cannot be confirmed deterministically.';
    return { satisfied, evidence, confidence: satisfied ? 1 : 0.5, validation };
  }

  private spawnDaemon(id: string): number | undefined {
    if (!this.daemonInvocation) throw new Error('Cannot start a background loop: daemon invocation is not configured.');
    const out = fs.openSync(this.logPath(id), 'a');
    try {
      const child = spawn(this.daemonInvocation.execPath, [...this.daemonInvocation.argv, 'loops', '_run', id, '--cwd', this.cwd], {
        cwd: this.cwd,
        detached: true,
        stdio: ['ignore', out, out],
        windowsHide: true,
      });
      child.unref();
      return child.pid;
    } finally {
      fs.closeSync(out);
    }
  }

  private killPid(pid: number | undefined): void {
    if (!pid || !this.isPidAlive(pid)) return;
    try { process.kill(pid); } catch { /* already gone */ }
  }

  private isPidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch { return false; }
  }

  private loopDir(id: string): string { this.assertId(id); return join(this.loopsDir, id); }
  private manifestPath(id: string): string { return join(this.loopDir(id), 'manifest.json'); }
  private logPath(id: string): string { return join(this.loopDir(id), 'daemon.log'); }
  private assertId(id: string): void { if (!LOOP_ID_PATTERN.test(id)) throw new Error(`Invalid loop id "${id}". Expected YYYYMMDDHHMMSS-xxxxxxxx.`); }

  private async writeManifest(manifest: LoopManifest): Promise<void> {
    await fs.ensureDir(this.loopDir(manifest.id));
    await writeFileAtomic(this.manifestPath(manifest.id), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  private async patchManifest(id: string, patch: Partial<LoopManifest>): Promise<LoopManifest> {
    const current = await this.getLoopStatus(id);
    const next: LoopManifest = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await this.writeManifest(next);
    return next;
  }

  private async appendLog(id: string, message: string): Promise<void> {
    await fs.ensureDir(this.loopDir(id));
    await fs.appendFile(this.logPath(id), `${new Date().toISOString()} ${message}\n`, 'utf8');
  }

  private async writeTick(id: string, tick: number, record: TickRecord): Promise<void> {
    const dir = join(this.loopDir(id), 'ticks');
    await fs.ensureDir(dir);
    await writeFileAtomic(join(dir, `${String(tick).padStart(4, '0')}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
}
