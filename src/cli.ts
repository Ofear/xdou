#!/usr/bin/env node
import { Command, Flags } from '@oclif/core';
import fs from 'fs-extra';
import pc from 'picocolors';
import Table from 'cli-table3';
import YAML from 'yaml';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execa } from 'execa';
import { XdouOrchestrator } from './orchestrator.js';
import { defaultConfig, type TeamConfig, type XdouConfig } from './config/schema.js';
import { loadConfig } from './config/load.js';
import { isActionableCodingMission, launchCockpit, readCockpitState, renderCockpitSnapshot, type CockpitOperatorCommand } from './tui/cockpit.js';
import { shouldAnswerAskLocally } from './core/ask-routing.js';
import { isGitRepo, hasGitHead } from './core/repo.js';
import { selectAgents } from './agents/registry.js';
import { runLoopCommand, type LoopCommandContext } from './commands/loop.js';
import { runGoalCommand } from './commands/goal.js';
import { runLoopsCommand } from './commands/loops.js';
import { runPluginsCommand, type PluginCommandContext } from './commands/plugins.js';
import type { DaemonInvocation } from './core/loop-engine.js';

interface ProjectResolutionOptions { project?: string | undefined; yes?: boolean; noInit?: boolean; dryRun?: boolean }

class Xdou extends Command {
  static override description = 'xdou: multi-agent coding from your terminal';
  static override strict = false;
  static override flags = {
    cwd: Flags.string({ default: process.cwd(), description: 'Working directory' }),
    json: Flags.boolean({ default: false }),
    agents: Flags.string({ description: 'Comma-separated agent ids for brainstorm/plan/run' }),
    'max-fix-attempts': Flags.integer({ default: 1, description: 'Maximum fixer iterations for run' }),
    snapshot: Flags.boolean({ default: false, description: 'Render cockpit once and exit' }),
    project: Flags.string({ description: 'Project folder to use/create for coding missions' }),
    yes: Flags.boolean({ default: false, description: 'Approve safe defaults in non-interactive flows' }),
    'no-init': Flags.boolean({ default: false, description: 'Refuse automatic Git initialization' }),
    'dry-run': Flags.boolean({ default: false, description: 'Resolve/preflight without launching agents' }),
    help: Flags.boolean({ char: 'h', description: 'Show help' }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(Xdou);
    const [cmd, ...rest] = argv as string[];
    if (flags.help) { this.log(this.helpText()); return; }
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
      case 'ask': await this.ask(orchestrator, rest, team); break;
      case 'find': await this.findCommand(cwd, rest); break;
      case 'plan': await this.plan(orchestrator, rest, team, flags.agents, { project: flags.project, yes: flags.yes, noInit: flags['no-init'], dryRun: flags['dry-run'] }); break;
      case 'run': await this.runMission(orchestrator, rest, team, flags.agents, flags['max-fix-attempts'], flags.json, { project: flags.project, yes: flags.yes, noInit: flags['no-init'], dryRun: flags['dry-run'] }); break;
      case 'apply': await this.apply(orchestrator, rest, flags.json); break;
      case 'test': await this.testRun(orchestrator, rest, flags.json); break;
      case 'discard': await this.discard(orchestrator, rest, flags.json); break;
      case 'undo': await this.undo(orchestrator, rest, flags.json); break;
      case 'status': await this.status(orchestrator, rest, flags.json); break;
      case 'runs': await this.runs(orchestrator, rest, flags.json); break;
      case 'context': await this.context(orchestrator, rest); break;
      case 'collab': await this.collab(orchestrator, rest, flags.json); break;
      case 'cockpit': await this.cockpit(orchestrator, rest, flags.snapshot, team, flags.agents, flags['max-fix-attempts'], flags.json); break;
      case 'loop': await runLoopCommand(this.loopContext(cwd, config, rest, flags.json, flags.agents)); break;
      case 'goal': await runGoalCommand(this.loopContext(cwd, config, rest, flags.json, flags.agents)); break;
      case 'loops': await runLoopsCommand(this.loopContext(cwd, config, rest, flags.json, flags.agents)); break;
      case 'plugins': await runPluginsCommand(this.pluginContext(cwd, rest, flags.json)); break;
      case 'config': await this.configCommand(cwd, rest); break;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        this.log(this.helpText());
        break;
      default: throw new Error(`Unknown command: ${cmd}. Try: xdou init | agents detect | brainstorm | plan | run | loop | goal | loops list | plugins init|load|list|call|unload | status | runs list | context | config validate`);
    }
  }

