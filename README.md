# xdou

`xdou` is a terminal-native multi-agent development system.

Its north star: selected coding and architecture agents co-develop like a coordinated council of genius collaborators. The operator gives the mission; `xdou` coordinates council proposals, architectural synthesis, implementation, independent review, validation, and durable run artifacts.

## What it does

`xdou` coordinates Claude Code, Codex, OpenCode, OpenRouter, and future agents through an artifact-based context bus. Agents do not share raw chat by default. The orchestrator compiles role-specific context packets, stores every run under `.xdou/runs/<run-id>/`, captures diffs/validation/reviews, and keeps the operator in control.

A full run follows this loop:

1. **Council** — brainstormer and critic agents independently propose approaches and risks.
2. **Synthesis** — the architect agent turns council input into one canonical plan.
3. **Implementation** — the implementer agent executes against the synthesized plan.
4. **Validation** — detected project test/build/typecheck commands run automatically.
5. **Review** — one or more reviewer agents inspect the diff and validation result.
6. **Summary** — final run state is written to `.xdou/runs/<run-id>/final-summary.md`.

## Commands

```bash
xdou init
xdou agents detect
xdou brainstorm "Design the implementation"
xdou plan "Add GitHub OAuth login"
xdou run "Add GitHub OAuth login"
xdou status
xdou status --json
xdou context
```

## Design principles

- Use existing OSS agent CLIs/APIs instead of reinventing coding agents.
- Claude Code: architecture/review/debugging.
- Codex: implementation/fixes/refactors.
- OpenCode: optional provider-agnostic worker.
- OpenRouter: optional reasoning/review council member via `OPENROUTER_API_KEY`.
- Context sharing is artifact-based: mission, council, synthesis, plan, diff, validation, reviews, summary.
- External agent commands are invoked with argv arrays, not shell prompt interpolation.
- `xdou run` refuses dirty repos before launching coding agents; use `xdou plan`/`brainstorm` for non-mutating work.
- Durable artifacts are written atomically where correctness matters.

## Requirements

- Node.js >= 20.19
- Git repository for project runs
- Optional external agents installed/authenticated:
  - `claude`
  - `codex`
  - `opencode`

## Adding agents

Edit `xdou.yaml`:

```yaml
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

## Artifacts

Each run creates inspectable artifacts under `.xdou/runs/<run-id>/`, including:

- `mission.md`
- `project.md`
- `council.md`
- `plan.md`
- `synthesis.md`
- `diff.patch`
- `validation.json`
- `review.md`
- `final-summary.md`
- `timeline.ndjson`
- per-agent inbox/result files under `agents/<agent-id>/`
