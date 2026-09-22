# File tree responsiveness

## Problem

The file tree panel feels chunky and abrupt rather than continuous. Three things cause it.
Every row mounts a context menu root, a dropdown menu root, and four action buttons that are
hidden only by CSS — so a repo with a few hundred visible rows carries well over a thousand
always-mounted interactive components, all of which re-render whenever any panel state changes,
because no row is memoized. Expanding a folder shows nothing at all until a server round trip
completes: the chevron rotates and the row stays empty, which reads as a stall followed by a
jump. And a refresh re-reads every expanded directory at once, each read scanning the whole
change set again per directory row.

Orca's equivalent panel renders a bounded number of rows regardless of repo size and treats
every directory read as something that can arrive late, arrive stale, or not arrive at all.
That is the gap.

## Goal

The file tree stays responsive and visually continuous in a repository with thousands of files,
and every state change it shows is either immediate or explicitly in progress.

## Non-goals

Each of these is something a reader might reasonably assume is included. None of it is.

- **Drag and drop, or moving files by dragging.** Orca has it; we are not adding it.
- **Multi-select.** One selected path, as today.
- **Keyboard navigation of the tree.** Arrow-key traversal, type-ahead, focus rings.
- **Search within the tree.** The command palette owns file search and is unchanged.
- **Changing what the tree shows.** Same entries, same git status decorations, same ignore
  handling, same indent guides, same row height. Row *actions* are the one exception: file rows
  lose their hover overflow button and reach rename, delete, copy-path and reveal by right-click
  instead. Directory rows keep their inline buttons. This is a deliberate, named trade — the
  per-row overflow menu is a large part of what makes the tree heavy — and not licence to change
  anything else about a row.
- **Remote or SSH transports.** Orca tiers its concurrency by transport cost because it reads
  over SSH. Everything here is local.
- **The trigger that tells the tree something changed.** Covered by the filesystem watcher spec.
  This spec assumes the existing trigger and must work unchanged if the watcher never ships.
- **Any other panel.** The chat transcript, sidebar, and terminal are untouched.

## Behaviour

**Scrolling and rendering.** The tree renders only the rows near the viewport. Scrolling a
large repository stays smooth, and the scroll position is preserved across refreshes — a
refresh that changes nothing visible must not move the viewport.

**Expanding a folder.** The row responds immediately: the chevron turns. If the read outlasts the
spinner delay, an indicator joins it; a fast local read shows none. When the listing arrives the
children appear beneath it. If the folder was
expanded before and its contents are already known, the previously known children stay visible
for the whole read and are replaced only when fresh data lands — never cleared to empty first.

**Refreshing.** A refresh re-reads the open directories without ever blanking them. Reads are
capped so a deeply expanded tree cannot fire dozens of concurrent requests. Rows whose content
did not change do not visibly change.

**Stale and superseded reads.** If the user switches sessions, collapses a folder, or triggers
a second read of the same folder while the first is outstanding, the older response is discarded.
A late response never repopulates a tree that has moved on.

**Creating, renaming, and deleting.** The change appears in the tree immediately, before the
server has answered. If the server rejects it, the tree returns to its previous state and an
inline error names what failed.

**Large change sets.** Opening a session whose working tree has a very large number of changed
files must not expand every ancestor directory at once. Above a threshold the tree stays
collapsed and says how many files changed, leaving expansion to the user.

**Failure.** A directory that cannot be read is named in an error strip and leaves the rest of the
tree usable; it is reported once rather than retried in a loop. A failed root read is
distinguishable from a genuinely empty folder.

## Acceptance criteria

1. When the tree holds 5,000 visible rows, the number of row elements present in the document
   stays bounded by the visible window plus a fixed overscan, and does not grow with total row
   count.
2. When the user expands a directory whose contents are not yet known, the chevron turns
   immediately and no already-visible row changes its vertical position. When that read runs
   longer than the spinner delay, a loading indicator appears on that row; when it finishes
   sooner, no indicator appears at all — a spinner that fast reads as a glitch.
3. When a refresh re-reads a directory that already has known contents, those contents remain
   continuously visible until the new listing replaces them; at no point is the directory
   rendered as empty.
4. When a directory read completes after a newer read of the same directory has started, or
   after the session has changed, the older response does not modify the displayed tree.
5. When the user types in a rename or create input, no row other than the one being edited
   re-renders.
6. When a refresh runs against a tree with more open directories than the concurrency cap, the
   number of directory reads in flight at any moment does not exceed the cap.
7. When a refresh runs, the ignore lookup is issued at most once for the whole visible tree, not
   once per directory.
8. When the user creates, renames, or deletes an entry, the tree reflects it before the server
   responds; when the server then rejects the operation, the tree returns to its prior state and
   displays an inline error naming the operation and the reason.
9. When a session's working tree has more changed files than the auto-expand threshold, the tree
   does not auto-expand their ancestors and instead reports the change count.
10. When a directory read fails, the panel names it once and does not re-issue the read, the rest
    of the tree remains interactive, and a failed root read renders differently from an empty root.
11. When the panel re-renders for any reason other than a scroll, the scroll position is
    unchanged.

## Constraints

- **`@tanstack/react-virtual` is the approved new dependency** for virtualization, and the only
  one. No other new web packages.
- All UI continues to come from the project's shadcn primitives. No hand-rolled menus, buttons,
  or inputs, and no substituting text characters for icons.
- Row height, indent guides, colour tokens, and radii are unchanged. This is not a visual
  redesign; a screenshot before and at rest after should be indistinguishable.
- Logic that can be tested without a DOM must be extracted out of the component and unit tested,
  following the convention the repo already uses for its other pure modules. The component
  itself stays a single file.
- The existing REST-plus-one-WebSocket shape does not change. No new transport, no new
  long-lived connection.
- Must remain correct if the filesystem watcher spec never ships.

## Open questions

- **Concurrency cap value** — proceeding on the assumption of 16 concurrent directory reads,
  matching Orca's local tier, tunable in one place.
- **Auto-expand threshold** — proceeding on the assumption of 200 changed files, above which
  auto-expand is skipped. The number is a guess; it is defined as a single named constant so it
  can be changed after you have used it.
- **Overscan** — proceeding on the assumption of 20 rows above and below the viewport, matching
  Orca.
- **Spinner delay** — proceeding on 150ms before a loading indicator becomes visible, so a local
  read that completes in 40ms shows nothing. This follows Orca's rule that feedback under 100ms
  reads as a glitch, and is why criterion 2 is conditional rather than absolute.
