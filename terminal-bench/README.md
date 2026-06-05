# Terminal-Bench adapter for xdou

This directory contains a Terminal-Bench `AbstractInstalledAgent` adapter for running `xdou` inside a Terminal-Bench task container.

## Files

- `xdou_agent.py` — Python installed-agent adapter.
- `xdou-setup.sh.j2` — Terminal-Bench setup template that installs Node/npm when needed, then installs:
  - `@ofear/xdou@{{ version }}`
  - `@openai/codex@latest`

## Runtime behavior

The adapter:

1. Installs xdou and agent CLIs in the task container.
2. Writes a benchmark-safe `/app/xdou.yaml` using:
   - Claude Code for architect/implementer/fixer/critic/brainstormer by default, using propagated Claude CLI auth instead of raw provider keys.
   - Codex CLI is still installed and Codex auth is still propagated so the preset can be adjusted without relying on raw `OPENAI_API_KEY`.
   - No semantic reviewer in the Terminal-Bench preset; Terminal-Bench's pytest verifier is the authoritative review gate, which avoids blocking solved tasks on flaky free-form reviewer verdict extraction.
3. Runs:

```bash
xdou run "$MISSION" --project /app --yes --max-fix-attempts <n> --json
```

4. Checks the xdou run status.
5. If completed, applies the isolated worktree diff back into `/app`:

```bash
xdou apply "$RUN_ID" --json
```

Terminal-Bench then runs its normal verifier against `/app`.

## Required environment

For the default adapter team, prefer an existing Codex CLI login on the machine running `tb`:

- `~/.codex/auth.json` — encoded by the adapter and restored inside the task container as Codex CLI auth.
- `OPENAI_API_KEY` — still supported as an explicit benchmark-run fallback when no Codex CLI auth file is available.

The adapter also passes through/restores optional credentials for future/custom configs:

- `~/.claude/.credentials.json` via `XDOU_CLAUDE_CREDENTIALS_JSON_B64` for Claude Code CLI auth.
- `~/.claude.json` via `XDOU_CLAUDE_JSON_B64` for Claude Code CLI auth metadata.
- `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` when explicitly present in the runner environment.

## Platform note

Run Terminal-Bench from Linux/WSL when using Docker Desktop on Windows. Native Windows execution with Terminal-Bench `0.2.18` can fail before the agent starts because Terminal-Bench copies helper files to a container path like `\\tmp` instead of `/tmp`.

When invoking from WSL but using Windows-host CLI auth, set `XDOU_CODEX_AUTH_JSON_B64` / `XDOU_CLAUDE_CREDENTIALS_JSON_B64` from the Windows files before launching `tb`, or use a small wrapper that reads `/mnt/c/Users/<user>/.codex/auth.json` and `/mnt/c/Users/<user>/.claude/.credentials.json` and passes those values in the subprocess environment.

If provider credentials are absent in the shell running `tb`, the adapter still exits cleanly and Terminal-Bench records a normal unresolved task instead of hanging the harness.

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
