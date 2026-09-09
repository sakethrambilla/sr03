# Progress — per-provider default permission mode

**Plan:** ./plan.md
**Status:** complete
**Current:** — (all tasks done)

## Log
- 2026-09-10 Task 1 — done, not committed. typecheck clean; `pnpm test` 45/45; grep for removed
  symbols empty; PUT/GET curls, 400/404 rejections, restart persistence and the legacy migration
  all as specified.
- 2026-09-10 Task 2 — done. typecheck + web build clean; every UI bullet checked in a browser
  against /tmp/sr03-repo, including a real Claude turn and a real Cursor turn, cross-tab sync, and
  the mid-turn no-op on a running thread.
- 2026-09-10 Full suite re-run at the end: typecheck clean, `pnpm test` 45/45. Committed.

## Deviations
- Task 1 touched `web/src/components/SettingsView.tsx`, which the task file did not list:
  `GeneralPanel` read the deleted `state.defaults` / `setDefaultPermissionMode`, so typecheck forced
  a minimal rewire onto the default provider's own `defaults.permissionMode`. Task 2 deletes that
  panel anyway.
- Task 2 code applied exactly as written. Process note: the dev server shares `~/.sr03`, so
  verification ran against the real project list; only `/tmp/sr03-repo` was written to.
- The machine's provider defaults are left at Claude=Bypass, Cursor=Plan from verification.

## Blocked / needs a decision
- (none)
