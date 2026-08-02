# sr03

A local Claude control plane: thread sidepanel, folder-based projects, model + permission pickers,
git worktrees. Modelled on [t3code](https://github.com/pingdotgg/t3code)'s shape — the server owns
everything, the client is a thin view over one WebSocket — but deliberately much smaller.

**Out of scope.** Ask before building any of these: remote control / relay / Tailscale, mobile app,
providers other than Claude, checkpointing and turn revert, MCP
servers, PR integration. t3code is Effect-based and event-sourced; sr03 is not, and shouldn't become
so.

## Commands

```bash
pnpm dev         # server :3399 + Vite :5399 (open http://localhost:5399)
pnpm typecheck   # both packages
pnpm build       # web → web/dist, which the server then serves itself
pnpm start       # server only, serving web/dist
pnpm dmg         # desktop/dist/sr03-<version>-arm64.dmg (arm64, ad-hoc signed)
```

`SR03_PORT` moves the server port (Vite proxies to it); `SR03_DATA_DIR` moves state, default
`~/.sr03` (SQLite db + worktrees).

## Layout

```
server/src   plain Node, run through --experimental-strip-types (no build step)
  index.ts   http + ws, static serving
  api.ts     REST routes — regex table, one handler each
  claude.ts  one long-lived Agent SDK session per thread
  git.ts     worktree add/remove/list, branches, dirty + diff stat
  db.ts      node:sqlite — projects, threads, messages
  bus.ts     in-process pub/sub, fanned out to every socket
web/src      Vite + React 19 + Tailwind v4 + shadcn/ui + zustand
  store.ts       the single client store; applyEvent folds server events into it
  lib/api.ts     every server call, one method each
  lib/utils.ts   cn() — clsx + tailwind-merge
  components/ui  shadcn/ui, generated — don't hand-edit, re-add instead
  components/ui.tsx  app-level wrappers over shadcn (Dialog, Menu, Chip) + lucide icon aliases
desktop      Electron shell — a window over the ordinary server, nothing app-specific in it
  main.js    resolves the login shell's PATH, spawns the server, opens the window
  payload.mjs collects web/dist + a symlink-free server copy into desktop/payload
```

`desktop` is deliberately **outside** the pnpm workspace, with its own `pnpm-workspace.yaml` and
lockfile, so an ordinary `pnpm install` never pulls Electron's ~200M. `pnpm dmg` installs it.

`@/` resolves to `web/src` (tsconfig paths + vite alias), which is what the shadcn generator emits.

REST for commands, WebSocket (`/ws`) for everything the server pushes back. Wire event types live in
`server/src/types.ts` and are mirrored in `web/src/lib/types.ts` — change both together.

## Conventions

- Server side: no frameworks, no ORM, no Effect. Node built-ins and the Agent SDK are the
  dependency budget; reuse what's here before adding anything. The terminal panel is the one
  exception — `node-pty` on the server and `@xterm/xterm` on the web, since a PTY and an ANSI
  renderer can't be built from built-ins.
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

## Desktop shell

- The shell does not host the server in Electron's Node — it spawns the machine's own `node` as a
  child, the same command `pnpm start` runs. Type stripping, `node:sqlite` and node-pty's ABI all
  want the real thing.
- A GUI launch inherits a bare `PATH`, so `main.js` reads the login shell's (`$SHELL -ilc`). Without
  it an nvm or homebrew node is invisible, and the Claude CLI the server spawns can't find git.
- The window gets a free port, not 3399, so a packaged app and `pnpm dev` can run side by side.
  Both share `~/.sr03`.
- Electron 44 ships no postinstall, so its binary never lands from a plain install — `desktop`'s own
  `postinstall` runs `install-electron` to fetch it. electron-builder downloads its own copy anyway,
  so this only matters for `pnpm -C desktop dev`.
- `desktop/build/icon.png` is the app icon (1024², dark squircle + the mono `S`); electron-builder
  picks it up by convention and converts it to `.icns` itself.
- `payload.mjs` deploys the server with a filtered `--prod` install, which pnpm records as the
  workspace's install state — every later `pnpm <script>` would then want a production install and
  try to purge `node_modules`. The plain `pnpm install` right after the deploy undoes that; don't
  drop it.

## Testing changes

There are no automated tests yet. Verify by hand against a scratch repo — never the user's real
projects, since worktree and edit operations mutate them:

```bash
mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
  && echo hello > README.md && git add . && git commit -qm init
```

Then add `/tmp/sr03-repo` as a project, create a worktree, and run a turn in it. A change to the
Claude session or worktree code isn't done until a real turn has been through it.
