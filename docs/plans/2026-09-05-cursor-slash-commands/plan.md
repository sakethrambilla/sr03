# Plan — Cursor slash commands

Spec: `docs/plans/2026-09-05-cursor-slash-commands/spec.md`

## What exploration established

A real `cursor-agent acp` process was probed against `/tmp/sr03-repo`, and every code reference
below was checked against the files. Do not re-derive these:

- Commands are **not** in the `session/new` result. They arrive as a separate `session/update`
  notification with `update.sessionUpdate === "available_commands_update"` and
  `update.availableCommands: Array<{ name: string; description: string }>`, sent shortly after the
  `session/new` response.
- There is **no** `argumentHint` on those entries and **no** request method to pull the list. It is
  push-only, so a "query the live session" lookup like Claude's is impossible; the adapter caches
  what it was pushed, and fills `argumentHint` with `""`.
- `handleSessionUpdate` (`server/src/agents/cursor.ts:469`) drops this notification twice over: the
  `replayGate` early-return swallows it during `session/load`, and `!session.started` swallows it
  during `session/new` startup, since `started` is set only after `applySetupSettings`. The new case
  must sit **above both gates**. It is session state, not transcript replay, so handling it during
  replay is correct rather than a workaround.
- The web side is already provider-neutral: `Composer.tsx:391` gates the `/` menu on
  `capabilities.slashCommands`, `store.ts:879` folds `thread.commands` into `commandsByCwd`, and
  `runtime.ts:219` already turns a `commands.changed` adapter event into that wire event. **No web
  file changes in this plan.**
- `server/src/agents/cursor.test.ts` already spawns a deterministic mock ACP agent over a
  PATH-prepended shim (`MOCK_AGENT`), drives `cursorProvider.open` collecting `AgentEvent`s, and
  separately tests `discoverCursorModels`. Both new behaviours are testable there; the tests run
  under `pnpm test`, which executes `src/agents/*.test.ts` (acp + cursor).
- `findCursor` (`server/src/providers.ts:31`) falls back to `~/.local/bin/cursor-agent` and the
  homebrew paths, so **PATH manipulation cannot simulate "Cursor not installed"** on this machine.
  The failure path is covered by a mock agent that errors instead.
- Helper signatures, confirmed: `stringValue` returns `string | null` (so `?? ""` is required),
  `isRecord` and `errorMessage` are local to `cursor.ts`, `connection.registerNotificationHandler`
  exists on `AcpConnection` (`acp.ts`), and `AgentProvider` is
  `{ id, open, listCommands(cwd), readUsage, forkSession?, forgetThread? }`.
- `SHORTCUTS.md` needs no edit: its `/` rows are already provider-neutral.

## Constraints

- Cursor adapter only. `server/src/agents/claude.ts` must not appear in the diff.
- Server TS is type-stripped: no enums, no parameter properties, explicit `.ts` import extensions.
- No new dependencies.

## File map

| File | Change |
| --- | --- |
| `server/src/agents/cursor.ts` | Add `cwd` to the session context; add a per-cwd command cache; handle `available_commands_update` above the replay/started gates; add a cold-start probe; replace the stub `listCommands`. |
| `server/src/agents/cursor.test.ts` | Extend `MOCK_AGENT` to push a command list; add a failing-agent mock; assert the live-session event and both probe paths. |
| `server/src/models.ts` | Flip `slashCommands` to `true` in the cursor capability block (line 122). |

Nothing else. `server/src/types.ts`, `web/src/lib/types.ts` and the wire contract are unchanged —
`SlashCommand` and `thread.commands` already exist and already carry what is needed.

---

## Task 1 — Capture commands from a live Cursor session

**Deliverable:** a warm Cursor thread's command list is emitted as `commands.changed` and cached per
cwd, proven by a test.

1. In `server/src/agents/cursor.ts`, add `cwd: string;` to the `CursorNativeSession` interface,
   directly under `threadId: string;` (line 92).
