# Editor split groups

## Problem

A session shows exactly one thing at a time. The chat tab and every open file tab share a single
strip, and selecting one hides the rest. So the two views you most want together — the transcript
while the agent writes, and the file it is writing — can only be looked at in alternation, and
comparing two files means clicking back and forth and holding the difference in your head. Every
editor sr03 is measured against solves this with side-by-side groups; sr03 has no equivalent, and
no way to ask for one.

## Goal

A session's editor area can be split into two or three groups, horizontally or vertically, by
dragging a tab to the edge of the area and dropping it on a previewed target — and it is still
split that way the next time the session is opened.

## Non-goals

- **Dragging a tab between two sessions.** Drags are confined to the session they start in.
- **Moving the terminal, agents panel or file tree into a group.** Those keep their current fixed
  docks and are unaffected by any split.
- **Tearing a tab out into its own OS window.**
- **Nested grids.** Three groups sit along one axis. There is no group that is itself split the
  other way, and no fourth group.
- **Splitting the same file into two groups.** A file is open in exactly one group at a time.
- **Rewriting how files open.** Quick open, file tree clicks and `⌘`-clicking an import keep
  landing where they land today, in whichever group is focused.

## Behaviour

**Splitting.** Press and hold a tab and it lifts. As the pointer moves over the editor area, an
overlay previews where a drop would put it: hovering the outer border band of a group previews a
half-size rectangle against the edge nearest the pointer — left, right, top or bottom — and
anywhere else previews the whole group, meaning "move it into this group, no split". Release and
the tab lands where the preview showed. Dropping on an edge creates a new group there; the axis of
the first split fixes the axis for the session, so a second split can only extend the same row or
column, and the sr03 area is never more than three groups wide or tall.

**Living with a split.** Each group has its own tab strip and its own active tab; the focused group
is the one that a newly opened file goes to and the one keyboard shortcuts act on. A sash between
groups drags to re-proportion them, and double-clicking it returns the groups to equal shares.
Closing a group's last tab removes the group and gives its space back to its neighbours; when only
one group is left the layout is indistinguishable from today's.

**The chat tab.** Chat is an ordinary tab for the purposes of dragging: it can be moved into any
group and sit beside a file. It remains unclosable — it can be moved but never closed, so a session
always has exactly one chat tab somewhere. In a narrow group the transcript and composer stay
usable at reduced width rather than switching to a different layout.

**By keyboard.** Splitting is not only a drag. `⌘\` splits the focused group's active tab into a
new group along the session's axis, and `⌘K ←` / `⌘K →` move focus between groups — which is also
the only way to reach a group without a pointer. Both obey the same three-group and single-axis
caps as a drop.

**Reordering.** Because tabs can be dragged, they can also be dropped onto another tab's strip
position, which moves them within that strip. This is the same gesture as a split, resolved
differently by where it is released.

**When things go wrong.** A drop that lands outside any group, or that would exceed three groups,
or that is cancelled with `Esc`, leaves the layout untouched and the tab where it started. A file
that is deleted or renamed on disk is handled per group exactly as it is handled today. If a stored
layout can no longer be reconstructed — the file it names is gone, or the record is malformed — the
session opens as a single group with the chat tab in it rather than failing to open.

## Acceptance criteria

1. When a tab is dragged and the pointer is inside a group's outer border band, an overlay covers
   the half of that group nearest the pointer, and releasing there creates a new group on that side
   containing the dragged tab.
2. When a tab is dragged and the pointer is in the middle of a group, away from its border band,
   an overlay covers the whole group, and releasing there moves the tab into that group's strip
   without changing the number of groups.
3. When the session already has two groups split horizontally, dropping a tab on the top or bottom
   edge of either group produces no split preview, and releasing there leaves the layout unchanged.
4. When the session already has three groups, no edge of any group offers a split preview.
5. When the chat tab is dragged into a second group, the transcript and composer render in that
   group and the session still shows exactly one chat tab.
6. When a group's last remaining tab is closed, that group is removed and the remaining groups
   expand to fill the area.
7. When the sash between two groups is dragged, the two groups resize together and no group can be
   reduced below a minimum width or height that keeps its tab strip readable.
8. When a session with a split layout is closed and reopened — including after a full reload of the
   app — it reopens with the same number of groups, the same axis, the same proportions, the same
   tabs in each group and the same active tab per group.
9. When a stored layout names a file that no longer exists, the session opens with that file absent
   from its group, and if that leaves the group empty the group is dropped, without an error dialog.
10. When a stored layout cannot be parsed at all, the session opens as a single group containing the
    chat tab, and no error is shown to the user.
11. When a drag is cancelled with `Esc` or released outside the editor area, the layout and the
    dragged tab's position are both unchanged, and no overlay remains on screen.
12. When a file is opened from quick open, the file tree, or a `⌘`-click while a split is active,
    it opens in the focused group.
13. When `⌘\` is pressed with two groups already open along one axis, a third group is created on
    that same axis; pressed again with three open, nothing changes.
14. When `⌘K →` is pressed, focus moves to the next group and the following `⌘W` closes that
    group's active tab rather than the previously focused group's.
15. When the folder contains a file named `chat`, opening it shows that file's contents, and the
    transcript remains reachable as its own separate tab.

## Constraints

- The layout is stored on the server alongside the thread, so it survives across browsers and the
  desktop app. That means the wire format is part of this change, and the server's own type
  definitions and their mirrored copy on the web have to move together.
- A thread row that predates this feature has no stored layout; it must open as a single group
  rather than requiring a migration step before the session is usable.
- A tab is identified by a tagged value — the transcript or a file path — not by a bare string, so
  a file named `chat` can never be mistaken for the transcript.
- The dependency budget stands: the drag interaction, the overlays and the sashes are built from
  what is already in the project. No drag-and-drop or layout library.
- Every open file stays mounted today so unsaved edits survive tab switches. That must remain true
  across a split — moving a tab between groups must not remount its editor and must not discard
  unsaved changes.
- Keyboard shortcuts that act on "the active tab" become shortcuts that act on the focused group's
  active tab, and each one is recorded in the project's shortcut reference in the same change.

## Open questions

- Whether the split axis should be per session or a single global preference — proceeding on the
  assumption that it is per session, decided by the first drop or the first `⌘\`, since that needs
  no settings UI.
- Whether a group's proportions should be stored as fractions or pixels — proceeding with fractions,
  so a layout saved on a wide screen still opens sensibly on a narrow one.
- Whether the focused group should be visually marked beyond its active tab styling — proceeding
  without a distinct focus outline, since the tab strip's existing accent already reads as focus,
  and adding one is a small follow-up if it turns out to be needed.
