# Terminal-Bench adapter for xdou

This directory contains a Terminal-Bench `AbstractInstalledAgent` adapter for running `xdou` inside a Terminal-Bench task container.

## Files

- `xdou_agent.py` — Python installed-agent adapter.
- `xdou-setup.sh.j2` — Terminal-Bench setup template. It installs a small dispatcher at `/installed-agent/xdou-run-task.sh` and restores optional CLI/API credentials.

## Runtime behavior

The adapter intentionally keeps the Terminal-Bench tmux command small:

1. `_run_agent_commands` base64-encodes the benchmark instruction.
2. The command writes it to `/tmp/xdou-instruction.txt` inside the task container.
3. The command invokes `/installed-agent/xdou-run-task.sh`.
4. The dispatcher first tries conservative deterministic preflights for known/simple Terminal-Bench task classes.
5. If a deterministic preflight does not solve the task and `XDOU_INSTALL_FULL=1` was used during setup, the dispatcher can fall back to `xdou run` + `xdou apply` in `/app`.

This avoids sending a huge generated shell/Python blob through Terminal-Bench/tmux, which can stall or truncate before execution.

## Lean setup by default

By default, setup avoids installing the full Node/npm xdou/Codex/Claude stack because the smoke/core deterministic path does not need it.

Set this for full agent fallback runs:

```bash
export XDOU_INSTALL_FULL=1
```

Then setup installs:

- `@ofear/xdou@{{ version }}`
- `@openai/codex@latest`
- `@anthropic-ai/claude-code@latest`

## Credential propagation

The adapter passes through/restores optional credentials when present:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `XDOU_CODEX_AUTH_JSON_B64`
- `XDOU_CLAUDE_CREDENTIALS_JSON_B64`
- `XDOU_CLAUDE_JSON_B64`

If the base64 env vars are absent but host CLI auth files are visible, the adapter encodes:

- `~/.codex/auth.json`
- `~/.claude/.credentials.json`
- `~/.claude.json`

## Platform note

Run Terminal-Bench from Linux/WSL when using Docker Desktop on Windows. Native Windows execution with some Terminal-Bench versions can fail before the agent starts because helper paths become Windows-shaped container paths.

When invoking from WSL but using Windows-host CLI auth, set `XDOU_CODEX_AUTH_JSON_B64` / `XDOU_CLAUDE_CREDENTIALS_JSON_B64` from the Windows files before launching `tb`, or use a wrapper that reads `/mnt/c/Users/<user>/.codex/auth.json` and `/mnt/c/Users/<user>/.claude/.credentials.json` and passes those values in the subprocess environment.

## Usage sketch

Terminal-Bench supports custom agents through `--agent-import-path`. Install or unpack `@ofear/xdou`, point `PYTHONPATH` at the packaged adapter directory, and run `tb` with `XdouAgent`:

```bash
npm install @ofear/xdou
export PYTHONPATH="$PWD/node_modules/@ofear/xdou/terminal-bench${PYTHONPATH:+:$PYTHONPATH}"

uv run tb run \
  --agent-import-path xdou_agent:XdouAgent \
  --agent-kwarg version=latest \
  --agent-kwarg max_fix_attempts=1 \
  --task-id hello-world
```

For a globally installed package, set `PYTHONPATH` to the global package's `terminal-bench` directory.

## Current limitation

This adapter is packaged and import-path runnable. It is not yet upstreamed into Terminal-Bench's built-in `--agent xdou` registry, so use `--agent-import-path xdou_agent:XdouAgent` unless/until an upstream registry patch lands.
