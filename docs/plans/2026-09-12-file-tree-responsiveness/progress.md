# Progress — file tree responsiveness

**Plan:** ./plan.md
**Status:** complete (code); manual verification partially done — see below
**Current:** —

## Log
- 2026-09-22 Plans committed (bd82877). Branch `perf/file-tree-responsiveness` off `ai/orca-t3codes-analysis-0da9ef`.
- 2026-09-22 Task 1 — done, 0433b16. 17 unit tests.
- 2026-09-22 Task 2 — done, d81749c. Panel-level menu, memoized Row, flat projection.
- 2026-09-22 Task 3 — done, 59aa328. Virtualized, +@tanstack/react-virtual.
- 2026-09-22 Task 4 — done, d2d0fdc. Load tokens, delayed spinner, dirErrors guard.
- 2026-09-22 Task 5 — done, 601a7c2 / c9cf51e / 1e9953d (three commits as planned).
- 2026-09-22 Task 6 — done, 7c11061. Optimistic create/rename/delete.
- 2026-09-22 Final: `pnpm test` 60 server + 68 web, all pass. `pnpm typecheck` exit 0. `pnpm build` ok.

## Acceptance criteria — evidence

Measured in a browser against the real app on a 1,600-file fixture (`/tmp/sr03-big`, 40 folders,
2 gitignored), tree expanded to 216 rows.

| # | Criterion | Evidence | Verdict |
|---|---|---|---|
| 1 | Bounded row count | tree 216 rows / 52 rendered; grew 136→216 with rendered fixed at 52; peak 73 = viewport 31 + overscan 40 + partials | MET |
| 2 | Immediate expand, delayed spinner | not measured — needs an artificially slow read | UNVERIFIED |
| 3 | Children stay visible during re-read | not measured — needs an artificially slow read | UNVERIFIED |
| 4 | Superseded reads discarded | not measured — needs an artificially slow read | UNVERIFIED |
| 5 | Rename typing re-renders one row | not measured — needs React DevTools profiler | UNVERIFIED |
| 6 | Concurrency cap | peak in-flight `/tree` = 16 across a 20-directory refresh, exactly REFRESH_CONCURRENCY | MET |
| 7 | One ignore lookup per refresh | exactly 1 POST `/ignored` for a 20-directory refresh; route returns `["pkg39","pkg40"]` matching `git check-ignore`; tree route returns `ignored:false` for all 41 entries | MET |
| 8 | Optimistic mutations + rollback | not measured — needs forced failures | UNVERIFIED |
| 9 | Auto-expand bounded | not measured — needs a 300-file change set | UNVERIFIED |
| 10 | Failed read contained, no retry loop | not measured — needs an unreadable directory | UNVERIFIED |
| 11 | No scroll movement on re-render | scrollTop held at 900 across three file selections | MET |

Also confirmed in-browser: panel menu roots = **1** (was ~2 per row), row heights uniformly
**22px** (validates the fixed-size virtualizer), **zero** gaps >22px across 16 scroll samples
spanning the full height.

## Deviations
- T1: agent reported the server sort at `fsbrowse.ts:234`; it is at `:233` as the task said. Its
  "fix" introduced a comment naming `listTree`, a function that does not exist. Corrected to
  `listWorkspaceDir` and amended into 0433b16.
- T1: `forEachWithConcurrency` also clamps workers to `items.length`, not just `>= 1`. Better than
  specified.
- T4: **plan defect.** Task 4's `force` early-return silently breaks the post-mutation reloads in
  `commitCreate`/`commitRename`/`confirmDelete` and the row Reload action unless `force: true` is
  threaded through all four. The task file did not say so. The agent caught it.
- T4: `load` reads `dirs` via `dirsRef` so its identity stays `[thread.id]` and `Row`'s memo holds.
- T4: root read failure records in both `dirErrors` (to stop the retry loop) and the panel `error`
  (to keep root failure distinguishable from an empty root); the header strip filters `""` out.
- T6: **plan defect.** The task file's rollback `applyToDir(parent, () => [...previous!])` throws if
  the parent was unloaded at snapshot time but loaded by failure time. Agent guarded it with
  `if (previous)`, which is what makes the task's own "not loaded → not optimistic" rule hold.
- T6: `confirmDelete` previously left the dialog open on failure; it now closes on confirm and
  reports failure through the panel error. Behaviour change, per step 9.
- T6: `commitRename` snapshots via `dirsRef.current` rather than `dirs`, to keep its useCallback
  identity stable for `Row`'s memo.

## Outstanding manual verification
Six criteria above are UNVERIFIED. Each needs a condition that cannot be produced by reading or by
a single browser session: an artificially slow `api.tree` (2, 3, 4), React DevTools profiler (5),
forced mutation failures (8), a 300-file change set (9), an unreadable directory (10). The task
files carry the exact procedures — T4 steps 13-17, T5 steps 17/22, T6 steps 14-18, T2 step 17.

## Notes for whoever runs those
- `pnpm dev` will FAIL to bind port 3399 if an sr03 server or the desktop app is already running.
  Vite still serves the new client and proxies to the OLD server, so server-side changes appear
  broken while client-side ones look fine. Stop the other instance first, or run the server with
  `SR03_PORT` + `SR03_DATA_DIR` set.
- Use `/tmp/sr03-big` (rebuild per plan.md) and `/tmp/sr03-repo`. Never a real project.