2. In `open()` (line 1108), add `cwd: thread.cwd,` to the `session = { ... }` object literal that
   begins at line 1132, alongside `threadId: thread.id`.
3. Add `SlashCommand` to the existing `import type { ... } from "../types.ts"` block (line 8).
4. Above `handleSessionUpdate`, add the cache and the parser:

   ```ts
   const commandsByCwd = new Map<string, SlashCommand[]>();

   function parseAvailableCommands(update: Record<string, unknown>): SlashCommand[] {
     const listed = Array.isArray(update.availableCommands) ? update.availableCommands : [];
     const commands: SlashCommand[] = [];
     for (const entry of listed) {
       if (!isRecord(entry)) continue;
       const name = stringValue(entry.name);
       if (!name) continue;
       commands.push({
         name,
         description: stringValue(entry.description) ?? "",
         argumentHint: "",
       });
     }
     return commands.sort((left, right) => left.name.localeCompare(right.name));
   }
   ```

   Cursor advertises no argument hints, hence the empty string.
5. In `handleSessionUpdate` (line 469), insert this **immediately after** the
   `const update = isRecord(params.update) ? params.update : params;` line and **before** the
   `if (session.replayGate)` block:

   ```ts
   // command state, not transcript replay — below either gate the push is silently dropped
   if (update.sessionUpdate === "available_commands_update") {
     const commands = parseAvailableCommands(update);
     commandsByCwd.set(session.cwd, commands);
     session.emit({ type: "commands.changed", commands });
     return;
   }
   ```
6. In `server/src/agents/cursor.test.ts`, make the mock agent advertise commands. In `MOCK_AGENT`'s
   `session/new` branch, after the existing `send({ ... result: { sessionId: "mock-session", ... } })`
   call, append:

   ```js
   send({
     jsonrpc: "2.0",
     method: "session/update",
     params: {
       sessionId: "mock-session",
       update: {
         sessionUpdate: "available_commands_update",
         availableCommands: [
           { name: "worktree", description: "Create a worktree" },
           { name: "alias", description: "Name a thing" }
         ]
       }
     }
   });
   ```

   Two entries, deliberately out of alphabetical order, so the sort is exercised.
7. In the existing adapter-contract test (the one that calls `cursorProvider.open` and collects
   `events`), add an assertion after the `models.changed` assertion:

   ```ts
   const pushed = events.find((event) => event.type === "commands.changed");
   assert.deepEqual(
     pushed?.type === "commands.changed" ? pushed.commands : [],
     [
       { name: "alias", description: "Name a thing", argumentHint: "" },
       { name: "worktree", description: "Create a worktree", argumentHint: "" },
     ],
   );
   ```

   This is the Task 1 gate: it fails before step 5 (the notification is swallowed by the
   `!session.started` guard) and passes after.
8. Verify:

   ```bash
   pnpm typecheck && pnpm test
   ```

   Expected: typecheck silent, and the test run reports `# fail 0` with the cursor adapter test
   among the passes. If the new assertion fails with an empty array, step 5's placement is wrong —
   it is below one of the two gates.
9. Commit: `feat(cursor): capture acp available_commands_update`

## Task 2 — Serve the list, with a cold-start probe

**Deliverable:** `GET /api/commands?provider=cursor&cwd=<path>` returns the real list whether or not
a session is warm, and an unusable agent yields `[]` rather than an error.

1. In `server/src/agents/cursor.ts`, next to the other timeout constants (line 115-117), add:

   ```ts
   const COMMANDS_TIMEOUT_MS = 15_000;
   ```
