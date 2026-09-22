# Progress — filesystem watcher

**Plan:** ./plan.md
**Status:** complete — criteria 1-5 and 9 verified by measurement; 6-8 by test + code
**Current:** —

## Log
- 2026-09-22 Task 1 — done, 9628d3b. Coalescer, filter, refcounted watch, wire types. 13 tests.
- 2026-09-22 Task 2 — done, d9a96ae. Socket wiring, ChatView-owned watch, worktree release.
- 2026-09-22 Task 3 — done, 05d50a8. Inference deleted, git-status floor added.
- 2026-09-22 Final: server 73/73, web 77/77, typecheck clean, build ok.

## Acceptance criteria — evidence

Measured over a real WebSocket against a self-hosted build on an isolated port and data dir.

| # | Criterion | Measured | Verdict |
|---|---|---|---|
| 1 | Any process's writes signal | external `writeFile` → 1 signal, **168ms** latency | MET |
| 2 | Coalesced, never starved | 75 writes over 3s → **6** signals, inter-signal gaps **510-516ms**, i.e. pinned to the 500ms ceiling | MET |
| 3 | Lone change emits at the quiet period | 168ms ≈ the 150ms trailing window | MET |
| 4 | `.git` produces nothing | write to `.git/PROBE` → **0** signals | MET |
| 5 | No watch when nobody looks | `fs.watch {on:false}` then a write → **0** signals | MET |
| 6 | Failed watch degrades, logs once | unit test: throwing factory → no-op release, logged once, no retry | MET (test) |
| 7 | Overflow emits a signal | unit test: handle `error` event → one `fs.changed`, watch closed | MET (test) |
| 8 | Released before worktree removal | `releaseAllUnder(target)` precedes `git.removeWorktree`; unit test covers force-close + stale release | MET (code+test) |
| 9 | Exactly one refresh path | inference deleted; `grep bumpFs|WRITE_TOOLS|FS_SETTLE_MS|fsTimers` in store.ts returns nothing. In the UI a single change surfaced as "1 changed" with no agent turn | MET |

**Why criterion 2 matters most:** the deleted `FS_SETTLE_MS = 750` was a pure trailing debounce
with no upper bound. Under the same 3s churn it would have emitted **once, at the very end**.
The 6 signals at a 510ms cadence are the starvation fix working.

## Deviations
- T1: `watchThread` gained an optional 4th param (`options?: CoalescerOptions`) so the
  null-filename and ignored-path tests need not sleep past the real 150ms window.
- T1: `fs.watch` is created with `persistent: false`, so a leaked watch cannot hold the process
  open. Not in the plan; strictly safer.
- T1: the integration test originally wrote once and raced FSEvents' arm-up latency — it failed
  roughly 1 run in 4. Rewritten to keep writing until the event arrives; 6 consecutive clean runs.
  Amended into 9628d3b.
- T3: **plan gap.** Step 5 did not mention that `onSaved` is a *required* prop on `FileView`, so
  removing its only provider fails typecheck. `FileView.tsx` is in the commit beyond the plan's
  three-file list.
- T3: the plan's line citations were 1-2 lines stale after Task 2 shifted them. Substance held.
- T3: the git-status floor uses an unmount-scoped `mountedRef`, not the refresh effect's existing
  `cancelled` flag — reusing `cancelled` would kill the trailing run on the next tick, which is
  the dropped-change bug the step warns about. (No `StrictMode` in this app, so the pattern is safe.)

## Notes
`pnpm dev` fails to bind 3399 when an sr03 instance or the desktop app is already running. Vite
still serves the new client and proxies to the OLD server, so server-side changes look broken while
client-side ones look fine. Run with `SR03_PORT` + `SR03_DATA_DIR` instead.
