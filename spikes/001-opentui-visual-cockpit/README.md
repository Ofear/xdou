# 001: OpenTUI visual cockpit spike

## Goal

Validate whether OpenTUI can support xdou's real goal: a visual terminal cockpit where the operator can watch multiple agents speak, plan, code, review, update artifacts, and hit blockers in panes.

## Sources reviewed

- OpenTUI package docs from `node_modules/@opentui/*`.
- Pi docs index and pages reachable from `https://pi.dev/docs/latest`.
- OpenCode docs via research subagent.
- Aider docs via research subagent.

## UX patterns to borrow

- Pi: small core, extension-first, sessions, JSON event stream, TUI components, keybindings, themes, packages.
- OpenCode: server/core separated from TUI client, SSE/event stream, sessions/forks, permissioned tool cards, command palette, `/` commands, `@` file references, `!` shell injection, model/session/theme selectors.
- Aider: repo map/context discipline, `/diff`, `/undo`, `/test`, `/lint`, architect/editor mode, auto-commit-sized work units.
- Codex: approval/sandbox/event protocol discipline.

## Prototype commands

OpenTUI attempt:

```bash
npx tsx spikes/001-opentui-visual-cockpit/prototype.tsx
```

Result on this Windows/Node host:

```text
Error: bun-ffi-structs requires Bun or Node.js with node:ffi enabled (--experimental-ffi --allow-ffi).
Node.js v24.14.0: bad option: --experimental-ffi / --allow-ffi
bun: command not found
```

Pi TUI fallback/proof:

```bash
npx tsx spikes/001-opentui-visual-cockpit/prototype-pi-tui.ts
```

Result:

```text
Rendered a pane-based visual cockpit in the terminal with agent roster, live council transcript, artifact pane, and action bar using plain Node.
```

Controls:

```text
tab  switch pane focus
q    quit
```

## Validation checklist

- [x] Packages install on Windows host.
- [x] OpenTUI package installs.
- [x] OpenTUI fails at runtime on current Node because `node:ffi` is unavailable and Bun is not installed.
- [x] Pi TUI package installs.
- [x] Pi TUI prototype renders in a TTY.
- [x] Keyboard/focus model is supported by API and prototype.
- [x] Pane layout is viable with differential rendering.

## Verdict: PARTIAL

OpenTUI is still conceptually the richer high-performance target, but it is blocked on this current host/runtime because it needs Bun or Node FFI support that is not available here.

Pi TUI is immediately viable:

- MIT licensed.
- TypeScript/Node friendly.
- Small component interface.
- Differential rendering.
- Built-in editor/input/markdown/select components.
- Windows support via native console mode helper.
- Matches Pi's docs philosophy: small core plus custom TUI components and event streams.

## Recommendation for the real build

Use Pi TUI for xdou v1.2's real visual cockpit now. Keep OpenTUI on the roadmap behind a runtime feasibility flag/spike: adopt it only if xdou later bundles Bun or Node ships stable FFI support.

Production direction:

1. Keep `xdou cockpit --snapshot` as text/no-TTY fallback.
2. Replace interactive `xdou cockpit` with a Pi TUI pane layout.
3. Add `.xdou/runs/<id>/events.ndjson` as canonical visual event stream in the next milestone.
4. Render agents/transcript/artifacts/timeline from that stream.
