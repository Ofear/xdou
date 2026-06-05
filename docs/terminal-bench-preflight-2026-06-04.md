# Terminal-Bench Preflight — 2026-06-04

## Goal
Verify `xdou` against Terminal-Bench-style execution before attempting an official benchmark.

## Environment
- Docker available: `Docker version 29.4.2, build 055a478`
- Node: `v24.14.0`
- npm: `11.6.4`
- Python: `3.14.3`

## Preflight tasks executed

### 1. Access log exact report task
- Task shape: create `report.txt` from `access_log`; verifier is `python -m pytest -q` exact output assertion.
- Final xdou run: `20260604192915-eb31b438`
- Result: completed
- Validation:
  - `python -m pytest -q` → `1 passed in 0.01s`
  - `xdou diff-required-check` → passed
  - `xdou mission-completion-check` → passed
- Semantic review: approved by Claude reviewer with confidence `0.99`.

### 2. Maximal square implementation/performance task
- Task shape: implement `maximal_square(matrix: numpy.ndarray) -> int`; verifier checks correctness against reference and runtime bound.
- Final xdou run: `20260604194203-ba856fe8`
- Result: completed
- Validation:
  - `python -m pytest -q` → `2 passed in 0.14s`
  - `xdou diff-required-check` → passed
  - `xdou mission-completion-check` → passed
- Semantic review: approved by Claude reviewer with confidence `0.97`.

## Issues discovered and fixed

### 1. Codex sandbox mode prevented command execution on Windows
- Symptom: Codex implementation reported `windows sandbox failed: spawn setup refresh`; produced plausible output but could not run tests.
- Fix/workaround used for benchmark preflight: configured a `codexfull` agent in task-local `xdou.yaml` with `fullAuto: true`, causing `codex exec --dangerously-bypass-approvals-and-sandbox` inside isolated temp worktrees.
- Result: Codex could inspect files, edit, and run pytest.

### 2. Claude reviewer prompts could contain NUL bytes
- Symptom: Claude reviewer failed before execution with `Arguments cannot contain null bytes`.
- Code fix: `src/agents/base.ts` now sanitizes NUL bytes from agent CLI args/stdin before spawning.
- Regression: `test/agent-adapters.test.ts` includes a NUL-byte spawn test.

### 3. Claude reviewer had too few turns / tool-use drift
- Symptom: Reviewer failed with `error_max_turns: tool_use`, blocking runs even when verifier tests passed.
- Code fix: Claude reviewer turn cap increased from 1 to 5 and reviewer prompt explicitly says to use only provided mission/diff/validation/context, not tools.
- Regression: `test/agent-adapters.test.ts` updated for reviewer turn cap.

## QA after fixes
Full xdou QA passed after changes:
- `npm run lint` → passed
- `npm run typecheck` → passed
- `npm test -- --run` → 23 files passed, 76 tests passed
- `npm run build` → passed

## Readiness assessment

### What xdou now demonstrates
- Can solve Terminal-Bench-style file/algorithm tasks in isolated git worktrees.
- Can run verifier commands and use them as completion evidence.
- Can block false completion when validation/review fails.
- Can complete after semantic review approval.
- Captures run artifacts: validation JSON, review verdicts, final summary, diffs, worktree path.

### Remaining gaps before official Terminal-Bench
- The native `tb` installed-agent adapter now exists under `terminal-bench/` and is included in the npm package.
- The adapter manages `/app` safely by running `xdou run --project /app --yes`, applying only completed run diffs back into `/app`.
- The adapter emits xdou logs/status/apply artifacts under `/agent-logs/xdou`.
- The adapter now prefers existing CLI auth instead of raw API-key development loops: host `~/.codex/auth.json` is restored into the container via `XDOU_CODEX_AUTH_JSON_B64`; host `~/.claude/.credentials.json` and `~/.claude.json` are restored via `XDOU_CLAUDE_CREDENTIALS_JSON_B64` / `XDOU_CLAUDE_JSON_B64` for Claude Code teams.
- Remaining validation gap: official full-suite measurement still needs controlled `tb run` execution from WSL/Linux/Docker with the custom `--agent-import-path xdou_agent:XdouAgent`. Native Windows Terminal-Bench reaches Docker but fails before the agent starts because helper paths are copied as `\\tmp` instead of `/tmp`.
- Verified WSL smoke runs from this Windows host:
  - deterministic adapter preflight: `xdou-cli-auth-smoke-wsl-3`, `hello-world`, Terminal-Bench accuracy `100.00%`, parser `test_hello_txt_exact=passed`, `total_input_tokens=0`, auth env reported Codex+Claude present.
  - real Codex CLI path: `xdou-cli-auth-real-codex-wsl-1`, `answer-file`, deterministic preflight `solved=false`, Terminal-Bench accuracy `100.00%`, parser `test_answer_txt_exact=passed` and `test_no_hello_txt=passed`, auth env reported Codex+Claude present.

## Recommended next implementation step
Run a small `tb run` dry run from WSL/Linux using the packaged adapter and Codex CLI auth propagation, then reserve explicit provider API keys only for controlled official benchmark measurement.
