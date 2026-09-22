# File tree responsiveness — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch:** `perf/file-tree-responsiveness`
**Test command:** `pnpm -C web test`
**Single test file:** `node --experimental-strip-types --test web/src/lib/filetree.test.ts`
**Lint / typecheck:** `pnpm typecheck`
**Manual harness:** two scratch repos — never a real project, since worktree and edit operations
mutate what they point at.

```bash
# small, for correctness checks (the one CLAUDE.md describes)
mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
  && echo hello > README.md && git add . && git commit -qm init

# large, for every "is it still fast" check: 1,600 files in 40 folders, two of them gitignored
mkdir -p /tmp/sr03-big && cd /tmp/sr03-big && git init -q -b main
for d in $(seq 1 40); do mkdir -p "pkg$d/src"; for f in $(seq 1 40); do echo "export const v$f = $f;" > "pkg$d/src/m$f.ts"; done; done
printf 'pkg39/\npkg40/\n' > .gitignore && git add -A && git commit -qm init
```

## Approach

All the tree logic that does not need a DOM moves into one new module, `web/src/lib/filetree.ts`,
which the repo's existing node:test runner can cover — the same shape as `lib/layout.ts` and its
test file. `FileTree.tsx` stays a single component file but becomes a thin consumer of that
module plus a virtualizer.

The three structural changes, in dependency order: row projection becomes a flat array (which is
what makes virtualization possible at all), the per-row Radix menu roots collapse into one
panel-level menu driven by coordinates, and every directory read gets a revision token so a late
response cannot repaint a tree that has moved on.

The obvious alternative — patching `FileTree.tsx` in place without extraction — was rejected
because the load tracker and the concurrency limiter are exactly the kind of logic that fails
subtly and silently, and neither is testable from inside a component in this repo.

## Global constraints

- `@tanstack/react-virtual` is the only new dependency permitted. Add it to `web/package.json`
  only, in Task 3.
- New test files **must** live in `web/src/lib/` — `web/package.json`'s test script globs
  `src/lib/*.test.ts` and will not see a test file anywhere else.
- Server TS is type-stripped: no enums, no parameter properties, no namespaces, and imports
  carry explicit `.ts` extensions. The same import convention applies in `web/src/lib`.
- UI comes from the existing shadcn primitives in `web/src/components/ui`. Do not hand-roll a
  menu, button, or input, and do not edit files under `components/ui/`.
- Row height stays 22px, indent guides stay 12px, colour tokens and radii are unchanged.
- Zustand selectors must never return a fresh object or array. Use a module-level constant.
- No changes to `web/src/store.ts` in this plan — the refresh trigger belongs to the filesystem
  watcher plan.
- Every task ends at a commit, message per the repo's Conventional Commits rule.

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `web/src/lib/filetree.ts` | Create | Row projection, dirty-ancestor set, ancestor/parent helpers, subtree toggle, auto-expand policy, directory load tracker, concurrency limiter, entry insert/remove/rename and the sort comparator |
| `web/src/lib/filetree.test.ts` | Create | node:test coverage for every export above |
| `web/src/components/FileTree.tsx` | Modify | Consume the module; one panel-level menu; memoized row; virtualized viewport; per-directory loading state; optimistic mutations |
| `web/src/components/ui.tsx` | Modify | Spinner icon alias, if absent (Task 4) |
| `web/package.json`, `pnpm-lock.yaml` | Modify | Add `@tanstack/react-virtual` (Task 3 only) |
| `server/src/api.ts` | Modify | Add the batch ignore route; drop per-directory ignore from the tree route (Task 5) |
| `web/src/lib/api.ts` | Modify | Add the `ignored` client method (Task 5) |

## Tasks

1. [tasks/01-tree-model.md](tasks/01-tree-model.md) — pure tree model in `lib/`, no component change
2. [tasks/02-shared-menu-and-memo.md](tasks/02-shared-menu-and-memo.md) — one menu for the panel, memoized row, flat projection
3. [tasks/03-virtualize.md](tasks/03-virtualize.md) — windowed rendering over the flat projection
4. [tasks/04-load-tokens-and-loading-state.md](tasks/04-load-tokens-and-loading-state.md) — stale-read guarding, keep-children-visible, delayed spinner
5. [tasks/05-refresh-discipline.md](tasks/05-refresh-discipline.md) — capped concurrency, one ignore lookup, bounded auto-expand
6. [tasks/06-optimistic-mutations.md](tasks/06-optimistic-mutations.md) — create / rename / delete paint before the server answers

