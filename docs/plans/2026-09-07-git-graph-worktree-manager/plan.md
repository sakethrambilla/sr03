# Git graph + enhanced worktree management — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch / worktree:** this worktree (`sr03-git-graph-worktree-09921e`), branch `ai/sr03-git-graph-worktree-09921e`
**Test command:** `pnpm -C server test` (git.ts changes); no web test glob covers components, so UI tasks are verified manually per file map below.
**Lint / typecheck:** `pnpm typecheck` (runs both packages)

## Approach

Phase A adds a read-only commit-log/ref data layer to `git.ts` (two new
`git log`/`for-each-ref` wrappers, plus per-commit file/diff lookups),
exposes it as project-scoped REST routes, and renders it in a new
`GitGraphPanel` — an SVG lane graph computed client-side from parent
hashes, next to a commit table, opened as a dialog the same way
`WorktreePanel` already is. Phase B extends `git.ts`'s existing
`listWorktrees`/`Worktree` shape with lock state (already present in
`git worktree list --porcelain`, just unparsed today) and adds
lock/unlock/move/fetch/pull/push/merged-branch wrappers, a small SQLite
table for favorites, and matching `WorktreePanel` UI. Both phases reuse
the file's existing shell-out-to-git style — no new dependency, no
library, no framework.

## Global constraints

- No new runtime dependency in `server/` or `web/`; no graph-layout
  library — lane geometry is computed from commit parent hashes.
- Server TS is type-stripped (`erasableSyntaxOnly`): no enums, no
  namespaces, no parameter properties; import with explicit `.ts`
  extensions.
- Every new git call goes through `git.ts`'s existing `git()`/`diffText()`
  helpers so failures surface as `GitError` uniformly.
- New web UI uses only `components/ui/*` (shadcn) via `components/ui.tsx`
  wrappers, and `lucide-react` icons already aliased in `ui.tsx` (or newly
  aliased there, never imported raw in a component).
- Lane/ref colors are new CSS custom properties added to
  `web/src/index.css` next to the existing token block (light and dark
  variants), never inline hex in a component.
- No cherry-pick/revert/merge/rebase/stash actions, no checkout from the
  graph, no rewind/checkpointing — all explicit non-goals in the spec.
- `GitError` must map to HTTP 400 (not the default 500) so a failed
  fetch/pull/push/lock/move surfaces as a normal client error, not a
  server-error log line — currently only `HttpError` gets a non-500
  status in `handleApiRequest`.

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/git.ts` | Modify | Commit/Ref/CommitFile types; `commitLog`, `listRefs`, `commitFiles`, `commitFileDiff` (Phase A); `Worktree.locked`/`lockReason`; `lockWorktree`, `unlockWorktree`, `moveWorktree`, `fetchWorktree`, `pullWorktree`, `pushWorktree`, `mergedBranches` (Phase B) |
| `server/src/git.test.ts` | Create | node:test unit tests for every function above, against a real temp repo |
| `server/src/api.ts` | Modify | New routes for log/refs/commit-files/commit-diff/project-changes/project-diff (Phase A); worktree lock/unlock/move/fetch/pull/push/favorite/merged-candidates/remove-merged (Phase B); map `GitError` to 400 in `handleApiRequest` |
| `server/src/db.ts` | Modify | `worktree_favorites` table + `worktreeFavorites` accessor; `threads.setCwd` (used by the move-worktree route to keep existing sessions pointed at the new path) |
| `web/src/lib/types.ts` | Modify | `Commit`, `Ref`, `CommitFile` types; `Worktree` gains `locked`, `lockReason`, `favorite`, `ahead`, `behind` |
| `web/src/lib/api.ts` | Modify | Client methods for every new route |
| `web/src/components/GitGraphPanel.tsx` | Create | SVG lane graph + commit table + text/branch filter + load-more + file list/diff pane |
| `web/src/components/Sidebar.tsx` | Modify | Entry-point button next to `WorktreeButton` that opens `GitGraphPanel` |
| `web/src/components/WorktreePanel.tsx` | Modify | Lock/unlock/move/fetch/pull/push buttons, favorite star (sorted to top), "remove merged worktrees" bulk action |
| `web/src/components/ui.tsx` | Modify | New icon aliases used by the two panels above (lock, unlock, star, download/upload for fetch/pull/push, history for the graph entry point) |
| `web/src/index.css` | Modify | Fixed 8-color lane-token set (`--graph-lane-1` … `-8`), light + dark |

## Tasks

1. [tasks/01-commit-log-data-layer.md](tasks/01-commit-log-data-layer.md) — `git.ts` commit log, refs, commit-file, commit-diff functions + tests
2. [tasks/02-graph-api-routes.md](tasks/02-graph-api-routes.md) — API routes + web types for graph data + `GitError` → 400
3. [tasks/03-graph-panel-ui.md](tasks/03-graph-panel-ui.md) — `GitGraphPanel` component + Sidebar wiring + lane color tokens
4. [tasks/04-worktree-lifecycle-data-layer.md](tasks/04-worktree-lifecycle-data-layer.md) — `git.ts` lock/unlock/move/fetch/pull/push/merged-branches + tests
5. [tasks/05-worktree-management-routes.md](tasks/05-worktree-management-routes.md) — favorites table + API routes + web types
6. [tasks/06-worktree-panel-ui.md](tasks/06-worktree-panel-ui.md) — `WorktreePanel` UI enhancements + web client methods

## Spec coverage

| Acceptance criterion | Task |
|---|---|
| 1. Lanes + ref pills render | 3 |
| 2. Empty repo → empty state, no crash | 1, 3 |
| 3. Uncommitted-changes synthetic row | 2, 3 |
| 4. Click commit → files/diff, no error on empty commit | 1, 2, 3 |
| 5. Text filter narrows loaded rows | 3 |
| 6. Load-more pagination | 1, 2, 3 |
| 7. Locked worktree blocks removal, error surfaced | 4, 5, 6 |
| 8. Unlock restores removability | 4, 5, 6 |
| 9. "Remove merged" lists candidates before removing | 4, 5, 6 |
| 10. Favorites persist across restart | 5, 6 |
| 11. Fetch/pull/push surfaces missing-upstream error | 4, 5, 6 |
| 12. Failed action leaves list state unchanged, shows git error | 2 (GitError→400), 4, 5, 6 |

## Risks

- **Numstat/name-status lockstep parsing** (`commitFiles`, task 1) assumes
  git walks the same diff in the same order for `--name-status` and
  `--numstat` given identical arguments. This holds for a plain two-tree
  diff (no rename-detection threshold flags that could differ between
  invocations) but is worth a dedicated rename test case in task 1.
- **Moving a worktree** changes its on-disk path out from under any
  thread whose `cwd` (or PTY cwd) still points at the old one. Task 5's
  route retargets affected threads' `cwd` in the database, but an
  already-open terminal or a live agent process for that thread keeps
  its old OS-level working directory until the thread is next opened —
  call this out to the user in the move confirmation copy (task 6)
  rather than trying to rewrite a live process's cwd.
- **`git branch --merged`** compares against the *checked-out* branch of
  the repo's main worktree, not a configured "default branch" — sr03 has
  no concept of the latter today. This matches the spec's "merged into
  the project's default branch" criterion only if the main worktree's
  branch is what the user considers default; flagged in task 4.
