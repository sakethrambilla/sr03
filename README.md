# sr03

A local control plane for Claude Code. It runs on your machine, drives the Claude Agent SDK, and
gives you a thread sidepanel over folder-based projects — with model, permission and effort
pickers, git worktrees, a file tree and editor, a terminal, and a usage meter.

Modelled on [t3code](https://github.com/pingdotgg/t3code)'s shape — the server owns everything,
the client is a thin view over one WebSocket — but deliberately much smaller: no frameworks on the
server, no ORM, no event sourcing.

## Requirements

- Node 22.16 or newer (`node:sqlite` and type stripping are both used unbuilt)
- pnpm 11
- [Claude Code](https://claude.com/claude-code) installed and signed in — sr03 runs through the
  Agent SDK, which reuses the CLI's own login and its `~/.claude` settings
- macOS or Windows. The core works on both, but the native folder and file pickers, "reveal in
  Finder", the open-in app list and the resource meter are macOS-only, and both installers are
  built from macOS

## Quick start

```bash
pnpm install
pnpm dev          # server :3399 + Vite :5399
open http://localhost:5399
```

Add a folder, pick a branch (optionally in a worktree), and send the first turn. Nothing is written
to disk outside that folder and `~/.sr03`.

## Commands

```bash
pnpm dev         # server :3399 + Vite :5399 (open http://localhost:5399)
pnpm typecheck   # both packages
pnpm build       # web → web/dist, which the server then serves itself
pnpm start       # server only, serving web/dist
pnpm dmg         # desktop/dist/sr03-<version>-arm64.dmg (macOS arm64, ad-hoc signed)
pnpm exe         # desktop/dist/sr03-<version>-x64-setup.exe (Windows x64 NSIS, unsigned)
```

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `SR03_PORT` | `3399` | Server port; Vite proxies to it |
| `SR03_DATA_DIR` | `~/.sr03` | Where state lives — `sr03.db`, `worktrees/`, `uploads/` |
| `SR03_IDLE_PARK_MS` | `600000` | How long an idle thread keeps its CLI process before it is parked; the next turn resumes it |

## How it works

- **One server, one socket.** REST for commands (`server/src/api.ts`), and a WebSocket at `/ws` for
  everything the server pushes back. Anything that changes publishes one event on an in-process bus,
  which is fanned out to every connected client.
- **One Claude session per thread.** `server/src/claude.ts` holds a streaming-input Agent SDK
  session per thread, which is what makes `interrupt()`, `setModel()` and `setPermissionMode()`
  possible mid-session. Continuation is `resume: <session_id>`. An idle session is stopped after ten
  minutes and resumed cold on the next turn, since a live CLI holds ~250 MB.
- **The server is authoritative.** The client keeps no state the server can't replace: a reconnect
  after any real gap re-reads the thread list and the open thread instead of trusting the socket.
- **The wire types are duplicated on purpose.** `server/src/types.ts` and `web/src/lib/types.ts`
  mirror each other and nothing checks that they agree — change both together.
- **Rewind and `/clear` are conversation-only.** They drop messages and the CLI session; they never
  touch your files. There is no checkpointing.

## Layout

```
server/src   plain Node, run through --experimental-strip-types (no build step)
web/src      Vite + React 19 + Tailwind v4 + shadcn/ui + zustand
desktop      Electron shell — a window over the ordinary server
```

Every source file carries a header comment saying what it holds. In short:

### `server/src` — plain Node, no build step

| File | Contents |
| --- | --- |
| `index.ts` | Process entry point: http + static serving + the `/ws` socket and the client messages it accepts |
| `api.ts` | Every REST route, as one flat table of method + regex + handler |
| `claude.ts` | One Agent SDK session per thread, and everything folded out of its message stream — transcript, streamed text, tool approvals, subagents, usage |
| `db.ts` | The whole persistence layer on `node:sqlite`: schema, migrations, and one accessor per table |
| `git.ts` | Everything sr03 asks git — repo info, worktrees, changed files, diffs, ignore checks |
| `pty.ts` | The terminal panel's shells: one `node-pty` process per terminal, with scrollback |
| `table.ts` | The csv/xlsx reader: a byte-offset index for paging and filtering large files, single-cell writes, and a minimal zip + xlsx parser |
| `fsbrowse.ts` | Filesystem work that isn't git — folder picker, uploads, the session folder's tree, open-in apps |
| `metrics.ts` | The resource meter's sampler: `ps` on a tick, attributed per thread |
| `models.ts` | The model catalog read off the CLI, plus the permission-mode and effort tables |
| `providers.ts` | What the settings page shows about the Claude CLI: install, account, logout |
| `bus.ts` | In-process pub/sub — the whole of the push side |
| `config.ts` | Paths and tunables from the environment, resolved once |
| `types.ts` | The wire contract: db rows and every socket event |

### `web/src` — the client

| File | Contents |
| --- | --- |
| `main.tsx` | Browser entry point |
| `App.tsx` | The shell: opens the socket, keeps the store in sync, picks the one view on screen |
| `store.ts` | The single zustand store; `applyEvent` folds server events into it |
| `lib/api.ts` | Every server call, one method each |
| `lib/ws.ts` | The `/ws` connection, with reconnect backoff; terminal traffic bypasses the store |
| `lib/types.ts` | Mirror of `server/src/types.ts` plus the REST response shapes |
| `lib/fileref.ts` | Resolving a path in text, and imports and imported names on a line, against the session's file list |
| `lib/highlight.ts` | The syntax highlighter shared by the file view and markdown fences |
| `lib/appearance.ts` | Theme and font choice, and which faces the machine actually has |
| `lib/utils.ts` | `cn()` — the one class merger in the bundle |

| Component | Contents |
| --- | --- |
| `ChatView.tsx` | One open session: header, transcript, composer, and the panels around them |
| `Timeline.tsx` | The transcript — bubbles, grouped tool rows, the streaming tail, scroll behaviour |
| `Composer.tsx` | The prompt box: attachments, dictation, slash commands, the three pickers, approvals |
| `Sidebar.tsx` | The session list grouped by folder, with filters and the per-session menu |
| `DraftView.tsx` | The new-session screen — folder, branch, worktree |
| `SettingsView.tsx` | Provider card and appearance panel |
| `FileTree.tsx` | The session folder's tree, with git decorations and row actions |
| `FileView.tsx` | One file tab: highlighted listing, diff gutter, editor, markdown preview |
| `TableView.tsx` | The csv/xlsx viewer: paged rows, search, column checklists, cell edits |
| `TerminalPanel.tsx` | xterm tabs bound to the server's PTYs (lazily imported — xterm is ~490 KB) |
| `Markdown.tsx` | The markdown renderer, with clickable paths and runnable shell fences |
| `AgentsPanel.tsx` | Subagents the current turn spawned |
| `UsageMeter.tsx` | Context, cost, plan rate-limit windows, process resources |
| `WorktreePanel.tsx` | A project's worktrees — add and remove |
| `FolderPicker.tsx` | The add-a-folder dialog |
| `ui.tsx` | App-level wrappers over shadcn, the lucide icon aliases, `usePersistedState` |
| `ui/*` | shadcn/ui, generated — not hand-edited, and so not commented; re-add instead |

### `desktop` — the Electron shell

Deliberately **outside** the pnpm workspace, with its own workspace file and lockfile, so an
ordinary `pnpm install` never pulls Electron's ~200 MB. `pnpm dmg` and `pnpm exe` install it.

| File | Contents |
| --- | --- |
| `main.js` | Resolves the login shell's `PATH`, spawns the machine's own `node` to run the server, opens the window |
| `payload.mjs` | Collects `web/dist` plus a symlink-free server copy into `desktop/payload`, for one target platform |
| `report.mjs` | Prints where the installer landed, as the build's last line |
| `build/icon.png` | The app icon; electron-builder converts it to `.icns` and `.ico` itself |

The shell does not host the server in Electron's Node — type stripping, `node:sqlite` and
node-pty's ABI all want the real thing. It also gets a free port rather than 3399, so a packaged
app and `pnpm dev` can run side by side; both share `~/.sr03`.

## Keyboard shortcuts

All of them are listed in [SHORTCUTS.md](SHORTCUTS.md), each with the file that handles it. In a
browser tab the browser claims some first (`⌘⇧N`, `⌘W`, `⌘N`) — test those in the packaged app.

## What is stored where

- `~/.sr03/sr03.db` — projects, threads, messages, settings, the last usage read
- `~/.sr03/worktrees/` — worktrees sr03 created, one directory per repo and branch
- `~/.sr03/uploads/` — files you dropped or pasted into the composer
- `~/.claude*` — the CLI's own; sr03 reads the signed-in profile and honours the machine's existing
  permission rules, and never reads credentials, which live in the system keychain

## Out of scope

Ask before building any of these: remote control / relay / Tailscale, a mobile app, providers other
than Claude, file checkpointing, MCP servers, PR integration.

## Contributing

There are no automated tests. Verify by hand against a scratch repo — never a real project, since
worktree and edit operations mutate them:

```bash
mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
  && echo hello > README.md && git add . && git commit -qm init
```

Add `/tmp/sr03-repo` as a project, create a worktree, and run a turn in it. A change to the Claude
session or the worktree code isn't done until a real turn has been through it.

The conventions the code follows — server dependency budget, shadcn-only UI, the colour tokens, the
zustand selector rule, the type-stripping constraints — are in [CLAUDE.md](CLAUDE.md).