**Order is 1 → 2 → 3 → 4 → 5, with 6 free after 1.** The dependencies are real, not stylistic:

- Task 2 replaces the recursive row builder with the flat projection every later task indexes into.
- Task 3 needs that projection to have something to window.
- **Task 4 depends on 1, 2 and 3** — it adds a prop to Task 2's memoized `Row`, and Task 3's
  indexing rule is what forces its per-directory errors into the header rather than the list.
  It defines `EMPTY_DIRS`, `loadingDirs` and the token-guarded `load(path, { force })`.
- **Task 5 depends on 1, 2 and 4** — it consumes Task 2's projection and Task 4's `EMPTY_DIRS` and
  `load()`. Running it earlier fails `pnpm -C web typecheck` on undefined identifiers.
- Task 6 touches only the three mutation functions and can land any time after Task 1.

Task 5 ships as three commits (ignore batching, concurrency cap, auto-expand bound) because only
the first has a server half that must land atomically with its client half.

## Criterion coverage

Every acceptance criterion in the spec, and where it is implemented and checked:

| Criterion | Implemented in | Verified by |
|---|---|---|
| 1 — bounded row count | Task 3 | 03 step 9 |
| 2 — immediate response, delayed spinner | Task 4 | 04 step 15 |
| 3 — children stay visible during re-read | Task 4 | 04 step 14 (watch a re-expand under the delay patch: children never blank) |
| 4 — superseded reads discarded | Tasks 4, 5 | 04 step 14 |
| 5 — rename typing re-renders one row | Task 2 | 02 step 17 |
| 6 — concurrency cap respected | Task 5 Part B | 05 step 17 |
| 7 — one ignore lookup per refresh | Task 5 Part A | 05 step 10 |
| 8 — optimistic mutations with rollback | Task 6 | 06 steps 14–17 |
| 9 — auto-expand bounded | Task 5 Part C | 05 step 22 |
| 10 — failed directory read is contained | Task 4 | 04 step 17 |
| 11 — no scroll movement on re-render | Task 3 | 03 step 12 — record `scrollTop`, click three files, re-read it: unchanged |

## Risks

- **File rows lose their hover `…` menu (Task 2).** Today every row carries a dropdown but only
  directory rows carry the four action buttons. Removing the per-row dropdown leaves file rows
  with no hover affordance — rename, delete, copy path and reveal become right-click only. This is
  a real affordance regression accepted deliberately, because the alternative is keeping a Radix
  root per row, which is the whole thing Task 2 removes. If it turns out to bother you in use, the
  fix is one shared `…` button rendered into the hovered row, not a menu per row.
- **`noUnusedLocals` is on** (`web/tsconfig.json:10`), so every helper this plan moves into `lib/`
  must have its old copy deleted in the same task or `pnpm -C web typecheck` fails. Tasks 2 and 6
  each carry an explicit delete step for this reason; do not skip them as cleanup.
- **Task 5's Part A changes an API response shape.** `/api/threads/:id/tree` stops reporting
  `ignored`, so a client without the batch lookup renders every file as un-ignored. Part A commits
  both halves together.
- **The virtualizer and the indent guides.** Guides are `border-r` spans sized by depth, so a row's
  width is not uniform. The virtualizer measures height only, so this should not bite — but if a
  row's height is ever not exactly 22px the windowing will drift. Task 3's verification includes an
  explicit height assertion for this reason.
- **Dropping per-directory ignore from the tree route (Task 5) changes an API response shape.** The
  `ignored` field becomes always `false` from that route and the client must call the batch route.
  If Task 5 is landed without its client half, every file renders as un-ignored. The task commits
  both halves together.
- **Optimistic delete is the one mutation that is genuinely destructive.** Task 6 paints the removal
  immediately but the operation moves to Trash, so a rollback restores a row rather than a file.
  The task keeps the existing confirmation dialog in front of it.
- **Spec A's debounce-starvation problem is not fixed here.** A turn that writes continuously can
  still push the refresh out indefinitely, because the trigger lives in `store.ts` and belongs to
  the watcher plan. This plan does not regress it, and does not fix it.
- **`@tanstack/react-virtual` is the first new web dependency in a while.** If it turns out to be
  unwanted after Task 3, Tasks 4–6 do not depend on it and Task 3 is revertable on its own.
