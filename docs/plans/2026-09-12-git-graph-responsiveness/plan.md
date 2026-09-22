# Git graph responsiveness — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch:** `perf/git-graph-responsiveness`
**Test command:** `pnpm -C web test`
**Single test file:** `node --experimental-strip-types --test web/src/lib/gitgraph.test.ts`
**Lint / typecheck:** `pnpm typecheck`

**Manual harness.** No repo in this project has enough history. Clone one, read-only, and never
point the app at one of your own projects — worktree and edit operations mutate what they touch:

```bash
git clone --bare https://github.com/nodejs/node.git /tmp/sr03-history.git \
  && git clone /tmp/sr03-history.git /tmp/sr03-history
```

## Approach

The lane layout moves to `web/src/lib/gitgraph.ts` and gets pinned by tests, because the spec
requires its output be identical commit-for-commit and that is only checkable if it is testable.

Rendering then changes shape: instead of an SVG sized to the whole history sitting next to a table
sized by its own row heights, both live in one relatively-positioned container and are positioned
from the same virtual-item offset. That is what makes drift structurally impossible rather than
merely unlikely.

**What is already fine, and must stay fine.** `GitGraphPanel.tsx:202-203` already memoizes
`withUncommitted` and `layoutGraph`, and `filterText` is not among their dependencies — so typing
does *not* re-run lane assignment today. Only the `visibleRows` filter (`:206-213`) and the `edges`
array inside `Graph` (`:85-96`) rebuild per keystroke. Do not "fix" the memoization that exists.

## Global constraints

- `@tanstack/react-virtual` only. It is currently absent from `web/package.json` and
  `pnpm-lock.yaml`; if the file tree plan has landed first it will already be there, and this
  plan's diff then shows no dependency change.
- New test files must live in `web/src/lib/` to be picked up by the test glob.
- `web/tsconfig.json:10` sets `"noUnusedLocals": true` — every symbol this plan moves or orphans
  must have its import or declaration removed in the same task, or `typecheck` fails.
- UI comes from the existing shadcn primitives. Replacing `Table` with grid rows is the one
  sanctioned exception and is confined to this panel.
- Lane colours (`--graph-lane-1` … `-8`, `web/src/index.css:35-42` / `:69-76`), node radii, row
  height and column widths are unchanged.
- The panel stays inside its `Dialog` (`GitGraphPanel.tsx:244`, `:251`). Moving it out is
  explicitly out of scope.
- Read-only: no checkout, cherry-pick, revert or merge.

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `web/src/lib/gitgraph.ts` | Create | Lane layout, uncommitted-node synthesis, lane colour, filter predicate, shared constants |
| `web/src/lib/gitgraph.test.ts` | Create | Pins lane assignment against fixtures; covers merges, filtering, the uncommitted node |
| `web/src/components/GitGraphPanel.tsx` | Modify | Consume the module; debounce the filter; one positioned container for graph and rows; virtualized |
| `web/package.json`, `pnpm-lock.yaml` | Modify | Add `@tanstack/react-virtual` (Task 2, only if absent) |

## Criterion coverage

| Criterion | Implemented in | Verified by |
|---|---|---|
| 1 — bounded row count | Task 2 | T2 step 12 |
| 2 — node centred on its row | Task 2 | T2 step 12 |
| 3 — nothing rebuilds until input settles | Task 1 | T1 step 9 |
| 4 — clearing the filter restores identical lanes | Task 1 | T1 step 8 (unit) + T2 step 13 |
| 5 — paging preserves scroll | Task 2 | T2 step 12 |
| 6 — uncommitted node | Task 1, Task 2 | T1 step 5, T2 step 14 |
| 7 — not-a-repo state | unchanged | T2 step 15 |
| 8 — failed history read | unchanged | T2 step 15 |

---

## Task 1: Extract and pin the lane layout; debounce the filter

**Depends on:** nothing
**Files:** Create `web/src/lib/gitgraph.ts`, `web/src/lib/gitgraph.test.ts`;
Modify `web/src/components/GitGraphPanel.tsx`

**Interfaces — produces:**

