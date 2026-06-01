#!/usr/bin/env node
import { Command, Flags } from '@oclif/core';
import fs from 'fs-extra';
import pc from 'picocolors';
import Table from 'cli-table3';
import YAML from 'yaml';
import { join } from 'node:path';
import { XdouOrchestrator } from './orchestrator.js';
import { defaultConfig, type TeamConfig } from './config/schema.js';
import { loadConfig } from './config/load.js';
import { launchCockpit, readCockpitState, renderCockpitSnapshot } from './tui/cockpit.js';

class Xdou extends Command {
  static override description = 'xdou: multi-agent coding from your terminal';
  static override strict = false;
  static override flags = {
    cwd: Flags.string({ default: process.cwd(), description: 'Working directory' }),
    json: Flags.boolean({ default: false }),
    agents: Flags.string({ description: 'Comma-separated agent ids for brainstorm/plan/run' }),
    'max-fix-attempts': Flags.integer({ default: 1, description: 'Maximum fixer iterations for run' }),
    snapshot: Flags.boolean({ default: false, description: 'Render cockpit once and exit' }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(Xdou);
    const [cmd, ...rest] = argv as string[];
    const cwd = flags.cwd;
    const { config } = await loadConfig(cwd);
    const orchestrator = new XdouOrchestrator(cwd, config.artifactDir, config.agents);
    const fallbackTeam = defaultConfig().teams.default;
    if (!fallbackTeam) throw new Error('Internal error: default team missing');
    const team = config.teams.default ?? fallbackTeam;
    switch (cmd) {
      case 'init': await this.initProject(cwd); break;
      case 'agents': await this.agents(orchestrator, rest, flags.json); break;
      case 'brainstorm': await this.brainstorm(orchestrator, rest, team, flags.agents); break;
      case 'plan': await this.plan(orchestrator, rest, team, flags.agents); break;
      case 'run': await this.runMission(orchestrator, rest, team, flags.agents, flags['max-fix-attempts'], flags.json); break;
      case 'apply': await this.apply(orchestrator, rest, flags.json); break;
      case 'status': await this.status(orchestrator, rest, flags.json); break;
      case 'runs': await this.runs(orchestrator, rest, flags.json); break;
      case 'context': await this.context(orchestrator, rest); break;
      case 'cockpit': await this.cockpit(orchestrator, rest, flags.snapshot); break;
      case 'config': await this.configCommand(cwd, rest); break;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        this.log('xdou: multi-agent coding from your terminal\n\nCommands:\n  init\n  agents [list|detect]\n  brainstorm <mission> [--agents a,b]\n  plan <mission>\n  run <mission> [--agents architect,implementer,reviewer] [--max-fix-attempts n] [--json]\n  apply <run-id> [--json]\n  cockpit [run-id] [--snapshot]\n  status [run-id]\n  runs list\n  context [run-id]\n  config validate');
        break;
      default: throw new Error(`Unknown command: ${cmd}. Try: xdou init | agents detect | brainstorm | plan | run | status | runs list | context | config validate`);
    }
  }

  private async initProject(cwd: string): Promise<void> {
    const configPath = join(cwd, 'xdou.yaml');
    if (await fs.pathExists(configPath)) throw new Error(`Config already exists: ${configPath}`);
    await fs.writeFile(configPath, YAML.stringify(defaultConfig()), 'utf8');
    await fs.ensureDir(join(cwd, '.xdou', 'runs'));
    await this.ensureGitignore(cwd);
    this.log(`${pc.green('created')} ${configPath}`);
  }

  private async ensureGitignore(cwd: string): Promise<void> {
    const path = join(cwd, '.gitignore');
    const current = await fs.readFile(path, 'utf8').catch(() => '');
    const required = ['.xdou/runs/', '.xdou/worktrees/'];
    const existing = current.split(/\r?\n/);
    const missing = required.filter((line) => !existing.includes(line));
    if (missing.length) await fs.appendFile(path, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`, 'utf8');
  }

  private async agents(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    const sub = args[0] ?? 'list';
    if (!['list', 'detect'].includes(sub)) throw new Error('Usage: xdou agents [list|detect]');
    const detected = await orchestrator.detectAgents();
    if (json) { this.log(JSON.stringify(detected, null, 2)); return; }
    const table = new Table({ head: ['agent', 'available', 'version/path'] });
    for (const [name, info] of Object.entries(detected)) table.push([name, info.available ? pc.green('yes') : pc.red('no'), info.version ?? info.path ?? info.error ?? '']);
    this.log(table.toString());
  }

  private mission(args: string[]): string { const text = args.join(' ').trim(); if (!text) throw new Error('Mission is required. Example: xdou run "add oauth"'); return text; }
  private parseAgents(args: string[], fallback: string[], flagValue?: string): string[] {
    if (flagValue) return flagValue.split(',').map((s) => s.trim()).filter(Boolean);
    const idx = args.indexOf('--agents');
    const value = idx >= 0 ? args[idx + 1] : undefined;
    if (idx >= 0 && !value) throw new Error('--agents requires a comma-separated value');
    return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
  }
  private cleanMissionArgs(args: string[]): string[] { const idx = args.indexOf('--agents'); return idx >= 0 ? args.slice(0, idx) : args; }
  private numberFlag(args: string[], name: string, fallback: number): number {
    const idx = args.indexOf(name);
    if (idx < 0) return fallback;
    const value = Number(args[idx + 1]);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} requires a non-negative integer`);
    return value;
  }
  private cleanRunArgs(args: string[]): string[] {
    let cleaned = this.cleanMissionArgs(args);
    const idx = cleaned.indexOf('--max-fix-attempts');
    if (idx >= 0) cleaned = [...cleaned.slice(0, idx), ...cleaned.slice(idx + 2)];
    return cleaned;
  }

  private async brainstorm(orchestrator: XdouOrchestrator, args: string[], team: TeamConfig, agentsFlag?: string): Promise<void> {
    const agents = this.parseAgents(args, team.brainstormers, agentsFlag);
    const runId = await orchestrator.brainstorm(this.mission(this.cleanMissionArgs(args)), agents);
    this.log(`${pc.green('brainstorm complete')} run=${runId} artifacts=${orchestrator.store.runDir(runId)}`);
  }

  private async plan(orchestrator: XdouOrchestrator, args: string[], team: TeamConfig, agentsFlag?: string): Promise<void> {
    const agents = this.parseAgents(args, [team.architect, team.implementer, team.reviewer[0] ?? team.architect], agentsFlag);
    const runId = await orchestrator.run({
      cwd: orchestrator.cwd,
      mission: this.mission(this.cleanRunArgs(args)),
      execute: false,
      team: agents,
      brainstormers: team.brainstormers,
      critics: [team.critic],
      reviewers: team.reviewer,
    });
    this.log(`${pc.green('plan complete')} run=${runId} artifacts=${orchestrator.store.runDir(runId)}`);
  }

  private async runMission(orchestrator: XdouOrchestrator, args: string[], team: TeamConfig, agentsFlag?: string, maxFixAttempts = 1, json = false): Promise<void> {
    const agents = this.parseAgents(args, [team.architect, team.implementer, team.reviewer[0] ?? team.architect], agentsFlag);
    const runId = await orchestrator.run({
      cwd: orchestrator.cwd,
      mission: this.mission(this.cleanRunArgs(args)),
      team: agents,
      brainstormers: team.brainstormers,
      critics: [team.critic],
      reviewers: team.reviewer,
      fixer: team.fixer,
      maxFixAttempts,
    });
    const manifest = await orchestrator.store.readManifest(runId);
    const payload = { runId, status: manifest.status, phase: manifest.phase, artifactDir: manifest.artifactDir, worktreePath: manifest.worktreePath };
    this.log(json ? JSON.stringify(payload, null, 2) : `${pc.green('run complete')} run=${runId} artifacts=${orchestrator.store.runDir(runId)}`);
  }

  private async apply(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    const runId = args[0];
    if (!runId) throw new Error('Usage: xdou apply <run-id>');
    const result = await orchestrator.applyRun(runId);
    this.log(json ? JSON.stringify(result, null, 2) : `${pc.green('applied')} run=${runId} files=${result.filesChanged}`);
  }

  private async status(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    await orchestrator.store.recoverStaleRuns();
    const runId = args[0] ?? await orchestrator.store.latestRunId();
    if (!runId) { this.log('No runs found.'); return; }
    const manifest = await orchestrator.store.readManifest(runId);
    this.log(json ? JSON.stringify(manifest, null, 2) : `${manifest.id} ${manifest.status}/${manifest.phase}\n${manifest.artifactDir}`);
  }

  private async runs(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    if ((args[0] ?? 'list') !== 'list') throw new Error('Usage: xdou runs list');
    await orchestrator.store.recoverStaleRuns();
    const runs = await orchestrator.store.listRuns();
    if (json) { this.log(JSON.stringify(runs, null, 2)); return; }
    if (!runs.length) { this.log('No runs found.'); return; }
    const table = new Table({ head: ['run', 'status', 'phase', 'mission'] });
    for (const run of runs) table.push([run.id, run.status, run.phase, run.mission]);
    this.log(table.toString());
  }

  private async context(orchestrator: XdouOrchestrator, args: string[]): Promise<void> {
    const runId = args[0] ?? await orchestrator.store.latestRunId();
    if (!runId) throw new Error('No run id supplied and no previous run found.');
    const inboxPath = join(orchestrator.store.runDir(runId), 'agents');
    this.log(inboxPath);
  }

  private async cockpit(orchestrator: XdouOrchestrator, args: string[], snapshot: boolean): Promise<void> {
    const runId = args.find((arg) => !arg.startsWith('-'));
    const state = await readCockpitState(orchestrator.store, runId);
    if (snapshot || !process.stdout.isTTY) {
      this.log(renderCockpitSnapshot(state));
      return;
    }
    await launchCockpit(state);
  }

  private async configCommand(cwd: string, args: string[]): Promise<void> {
    if ((args[0] ?? 'validate') !== 'validate') throw new Error('Usage: xdou config validate');
    const loaded = await loadConfig(cwd);
    this.log(`${pc.green('valid')} ${loaded.filepath ?? 'defaults'}`);
  }
}

void Xdou.run().catch((error: unknown) => {
  console.error(pc.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