2. Below `discoverCursorModels` (line 1456), add the probe. It is written out in full here; do not
   improvise the spawn options:

   ```ts
   // The list only ever arrives as a push, so a cold read starts a session and waits for it.
   async function probeCommands(cwd: string): Promise<SlashCommand[]> {
     const binary = await findCursor();
     if (!binary) return [];
     const connection = spawnAcp({
       binary,
       args: ["acp"],
       cwd,
       onStderr(text) {
         const message = text.trim();
         if (message) console.error(`[cursor:commands] ${message}`);
       },
     });
     let settle!: (commands: SlashCommand[]) => void;
     const pushed = new Promise<SlashCommand[]>((resolve) => {
       settle = resolve;
     });
     const timer = setTimeout(() => settle([]), COMMANDS_TIMEOUT_MS);
     connection.registerNotificationHandler("session/update", (params) => {
       if (!isRecord(params)) return;
       const update = isRecord(params.update) ? params.update : params;
       if (update.sessionUpdate !== "available_commands_update") return;
       settle(parseAvailableCommands(update));
     });
     try {
       await connection.request(
         "initialize",
         {
           protocolVersion: 1,
           clientCapabilities: CLIENT_CAPABILITIES,
           clientInfo: { name: "sr03", version: "0.0.0" },
         },
         { timeoutMs: STARTUP_TIMEOUT_MS },
       );
       await connection.request(
         "authenticate",
         { methodId: "cursor_login" },
         { timeoutMs: STARTUP_TIMEOUT_MS },
       );
       await connection.request(
         "session/new",
         { cwd, mcpServers: [] },
         { timeoutMs: STARTUP_TIMEOUT_MS },
       );
       return await pushed;
     } catch (error) {
       console.error(`[cursor:commands] ${errorMessage(error)}`);
       return [];
     } finally {
       clearTimeout(timer);
       connection.close();
     }
   }
   ```

   The `let settle!` non-null assertion is required: without it `erasableSyntaxOnly` strict mode
   rejects the handler's use as "used before assigned". The handler is registered before
   `session/new` is sent, or the push can arrive unobserved.
3. Add the caching wrapper and replace the stub:

   ```ts
   const probesByCwd = new Map<string, Promise<SlashCommand[]>>();

   function listCommands(cwd: string): Promise<SlashCommand[]> {
     const pushed = commandsByCwd.get(cwd);
     if (pushed) return Promise.resolve(pushed);
     const known = probesByCwd.get(cwd);
     if (known) return known;
     // an empty result means the probe failed, so it is not cached and the next read retries
     const pending = probeCommands(cwd).then((commands) => {
       if (commands.length) commandsByCwd.set(cwd, commands);
       else probesByCwd.delete(cwd);
       return commands;
     });
     probesByCwd.set(cwd, pending);
     return pending;
   }
   ```

   Then change the provider object at line 1497 from the `async listCommands() { return []; }` stub
   to `listCommands,`, leaving `id`, `open` and `readUsage` as they are.

   The retry only helps a second server-side read; note that the web client caches `[]` for the life
   of the page (spec, criterion 2), so a user-visible retry needs a reload. That is inherited, and
   out of scope here.
4. In `server/src/agents/cursor.test.ts`, add a probe test modelled on the existing
   `"discovers Cursor models without opening a thread"` test (line 292) — copy its whole
   env-swapping and `context.after` cleanup block verbatim, changing only the mkdtemp prefix to
   `sr03-cursor-commands-`, and end with:

   ```ts
   const { cursorProvider } = await import("./cursor.ts");
   const commands = await cursorProvider.listCommands(directory);
   assert.deepEqual(
     commands.map(({ name, argumentHint }) => ({ name, argumentHint })),
     [
       { name: "alias", argumentHint: "" },
       { name: "worktree", argumentHint: "" },
     ],
   );
   ```

   Name the test `"reads Cursor commands without opening a thread"`.
