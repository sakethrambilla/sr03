# sr03

A local AI harness control plane: thread sidepanel, folder-based projects, provider + model +
permission pickers, git worktrees. Modelled on [t3code](https://github.com/pingdotgg/t3code)'s
shape — the server owns everything, the client is a thin view over one WebSocket — but deliberately
much smaller.

**Out of scope.** Ask before building any of these: remote control / relay / Tailscale, mobile app,
providers other than Claude or Cursor, file checkpointing — snapshotting the worktree so a rewind
can put code back — MCP servers, PR integration. Rewind and `/clear` are conversation-only: they
drop messages and the CLI session, and never touch disk. t3code is Effect-based and event-sourced;
sr03 is not, and shouldn't become so.

## Commands

```bash
pnpm dev         # server :3399 + Vite :5399 (open http://localhost:5399)
pnpm test        # provider transport tests
pnpm typecheck   # both packages
pnpm build       # web → web/dist, which the server then serves itself
pnpm start       # server only, serving web/dist
pnpm dmg         # desktop/dist/sr03-<version>-arm64.dmg (macOS arm64, ad-hoc signed)
pnpm exe         # desktop/dist/sr03-<version>-x64-setup.exe (Windows x64 NSIS, unsigned)
```

`SR03_PORT` moves the server port (Vite proxies to it); `SR03_DATA_DIR` moves state, default
`~/.sr03` (SQLite db + worktrees). `SR03_IDLE_PARK_MS` is how long an idle thread keeps its CLI
process before it is parked (default ten minutes; the next turn resumes it).

## Layout

```
server/src   plain Node, run through --experimental-strip-types (no build step)
  index.ts   http + ws, static serving
  api.ts     REST routes — regex table, one handler each
  agents/runtime.ts  provider-neutral sessions, transcript projection, approvals, parking
  agents/claude.ts   Claude Agent SDK adapter
  agents/cursor.ts   Cursor ACP adapter
  agents/acp.ts      newline-delimited JSON-RPC transport
  agents/registry.ts provider lookup
  git.ts     worktree add/remove/list, branches, dirty + diff stat
  db.ts      node:sqlite — projects, threads, messages
  bus.ts     in-process pub/sub, fanned out to every socket
web/src      Vite + React 19 + Tailwind v4 + shadcn/ui + zustand
  store.ts       the single client store; applyEvent folds server events into it
  lib/api.ts     every server call, one method each
  lib/layout.ts  the editor's group model — split, move, close, and the drop-zone geometry
  lib/utils.ts   cn() — clsx + tailwind-merge
  components/ui  shadcn/ui, generated — don't hand-edit, re-add instead
  components/ui.tsx  app-level wrappers over shadcn (Dialog, Menu, Chip) + lucide icon aliases
  components/EditorGroups.tsx  the editor grid: per-group tab strips, sashes, drop overlay
  components/SubagentView.tsx  one subagent's tab body — transcript or Cursor card
desktop      Electron shell — a window over the ordinary server, nothing app-specific in it
  main.js    resolves the login shell's PATH, spawns the server, opens the window
  payload.mjs collects web/dist + a symlink-free server copy into desktop/payload
  report.mjs prints where the installer landed, as the build's last line
```

`desktop` is deliberately **outside** the pnpm workspace, with its own `pnpm-workspace.yaml` and
lockfile, so an ordinary `pnpm install` never pulls Electron's ~200M. `pnpm dmg` installs it.

`@/` resolves to `web/src` (tsconfig paths + vite alias), which is what the shadcn generator emits.

REST for commands, WebSocket (`/ws`) for everything the server pushes back. Wire event types live in
`server/src/types.ts` and are mirrored in `web/src/lib/types.ts` — change both together.

## Conventions

- Server side: no frameworks, no ORM, no Effect. Node built-ins and the Agent SDK are the
  dependency budget; reuse what's here before adding anything. The terminal panel is one
  exception — `node-pty` on the server and `@xterm/xterm` on the web, since a PTY and an ANSI
  renderer can't be built from built-ins. The mermaid and excalidraw file previews are the other —
  `mermaid` and `@excalidraw/excalidraw` on the web, both dynamically imported so opening neither
  kind of file costs anything on the rest of the app.
- UI comes from shadcn/ui — never hand-roll a button, dialog, menu, popover, input or the like.
  Add what you need with `pnpm dlx shadcn@latest add <component>` (run it in `web/`), then compose
  it. Icons come from `lucide-react`, aliased in `components/ui.tsx`; no hand-drawn SVG glyphs and
  no text characters (✕, ⧉, ▶) standing in for icons.
- `components/ui/*` is generated output. Restyle through the shadcn tokens or a wrapper in
  `components/ui.tsx`, not by editing those files.
- Server TS is type-stripped, not compiled: `erasableSyntaxOnly` is on, so no parameter properties,
  no enums, no namespaces. Import with explicit `.ts` extensions.
- Zustand selectors must never return a fresh object or array — `?? []` inline causes an infinite
  render loop. Use a module-level empty constant.
- Colors are the shadcn token set, defined once in `web/src/index.css` and carrying sr03's palette:
  `background`, `foreground`, `card`, `popover`, `primary` (the orange accent), `secondary`,
  `muted`/`muted-foreground`, `accent` (raised surfaces, hover), `destructive`, `border`, `input`,
  `ring`, plus two extras of ours, `faint` and `added`. Use the token classes
  (`bg-card`, `text-muted-foreground`, `border-border`) — never raw hex, never a one-off oklch.
- Radii: `rounded-md` for anything interactive, `rounded-lg` for panels and bubbles, `rounded-full`
  only for actual dots. Nothing else.
- Comments only where the code can't speak for itself.
- Every keyboard shortcut is listed in `SHORTCUTS.md`. Add, change or remove its row in the same
  change as the code.

## Claude session gotchas

- `systemPrompt: { type: "preset", preset: "claude_code" }` is **required**. Without it the agent
  gets no environment context: tools still run in the right cwd, but the model doesn't know its cwd
  and writes files into the home directory.
- Sessions run in streaming-input mode (an async-iterable prompt queue). That's what makes
  `interrupt()`, `setModel()` and `setPermissionMode()` available — a plain string prompt loses them.
- Continuation is `resume: thread.session_id`, captured from the `system`/`init` message.
- `settingSources: ["user", "project", "local"]` means sr03 honors the machine's existing
  `~/.claude` permission rules, so pre-approved tools never reach our approval prompt.
- `canUseTool` is only consulted in `default` and `plan` modes; `acceptEdits` and `bypassPermissions`
  auto-approve before the callback runs.

## Cursor session gotchas

- Cursor runs as `cursor-agent acp` over newline-delimited JSON-RPC on stdio. The CLI remains an
  external prerequisite; unlike Claude's SDK CLI, it is not bundled into the desktop payload.
- Auto-review and Force are process flags. Agent, Plan and Ask are reapplied with
  `session/set_mode` after every new or loaded session; changing a permission mode parks the idle
  process first.
- Cursor advertises picker slugs through `cursor/list_available_models` at startup (Auto, Composer,
  Grok, …). `initialize` sets `parameterizedModelPicker`, so `session/set_model` accepts those
  slugs rather than the parameterized ACP IDs. The selected slug is reapplied after every new or
  loaded session.
- `session/load` replays prior updates. The adapter suppresses that replay because sr03 already owns
  the persisted transcript; replaying it would duplicate every message and tool row.
- Effort and fast are per-model config options, not model-id parameters: `cursor/list_available_models`
  advertises them per model (`effort`/`reasoning`/`thinking` under `thought_level`, plus `fast`), and
  `session/set_config_option` applies them after every new or loaded session. The option set belongs
  to the selected model, so both are reapplied after `session/set_model`. The CLI persists these
  globally, so `fast` is asserted even when false — otherwise a thread inherits Cursor's own default,
  which is on for some models.
- ACP request-permission options are provider supplied. Only decisions present in that request may
  be returned, and `cursor/ask_question` stays pending until the web client answers it.
- `cursor/task` arrives on both the request and notification paths. It carries description, prompt,
  subagent type, model, agent id and duration, and nothing else — there is no child transcript to
  render.

## Desktop shell

- The shell does not host the server in Electron's Node — it spawns the machine's own `node` as a
  child, the same command `pnpm start` runs. Type stripping, `node:sqlite` and node-pty's ABI all
  want the real thing.
- A macOS GUI launch inherits a bare `PATH`, so `main.js` reads the login shell's (`$SHELL -ilc`).
  Without it an nvm or homebrew node is invisible, and the Claude CLI the server spawns can't find
  git. Windows resolves the real `PATH` from the registry before the process starts, so there it
  uses `process.env.PATH` as-is.
- macOS hides the native title bar and the app's own headers stand in for it (the `.mac` class on
  `<html>` is what reserves room for the traffic lights). Windows keeps its native frame, since its
  controls sit right where the panes have nothing to spare.