```ts
import type { Commit } from "./types.ts";

export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 16;
export const OVERSCAN = 20;
export const FILTER_DEBOUNCE_MS = 150;
export const UNCOMMITTED = "uncommitted";

export interface GraphRow { commit: Commit; lane: number }

export function layoutGraph(commits: readonly Commit[]): { rows: GraphRow[]; laneCount: number };
export function withUncommitted(
  commits: readonly Commit[],
  headHash: string | null,
  dirty: boolean,
): Commit[];
export function laneColor(lane: number): string;
/** `needle` must already be trimmed and lowercased by the caller. */
export function matchesFilter(commit: Commit, needle: string): boolean;
```

**Behaviour the implementer must not improvise:**

- `layoutGraph` and `withUncommitted` move from `GitGraphPanel.tsx:28` and `:61` with their logic
  unchanged. Do not simplify, rename locals, or tidy the lane loop — the spec requires identical
  output, and a silent behaviour change here is invisible until someone looks at a merge.
- `withUncommitted`'s existing body returns `commits` unchanged on the early path
  (`GitGraphPanel.tsx:62`). With a `readonly Commit[]` parameter and a `Commit[]` return that is an
  assignability error, so return `[...commits]` on that path. This is the one permitted edit.
- `matchesFilter` reproduces the predicate at `GitGraphPanel.tsx:207-212`: case-insensitive
  substring on message and author name, plus `hash.startsWith(needle)`.
- Neither function depends on component scope — `layoutGraph` uses only locals, `withUncommitted`
  only the module-level `UNCOMMITTED` (`:17`), `laneColor` only its argument.

**Steps:**

- [ ] 1. Create `web/src/lib/gitgraph.test.ts`, importing from `./gitgraph.ts`, which does not
      exist yet. Write the linear case: 4 commits in a chain, every row lane 0.

- [ ] 2. Add the branching case. Build a history that diverges and re-merges, and assert the exact
      lane for every row as a **literal array**, so any future change to the algorithm fails loudly.
      Generate the expected values by running today's `layoutGraph` on the fixture — this pins
      current behaviour rather than validating it, which is what the spec asks for.

- [ ] 3. Add the merge case: a commit with two parents puts the second parent in its own lane, and
      that lane is freed when the parent is placed.

- [ ] 4. Add the truncated case: a commit whose parent is absent from the list (beyond the loaded
      page) assigns a lane and does not throw.

- [ ] 5. Add the uncommitted cases: `dirty: false` returns a list of the same length;
      `dirty: true` with a head hash prepends a row whose hash is `UNCOMMITTED` and whose single
      parent is that head; `dirty: true` with a `null` head returns the input length unchanged.

- [ ] 6. Add `laneColor(0)` and `laneColor(8)` both resolving to `--graph-lane-1`, and
      `matchesFilter` hitting on message substring, author substring and hash prefix, and missing
      on a hash infix.

- [ ] 7. Run `node --experimental-strip-types --test web/src/lib/gitgraph.test.ts`.
      Expect: FAIL — `Cannot find module '.../web/src/lib/gitgraph.ts'`.

- [ ] 8. Create `web/src/lib/gitgraph.ts` by moving the functions out of `GitGraphPanel.tsx`. Keep
      their explanatory comments with them — the lane-assignment comment starting at
      `GitGraphPanel.tsx:24` describes non-obvious logic and must travel with the code.
      Run the test command again. Expect: PASS — `# fail 0`.

- [ ] 9. Update `GitGraphPanel.tsx` to import from the module and delete the local copies:
      `layoutGraph` (`:28`), `withUncommitted` (`:61`), `laneColor`, and the constants `ROW_HEIGHT`
      (`:15`), `LANE_WIDTH` (`:16`), `UNCOMMITTED` (`:17`) and the `GraphRow` interface (`:19-22`).
      All seven must go, not just the two functions — `noUnusedLocals` flags whichever you leave.

- [ ] 10. Debounce the filter. Keep `filterText` as the immediate input value so typing stays
      responsive, and derive a `needle` that lags it by `FILTER_DEBOUNCE_MS` via a `useEffect` +
      `window.setTimeout` (the repo's convention — a bare `setTimeout` resolves to the Node overload
      under `"types": ["vite/client", "node"]`).

- [ ] 11. Memoize what actually rebuilds per render: `visibleRows` (`:206-213`), keyed on
      `[rows, needle]` using the debounced needle, and the `edges` array inside `Graph` (`:85-96`).
      Leave the `withUncommitted` and `layoutGraph` memos at `:202-203` exactly as they are.

