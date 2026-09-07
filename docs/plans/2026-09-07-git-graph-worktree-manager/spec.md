# Git graph + enhanced worktree management

## Problem

sr03 has no way to see commit history as a graph, and its worktree UI
(`WorktreePanel`) is a single flat dialog: create-worktree-on-new-branch,
checkout-existing-branch, remove. There's no lock/move, no per-worktree
fetch/pull/push, no bulk cleanup of merged worktrees, and no favorites.
Users doing multi-worktree, multi-agent work (sr03's core use case) can't
see how branches relate to each other, and have to leave the app or drop
to a terminal to do routine worktree hygiene.

## Goal

From a project's UI, a user can open a commit graph showing branches,
tags, and remote-tracking refs with commit relationships, inspect any
commit's changed files/diffs, and manage worktrees (lock/unlock, move,
fetch/pull/push, bulk-remove merged, favorite) without leaving sr03.

## Non-goals

- No cherry-pick, revert, merge, rebase, or stash actions on commits (fast-follow).
- No checkout-from-graph in v1 (fast-follow) — checkout stays in `WorktreePanel` as it works today.
- No rewind/checkpointing/file-snapshotting of any kind (already out of scope repo-wide).
- No graph-layout third-party library — layout is computed client-side from parent hashes, matching git-graph's own approach.
- No changes to how worktrees are created today (path scheme, `.worktreeinclude` copy) — Phase B only adds new lifecycle actions on top.
- No repairWorktree/bundleRepo/system-explorer/terminal-launch parity with jackiotyu — out of scope for this plan.

## Behaviour

**Commit graph (Phase A).** A new panel, opened per-project alongside the
existing worktree entry point, shows a left-hand lane graph (one colored
lane per branch) next to a scrollable commit table (message, author,
date, ref pills for branches/tags/remotes pointing at that commit).
Uncommitted changes in the currently-open worktree appear as a synthetic
row at the top when the worktree is dirty. The list loads a page of
commits at a time with a "load more" control. Clicking a commit row shows
its changed files (reusing the existing file-diff view) below or beside
the graph. A text filter narrows the visible commits by message/author/
hash; a branch filter narrows which refs' history is included.

If the project isn't a git repo, or has no commits yet, the panel says so
instead of rendering an empty graph.

**Worktree management (Phase B).** `WorktreePanel` (or its successor)
gains, per worktree: lock/unlock (with a reason on lock, matching `git
worktree lock`), move to a new path, fetch, pull, push, and a star/
favorite toggle that persists across restarts. A "remove merged
worktrees" bulk action removes every worktree whose branch is fully
merged into the project's default branch, after a confirmation listing
which ones qualify. Locked worktrees can't be removed (single or bulk)
until unlocked, matching git's own behavior. Favorited worktrees are
pinned to the top of the list.

## Acceptance criteria

1. When a user opens the graph panel on a project with commits on more
   than one branch, the system renders one lane per branch with commits
   connected to their parents, and a ref pill on every commit that a
   branch, tag, or remote-tracking ref points at.
2. When a user opens the graph panel on a project with no commits, the
   system shows an empty-state message and does not attempt to render a
   graph.
3. When the current worktree has uncommitted changes, the graph shows a
   synthetic "Uncommitted changes" row above HEAD's commit, and clicking
   it shows the working-tree diff (via the existing changed-files/diff
   plumbing) rather than a commit diff.
4. When a user clicks a commit row, the system shows that commit's
   changed files and, on selecting a file, its diff; no server error is
   raised for a commit with zero changed files (root commit or empty
   commit).
5. When a user types into the commit filter, the system narrows the
   visible rows to those matching the text (message, author, or hash
   prefix) without re-fetching already-loaded pages.
6. When there are more commits than the current page size, the system
   shows a "load more" control that appends the next page; when there
   are no more commits, the control is not shown.
7. When a user locks a worktree with a reason, subsequent attempts to
   remove that worktree (single or as part of "remove merged") are
   rejected by the server with an error naming the lock reason, and the
   UI surfaces that error instead of removing it.
8. When a user unlocks a previously locked worktree, it becomes
   removable again through the existing remove flow.
9. When a user triggers "remove merged worktrees", the system first
   lists which worktrees qualify (branch merged into the project's
   default branch) and removes only those the user confirms; a worktree
   with unmerged commits is never listed as a candidate.
10. When a user favorites a worktree, it persists in the database and
    still appears favorited after a server restart; unfavoriting removes
    it from that list the same way.
11. When a user fetches, pulls, or pushes on a worktree with no
    configured upstream/remote, the system surfaces the git error
    message rather than silently no-op'ing.
12. When a fetch/pull/push/move/lock/unlock action fails (e.g. dirty
    worktree blocking a pull), the system shows the git error text to the
    user and leaves the worktree list state unchanged.

## Constraints

- Server: Node built-ins only, no new dependency, type-stripped TS
  (`erasableSyntaxOnly`) — matches existing `git.ts` style.
- Client: graph rendering is hand-built (SVG), no layout library; UI
  controls must be shadcn/ui components via `components/ui.tsx`, icons
  from `lucide-react` only.
- Wire types added to `server/src/types.ts` must be mirrored in
  `web/src/lib/types.ts` in the same change.
- Favorites persist via a new SQLite table in `db.ts`, following the
  existing projects/threads persistence pattern.
- Commit log and ref enumeration must be paginated server-side
  (`--max-count`/`--skip` or equivalent) — never load full history in
  one call.

## Open questions

None outstanding — all resolved during scoping:
- v1 graph interactions: view + diff only, no checkout/cherry-pick/etc.
- Ref scope: local branches + tags + remote-tracking refs.
- Placement: new per-project panel, not folded into `WorktreePanel`.
- Favorites: persisted server-side in SQLite.
