# xdou Dogfood Report — 2026-06-04

## Scope

Dogfooded xdou across CLI intent boundaries, cockpit/TUI snapshots, apply/undo lifecycle, agent adapter behavior, packaged artifact smoke tests, and live agent availability.

## Issues found and fixed in this pass

1. `run --dry-run` initialized Git and created project folders.
   - Fix: dry-run now resolves/preflights project paths without mutation.
   - Regression: `test/productivity-flows.test.ts`.

2. `undo` refused legitimate undo immediately after apply because the applied diff made the checkout dirty.
   - Fix: undo now allows reversing the target patch while still blocking unrelated dirty files.
   - Regression: `test/cockpit-100-productivity.test.ts`, `test/apply-and-json.test.ts`.

3. Cockpit action bar overflowed narrow/non-interactive snapshots.
   - Fix: width-aware truncation for action bar and snapshot width propagation from terminal columns.
   - Regression: `test/cockpit.test.ts`.

4. README cockpit keyboard docs drifted from visible cockpit controls.
   - Fix: updated docs and added consistency regression.
   - Regression: `test/cockpit.test.ts`.

5. Claude non-mutating roles could hang/tool-loop despite being given all necessary context.
   - Fix: non-mutating Claude Code calls now use an empty `--allowedTools` set; reviewer calls are limited to one turn.
   - Regression: `test/agent-adapters.test.ts`, `test/non-mutating-agents.test.ts`.

## Verification evidence

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm test -- --run`: passed, 23 test files, 75 tests.
- `npm run build`: passed.
- `npx publint`: passed.
- `npm pack --json`: passed.
- Packed artifact: `ofear-xdou-1.2.5.tgz`.
- Package size: 81,995 bytes.
- Package integrity: `sha512-Va32IEcxS5+YQ6u7ciEMMjEAPzRCVTCWlQHxnE7Ika3IeXu3f5RPPPBvn90OP/EY1ei5sy+RK5tLGY9qXYd8NQ==`.
- Packaged smoke install: passed.
- Packaged `xdou --help`: passed.
- Packaged cockpit empty snapshot at `COLUMNS=140`: passed; mission tabs and prompt composer visible; max line width <= 140.
- Packaged read-only `plan --dry-run` outside Git: passed; no `.git` created.
- Packaged conversational rejection: `run 'tell me a joke' --dry-run` rejected as non-coding mission.
- Packaged path traversal JSON error: `status ../../escape --json` rejected with `Invalid run id`.
- Live Claude reviewer no-tool smoke: passed; returned `REVIEW_VERDICT` in one turn with `--allowedTools ''`.
- Live agent detection: Claude Code available, Codex CLI available, OpenCode unavailable.

## Remaining external blocker

A final real Codex + Claude end-to-end run could not be completed because Codex returned quota errors: `You've hit your usage limit ... try again at 7:12 PM`. That is an external account/quota condition, not a code/test failure in the repository. The prior full real-agent mission path was already exercised before this pass; this pass added fixes and regression coverage for issues discovered while trying to repeat it.

## Current confidence

No known reproducible xdou product issues remain from the paths exercised in this pass. The only unclosed verification item is re-running the full live Codex + Claude mission after Codex quota resets.
