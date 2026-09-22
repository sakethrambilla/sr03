# Progress — file tree responsiveness

**Plan:** ./plan.md
**Status:** complete — all 11 acceptance criteria verified by measurement
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

All measured in a real browser against a self-hosted build (`SR03_PORT=3517`, isolated
`SR03_DATA_DIR`) on the 1,600-file fixture. **Both halves were this branch's code** — see the
Notes section for why an earlier attempt measured the server half wrongly.

| # | Criterion | Measured | Verdict |
|---|---|---|---|
| 1 | Bounded row count | tree 136→216 rows with rendered fixed at 52; peak 73 = viewport 31 + overscan 40 + partials | MET |
| 2 | Immediate expand, delayed spinner | 0 spinners at 70ms; 1 at 520ms with the read held open; 0 after it landed | MET |
| 3 | Children stay visible during re-read | rows held at 42 for the whole held read, went to 43 only on landing — never blanked | MET |
| 4 | Superseded reads discarded | a held read rewritten to return `STALE-MARKER.txt` never landed after a newer read won | MET |
| 5 | Rename typing re-renders one row | 6 keystrokes with 52 rows rendered → 30 DOM mutations across exactly **1** distinct row | MET |
| 6 | Concurrency cap | peak in-flight `/tree` = 16 across a 20-directory refresh | MET |
| 7 | One ignore lookup per refresh | exactly 1 POST `/ignored` per refresh; returns `["pkg39","pkg40"]` matching `git check-ignore`; tree route returns `ignored:false` for all 41 entries | MET |
| 8 | Optimistic mutations + rollback | row count 82→83 while the create response was held open, 83 after confirm; duplicate name → `.gitignore already exists` shown and tree unchanged | MET |
| 9 | Auto-expand bounded | 300 changes → "300 changed" shown, 41 rows (root only), nothing expanded. 1 change → 82 rows, changed file revealed | MET |
| 10 | Failed read contained, no retry | unreadable dir → exactly **1** request in 8s, header "Could not read locked", rest of tree interactive | MET |
| 11 | No scroll movement on re-render | scrollTop held at 900 across three file selections | MET |

Also confirmed: panel menu roots = **1** (was ~2 per row), row heights uniformly **22px**,
**zero** gaps >22px across 16 scroll samples spanning the full height.

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

## Notes
- `pnpm dev` will FAIL to bind port 3399 if an sr03 server or the desktop app is already running.
  Vite still serves the new client and proxies to the OLD server, so server-side changes appear
  broken while client-side ones look fine. Stop the other instance first, or run the server with
  `SR03_PORT` + `SR03_DATA_DIR` set.
- Use `/tmp/sr03-big` (rebuild per plan.md) and `/tmp/sr03-repo`. Never a real project.
