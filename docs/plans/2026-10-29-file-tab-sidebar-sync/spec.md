# File tab ↔ explorer sync, and chat file links that resolve

## Problem
Opening or switching to a file tab in the editor leaves the explorer sidebar unchanged: the active
file is not highlighted, and if its folder is collapsed you can't see where it lives. Separately,
clicking a file path the agent writes in chat as a link sometimes opens a "file not found" view even
though the file exists — reported for absolute paths, relative paths carrying a `:line` suffix, and
paths with spaces / URL-encoding.

## Goal
The explorer always reveals and highlights the active editor tab's file, and every chat link that
names a real file on disk opens it.

## Non-goals
- No option to turn auto-reveal off (VS Code's `explorer.autoReveal` setting).
- No jumping to the `:line` / `#L` target inside the opened file — the suffix only has to stop
  breaking resolution.
- No change to which links the chat renders as clickable.
- No new file-tree features (rename, drag, multi-select).

## Behaviour
**Reveal.** When a file tab becomes active — opened from anywhere, clicked in a tab strip, focused
in another editor group, or restored on load — the explorer expands every collapsed ancestor folder,
scrolls the file's row into view, and highlights it as selected. Folders the user expanded stay
expanded; reveal only opens, never collapses. Non-file tabs (chat, subagent, diff of nothing) clear
the selection. If the explorer panel is hidden, nothing visible happens; showing it reveals the
current file.

**Links.** A chat link is decoded and normalized before lookup: percent-encoding decoded, `file://`
stripped, trailing `:line`, `:line:col` and `#Lline` removed. An absolute path inside the thread's
project or worktree opens as that project-relative file. An absolute path inside the main checkout
while the thread runs in a worktree (or vice-versa) maps to the same relative path in the thread's
root when that file exists there. A relative path resolves against the thread's root.

**Outside / missing.** If the normalized path exists on disk but lies outside the thread's root, the
link reveals it in Finder instead of showing an error. If it does not exist at all, the not-found
view names the exact path that was tried.

## Acceptance criteria
1. When the user clicks a tab whose file sits in a collapsed folder, every ancestor folder of that
   file is expanded and the file's row is highlighted and scrolled into view.
2. When the user switches between two file tabs, exactly one tree row is highlighted — the active
   tab's — and folders opened for the previous tab remain open.
3. When the active tab is not a file, no tree row is highlighted.
4. When a chat link is `/abs/path/to/worktree/src/a b.ts:42` or `src/a%20b.ts#L42`, clicking it
   opens `src/a b.ts` in an editor tab.
5. When a chat link is an absolute path into the main checkout and the thread runs in a worktree
   containing the same relative file, clicking it opens that file from the worktree.
6. When a chat link names an existing file outside the thread's root, clicking it reveals the file
   in Finder and opens no editor tab.
7. When a chat link names a file that does not exist, the not-found view shows the full path that
   was looked up.

## Constraints
- Reveal-in-Finder throws on Windows (existing degradation); there the outside-root case falls back
  to the not-found view naming the path.
- Server: Node built-ins only. UI: existing shadcn components and the existing file tree — no new
  tree library.

## Open questions
- Exact failing link strings weren't captured — proceeding on the assumption that the three shapes
  above cover them; exploration will try to reproduce each and record any extra shape found.