- The window gets a free port, not 3399, so a packaged app and `pnpm dev` can run side by side.
 Both share `~/.sr03`; server-instance leases keep a warm or running thread owned by only one of
 them at a time. Only one desktop instance runs (`requestSingleInstanceLock`), so a freshly built
 app exits on launch while an installed one is open.
- Electron 44 ships no postinstall, so its binary never lands from a plain install — `desktop`'s own
  `postinstall` runs `install-electron` to fetch it. electron-builder downloads its own copy anyway,
  so this only matters for `pnpm -C desktop dev`.
- `desktop/build/icon.png` is the app icon (1024², dark squircle + the mono `S`); electron-builder
  picks it up by convention and converts it to `.icns` and `.ico` itself.
- `payload.mjs` deploys the server with a filtered `--prod` install, which pnpm records as the
  workspace's install state — every later `pnpm <script>` would then want a production install and
  try to purge `node_modules`. The plain `pnpm install` right after the deploy undoes that; don't
  drop it, and keep its `--config.confirmModulesPurge=false` — without it that install can stop on
  a confirmation prompt, which on a pipe fails the build and strands the production install state.
- `payload.mjs` takes the target triple (`darwin-arm64`, `win32-x64`, …) and makes the payload
  carry only that platform: it keeps that one node-pty prebuild and deletes the rest, and it
  swaps the Agent SDK's per-platform CLI package. That swap is what makes cross-building work at
  all — the deploy resolves the *host's* optional dependency, so a Windows payload built on macOS
  would otherwise ship a Mach-O `claude` and the SDK, which looks for
  `claude-agent-sdk-<platform>-<arch>/claude[.exe]`, would find nothing and fail every turn.
  Both installers cross-build from macOS; neither needs wine. The Windows one is unsigned, so
  SmartScreen warns.
- If a build dies between the deploy and its restoring install, the workspace is left needing a
  production install and every later `pnpm <script>` fails in `runDepsStatusCheck`. Recover with
  `pnpm install --config.confirmModulesPurge=false`.
- Windows gets the server's POSIX-only features degraded, not ported. The native folder and file
  pickers and reveal-in-Finder throw, and "open in <editor>" lists nothing; browsing to a project
  path by hand still works. Provider executables are resolved from PATH with PATHEXT support. The
  resources meter shells out to `ps` and `lsof`, so while it is open each tick logs
  `spawn ps ENOENT` and publishes no sample.

## Testing changes

The ACP transport has protocol tests. Verify provider turns by hand against a scratch repo — never
the user's real projects, since worktree and edit operations mutate them:

```bash
mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
  && echo hello > README.md && git add . && git commit -qm init
```

Then add `/tmp/sr03-repo` as a project, create a worktree, and run a turn with each affected
provider. A change to provider sessions or worktree code isn't done until a real turn has been
through it.
