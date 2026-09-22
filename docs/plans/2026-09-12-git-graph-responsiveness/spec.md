# Git graph responsiveness

## Problem

The commit history view renders every loaded commit at once. Paging in more commits makes it
progressively heavier, and because the lane graph and the commit table are two separate elements
that only line up when each table row happens to be exactly the assumed height, the graph can
drift out of alignment with the rows it describes. The lane assignment itself is already memoized
and does not re-run while typing — but the filtered row list and the whole edge-geometry array are
rebuilt on every render, and the filter field has no debounce, so each keystroke walks and
re-renders the entire loaded history.

The panel also lives inside a modal dialog, which means history cannot be consulted while doing
anything else.

## Goal

Commit history stays responsive at thousands of commits, and the lane graph cannot drift out of
alignment with its rows.

## Non-goals

- **Write operations.** No checkout, cherry-pick, revert, merge, branch create, or stash. The
  view stays read-only, as it is today.
- **Changing the lane assignment algorithm.** The single-pass lane layout is correct and stays;
  only when and how often it runs changes.
- **Moving the panel out of its dialog.** Making history a dockable panel is a layout change with
  its own design questions. Called out here because it is the obvious next thought, and it is
  not in this scope.
- **Infinite scroll.** Explicit paging stays.
- **Graph rendering for the diff view.** The changed-file list and diff pane below the graph are
  unchanged.
- **Searching commit contents.** The filter matches message, author, and hash prefix, as today.

## Behaviour

**Scrolling.** Only the commits near the viewport are rendered, including their lane segments.
Scrolling stays smooth after many pages have been loaded.

**Alignment.** Each commit's lane node and its row are produced together, so the graph cannot
disagree with the table about where a row is. Changing row height, font, or density moves both
or neither.

**Filtering.** Typing in the filter does not re-lay-out the graph on every keystroke. The field
stays responsive while typing and the results settle shortly after the user stops. Filtering
narrows which commits are shown; lanes are computed from the full loaded history so the graph
stays topologically honest rather than re-laning a filtered subset.

**Paging.** Loading more commits appends to the list and preserves the current scroll position —
the user's place does not move because more history arrived below.

**Empty and error states.** A repository with no commits, a folder that is not a repository, and
a failed history read each say what happened; none of them render an empty graph.

## Acceptance criteria

1. When 2,000 commits are loaded, the number of commit row elements present in the document
   stays bounded by the visible window plus a fixed overscan.
2. When the user scrolls the history, each visible commit's lane node is vertically centred on
   its own row, at any row height.
3. When the user types in the filter, neither the filtered row list nor the edge-geometry array
   is rebuilt until input has settled; each is rebuilt at most once per settled input. The lane
   assignment does not re-run at all, which is already true today and must stay true.
4. When the filter is cleared, the visible set returns to the full loaded history and the lane
   assignment is identical to what it was before the filter was applied.
5. When more commits are loaded, the scroll position stays on the commit the user was looking at.
6. When the working tree is dirty, the synthetic uncommitted node appears above the head commit
   with an edge to it, as today.
7. When the folder is not a git repository, the panel says so and renders no graph.
8. When a history read fails, the panel shows the failure and the previously loaded commits, if
   any, remain visible.

## Constraints

- **`@tanstack/react-virtual`** — the same dependency the file tree spec introduces, and no
  other new packages. If the file tree work has not landed, this spec introduces it.
- UI continues to come from the project's shadcn primitives.
- The visual result is unchanged: same lane colours, same node sizes, same row height, same
  columns. This is not a redesign.
- The lane layout algorithm's output must be identical, commit for commit, before and after.
  This is verifiable and should be verified rather than assumed.
- The commit rows stop being an HTML table. A `<table>` cannot be positioned per row, which is
  what windowing requires. Column widths, text sizes, row height and header treatment must be
  reproduced — and the header must keep scrolling with the list rather than becoming sticky,
  which is what it does today.

## Open questions

- **Filter debounce interval** — proceeding on 150ms, matching the coalescing window used
  elsewhere, defined as a named constant.
- **Whether filtering should re-lane the filtered set** — proceeding on *no*: lanes come from the
  full loaded history, and filtering hides rows. Re-laning a filtered subset would draw edges
  between commits that are not actually parent and child, which is worse than a gapped graph.
  This is a deliberate behaviour choice worth objecting to if you disagree.
- **Overscan** — proceeding on 20 rows, matching the file tree spec.
