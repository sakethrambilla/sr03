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
| `⌘B` | Show / hide the file tree | `web/src/components/ChatView.tsx` |
| `⌘J` | Show / hide the terminal | `web/src/components/ChatView.tsx` |
| `⌘⇧A` | Show / hide the agents panel | `web/src/components/ChatView.tsx` |
| `⌘W` | Close the active file tab — the chat tab is pinned | `web/src/components/ChatView.tsx` |
| `⌘K` then `W` | Close every file tab | `web/src/components/ChatView.tsx` |

## File editor

Active while a file tab is selected.

| Shortcut | Action | Code |
| --- | --- | --- |
| `⌘S` | Save | `web/src/components/FileView.tsx` |
| `⌘⇧V` | Toggle preview — Markdown, CSV and TSV only | `web/src/components/FileView.tsx` |
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
| `1`–`9` | Model or permission-mode menu open: pick the nth item | `web/src/components/ui.tsx` |
| `←` / `→` | Effort slider focused: step the level | `web/src/components/Composer.tsx` |

## Sidebar

| Shortcut | Action | Code |
| --- | --- | --- |
| `R` | Session menu (`…`) open: rename | `web/src/components/Sidebar.tsx` |
| `F` | Session menu open: fork | `web/src/components/Sidebar.tsx` |
| `A` | Session menu open: archive / unarchive | `web/src/components/Sidebar.tsx` |
| `⏎` / `Esc` | Renaming: commit / cancel | `web/src/components/Sidebar.tsx` |
