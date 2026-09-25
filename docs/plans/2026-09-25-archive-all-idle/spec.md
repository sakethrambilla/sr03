# Archive all idle sessions in a project

## Problem
A project's sidebar list fills up with sessions that are finished or stopped but not archived.
Clearing them means opening each session's `…` menu and picking Archive, once per session. With
a dozen stale sessions in one folder, that takes a dozen round trips.

## Goal
One click, or one shortcut, archives every session in a project that isn't running.

## Non-goals
- Archiving across all projects at once. It always works on one project.
- Stopping or interrupting running sessions. Running ones are left alone.
- Bulk unarchive, multi-select or checkbox selection.
- A confirmation dialog or an undo toast. Each session can still be unarchived one at a time.
- Deleting sessions, removing worktrees or touching anything on disk. Archive stays a flag.
- Any change to how a single session is archived today.

## Behaviour
Each project header in the sidebar gets an **Archive idle sessions** icon button among its hover
buttons, next to New session. When one folder is picked in the sidebar's folder filter, the same
button appears in the toolbar row instead, because that view has no project headers.

Clicking it immediately archives every session in that project that is:
- not archived, and
- idle or errored (not running), and
- not the session currently open in the editor.

Those sessions move into the Archived section, and every connected client sees the change. The
button is disabled when nothing qualifies. Its tooltip names the action and the shortcut.

**⌘⇧X** (Ctrl⇧X off macOS) does the same for one project: the open session's project, or the
folder picked in the filter if no session is open. With neither, it does nothing.

If the server rejects the request, the sidebar shows the error the way other sidebar failures do,
and no session changes state.

## Acceptance criteria
1. When a project has 3 idle, 1 errored, 1 running and 1 already-archived session, none of them
   open, clicking the button leaves exactly 5 archived and the running one unarchived.
2. When the open session is idle and in that project, it stays unarchived after the click.
3. When every non-archived session in the project is running or open, the button is disabled.
4. When a folder is picked in the filter, the button is shown in the toolbar row and acts on that
   folder only. Sessions in other projects are unchanged.
5. When ⌘⇧X is pressed with a session open, the idle sessions in that session's project are
   archived. Sessions in other projects are unchanged.
6. When ⌘⇧X is pressed with no session open and no folder picked, nothing changes and no request
   is sent.
7. When a second browser tab is open, it shows the same sessions as archived without a reload.
8. When the server call fails, an error appears and no session's archived flag changes.
9. A session that starts running between the click and the server handling the request is not
   archived.
10. SHORTCUTS.md lists ⌘⇧X.

## Constraints
- Must use the existing archived flag and the existing thread-update event, so clients running
  today's code can apply it without changes.
- UI comes from the existing shadcn components and lucide icons (repo convention).

## Open questions
- Which shortcut? Proceeding with **⌘⇧X**, which is free in SHORTCUTS.md and not claimed by
  Chrome.
- Does "the chat I have open" mean only the focused session, or every session in an editor tab?
  Proceeding on the assumption that it means the focused session only.
