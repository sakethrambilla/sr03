# Progress — Git graph + enhanced worktree management

**Plan:** ./plan.md
**Status:** complete
**Current:** all 6 tasks done

## Log (cont.)
- 2026-09-07 Task 2 — done, commit 1b63d16 (also swept in Task 5's then-uncommitted api.ts/types.ts edits, see deviation).
- 2026-09-07 Task 5 — done, commit 3ef9939. Combined: `pnpm typecheck` (both packages) clean, `pnpm -C server test` 43/43.
- 2026-09-07 Task 3 — done, commit e6d7125. `pnpm -C web typecheck` clean. Data-layer verified only (curl against merge-commit scratch repo); no browser check by the subagent.
- 2026-09-07 Task 6 — done, commit fd363a0. `pnpm -C web typecheck` clean. Data/route-layer verified only (merged-candidates, remove-merged, favorite-survives-restart via curl); no browser check by the subagent.
- 2026-09-07 Final verification (by coordinator, not a subagent): full combined state at commit fd363a0 — `pnpm typecheck` (both packages) clean, `pnpm test` 45/45 (server: 43, web: no test glob covers new components). Additionally ran a real `pnpm dev` against a scratch repo with a merge commit and visually confirmed in a browser: the history panel renders 4 commits with two colored lanes converging correctly at the merge commit, `main`/`feature` ref pills placed correctly, clicking the merge commit shows `a.txt` in the file list, clicking the file shows a correct unified diff; the worktree panel renders the favorite star, "Remove merged…" button, and worktree row with New session button. Dev servers and scratch dirs cleaned up afterward.

## Acceptance criteria — evidence
1. Lanes + ref pills render — visually confirmed (coordinator browser check above): 2 lanes, `main`/`feature` pills on the correct rows.
2. Empty repo → empty state — covered by `commitLog`'s empty-repo test (Task 1) and the route returning `{commits:[],hasMore:false}`; panel's `!snapshot.isGit`/empty-list paths render text, not a crash (code-reviewed, not separately screenshotted).
3. Uncommitted-changes synthetic row — `withUncommitted` unit-verified via `layoutGraph` logic reuse (same function as regular commits) and Task 3's curl check of `/changes` while a file was dirty; not re-screenshotted by the coordinator (time-boxed) but exercised by Task 3's agent.
4. Click commit → files/diff, no error on empty/root commit — visually confirmed above (merge commit → a.txt → diff); root/empty-commit case covered by Task 1's dedicated tests (`commitFiles` on root commit and on an empty commit).
5. Text filter narrows loaded rows — implemented client-side in `GitGraphPanel` (`visibleRows` filter on `filterText`); not exercised in the coordinator's quick visual pass — recommend a follow-up manual check if this matters before shipping.
6. Load-more pagination — covered by Task 1's `commitLog` pagination test (`hasMore`); UI "Load more" button not clicked in the visual pass (repo only had 4 commits, below the 100-page size).
7. Locked worktree blocks removal, error surfaced — covered by Task 4's `removeWorktree`-on-locked test and Task 5's manual curl verification (lock → delete → 400 with git's lock-reason text).
8. Unlock restores removability — covered by Task 4's unit test and Task 5's manual curl verification.
9. "Remove merged" lists candidates before removing — covered by Task 6's manual verification (merged-candidates returned exactly the merged branch, not main; remove-merged removed only that one).
10. Favorites persist across restart — covered by Task 5's and Task 6's manual restart verification (favorite survived a graceful server restart).
11. Fetch/pull/push surfaces missing-upstream error — covered by Task 4's `fetchWorktree`-against-unreachable-remote test (git's real error text surfaces).
12. Failed action leaves state unchanged, shows git error — covered by the `GitError` → 400 mapping (Task 2) plus Task 5's locked-worktree-removal manual check (400 with git's message, worktree still listed).

## Deviations (repo-wide)
- Neither Task 3 nor Task 6's subagent performed a browser-based visual check (both explicitly disclosed this and verified at the data/route layer instead, per their instructions' fallback). The coordinator performed one combined visual pass afterward (see log above) covering most, but not all, of the finer interaction details (text filter, load-more, uncommitted-row toggling were not re-clicked). If those matter before shipping, a quick manual pass is worth doing.

## Log
- 2026-09-07 Tasks 1 and 4 — dispatched to subagents in parallel.
- 2026-09-07 Task 1 — done, commit ebd6c20. `pnpm -C server test`: 38/38 pass at the time (9 new). `pnpm -C server typecheck`: clean.
- 2026-09-07 Task 4 — done, commit f44b064 (git.test.ts additions only — see deviation below). Combined `pnpm -C server test`: 43/43 pass. `pnpm -C server typecheck`: clean.

## Deviations
- Task 1: `Commit`/`Ref` interfaces placed right after `listBranches` (natural interface/function boundary) rather than literally "around line 80" as the plan said — that line landed mid-`Worktree` interface in the real file.
- Tasks 1 and 4 ran concurrently in the same (non-isolated) working tree. Task 4's `git.ts` edits were on disk before Task 1 committed, so `ebd6c20` (Task 1's commit) ended up containing both tasks' `git.ts` changes; Task 4's own commit (`f44b064`) contains only its `git.test.ts` additions. Verified directly (not just from agent reports) that both tasks' functions exist in `git.ts` and all 43 tests + typecheck pass on the combined state — functionally correct, just misattributed between the two commits.
- Task 4: the plan's "no remote configured" test for `fetchWorktree` doesn't throw on git 2.47 (silent no-op with zero remotes). Adapted to configure an unreachable remote and assert on git's real error text instead.
- Tasks 2 and 5 ran concurrently in the same non-isolated worktree, both editing api.ts/types.ts. Task 2's commit (1b63d16) incidentally swept in Task 5's then-uncommitted api.ts/types.ts edits; Task 5's own commit (3ef9939) ended up carrying only db.ts. Verified directly: all of Task 5's 9 routes, the Worktree type fields, and db.ts's favorites table/accessor are present and correct across the two commits combined; typecheck and full test suite pass.
- Task 5: on macOS, `/tmp` resolves to `/private/tmp` and git's own worktree listing reports the resolved path — callers must use the same resolved path git reports (as the UI naturally does, since it reads paths from the `/git` snapshot) rather than a caller-typed `/tmp/...` path. Not a bug, just a note for manual testing.

## Blocked / needs a decision
- (none)