  private helpText(): string {
    return 'xdou: multi-agent coding from your terminal\\n\\nCommands:\\n  init\\n  agents [list|detect]\\n  ask <question>\\n  find <file-query>\\n  brainstorm <mission> [--agents a,b]\\n  plan <mission>\\n  run <mission> [--agents architect,implementer,reviewer] [--max-fix-attempts n] [--project path] [--yes] [--json]\\n  apply [run-id] [--json]\\n  test [run-id] [--json]\\n  discard [run-id] [--json]\\n  undo [run-id] [--json]\\n  cockpit [run-id] [--snapshot]\\n  loop <cadence> <prompt>     Run a prompt on a schedule (hourly|daily|30m|"*/30 * * * *")\\n  goal <condition>            Run until a verifiable condition is satisfied\\n  loops list                  List loops with status\\n  loops pause|resume|stop <id>  Control a loop\\n  loops logs <id> [--tail n]  View loop execution logs\\n  plugins init|load|list|call|unload  Manage MCP plugins\\n  status [run-id]\\n  runs list\\n  context [run-id]\\n  config validate';
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
    const required = ['.xdou/runs/', '.xdou/worktrees/', '.xdou/loops/'];
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
    for (const name of ['--max-fix-attempts', '--project']) {
      const idx = cleaned.indexOf(name);
      if (idx >= 0) cleaned = [...cleaned.slice(0, idx), ...cleaned.slice(idx + 2)];
    }
    cleaned = cleaned.filter((arg) => !['--yes', '--no-init', '--dry-run'].includes(arg));
    return cleaned;
  }

  private async brainstorm(orchestrator: XdouOrchestrator, args: string[], team: TeamConfig, agentsFlag?: string): Promise<void> {
    const agents = this.parseAgents(args, team.brainstormers, agentsFlag);
    const runId = await orchestrator.brainstorm(this.mission(this.cleanMissionArgs(args)), agents);
    this.log(`${pc.green('brainstorm complete')} run=${runId} artifacts=${orchestrator.store.runDir(runId)}`);
  }

  private async ask(orchestrator: XdouOrchestrator, args: string[], team: TeamConfig): Promise<void> {
    const prompt = this.mission(args);
    if (shouldAnswerAskLocally(prompt)) {
      this.log(`Hi! How can I help? You can ask a question, or use /plan <idea> /code <idea> for coding work.\n\nYou said: ${prompt}`);
      return;
    }
    await this.askAssistant(orchestrator, prompt, team);
  }

  private async findCommand(cwd: string, args: string[]): Promise<void> {
    await this.findFiles(cwd, this.mission(args));
  }

  private async plan(orchestrator: XdouOrchestrator, args: string[], team: TeamConfig, agentsFlag?: string, projectOptions: ProjectResolutionOptions = {}): Promise<void> {
    const mission = this.mission(this.cleanRunArgs(args));
    this.ensureActionableMission(mission);
    const missionCwd = await this.prepareGitForMission(orchestrator.cwd, mission, projectOptions);
    if (projectOptions.dryRun) { this.log(`${pc.green('plan preflight ok')} cwd=${missionCwd} mission=${mission}`); return; }
    const activeOrchestrator = missionCwd === orchestrator.cwd ? orchestrator : this.orchestratorForCwd(orchestrator, missionCwd);
    const agents = this.parseAgents(args, [team.architect, team.implementer, team.reviewer[0] ?? team.architect], agentsFlag);
    const runId = await activeOrchestrator.run({
      cwd: activeOrchestrator.cwd,
      mission,
      execute: false,
      team: agents,
      brainstormers: team.brainstormers,
      critics: [team.critic],
      reviewers: team.reviewer,
    });
    this.log(`${pc.green('plan complete')} run=${runId} artifacts=${activeOrchestrator.store.runDir(runId)}`);
  }

