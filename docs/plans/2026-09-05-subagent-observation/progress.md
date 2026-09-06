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

## Follow-up verification — 2026-09-06
The two criteria the execution log left unconfirmed are now checked live against `/tmp/sr03-repo`.

- **Criterion 7 (a failed subagent) — confirmed.** A real failure was forced by starting the
  server with `CLAUDE_CODE_SUBAGENT_MODEL=claude-not-a-real-model` and
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`; sr03 passes no `env` to the SDK, so the CLI inherits both.
  The row went `failed` with a red dot and the error trailer, and the tab header read `failed`
  above the full text in `text-destructive`: *"Agent terminated early due to an API error … (error
  type model_not_found, HTTP 404 …)"*. This is a better trigger than the plan's `exit 9`, which
  makes the subagent *succeed* at running a failing command.
- **Criterion 12 (parked) — confirmed, including a real park.** The park timer was observed
  firing: with `SR03_IDLE_PARK_MS=20000`, the `claude` child count dropped 6 → 5 about twenty
  seconds after the thread went idle. Park routes through `stopSession`, which — unlike
  `closeSession` — never touches `tasksByThread` and publishes no `thread.tasks`, so rows survive
  a park by construction. The stale UI was then produced by interrupting mid-subagent (the same
  `stopSession` path): panel row read `parked`, the tab header read `no longer live`, captured
  content was preserved, and nothing errored.

## Defect found and fixed — 2026-09-06
**A settled subagent row was relabelled by a later status.** A task read `done` through the whole
idle window and then flipped to `stopped` once the session parked and the next turn resumed it: the
shutting-down CLI reports its still-registered background tasks as stopped, and `trackTask` applied
that to tasks that had already finished. Neither the `task_updated` nor the `task_notification`
branch guarded a terminal → terminal transition. It contradicted spec criterion 4.

Fixed with `nextStatus` in `claude.ts`, applied in both branches: an incoming status is ignored
unless the stored task is still `running`. `endedAt` follows the same rule, so a settled row keeps
its original finish time. The Cursor adapter had the mirror of the same defect — its handler
derived status purely from whether the current payload carried `durationMs`, so any later
`cursor/task` update without one pulled a `done` row back to `running`; it now keeps a settled
row's status and `endedAt`.

Covered by the existing `emits one task row for a Cursor subagent` test, which now sends a trailing
duration-less `cursor/task`. Confirmed the test is wired to the behaviour: reverting the Cursor
guard fails it with `actual: 'running', expected: 'done'`.

Re-verified live with `SR03_IDLE_PARK_MS=20000`: the subagent settled `done` at t+18s, the park
fired at ~t+40s (CLI child count 1 → 0), and the row stayed `done` across the park and across the
resume that the next turn triggered.

## Second defect found and fixed — 2026-09-06
**A subagent row lost its name to its current step.** `task_progress.description` narrates the step
in flight ("Running <tool>…") while `task_started.description` names the task, and the progress
branch preferred the incoming value — so a row that started as `Count lines in README.md` became
`Running Count lines and …` seconds later, and the panel never showed what the subagent had been
asked to do. The precedence is now reversed: the stored name wins, and the incoming value is used
only to fill a task that started without one. `lastTool` already carries the step, so nothing is
lost.

Left the Cursor adapter alone here — its `cursor/task` description is the task's name, not a step
narration, so overwriting is correct there.

Verified live: across a four-file summarising subagent the row held `Summarize every repo file`
through every progress event while its trailer moved to `Bash`.

## Blocked / needs a decision
- (none)
