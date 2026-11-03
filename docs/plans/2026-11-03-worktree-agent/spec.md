# Spawn another agent in the same worktree

## Problem
A thread's worktree is reachable only by the thread that created it. To put a second agent
(say Codex reviewing what Claude just wrote, or a Claude side-question while a long turn runs)
on the same checkout, the user has to start a New thread, pick the project, tick worktree and
find the right path by hand — and the result opens as a separate thread that replaces the one
they were watching.

## Goal
From any thread, one click and a provider pick puts a new agent session on that thread's exact
cwd, open as a tab next to the current chat.

## Non-goals
- No coordination between agents: they don't see each other's transcripts, there are no file
  locks, and concurrent edits are the user's to manage.
- No entry point in the sidebar or the worktree menus — only the chat header.
- No keyboard shortcut.
- No sidebar grouping by worktree; the list stays flat.
- No split-on-open: the tab lands in the current group; the user can drag it into a split with
  the existing drag-and-drop.
- Not limited to worktrees: a thread on the project folder itself spawns onto that folder too
  (same mechanism, same cwd rule).

## Behaviour
The chat header gets a **+ Agent** button beside the provider chip. Clicking it opens a menu of
the installed providers (Claude, Codex, Cursor), the current thread's provider first. Picking one
adds a **New agent** tab to the focused editor group and activates it. The tab holds the normal
composer with provider, model, effort and permission pickers, but the location is locked: it shows
the parent's branch chip and cannot be changed.

On first send the thread is created with the parent's cwd and the turn starts. The tab's title
becomes the new thread's title, and the new thread appears in the sidebar like any other, with the
same branch chip as its parent. Closing the tab before sending discards the draft; closing it after
sending keeps the thread (it is still in the sidebar). Opening the child thread from the sidebar
shows it as its own primary chat, as usual.

If the parent's cwd no longer exists (worktree removed) when the user sends, the send fails with an
inline error in that tab and no thread is created. The menu lists the same providers as the New
thread picker, which does not disable a missing CLI either; a missing CLI fails the first turn the
same way it does for a New thread.

## Acceptance criteria
1. When the user clicks + Agent in a thread's header, a menu lists every provider the New thread
   picker lists, the current thread's provider first.
2. When the user picks a provider, a tab titled "New agent" is added to and activated in the
   focused editor group, and the original chat tab stays in that group, unchanged.
3. When the user sends the first message in that tab, a thread is created whose cwd equals the
   parent's cwd and whose branch chip matches the parent's, and it appears in the sidebar.
4. After that send, the tab title shows the new thread's title, and its transcript streams in the
   tab while the parent's chat tab keeps streaming its own turn.
5. When the user reloads the app, a tab holding a sent child thread is still in the group; an
   unsent New agent tab is gone.
6. When the parent's cwd has been deleted and the user sends, the tab shows the server's error and
   no thread is created.
7. When the user closes a child thread's tab, the thread still exists in the sidebar and its CLI
   process is not stopped mid-turn.
8. Changing the location in the New agent tab is not possible: no folder, branch or worktree
   picker is shown.

## Constraints
- Per-thread layouts are persisted by the server, which rejects tab kinds it doesn't know, so a new
  tab kind needs both the server guard and the client type updated together.
- UI pieces come from the existing shadcn components and lucide icons.

## Open questions
- Approval prompts from a child running in a background tab — proceeding on the assumption that
  they surface in the child's tab composer, not on the parent's chat, with no extra marker on the
  tab itself for now.
