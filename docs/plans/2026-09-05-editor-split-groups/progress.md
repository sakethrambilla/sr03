# Progress — Editor split groups

**Plan:** ./plan.md
**Status:** complete
**Current:** all six tasks done

## Log
- 2026-09-05 Branch `feat/editor-split-groups` created off main.
- 2026-09-05 Task 1 — done, c2e0ae4. 25/25 server tests, typecheck clean. Verified live: layout
  round-trips, invalid shapes 400, `{"layout":null}` clears, survives a server restart, and the
  patched thread kept its position in the `threads` array (the `updated_at` check).
- 2026-09-05 Task 1 amended — e280c84. Tabs became tagged objects on the user's call.
- 2026-09-05 Plan amended after review — 71406e7.
- 2026-09-05 Task 2 — done, 2f5f6f9. 68 tests (28 server + 40 web), typecheck clean.
- 2026-09-05 Task 3 — done, 7d62165. Verified in the browser: grid renders, unsaved edits survive
  a tab switch, open tabs and the active tab survive a reload and a server restart, a deleted file
  closes its own tab with no error, and a gitignored file stays open across a reload.
- 2026-09-05 Task 4 — done, 0a158f4. `⌘\` splits to two and three groups and refuses a fourth;
  sash drags and clamps at 160px; `⌘K →` moves focus; `⌘W` closes only the focused group's tab;
  `⌘S` with two dirty files wrote only the focused one (confirmed on disk).
- 2026-09-05 Task 5 — done, e43c8a1. Composer overflow at the minimum width fixed and measured to
  zero; a real streaming turn rendered correctly in a 160px group; an unsent draft survived two
  layout changes.
- 2026-09-05 Task 6 — done, 82271f2. Drag verified: split, cap, axis lock, reorder, chat drag,
  Esc cancel, and an unsaved edit surviving a drag.

## Acceptance criteria — evidence

| # | Criterion | Evidence |
|---|---|---|
| 1 | Edge band → half overlay, release splits | Dragged `notes.md` to the right edge of a two-group layout; a third group was created holding it. Overlay geometry unit-tested in `layout.test.ts`. |
| 2 | Middle → whole-group overlay, moves into strip | Dragged `secret.txt` into the chat group's middle; it merged, group count fell to one. |
| 3 | Two groups horizontal → no top/bottom split preview | Dropped on the **bottom** edge of a horizontal layout; it merged into that group instead of splitting. `dropTargetAt` axis-lock cases unit-tested. |
| 4 | Three groups → no edge preview anywhere | With three groups, a drop on the left edge merged rather than splitting. `⌘\` a fourth time also did nothing. |
| 5 | Chat in a second group, still exactly one | Dragged the chat tab to the right edge; transcript and composer rendered there. Persisted layout showed `chat tabs total: 1`. |
| 6 | Last tab closed → group removed | `⌘W` on the third group's only tab removed it and the survivors expanded. |
| 7 | Sash resize with a minimum | Dragged to the floor: measured `chatWidth 160` against a 160px minimum, and the fraction survived a reload. |
| 8 | Layout survives close/reopen/full reload | Two tabs + active tab restored after a browser reload and again after a server restart. |
| 9 | Stored layout names a missing file | `rm main.ts` then reload: the tab closed itself, no error toast. Server now returns 404 for a missing file. |
| 10 | Unparseable layout → single chat group, no error | `parseLayout` rejects 15 malformed shapes (server suite); `normalize(null)` returns a single chat group (web suite). |
| 11 | `Esc` / out-of-bounds release cancels cleanly | Synthetic drag + `Esc`: overlay and label removed, tabs identical before and after, **and the file underneath stayed open**. |
| 12 | Quick open opens in the focused group | `⌘P` on `notes.md` opened it into the focused group while split. |
| 13 | `⌘\` to a third group, refuses a fourth | Verified in the browser, twice. |
| 14 | `⌘K →` then `⌘W` closes the right group's tab | Verified: README closed, not the left group's file. |
| 15 | A file named `chat` is a file, not the transcript | Unit-tested in `server/src/layout.test.ts`; tagged tabs make the collision unrepresentable. |

## Deviations
### Task 1
- Steps 2/6 contradicted each other (step 2 implemented `parseLayout`, step 5 expected failure).
  Created it as a stub so the test-first discipline held; 3 of 25 failed with `actual: null`.
- Adding a required `Thread.layout` broke four unmentioned sites: the `Thread` literal in
  `threads.create` and three fixtures in `cursor.test.ts`. (Review defect 4, hit before it landed.)
- Tabs became `{kind:"chat"} | {kind:"file",path}` and `active` an index, on the user's decision.

### Task 2
- `trackTemplate` had to become genuinely axis-dependent: `trackOf` puts vertical groups at rows
  1, 2, 4, 5, so the vertical template needs five tracks, not three. Added a test asserting every
  track `trackOf` claims exists in its own axis's template, for all three group counts.
- One planned assertion was invalid, not failing: `normalize(null)` deep-equalled two freshly
  generated UUIDs. Rewritten to ignore ids. The only place a test changed rather than the code.
- Two real bugs the tests caught: `rebuild` sliced the tail of `sizes` instead of dropping the
  removed group's entry; and clamping to `MIN_FRACTION` changed the total, leaving the clamped
  group still short. `fit` now returns shares summing to 1.

### Task 3
- Chat joined the strip here rather than in task 5. The grid needs every view as a direct child
  with a track style, and there is no clean way to keep chat out of that while files are in it.
  So task 5's steps 1–3 effectively landed in task 3, and task 5 became the narrow-width work.
- Consequently the strip is now always visible, where `main` shows it only once a file is open.
  Task 3's "indistinguishable from main" check does not hold and was replaced by the checks above.
- Needed an unplanned server change: `GET /file` returned a 500 with a raw `ENOENT` string, so the
  client had no reliable way to tell "gone" from "unreadable". It now returns 404, and `call`
  attaches the status to the thrown error.

### Task 4
- The sash was a literal 1px target. Added an invisible handle overflowing the track by 4px each
  side, so it is grabbable without taking layout space.
- Focus only followed clicks on the tab strip, so `⌘S` could not be aimed by clicking into an
  editor. Added focus-on-pointerdown to the view cells too.
- `onEqualise` became its own prop: a double-click across three groups cannot be expressed as a
  single sash resize.

### Task 5
- The overflow at minimum width was the **model picker**, not the permission `Menu` — it composes
  shadcn's `Button` and inherits its `shrink-0`, so its inner `truncate` never engaged. Fixed at
  that call site with `min-w-0 shrink`; the shared `Menu` was left alone.
- The composer's control row also needed `flex-wrap` so the chips stack instead of spilling.

### Task 6
- `stopPropagation` alone is not enough for the drag's `Esc`: when an event is dispatched at
  `window` itself, capture and bubble listeners are peers. Added `stopImmediatePropagation`.

## Review findings — all folded in
The pre-execution review raised 23 defects; every one was addressed in the plan amendment or the
code, with one exception worth recording: **defect 20 was wrong** — `web/package.json` already
declared `"type": "module"`. Verified before acting on it.

The two most valuable findings were both latent bugs that would have shipped:
- seeding `normalize` with `[CHAT_TAB]` would have wiped every stored tab on open;
- pruning the layout against `filesByCwd` would have silently closed gitignored files, since that
  list is `git ls-files --cached --others --exclude-standard` output. Task 3's gitignore check is
  the regression guard.

## Blocked / needs a decision
- (none)
