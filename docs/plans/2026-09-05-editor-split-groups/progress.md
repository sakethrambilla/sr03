# Progress — Editor split groups

**Plan:** ./plan.md
**Status:** in progress
**Current:** Task 2

## Log
- 2026-09-05 Branch `feat/editor-split-groups` created off main.
- 2026-09-05 Task 1 — done, commit c2e0ae4. `pnpm test` 25/25 pass, `pnpm typecheck` clean.
  Verified live on an isolated instance (`SR03_DATA_DIR=/tmp/sr03-verify SR03_PORT=3401`):
  layout round-tripped; invalid axis and four groups both 400; `{"layout":null}` cleared it;
  the layout survived a full server restart; and the patched thread kept its position in the
  `threads` array, confirming the `updated_at` avoidance.

## Deviations
- Task 1 steps 2/6 contradicted each other — step 2 implemented `parseLayout` while step 5
  expected the tests to fail. Created `layout.ts` as a signature-only stub in step 2 so the
  test-first discipline held; step 6 then implemented it. 3 of 25 tests failed at step 5 with
  `actual: null`, which is the right failure.
- Task 1 did not anticipate that adding a required `Thread.layout` breaks four other sites.
  Added `layout: null` to the `Thread` literal in `threads.create` (`server/src/db.ts`) and to
  the three `const thread: Thread` fixtures in `server/src/agents/cursor.test.ts`, and added
  that test file to the commit. (Independently confirmed by the plan review as defect 4.)
- Task 1 step 13 quoted the 400 body without backticks; the real body is
  `` `layout` is not a valid editor layout ``. Behaviour is correct, the doc was imprecise.

## Blocked / needs a decision
- (none)

## Review findings — all folded in (see the plan amendment commit)
Blocking (change a contract in task 2, so must be settled first):
- D1 `normalize(thread.layout, [CHAT_TAB])` in task 3 step 7 drops every file tab and writes the
  emptied layout back. Criterion 8 cannot pass. Needs a "trust the stored tabs" seed.
- D2 `known` comes from `filesByCwd`, which is `git ls-files` output — gitignored files that are
  open today would be silently closed. `known` must be workspace ∪ open tabs.
- D3 `dropTargetAt(..., canSplit: boolean)` cannot express the axis lock, so criterion 3's
  "no split preview" is unimplementable. Needs `allow: { split, axis }`.
- D6 `trackOf` / `trackTemplate` have no axis or strip/view part, so task 3's stated grid
  (`3n-1` rows when vertical) cannot be built from them.
- D16 the `"chat"` sentinel collides with a real file named `chat`.

Non-blocking but real:
- D5 `web/tsconfig.json` needs `"node"` in `types` or `pnpm -C web typecheck` fails on the new
  test file; knock-on is `window.setTimeout` for the coalesce timer. File map missing that file.
- D7 two `FileView`s would both be `active`, double-firing ⌘S / ⌘⇧V / Esc across groups.
- D8 the drag's Esc listener collides with FileView's; needs capture phase + stopPropagation.
- D9 ownership of the layout between ChatView state, the store and the `thread.updated` echo is
  unresolved.
- D10 `CLAUDE.md` is in the file map with no owning task; SHORTCUTS.md attributed to task 3 only.
- D11 `⌘\` and `⌘K ←/→` have no spec ancestor — decide whether they ship or are scaffolding.
- D12 task 4 step 6 is a conditional placeholder; tasks 4 and 5 add no automated tests.
- D13 task 3 fails the stranger test and is not reviewer-sized.
- D14 the "layout wider than the window" mitigation is claimed but no step does it.
- D15 `resize` and `groupOf` are exported but untested.
- D17 the vscode link in task 2 resolves to a path that does not exist.
- D20 `web/package.json` needs `"type": "module"`.
- D21 criterion 12 has no verification step anywhere.
- D22 task 4 gives the editor a permanent tab strip; intended but unstated.
- D23 `crypto.randomUUID()` needs a secure context.

## Decisions taken during execution
- Tabs are tagged objects (`{kind:"chat"} | {kind:"file",path}`), not bare strings — the user
  chose this over accepting the `chat`-filename collision. Task 1 was amended and reshipped as
  e280c84; `active` became an index into the group's own tabs at the same time, which removed a
  whole validation case.
- `⌘\` and `⌘K ←/→` ship as documented features rather than scaffolding, so the spec gained
  criteria 13 and 14 and they are no longer scope creep.
- The plan review's defect 20 was wrong: `web/package.json` already declares `"type": "module"`.
  Verified before acting on it; task 2 step 1 says so.
- Task 3 was split into task 3 (model refactor, no visible change) and task 4 (focus, sashes,
  shortcuts) because the review found it was not reviewer-sized. Old 04/05 became 05/06.
- Criterion 9 is now met by `FileView` reporting a file it cannot load, not by intersecting the
  layout against `filesByCwd` — that list is `git ls-files` output and would have silently closed
  gitignored files. Task 3 step 16 is the regression guard.
