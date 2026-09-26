# Smooth archive animation

## Problem
Archiving all of a project's idle sessions, from the sidebar button or with ⌘⇧X, removes every
row in the same frame. The list snaps shut, it's hard to tell what just happened, and nothing
lets you take it back. Archiving a single session has the same abrupt snap.

## Goal
Archived rows leave the sidebar with a short staggered collapse, like Apple Mail, and a toast
lets you undo the archive.

## Non-goals
- No new animation dependency. CSS transitions only.
- No reduced-motion handling in this pass. The user explicitly left it out.
- No animation for rows entering the list (unarchive, new thread, undo restore).
- No animation for the Archive view, project collapse, or thread reordering.
- No change to which threads count as idle, and no server or database changes beyond what undo
  needs. Undo reuses the existing single-thread unarchive.

## Behaviour
When the user triggers "archive idle", each affected row fades out and slides slightly left,
while its height collapses to zero. The rows start about 30ms apart, top to bottom, so the
removal reads as a wave, and the rows below close the gap smoothly instead of jumping. A row
removed on its own (the archive action in the thread menu) animates the same way, without the
stagger.

When the animation finishes, a toast appears: "Archived N sessions", with an Undo button.
Clicking Undo unarchives exactly those sessions. They reappear without animation.

If the server call fails, no row animates away, and the existing error surface shows the
failure. If there is nothing idle to archive, nothing animates and no toast appears.

## Acceptance criteria
1. When archive-idle succeeds for N ≥ 1 threads, each of the N rows animates out (opacity →
   0, translate-x, height → 0) over about 200ms, the start times are staggered about 30ms
   apart in list order, and each row is gone from the DOM once its animation ends.
2. While those rows collapse, the rows below them move up continuously. No row jumps by a whole
   row's height in a single frame.
3. When a single thread is archived from its menu, that row plays the same exit animation with
   no stagger.
4. After an archive-idle of N ≥ 1, a toast reads "Archived N sessions" (or "Archived 1
   session" when N is 1) and shows an Undo action.
5. When Undo is clicked, all N threads become unarchived and show in the sidebar again, and the
   toast closes.
6. When the archive request fails, no rows animate away, the thread list is unchanged, and the
   error is shown the way it is today.
7. When archive-idle matches 0 threads, no animation runs and no toast appears.
8. The active thread is never animated or archived by archive-idle, which is today's behaviour.

## Constraints
- Must follow the repo conventions: shadcn's sonner for the toast (already present), token
  colours, no hand-rolled components, and zustand selectors that never return fresh arrays.
- Rows must be removed only after their animation ends, so the store update has to be deferred
  or driven by a "leaving" state. Other clients receiving the WebSocket upsert can snap, which
  is acceptable.

## Open questions
- Should a toast appear for a single-thread archive? The assumption is no, only for archive-idle.
- Duration and stagger values are 200ms and 30ms, with an ease-out curve close to Apple's, so
  the whole wave takes about 500ms even for many rows. The assumption is that the stagger is
  capped so a 20-row archive finishes within about 700ms.
