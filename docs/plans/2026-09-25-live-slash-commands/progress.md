# Progress — live slash-command list

**Plan:** ./plan.md
**Status:** complete
**Current:** done

## Log
- 2026-09-25 Task 1 — done, commit 8d4484e. 9/9 tests pass, typecheck clean.
- 2026-09-25 Task 2 — done, commit ef0cb25. typecheck clean, 89 tests pass.
- 2026-09-25 Task 3 — done, commit 1f210fe. typecheck clean, 125/125 server tests pass.
- 2026-09-25 Task 4 — done, commit 66a12a5. typecheck clean, 89/89 web tests pass.
- 2026-09-25 Finish — full suite green (server 125/125, web 89/89), typecheck clean. Manual
  end-to-end verification run against an isolated dev server (SR03_PORT=3499,
  SR03_DATA_DIR=/tmp/sr03-verify-data, never the user's real ~/.sr03) and a scratch repo
  (/tmp/sr03-repo), covering all 7 acceptance criteria for Claude, Cursor and Codex. All
  scratch state (temp data dir, scratch repo, probe skill directories under
  ~/.claude/skills, ~/.cursor/skills, ~/.agents/skills, and this worktree's temporary
  .claude/launch.json) was removed afterward.

## Deviations
- Task 3: `listCommands` pushed-list fast path now also requires a live session in that cwd
  (`sessions.values()` check), not just a non-empty `commandsByCwd` entry — fixes a bug where a
  stale pushed list from a closed session would be served forever. This was specified explicitly
  in the task prompt, not an agent improvisation.
- Task 3: codex.ts's `skills/changed` notification handler was also updated from
  `refreshLiveCommands(session.cwd)` to `catalog.refresh(session.cwd)` — not explicitly listed in
  plan.md's steps but necessary since `refreshLiveCommands` no longer exists; same substitution
  pattern as everywhere else in the file.
- Task 3: cursor.ts had no leftover `writeCommandCache` call to migrate in its push handler (it
  only ever set `commandsByCwd` in memory) — nothing to change there, as the plan anticipated.

## Deviations
- (none)

## Blocked / needs a decision
- (none)