- [ ] 12. Run `pnpm -C web typecheck`. Expect: no output, exit 0. Run `pnpm test`. Expect: no new
      failures.

- [ ] 13. Verify visual parity: open the history panel on `/tmp/sr03-history`, screenshot it, and
      compare against a screenshot taken before this task. Indistinguishable — same lanes, same
      colours, same curve shapes.

- [ ] 14. Verify the debounce: type a six-character filter. The field keeps up with your typing and
      the list settles shortly after you stop. Then clear it and confirm the full history returns
      with the same lane assignment it had before (criterion 4).

- [ ] 15. Commit:
      `git add web/src/lib/gitgraph.ts web/src/lib/gitgraph.test.ts web/src/components/GitGraphPanel.tsx`
      `git commit -m "refactor(git): extract and test the commit lane layout"`

**Done when:** lane assignment is pinned by a literal expected-lane array, the panel renders
identically to before, typing no longer rebuilds the filtered list or the edge array per keystroke,
and `pnpm -C web typecheck` is clean.

---

## Task 2: One positioned container, virtualized

**Depends on:** Task 1
**Files:** Modify `web/src/components/GitGraphPanel.tsx`, and `web/package.json` +
`pnpm-lock.yaml` if the dependency is not already present

**Interfaces:**
- Consumes from `web/src/lib/gitgraph.ts`: `ROW_HEIGHT`, `LANE_WIDTH`, `OVERSCAN`, `laneColor`,
  `UNCOMMITTED`

**Two facts the implementer needs and cannot derive:**

**Which `laneCount`.** `Graph` currently computes it locally over the *visible* rows
(`GitGraphPanel.tsx:81`: `rows.reduce((max, row) => Math.max(max, row.lane + 1), 1)`), while
`layoutGraph` returns `lanes.length` over the *whole* history and the panel discards it
(`const { rows } = …` at `:203`). Keep the local, visible-rows computation. Switching to the
returned value widens the SVG whenever a filtered view uses fewer lanes, which fails the parity
check.

**Column widths do not exist to be reproduced.** Today's `<Table>` has no width declarations; the
browser computes them from content. Pick and record these, matching the current rendering closely
enough to pass a side-by-side screenshot: `minmax(0, 1fr)` for the message column (it already
carries `max-w-80 truncate`), `10rem` for author, `7rem` for date. If parity fails, adjust these
three numbers — not the surrounding structure.

**Steps:**

- [ ] 1. If `@tanstack/react-virtual` is absent from `web/package.json`, add it:
      `pnpm -C web add @tanstack/react-virtual`. If the file tree plan already added it, skip — and
      this task's diff must then not touch `web/package.json` or `pnpm-lock.yaml`.

- [ ] 2. Replace the `<Table>` block. It opens at `GitGraphPanel.tsx:284` and closes at `:317` —
      take that whole range; `:283` is the `</div>` closing the Graph wrapper and is not part of it.
      Remove the now-unused `Table, TableBody, TableCell, TableHead, TableHeader, TableRow` import at
      `:11`, or `noUnusedLocals` fails step 11.

- [ ] 3. Build the header row with the grid template above, and keep it **inside** the `ScrollArea`
      where `TableHeader` sits today, so it scrolls away exactly as it does now. Do not make it
      sticky — that is a visible change the parity check should fail.

- [ ] 4. Build each commit row as a grid div of height exactly `ROW_HEIGHT`, set explicitly rather
      than derived from content, because the graph's geometry depends on it. Reproduce the current
      cell styling: message `max-w-80 truncate` with its ref pills, author and date at
      `text-xs text-muted-foreground`. Add `data-graph-row` to the row div — step 12 counts on it.

- [ ] 5. Declare the scroll ref and resolve it to the Radix viewport, not the root:
      ```ts
      const scrollRootRef = useRef<HTMLDivElement>(null);
      const getScrollElement = () =>
        scrollRootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
      ```
      `web/src/components/ui/scroll-area.tsx:18` stamps that attribute, and the wrapper spreads its
      props onto `ScrollAreaPrimitive.Root` only — so the viewport cannot be reached by putting a ref
      on the component. Returning the root instead gives a virtualizer that renders one window and
      never updates on scroll; if rows stop appearing when you scroll, this is why.

