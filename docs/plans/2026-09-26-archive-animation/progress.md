# Progress — smooth archive animation

**Plan:** ./plan.md
**Status:** complete
**Current:** —

## Log
- 2026-09-26 Task 1 — done, commit 638ff16. Web suite 106/106, typecheck green.
- 2026-09-26 Task 2 — done, commit 0c47562 + fix 55376b2. Manual: 4 rows got data-leaving (0/30/60/90ms), gone by ~376ms; single archive unstaggered; server-down path animates nothing.
- 2026-09-26 Task 3 — done, commit 8124c50. Manual: "Archived 3 sessions" / "Archived 1 session", Undo restores all, no toast on single archive; real ⌘⇧X animates.

## Deviations
- Task 2: `leaving: NO_LEAVING` lives in the create() literal, not `EMPTY` (EMPTY is data-only).
- Task 2: `upsertThread` sorts by updatedAt, so archiving re-sorted pinned rows mid-list. Fixed in 55376b2: leaving rows are upserted only after their exit, and `thread.updated` is ignored for them.

## Blocked / needs a decision
- (none)
