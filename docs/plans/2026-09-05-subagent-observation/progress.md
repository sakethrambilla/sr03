# Progress — subagent observation

**Plan:** ./plan.md
**Status:** complete
**Current:** —
**Branch:** `feat/subagent-observation`, cut from `feat/editor-split-groups` at 3017f09 — this plan
depends on that one's tagged `EditorTab` and the editor grid, which are not on `main` yet.

## Log
- 2026-09-05 Plan committed, b42100b.
- 2026-09-05 Task 1 — done, commit 2ecbd1e. `pnpm test` and `pnpm typecheck` green.
- 2026-09-05 Task 2 — done, commit a8a77fd. `pnpm typecheck` and `pnpm test` green. Live Claude
  Explore turn against `/tmp/sr03-repo`: sqlite count of `meta.taskId` was 6; waiting label stayed
  `Running Agent…` (parent); agents panel showed one Explore row.
- 2026-09-05 Task 3 — done, commit 5c32372. `pnpm typecheck` and `pnpm test` green. Claude stop
  returned `{"ok":true}` and the row went `stopped` while the parent turn kept running; Cursor
  returned 501 and the turn kept running. Hitting Cursor before `handle` existed returned 409
  `This session is still starting`.
- 2026-09-05 Task 4 — done, commit 1461170. `pnpm typecheck` and `pnpm test` green. Editor
  regression on `/tmp/sr03-repo`: two files, split, ×, middle-click, ⌘W, unsaved prompt, layout
  persisted as chat+README.md.
- 2026-09-05 Task 5 — done, commit ccd6fe4. `pnpm typecheck` and `pnpm test` green. Live Claude
  Explore, stop, three-at-once, nested depth-2, no-subagent, interrupt-stale/parked, and Cursor
  card all checked against `/tmp/sr03-repo`.

## Deviations
- Task 1 step 3: `pnpm typecheck` also failed in `web/src/store.ts` (`EMPTY_PROVIDER` missing the
  two new capabilities). Plan only named `claude.ts`. Added `subagentTranscripts: false` and
  `stopSubagents: false` there so the client fallback catalog typechecks.
- Task 2 step 14: the main Timeline still showed the subagent's file listing until Task 5's
  client filter. Messages were already stamped; the sqlite stamp was the proof they were
  quarantined in data.
- Task 4: `SHORTCUTS.md` was updated with the ⌘W row (plan's git add list omitted it; the project
  rule is to change that file with the binding). `void openSubagent` satisfied `noUnusedLocals`
  until Task 5 wired the panel.
- Task 5: Claude's `ThreadTask.id` is the SDK `task_id`, not the Agent `tool_use_id`, so matching
  the transcript row on `task.id` never opened a Claude tab. Added `toolUseId` on `ThreadTask`
  (both type files, Claude start, Cursor `toolCallId`) and match on that. Description is a
  fallback when the ids are unique.
- Task 5: `exit 9` completed as `done` — the subagent ran the command successfully. Interrupt
  mid-subagent left the row `running` while the thread went idle (stale/parked), which is also
  criterion 12's UI without restarting the server. A dedicated `failed` row was not observed live;
  the tab/panel still render `failed` and `task.error` when that status arrives.
- Task 5: did not restart `pnpm dev` with `SR03_IDLE_PARK_MS=15000`. Interrupt-while-subagent
  produced the same stale condition (`running` task, idle thread): panel `parked`, tab
  `no longer live`.

## Blocked / needs a decision
- (none)