- [ ] 6. Set up the virtualizer over `visibleRows`:
      ```ts
      const virtualizer = useVirtualizer({
        count: visibleRows.length,
        getScrollElement,
        estimateSize: () => ROW_HEIGHT,
        overscan: OVERSCAN,
        getItemKey: (index) => visibleRows[index]?.commit.hash ?? `__row_${index}`,
      });
      ```

- [ ] 7. Build one relatively-positioned container inside the `ScrollArea` with
      `height: virtualizer.getTotalSize()`. The SVG and the rows are both absolutely positioned
      children of it: the SVG at `top: 0; left: 0`, full total height, width
      `laneCount * LANE_WIDTH + LANE_WIDTH / 2`; each row at
      `transform: translateY(${item.start}px)` with a left padding equal to that SVG width.
      Both now derive their vertical position from the same offset, which is the point of the task.

- [ ] 8. Draw edges from **display** indices. Build `displayIndexByHash` from `visibleRows`, not
      from the full history, since filtering hides rows. Draw an edge only when both endpoints are
      in that map — an edge to a filtered-out or not-yet-loaded parent is skipped, exactly as the
      current code already skips parents beyond the loaded page (`GitGraphPanel.tsx:90`).
      Draw **every** such edge, not only those intersecting the virtual window: an on-screen commit
      whose parent is scrolled off must still show its edge running off the top or bottom, which is
      what the panel does today. The SVG spans the full height, so off-screen segments cost only
      path data.

- [ ] 9. Lanes still come from the full layout, per the spec — this is the deliberate "gapped graph
      while filtering" behaviour, and the open question in the spec says so. Do not re-lane
      `visibleRows`.

- [ ] 10. Confirm paging preserves scroll. `loadMore` appends, so existing rows keep their item
      keys and TanStack keeps the offset — verify in step 12 rather than assuming.

- [ ] 11. Run `pnpm -C web typecheck`. Expect: no output, exit 0.

- [ ] 12. Verify at scale on `/tmp/sr03-history`. Click Load more until at least 2,000 commits are
      loaded, then in the console:
      ```js
      document.querySelectorAll('[data-graph-row]').length
      ```
      Expect: bounded by the visible window plus ~40, not tracking 2,000.
      Then: scroll to the middle, note the top visible commit, click Load more, and confirm your
      position has not jumped. Scroll the full height and confirm every node is vertically centred
      on its own row with no blank bands.

- [ ] 13. Verify parity against the Task 1 screenshot: same columns, same alignment, same lane
      colours and node sizes, header still scrolling with the list. Then filter, clear the filter,
      and confirm lanes are identical to before filtering (criterion 4).

- [ ] 14. Verify the uncommitted node: with a dirty working tree, the synthetic node appears above
      the head commit with an edge down to it, and clicking it still lists the working-tree changes
      in the side panel.

- [ ] 15. Verify the two error states still render. Not-a-repo: point the panel at a plain folder
      added as a project (`mkdir /tmp/sr03-notgit`), expect the "not a git repository" message and
      no graph. Failed history read: with the panel open on `/tmp/sr03-history`, `chmod a-r` its
      `.git` directory, click Load more, and expect the failure shown with previously loaded commits
      still visible. Restore with `chmod u+r`.

- [ ] 16. Commit — include the dependency files if step 1 added them, or a fresh clone will not
      build:
      `git add web/src/components/GitGraphPanel.tsx web/package.json pnpm-lock.yaml`
      `git commit -m "perf(git): virtualize the commit history and anchor the lane graph to rows"`

**Done when:** 2,000 loaded commits render a bounded number of rows, every node is centred on its
row at any scroll position, paging preserves position, the header still scrolls with the list, and
the panel is visually indistinguishable from before.

## Risks

- **The `ScrollArea` viewport is the most likely thing to get wrong.** Step 5 exists for it. If rows
  render once and never update on scroll, `getScrollElement` is returning the wrong node.
- **Column widths are invented, not reproduced,** because the current table has none. Step 13's
  side-by-side is the only thing standing between that and a visible regression.
- **"Identical lane output" pins, it does not validate.** Task 1 step 2's expected array is
  generated by running today's code, so it locks in whatever that code does — including any bug it
  already has. That is intended here, but worth knowing.
- **Two plans can both add `@tanstack/react-virtual`.** Whichever lands second must not re-add it.
  Step 1 branches on this; check `web/package.json` before running it rather than after.
