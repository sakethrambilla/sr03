# Progress — Cursor slash commands

**Plan:** ./plan.md
**Status:** complete
**Current:** all tasks done
**Branch:** feat/cursor-slash-commands

## Log
- 2026-09-05 Task 1 — done, commit a2feb32. `pnpm test` pass 8 / fail 0, typecheck silent.
  Gate honoured: assertion failed with `[]` before the handler, passed after.
- 2026-09-05 Task 2 — done, commit a6a4166. `pnpm test` pass 10 / fail 0. Live cold-path curl
  returned a non-empty list in 15.8s, second curl <10ms from cache, no stray cursor-agent.
- 2026-09-05 Task 3 — done, commit c1c9b64. `pnpm test` pass 10 / fail 0, typecheck clean.
  UI verified: Cursor `/` menu lists 63 commands, `wor` narrows to 4; Claude's list unchanged;
  `/wait-what` sent and answered. Diff is cursor.ts + cursor.test.ts + models.ts only.

## Deviations
- Task 1 step 4: the plan's "no argument hints" rationale was prose; kept as a one-line comment
  above `argumentHint: ""` instead. Cosmetic.
- Task 2 step 1: plan said `COMMANDS_TIMEOUT_MS = 15_000`; the real push arrives ~16.8s after
  spawn on a cold agent (`session/new` alone ~10.6s) and the timer starts before `initialize`,
  so 15s returned `[]` every time. Raised to 45_000 with a comment. Behavioural, not cosmetic.
- Task 3 steps 3-5: the app's folder picker is a native macOS dialog that browser tools cannot
  drive, so the scratch project and threads were created through the same REST endpoints the UI
  calls; every `/` check itself was done in the real UI. Scratch project and threads deleted after.

## Blocked / needs a decision
- (none)
