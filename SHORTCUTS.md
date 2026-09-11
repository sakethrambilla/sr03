# Keyboard shortcuts

Every shortcut sr03 handles. `⌘` is `Ctrl` on Linux and Windows — each binding accepts either.
The desktop app receives all of these. In a browser tab (`pnpm dev`) the browser claims some of
them first — Chrome keeps `⌘⇧N`, `⌘W` and `⌘N` for itself — so test those in the packaged app.

## Anywhere

| Shortcut | Action | Code |
| --- | --- | --- |
| `⌘⇧N` | New session — same as the sidebar's **New** button, opens the draft where you pick a folder | `web/src/App.tsx` |
| `⌘⇧B` | Show / hide the sidebar | `web/src/App.tsx` |
| `Esc` | Close settings | `web/src/components/SettingsView.tsx` |

## Session view

Active while a session is open.

| Shortcut | Action | Code |
| --- | --- | --- |
| `⌘O` | Open the session's folder in the preferred app (the one marked in the **Open** menu) | `web/src/components/ChatView.tsx` |
| `⌘P` | Quick open — files by name, `%` for text across the folder | `web/src/components/ChatView.tsx` |
| `⌘⇧F` | Quick open, already switched to text | `web/src/components/ChatView.tsx` |
| `⌘B` | Show / hide the file tree | `web/src/components/ChatView.tsx` |
| `⌘J` | Show / hide the terminal | `web/src/components/ChatView.tsx` |
| `⌘⇧A` | Show / hide the agents panel, when the provider reports subagent tasks | `web/src/components/ChatView.tsx` |
| `⌘\` | Split the focused group's active tab into a new group, along the session's axis | `web/src/components/ChatView.tsx` |
| `⌘K` then `←` / `→` | Move focus to the previous / next editor group | `web/src/components/ChatView.tsx` |
| `⌘W` | Close the focused group's active file or subagent tab — the chat tab is pinned | `web/src/components/ChatView.tsx` |
| `⌘K` then `W` | Close every file tab, in every group | `web/src/components/ChatView.tsx` |
| `Esc` | Cancel a tab drag, leaving the layout untouched | `web/src/components/EditorGroups.tsx` |

## Quick open

Active while the palette is open.

| Shortcut | Action | Code |
| --- | --- | --- |
| `↑` / `↓` | Move the highlight | `web/src/components/SearchPalette.tsx` |
| `⏎` | Open the highlighted file, on its line | `web/src/components/SearchPalette.tsx` |
| `Esc` | Close the palette | `web/src/components/SearchPalette.tsx` |

## Transcript

Active while the turn rail — the ticks in the transcript's left gutter — has focus.

| Shortcut | Action | Code |
| --- | --- | --- |
| `↑` / `↓` | Move to the previous / next turn | `web/src/components/Timeline.tsx` |
| `Home` / `End` | Move to the first / last turn | `web/src/components/Timeline.tsx` |
| `⏎` / `Space` | Scroll the transcript to that turn | `web/src/components/Timeline.tsx` |

## File editor

Active while a file tab is selected in the focused group. With the editor split, these act on that
group only — the other groups' files ignore them.

| Shortcut | Action | Code |
| --- | --- | --- |
| `⌘S` | Save | `web/src/components/FileView.tsx` |
| `Tab` / `⇧Tab` | Indent / outdent the caret's line, or every selected line | `web/src/components/FileView.tsx` |
| `⏎` | Keep the line's indent, one level deeper after `:` (Python) or an open bracket | `web/src/components/FileView.tsx` |
| `⌘/` | Comment / uncomment the selected lines | `web/src/components/FileView.tsx` |
| `⌘⇧V` | Toggle preview — Markdown, Mermaid, Excalidraw, CSV and TSV only | `web/src/components/FileView.tsx` |
| `Esc` | Close the file, only when it has no unsaved changes | `web/src/components/FileView.tsx` |
| `⌘`-click an import | Open that file | `web/src/components/FileView.tsx` |

## Composer

| Shortcut | Action | Code |
| --- | --- | --- |
| `⏎` | Send | `web/src/components/Composer.tsx` |
| `⇧⏎` | New line | `web/src/components/Composer.tsx` |
| `↑` / `↓` | Slash-command menu: move the highlight | `web/src/components/Composer.tsx` |
| `⏎` or `Tab` | Slash-command menu: pick the highlighted command | `web/src/components/Composer.tsx` |
| `Esc` | Slash-command menu: dismiss; image preview: close | `web/src/components/Composer.tsx` |
| `1`–`9` | Provider or permission-mode menu open: pick the nth item | `web/src/components/ui.tsx` |
| `1`–`9` | Question panel open: pick the nth option | `web/src/components/Composer.tsx` |
| `⏎` | Question panel, **Other…** open: submit the typed answer | `web/src/components/Composer.tsx` |
| `Esc` | Question panel, **Other…** open: discard it and go back to the options | `web/src/components/Composer.tsx` |
| `←` / `→` | Effort slider focused: step the level | `web/src/components/Composer.tsx` |

## Sidebar

| Shortcut | Action | Code |
| --- | --- | --- |
| `R` | Session menu (`…`) open: rename | `web/src/components/Sidebar.tsx` |
| `F` | Session menu open: fork | `web/src/components/Sidebar.tsx` |
| `A` | Session menu open: archive / unarchive | `web/src/components/Sidebar.tsx` |
| `⏎` / `Esc` | Renaming: commit / cancel | `web/src/components/Sidebar.tsx` |
