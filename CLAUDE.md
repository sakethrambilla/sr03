# sr03

A local Claude control plane: thread sidepanel, folder-based projects, model + permission pickers,
git worktrees. Modelled on [t3code](https://github.com/pingdotgg/t3code)'s shape — the server owns
everything, the client is a thin view over one WebSocket — but deliberately much smaller.

**Out of scope.** Ask before building any of these: remote control / relay / Tailscale, mobile app,
Electron shell, providers other than Claude, checkpointing and turn revert, embedded terminals, MCP
servers, PR integration. t3code is Effect-based and event-sourced; sr03 is not, and shouldn't become
so.

## Commands

```bash
pnpm dev         # server :3399 + Vite :5399 (open http://localhost:5399)
pnpm typecheck   # both packages
pnpm build       # web → web/dist, which the server then serves itself
pnpm start       # server only, serving web/dist
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
web/src      Vite + React 19 + Tailwind v4 + zustand
  store.ts   the single client store; applyEvent folds server events into it
  lib/api.ts every server call, one method each
```

REST for commands, WebSocket (`/ws`) for everything the server pushes back. Wire event types live in
`server/src/types.ts` and are mirrored in `web/src/lib/types.ts` — change both together.

## Conventions

- No frameworks, no ORM, no Effect. Node built-ins and the Agent SDK are the dependency budget;
  reuse what's here before adding anything.
- Server TS is type-stripped, not compiled: `erasableSyntaxOnly` is on, so no parameter properties,
  no enums, no namespaces. Import with explicit `.ts` extensions.
- Zustand selectors must never return a fresh object or array — `?? []` inline causes an infinite
  render loop. Use a module-level empty constant.
- Colors come from the `@theme` tokens in `web/src/index.css` (`canvas`, `panel`, `raised`, `line`,
  `ink`, `muted`, `faint`, `accent`, `danger`). No raw hex in components.
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

## Testing changes

There are no automated tests yet. Verify by hand against a scratch repo — never the user's real
projects, since worktree and edit operations mutate them:

```bash
mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
  && echo hello > README.md && git add . && git commit -qm init
```

Then add `/tmp/sr03-repo` as a project, create a worktree, and run a turn in it. A change to the
Claude session or worktree code isn't done until a real turn has been through it.