5. Add the failure test. Define a second mock next to `MOCK_AGENT`:

   ```js
   const FAILING_AGENT = `#!/usr/bin/env node
   const readline = require("node:readline");
   const lines = readline.createInterface({ input: process.stdin });
   const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
   (async () => {
   for await (const line of lines) {
     const message = JSON.parse(line);
     if (message.method === "initialize") {
       send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
     } else if (message.method === "authenticate") {
       send({ jsonrpc: "2.0", id: message.id, result: {} });
     } else if (message.id) {
       send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "no session for you" } });
     }
   }
   })();
   `;
   ```

   Write that as the shim binary in a test named `"falls back to no commands when Cursor errors"`,
   reusing the same env-swap block, and assert
   `assert.deepEqual(await cursorProvider.listCommands(directory), [])`. This is acceptance
   criterion 6; PATH cannot hide the real binary because `findCursor` has hard-coded fallbacks, so
   an erroring agent is the honest stand-in. Because `listCommands` caches per cwd across a process,
   each of these two tests must use its own fresh mkdtemp directory — do not share one.
6. Verify:

   ```bash
   pnpm typecheck && pnpm test
   ```

   Expected: `# fail 0`, with three cursor tests now passing (adapter contract, models discovery,
   commands discovery) plus the failure test.
7. Verify the real cold path by hand, against the scratch repo only — never a real project:

   ```bash
   mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main 2>/dev/null; echo hello > README.md; git add -A; git commit -qm init 2>/dev/null; true
   ```

   Start `pnpm dev` with no Cursor thread warm, then:

   ```bash
   curl -s 'http://localhost:3399/api/commands?provider=cursor&cwd=/tmp/sr03-repo' | head -c 400
   ```

   Expected: `{"commands":[{"name":"...","description":"...","argumentHint":""},...]}` with a
   non-empty array, back within ~15s. Then confirm nothing was stranded:

   ```bash
   pgrep -fl 'cursor-agent acp' | grep -v pgrep || echo "no stray cursor-agent"
   ```

   Expected: `no stray cursor-agent`. Run the curl a second time and expect a sub-second reply —
   that is the cache.
8. Commit: `feat(cursor): serve slash commands with a cold-start probe`

## Task 3 — Turn the menu on and verify in the app

**Deliverable:** typing `/` in a Cursor thread lists commands and sending one works.

1. In `server/src/models.ts:122`, change `slashCommands: false,` to `slashCommands: true,` in the
   cursor capability block. Change nothing else in that block.
2. Run `pnpm typecheck && pnpm test`. Expected: silent, `# fail 0`.
3. With `pnpm dev` running, open a **Cursor** thread on `/tmp/sr03-repo` and type `/` in the
   composer. Expected: the suggestion menu appears listing command names. Type `wor` and expect the
   list to narrow to names containing `wor` (the filter is a substring match, not a prefix match).
   This is acceptance criterion 1.
4. Open a **Claude** thread on the same folder and type `/`. Expected: the list Claude showed before
   this change. `commandKey` (`store.ts:235`) includes the provider id, so the two lists cannot
   collide structurally — this step is checking that nothing about Claude's fetch path was
   disturbed, which is criterion 7.
5. Back in the Cursor thread, pick a harmless read-only command from the menu, submit it, and
   confirm the prompt is sent and an assistant turn comes back in the transcript. This is criterion
   3. Do not pick a command that writes files or creates worktrees.
6. Confirm the diff touches only the three planned files:

   ```bash
   git diff --stat
   ```

   Expected: exactly `server/src/agents/cursor.ts`, `server/src/agents/cursor.test.ts` and
   `server/src/models.ts`. Any appearance of `server/src/agents/claude.ts` or a `web/` file means
   the scope slipped — stop and report.
7. Commit: `feat(cursor): enable slash command suggestions`

---

## Note for the implementer

If Task 1's mock-agent assertion passes but a **resumed** Cursor thread never produces a
`commands.changed` event in the real app, that is a genuine gap against criterion 5 — the agent may
only advertise on `session/new`. Report it rather than adding a re-probe on load; that is a scope
decision for the user, not a patch.
