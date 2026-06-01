# xdou

`xdou` is a terminal-native multi-agent development system.

Its north star: selected coding and architecture agents co-develop like a coordinated council of genius collaborators. The operator gives the mission; `xdou` coordinates council proposals, architectural synthesis, implementation, independent review, validation, fix iterations, and durable run artifacts.

## What it does

`xdou` coordinates Claude Code, Codex, OpenCode, OpenRouter, and future agents through an artifact-based context bus. Agents do not share raw chat by default. The orchestrator compiles role-specific context packets, stores every run under `.xdou/runs/<run-id>/`, captures diffs/validation/reviews, and keeps the operator in control.

A full run follows this loop:

1. **Council** — brainstormer and critic agents independently propose approaches and risks.
2. **Synthesis** — the architect agent turns council input into one canonical plan.
3. **Implementation** — the implementer agent executes against the synthesized plan.
4. **Validation** — detected project test/build/typecheck commands run automatically.
5. **Review** — one or more reviewer agents inspect the diff and validation result.
6. **Fix loop** — if implementation, validation, or review blocks, the fixer agent patches and validation/review rerun up to `--max-fix-attempts`.
7. **Summary** — final run state is written to `.xdou/runs/<run-id>/final-summary.md`.

## Install / local development

```bash
npm install
npm run build
node dist/cli.js help
```

During development you can run from source:

```bash
npm run dev -- help
```

## Commands

```bash
xdou init
xdou agents detect
xdou brainstorm "Design the implementation"
xdou plan "Add GitHub OAuth login"
xdou run "Add GitHub OAuth login" --max-fix-attempts 2
xdou cockpit
xdou cockpit --snapshot
xdou status
xdou status --json
xdou runs list
xdou runs list --json
xdou context
xdou apply <run-id>
xdou config validate
```

Global flags:

```bash
--cwd <path>              Run against another repository
--json                    Emit machine-readable JSON where supported
--agents a,b,c            Override team agents for brainstorm/plan/run
--max-fix-attempts <n>    Maximum fixer iterations for xdou run
```

## Cockpit TUI

`xdou cockpit` opens a terminal mission-control view over the existing artifact store. It does not replace `.xdou`; it reads run manifests, timeline events, review verdicts, artifact paths, and safe action hints from the same canonical files.

```bash
xdou cockpit              # interactive terminal cockpit
xdou cockpit <run-id>     # inspect one run
xdou cockpit --snapshot   # print once and exit for CI/logging
```

The cockpit defaults to high-signal operator context: current run status, mission, artifacts, review verdicts, recent timeline events, and safe commands such as `xdou apply <run-id>`.

## Safety model

- `xdou run` refuses to launch mutating coding agents unless the operator checkout is a clean git worktree.
- Mutating implementation, validation, review, and fixer phases run in an isolated git worktree by default.
- The operator checkout remains untouched; generated changes live in `.xdou/worktrees/<run-id>/`.
- The canonical patch is captured at `.xdou/runs/<run-id>/diff.patch`.
- `xdou init` adds `.xdou/runs/` and `.xdou/worktrees/` to `.gitignore` so xdou artifacts do not dirty the project.
- High-autonomy modes such as Codex `fullAuto` are opt-in through config.

## Applying generated changes

Inspect the run first:

```bash
xdou status
xdou context
xdou runs list
```

Then inspect artifacts:

```bash
cat .xdou/runs/<run-id>/final-summary.md
cat .xdou/runs/<run-id>/diff.patch
```

Apply the captured patch through xdou after review:

```bash
xdou apply <run-id>
```

For manual inspection, the canonical patch remains available:

```bash
cat .xdou/runs/<run-id>/diff.patch
```

Or inspect the isolated worktree directly:

```bash
cd .xdou/worktrees/<run-id>
git diff HEAD -- .
```

Failed/blocked runs preserve their worktree for debugging.

## Artifacts

Each run creates inspectable artifacts under `.xdou/runs/<run-id>/`, including:

- `mission.md`
- `project.md`
- `council.md`
- `plan.md`
- `synthesis.md`
- `diff.patch`
- `validation.json`
- `generated-acceptance.json`
- `mission-check.json`
- `review.md`
- `review-verdicts.json`
- `final-summary.md`
- `timeline.ndjson`
- `fixes/attempt-<n>/...` when fixer iterations run
- per-agent inbox/result files under `agents/<agent-id>/`

## Requirements

- Node.js >= 20.19
- Git repository for project runs
- Optional external agents installed/authenticated:
  - `claude`
  - `codex`
  - `opencode`

## Configuration

Edit `xdou.yaml`:

```yaml
artifactDir: .xdou

agents:
  qwen:
    type: openrouter
    model: qwen/qwen3-coder
    roles: [critic, reviewer]
  safe-codex:
    type: codex
    command: codex
    fullAuto: false

teams:
  default:
    brainstormers: [claude, codex, qwen]
    architect: claude
    critic: qwen
    implementer: safe-codex
    reviewer: [claude, qwen]
    fixer: safe-codex
```

Validate config:

```bash
xdou config validate
```

## Design principles

- Use existing OSS agent CLIs/APIs instead of reinventing coding agents.
- Claude Code: architecture/review/debugging.
- Codex: implementation/fixes/refactors.
- OpenCode: optional provider-agnostic worker.
- OpenRouter: optional reasoning/review council member via `OPENROUTER_API_KEY`.
- Context sharing is artifact-based: mission, council, synthesis, plan, diff, validation, reviews, summary.
- External agent commands are invoked with argv arrays, not shell prompt interpolation.
- Validation commands may use shell syntax and are run only after code generation in the isolated worktree.

## Security notes

External coding agents can execute commands and modify files in the isolated worktree. Use trusted repositories, review generated patches before applying, and keep high-autonomy modes opt-in. API keys such as `OPENROUTER_API_KEY` are read from the environment by the relevant adapter.