  private async runMission(orchestrator: XdouOrchestrator, args: string[], team: TeamConfig, agentsFlag?: string, maxFixAttempts = 1, json = false, projectOptions: ProjectResolutionOptions = {}): Promise<void> {
    const mission = this.mission(this.cleanRunArgs(args));
    this.ensureActionableMission(mission);
    const missionCwd = await this.prepareGitForMission(orchestrator.cwd, mission, projectOptions);
    if (projectOptions.dryRun) { this.log(`${pc.green('run preflight ok')} cwd=${missionCwd} mission=${mission}`); return; }
    const activeOrchestrator = missionCwd === orchestrator.cwd ? orchestrator : this.orchestratorForCwd(orchestrator, missionCwd);
    const agents = this.parseAgents(args, [team.architect, team.implementer, team.reviewer[0] ?? team.architect], agentsFlag);
    const runId = await activeOrchestrator.run({
      cwd: activeOrchestrator.cwd,
      mission,
      team: agents,
      brainstormers: team.brainstormers,
      critics: [team.critic],
      reviewers: team.reviewer,
      fixer: team.fixer,
      maxFixAttempts,
    });
    const manifest = await activeOrchestrator.store.readManifest(runId);
    const payload = { runId, status: manifest.status, phase: manifest.phase, artifactDir: manifest.artifactDir, worktreePath: manifest.worktreePath };
    this.log(json ? JSON.stringify(payload, null, 2) : `${pc.green('run complete')} run=${runId} artifacts=${activeOrchestrator.store.runDir(runId)}`);
  }

  private async apply(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    const runId = args[0] ?? await orchestrator.store.latestRunId();
    if (!runId) throw new Error('Usage: xdou apply <run-id>');
    const result = await orchestrator.applyRun(runId);
    this.log(json ? JSON.stringify(result, null, 2) : `${pc.green('applied')} run=${runId} files=${result.filesChanged}`);
  }

  private async testRun(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    const runId = args[0] ?? await orchestrator.store.latestRunId();
    if (!runId) throw new Error('Usage: xdou test <run-id>');
    const result = await orchestrator.rerunValidation(runId);
    const failed = result.validation.filter((item) => item.status === 'failed').length;
    this.log(json ? JSON.stringify(result, null, 2) : `validation complete run=${runId} failed=${failed}`);
  }

  private async discard(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    const runId = args[0] ?? await orchestrator.store.latestRunId();
    if (!runId) throw new Error('Usage: xdou discard <run-id>');
    const result = await orchestrator.discardRun(runId);
    this.log(json ? JSON.stringify(result, null, 2) : `discarded run=${runId}`);
  }

  private async undo(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    const runId = args[0] ?? await orchestrator.store.latestRunId();
    if (!runId) throw new Error('Usage: xdou undo <run-id>');
    const result = await orchestrator.undoRun(runId);
    this.log(json ? JSON.stringify(result, null, 2) : `undone run=${runId} files=${result.filesChanged}`);
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

  private async collab(orchestrator: XdouOrchestrator, args: string[], json: boolean): Promise<void> {
    const sub = args[0];
    if (sub === 'send') {
      const [runId, from, to, severity, ...messageParts] = args.slice(1);
      const message = messageParts.join(' ').trim();
      if (!runId || !from || !to || !severity || !message) throw new Error('Usage: xdou collab send <run-id> <from> <to> <info|suggestion|warning|blocker> <message>');
      if (!['info', 'suggestion', 'warning', 'blocker'].includes(severity)) throw new Error('Severity must be info, suggestion, warning, or blocker.');
      await orchestrator.messageAgent(runId, from, to, message, severity as 'info' | 'suggestion' | 'warning' | 'blocker');
      this.log(json ? JSON.stringify({ runId, from, to, severity, message }, null, 2) : `sent ${severity} ${from} -> ${to}`);
      return;
    }
    const runId = sub ?? await orchestrator.store.latestRunId();
    if (!runId) throw new Error('Usage: xdou collab <run-id>');
    const state = await orchestrator.collaboration(runId);
    if (json) { this.log(JSON.stringify(state, null, 2)); return; }
    this.log([
      `Shared room for run ${runId}`,
      `Events: ${state.events.length}`,
      `Agents: ${state.agents.map((agent) => agent.id).join(', ') || 'none'}`,
      ...state.blockers.slice(-5).map((event) => `BLOCKER ${event.from}${event.to ? ` -> ${event.to}` : ''}: ${event.message ?? event.type}`),
      ...state.warnings.slice(-5).map((event) => `WARN ${event.from}${event.to ? ` -> ${event.to}` : ''}: ${event.message ?? event.type}`),
      ...state.latestPatchDeltas.slice(-5).map((event) => `PATCH ${event.from}: ${event.file}`),
    ].join('\n'));
  }

  private async cockpit(orchestrator: XdouOrchestrator, args: string[], snapshot: boolean, team: TeamConfig, agentsFlag?: string, maxFixAttempts = 1, json = false): Promise<void> {
    let selectedRunId = args.find((arg) => !arg.startsWith('-'));
    for (;;) {
      const state = await readCockpitState(orchestrator.store, selectedRunId);
      if (snapshot || !process.stdout.isTTY) {
        const width = process.stdout.columns || Number(process.env.COLUMNS) || 120;
        this.log(renderCockpitSnapshot(state, width));
        return;
      }
      const result = await launchCockpit(state);
      if (result.kind === 'exit') return;
      if (result.kind === 'operator') {
        const handled = await this.handleCockpitOperatorCommand(orchestrator, result.command, team, json);
        selectedRunId = handled ?? selectedRunId;
        continue;
      }
      this.log(`${pc.cyan('starting')} ${result.command} mission: ${result.mission}`);
      if (result.command === 'plan') await this.plan(orchestrator, [result.mission], team, agentsFlag);
      else await this.runMission(orchestrator, [result.mission], team, agentsFlag, maxFixAttempts, json);
      selectedRunId = await orchestrator.store.latestRunId();
    }
  }

  private async prepareGitForMission(cwd: string, mission: string, options: ProjectResolutionOptions = {}): Promise<string> {
    let projectCwd = options.project ? resolve(cwd, options.project) : cwd;
    if (!(await isGitRepo(projectCwd))) {
      if (options.noInit) throw new Error(`Project folder is not a Git repository: ${projectCwd}`);
      if (!options.project && (this.isUnsafeAutoInitDir(cwd) || options.yes)) {
        projectCwd = await this.resolveApprovedProjectFolder(cwd, mission, options);
      }
      if (options.dryRun) return projectCwd;
      await fs.ensureDir(projectCwd);
      this.log(`${pc.cyan('initializing git')} ${projectCwd}`);
      await execa('git', ['init'], { cwd: projectCwd });
      await this.ensureGitignore(projectCwd);
    }
    if (options.dryRun) return projectCwd;
    if (!(await hasGitHead(projectCwd))) {
      this.log(`${pc.cyan('creating git baseline')} initial xdou baseline commit`);
      await execa('git', ['add', '.'], { cwd: projectCwd });
      await execa('git', ['commit', '--allow-empty', '-m', 'chore: initialize xdou workspace'], {
        cwd: projectCwd,
        env: {
          GIT_AUTHOR_NAME: 'xdou',
          GIT_AUTHOR_EMAIL: 'xdou@example.local',
          GIT_COMMITTER_NAME: 'xdou',
          GIT_COMMITTER_EMAIL: 'xdou@example.local',
        },
      });
    }
    return projectCwd;
  }

  private ensureActionableMission(mission: string): void {
    if (isActionableCodingMission(mission)) return;
    throw new Error([
      'That does not look like a coding mission yet.',
      `If you just want to chat, use: /ask ${mission}`,
      'If you want code, describe the change, e.g. /code build a todo app or /plan add login.',
    ].join('\n'));
  }

  private orchestratorForCwd(orchestrator: XdouOrchestrator, cwd: string): XdouOrchestrator {
    return new XdouOrchestrator(cwd, '.xdou', {}, orchestrator.agents);
  }

  private async resolveApprovedProjectFolder(cwd: string, mission: string, options: ProjectResolutionOptions = {}): Promise<string> {
    const suggested = this.suggestProjectFolder(mission, cwd);
    const guidance = [
      'Coding missions need a project folder.',
      `Suggested project folder: ${suggested}`,
      'Approve it, or counter with: xdou cockpit --cwd <your-folder>. Non-interactive: use --yes or --project <folder>.',
      'I will initialize Git there automatically if needed.',
    ].join('\n');
    if (options.yes) return suggested;
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(guidance);

    this.log(guidance);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question('Use suggested folder? [Y/n/path] ')).trim();
      if (!answer || /^y(es)?$/i.test(answer)) return suggested;
      if (/^n(o)?$/i.test(answer)) throw new Error('Cancelled. Restart with: xdou cockpit --cwd <folder>');
      return isAbsolute(answer) ? answer : resolve(cwd, answer);
    } finally {
      rl.close();
    }
  }

  private suggestProjectFolder(mission: string, baseDir?: string): string {
    const home = baseDir || process.env.USERPROFILE || process.env.HOME || process.cwd();
    const slug = mission.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'xdou-project';
    return join(home, 'projects', slug);
  }

  private isUnsafeAutoInitDir(cwd: string): boolean {
    const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const home = (process.env.USERPROFILE || process.env.HOME || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    return Boolean(home && normalized === home) || /^[a-z]:$/i.test(normalized) || normalized === '/';
  }

  private async handleCockpitOperatorCommand(orchestrator: XdouOrchestrator, command: CockpitOperatorCommand, team: TeamConfig, json = false): Promise<string | undefined> {
    if (command.action === 'ask') { await this.askAssistant(orchestrator, command.prompt, team); return; }
    if (command.action === 'web') { await this.askAssistant(orchestrator, `Use web/research ability if available. Answer this: ${command.query}`, team); return; }
    if (command.action === 'find') { await this.findFiles(orchestrator.cwd, command.query); return; }
    if (command.action === 'continue') { this.log('Continue: cockpit refreshed. Select a run or type /code, /plan, /ask, /find, /web, /diff, /review, /status, /test, /fix, /apply, /discard, or /undo.'); return; }
    if (command.action === 'diff') { await this.printRunArtifact(orchestrator, command.runId, 'diff.patch', 'No diff produced yet.'); return command.runId; }
    if (command.action === 'review') { await this.printRunArtifact(orchestrator, command.runId, 'review.md', 'No review produced yet.'); return command.runId; }
    if (command.action === 'status') { await this.status(orchestrator, command.runId ? [command.runId] : [], json); return command.runId; }
    if (command.action === 'apply') { await this.apply(orchestrator, command.runId ? [command.runId] : [], json); return command.runId; }
    if (command.action === 'test') { await this.testRun(orchestrator, command.runId ? [command.runId] : [], json); return command.runId; }
    if (command.action === 'discard') { await this.discard(orchestrator, command.runId ? [command.runId] : [], json); return command.runId; }
    if (command.action === 'undo') { await this.undo(orchestrator, command.runId ? [command.runId] : [], json); return command.runId; }
    if (command.action === 'fix') {
      const runId = command.runId ?? await orchestrator.store.latestRunId();
      const mission = runId ? `Fix the blockers in xdou run ${runId}. Inspect its review, validation, diff, and artifacts, then produce a corrected patch.` : 'Fix the latest xdou run blockers.';
      await this.runMission(orchestrator, [mission], team);
      return await orchestrator.store.latestRunId();
    }
    if (command.action === 'parallel') { await this.runMission(orchestrator, [command.mission], team); return await orchestrator.store.latestRunId(); }
    if (command.action === 'plan') { await this.plan(orchestrator, [command.mission], team); return await orchestrator.store.latestRunId(); }
    if (command.action === 'run') { await this.runMission(orchestrator, [command.mission], team); return await orchestrator.store.latestRunId(); }
    return;
  }

  private async printRunArtifact(orchestrator: XdouOrchestrator, runId: string | undefined, relativePath: string, fallback: string): Promise<void> {
    const selectedRunId = runId ?? await orchestrator.store.latestRunId();
    if (!selectedRunId) throw new Error('No run id supplied and no previous run found.');
    const manifest = await orchestrator.store.readManifest(selectedRunId);
    const path = join(orchestrator.store.runDir(selectedRunId), relativePath);
    const content = await fs.readFile(path, 'utf8').catch(() => fallback);
    this.log(`${pc.cyan(relativePath)} run=${selectedRunId} status=${manifest.status}/${manifest.phase}\n${content}`);
  }

  private async askAssistant(orchestrator: XdouOrchestrator, prompt: string, team: TeamConfig): Promise<void> {
    const [agent] = selectAgents([team.architect], orchestrator.agents);
    if (!agent) throw new Error(`Unknown assistant agent "${team.architect}".`);
    const result = await agent.run({ cwd: orchestrator.cwd, runDir: orchestrator.store.root, prompt: `Answer directly. Do not modify files unless explicitly asked. Current folder: ${orchestrator.cwd}\n\n${prompt}` });
    if (!result.ok) throw new Error(result.stderr || `${agent.id} failed`);
    this.log(result.stdout || result.stderr || '(no output)');
  }

  private async findFiles(cwd: string, query: string): Promise<void> {
    const matches: string[] = [];
    const needle = query.toLowerCase();
    const ignored = new Set(['.git', 'node_modules', '.xdou', 'dist']);
    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= 50) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (matches.length >= 50 || ignored.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.toLowerCase().includes(needle)) matches.push(path);
      }
    };
    await walk(cwd);
    this.log(matches.length ? matches.join('\n') : `No files matching "${query}" under ${cwd}`);
  }

  private async configCommand(cwd: string, args: string[]): Promise<void> {
    if ((args[0] ?? 'validate') !== 'validate') throw new Error('Usage: xdou config validate');
    const loaded = await loadConfig(cwd);
    this.log(`${pc.green('valid')} ${loaded.filepath ?? 'defaults'}`);
  }

  private loopContext(cwd: string, config: XdouConfig, args: string[], json: boolean, agentsFlag?: string): LoopCommandContext {
    return { cwd, config, args, json, agentsFlag, daemonInvocation: this.daemonInvocation(), log: (message: string) => { this.log(message); } };
  }

  private pluginContext(cwd: string, args: string[], json: boolean): PluginCommandContext {
    return { cwd, args, json, log: (message: string) => { this.log(message); } };
  }

  private daemonInvocation(): DaemonInvocation {
    // Replay the exact runtime that launched this process: node-level flags (process.execArgv,
    // which carries any TypeScript loader such as tsx's `--import`) followed by the entry script.
    // This reproduces the dev (tsx) and published (plain node dist/cli.js) launches alike, so the
    // detached daemon resolves its imports the same way the foreground process did.
    const script = process.argv[1];
    const argv = [...process.execArgv, ...(script ? [script] : [])];
    return { execPath: process.execPath, argv };
  }
}

void Xdou.run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(pc.red(message));
  process.exitCode = 1;
});
