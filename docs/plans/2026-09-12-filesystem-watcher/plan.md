# Filesystem watcher — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch:** `feat/filesystem-watcher`
**Test command:** `pnpm -C server test`
**Single test file:** `node --experimental-strip-types --test server/src/watch.test.ts`
**Lint / typecheck:** `pnpm typecheck`

**Manual harness:**
```bash
mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
  && echo hello > README.md && git add . && git commit -qm init
```

## Approach

The watcher mirrors the shape the server already uses for its resources meter: a refcounted
`watch()` that runs only while a client is looking, started by a client message over the existing
socket and torn down when the socket closes. That pattern is proven in `server/src/metrics.ts:224`
and `server/src/index.ts`, so this introduces no new lifecycle concept.

The coalescer and the watch factory are both injectable, so the debounce contract — trailing window
with an upper bound, which is the part that actually fixes today's starvation — and the failure
paths are unit tested rather than eyeballed.

**The watch is owned by `ChatView`, not `FileTree`.** This is the non-obvious decision in the plan.
`fsVersionByThread` has three consumers, not one: the file tree (`ChatView.tsx:713`), the workspace
file index (`ChatView.tsx:417-419`) and the branch chip (`ChatView.tsx:421-433`). Scoping the watch
to the files panel would leave the latter two with no signal whenever that panel is closed — today
they fire on every agent write. Owning it at the thread level keeps all three fed.

## Global constraints

- **No new dependencies.** Node built-ins only.
- Wire event types live in `server/src/types.ts` and are mirrored in `web/src/lib/types.ts`.
  Change both together — the repo's CLAUDE.md calls this out specifically.
- Server TS is type-stripped: no enums, no parameter properties, no namespaces, `.ts` import
  extensions. `server/tsconfig.json` includes `src`, so **test files are typechecked too** — an
  injected fake must satisfy the declared parameter type.
- New server test files must match `src/*.test.ts` to be picked up by `pnpm -C server test`.
- Zustand selectors must never return a fresh object or array — use a module-level constant.

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/watch.ts` | Create | Coalescer, watch-path filter, refcounted per-thread recursive watch, force-release by path |
| `server/src/watch.test.ts` | Create | Coalescer timing, path filter, failure and overflow paths, one tmpdir integration test |
| `server/src/types.ts` | Modify | Add `fs.changed` to `ServerEvent`, `fs.watch` to `ClientMessage` (Task 1) |
| `web/src/lib/types.ts` | Modify | Mirror both (Task 1) |
| `server/src/index.ts` | Modify | Handle `fs.watch`, release on socket teardown (Task 2) |
| `server/src/api.ts` | Modify | Release watches before a worktree is removed (Task 2) |
| `web/src/components/ChatView.tsx` | Modify | Send `fs.watch` for the open thread; drop the dead `refreshToken` (Task 2, 3) |
| `web/src/store.ts` | Modify | Consume `fs.changed`; delete the tool-message inference (Task 3) |
| `web/src/components/FileTree.tsx` | Modify | Minimum interval on the change-set read; drop `refreshToken` (Task 3) |

## Criterion coverage

| Criterion | Implemented in | Verified by |
|---|---|---|
| 1 — any process's change signals | Task 1, Task 2 | T1 step 6 (tmpdir), T2 step 9 |
| 2 — coalescing floor and ceiling | Task 1 | T1 steps 2–3 |
| 3 — lone change emits at the quiet period | Task 1 | T1 step 2 |
| 4 — git internals produce nothing | Task 1 | T1 step 4 |
| 5 — no watch when nobody looks; resumes on reconnect | Task 2 | T2 steps 10–11 |
| 6 — failed watch degrades, logs once, no retry | Task 1 | T1 step 5 |
| 7 — overflow emits a signal | Task 1 | T1 step 5 |
| 8 — released on delete and before worktree removal | Task 2 | T2 steps 6, 12 |
| 9 — exactly one refresh path | Task 3 | T3 steps 6–7 |

---

## Task 1: Coalescer, filter, watch, and the wire types

**Depends on:** nothing
**Files:** Create `server/src/watch.ts`, `server/src/watch.test.ts`; Modify `server/src/types.ts`,
`web/src/lib/types.ts`

The wire types are part of *this* task, not the next one. `watch.ts` publishes through
`bus.publish`, which is typed `(event: ServerEvent)` (`server/src/bus.ts:17`), so without the union
member this task cannot pass its own typecheck.

**Interfaces — produces:**

```ts
export const WATCH_TRAILING_MS = 150;
export const WATCH_MAX_WAIT_MS = 500;

export interface Coalescer { signal(): void; dispose(): void }
export function createCoalescer(
  emit: () => void,
  options?: {
    trailingMs?: number;
    maxWaitMs?: number;
    // A opaque handle, not NodeJS.Timeout — a fake scheduler must be able to return its own.
    schedule?: (fn: () => void, ms: number) => unknown;
    clear?: (timer: unknown) => void;
    now?: () => number;
  },
): Coalescer;

/** True for paths no consumer wants to hear about. `rel` is relative to the session root. */
export function shouldIgnoreWatchPath(rel: string): boolean;

export interface WatchHandle { close(): void; on(event: "error", listener: (error: Error) => void): void }
export type WatchFactory = (
  dir: string,
  onChange: (eventType: string, filename: string | null) => void,
) => WatchHandle;

/** Refcounted recursive watch on one thread's cwd. Returns an idempotent release. */
export function watchThread(threadId: string, cwd: string, factory?: WatchFactory): () => void;

/** Force-close every watch at or under `cwd`, ignoring refcounts. For worktree removal. */
export function releaseAllUnder(cwd: string): void;
```

**Behaviour the implementer must not improvise:**

- **The coalescer's contract is the whole point.** On the first `signal()` it records the time and
  arms a timer for `trailingMs`. Each later `signal()` re-arms for `trailingMs` but never past
  `firstSignalAt + maxWaitMs`. A lone signal emits at 150ms; a continuous stream emits every 500ms;
  after an emit the window resets. This upper bound is what `FS_SETTLE_MS` in
  `web/src/store.ts:326` lacks, and is why a long turn leaves the tree stale today.
- `dispose()` clears the timer and drops any pending signal without emitting.
- `shouldIgnoreWatchPath` returns true only when the first path segment is `.git`. Do **not** also
  filter `node_modules`: `server/src/fsbrowse.ts:211`'s `TREE_SKIP` holds only `.git`, so the tree
  renders `node_modules` and dropping its events would under-signal a directory the user can see.
  `TREE_SKIP` is not exported — declare the constant locally rather than exporting it from there.
- **`filename` is `string | null`.** `fs.watch` omits it on some platforms and event types. Treat
  `null` as "something changed, path unknown" and signal. The spec's "must never under-signal" makes
  this the load-bearing default.
- `watchThread` refcounts by `threadId`: the first caller creates the watch, later callers share it,
  the watch closes when the last release runs. The release is idempotent — mirror the `released`
  flag at `server/src/metrics.ts:230`.
- Every event feeds the coalescer; only the coalescer publishes `{ type: "fs.changed", threadId }`.
- A factory that throws is caught, logged **once** for that thread, and yields a no-op release. No
  retry loop.
- The handle's `error` event closes the watch and publishes one final `fs.changed` directly,
  bypassing the coalescer — a spurious refresh is cheap, a missed one is not.

**Steps:**

- [ ] 1. Add `| { type: "fs.changed"; threadId: string }` to the `ServerEvent` union at
      `server/src/types.ts:255`. Mirror it into `web/src/lib/types.ts` in the same edit.

- [ ] 2. Write the coalescer tests in `server/src/watch.test.ts`, using injected `schedule`,
      `clear` and `now` so nothing sleeps: a lone signal emits once at `trailingMs` and not before;
      after an emit, a later lone signal emits `trailingMs` after it.

- [ ] 3. Add the burst test: signals every 100ms for 2s emit at ~500ms intervals and never more
      often. Then the disposal tests: `dispose()` before the window elapses emits nothing, and
      calling it twice is safe.

- [ ] 4. Add the filter tests: `.git/HEAD` is true; `src/index.ts`, `src/.gitignore`,
      `node_modules/x/y.js` and `a/node_modules_old/x` are all false. `node_modules` being false is
      deliberate — see the behaviour note above.

- [ ] 5. Add the failure tests using a fake `WatchFactory`: a factory that throws yields a release
      that does not throw and logs once; emitting `error` on the handle publishes one `fs.changed`
      and closes; a `null` filename still signals.

- [ ] 6. Add the one integration test: `mkdtemp` a directory, `watchThread` it with the real
      factory, write a file, and assert a `fs.changed` for that thread reaches a `bus.subscribe`
      listener within 2s. Mark it in a comment as the only test that depends on platform watch
      support.

- [ ] 7. Run `node --experimental-strip-types --test server/src/watch.test.ts`.
      Expect: FAIL — `Cannot find module '.../server/src/watch.ts'`.

- [ ] 8. Create `server/src/watch.ts` implementing every export. Import `publish` from `./bus.ts`.

- [ ] 9. Run the same command. Expect: PASS — `# fail 0`.

- [ ] 10. Run `pnpm -C server typecheck`. Expect: no output, exit 0. An error about
      `"fs.changed"` not being assignable to `ServerEvent` means step 1 was skipped.

- [ ] 11. Commit:
      `git add server/src/watch.ts server/src/watch.test.ts server/src/types.ts web/src/lib/types.ts`
      `git commit -m "feat(server): add a coalesced filesystem watcher"`

**Done when:** the coalescer's timing contract, the filter, and both failure paths are covered by
tests that do not sleep; `pnpm -C server typecheck` is clean; and nothing outside the module calls
`watchThread` yet.

---

## Task 2: Wire it to the socket

**Depends on:** Task 1
**Files:** Modify `server/src/types.ts`, `web/src/lib/types.ts`, `server/src/index.ts`,
`server/src/api.ts`, `web/src/components/ChatView.tsx`

**Interfaces:**
- Consumes: `watchThread`, `releaseAllUnder` from `server/src/watch.ts`
- Produces, wire: `ClientMessage` gains `{ type: "fs.watch"; threadId: string; on: boolean }`

**Steps:**

- [ ] 1. Add `| { type: "fs.watch"; threadId: string; on: boolean }` to `ClientMessage` at
      `server/src/types.ts:286`, and mirror it into `web/src/lib/types.ts`.

- [ ] 2. Extend the `Connection` interface at `server/src/index.ts:61` with
      `watchFs: Map<string, () => void>`. A map, not a single handle — one socket can have several
      sessions open.

- [ ] 3. Initialise it at the construction site, `server/src/index.ts:129`:
      `{ send: …, watchResources: null, watchFs: new Map() }`.

- [ ] 4. Handle the message in `handleClientMessage`. It must sit **after** the `threads.byId`
      lookup at `server/src/index.ts:87`, so an unknown thread is rejected the way the pty messages
      are. On `on: true`, create and store a release if the map has no entry for that thread; on
      `on: false`, call and delete it.

- [ ] 5. Release every watch in `teardown` at `server/src/index.ts:146`, beside the existing
      `watchResources` release, and clear the map.

- [ ] 6. Release before a worktree is removed. In `server/src/api.ts`, call
      `releaseAllUnder(target)` in the `DELETE /api/projects/:id/worktrees` handler immediately
      before `git.removeWorktree`. An open handle can block removal on some platforms, and the
      spec makes this a constraint.

- [ ] 7. Send the watch from `ChatView`, **not** from `FileTree`. Add an effect keyed on
      `[thread.id, connected]` that sends `{ type: "fs.watch", threadId: thread.id, on: true }` via
      `sendClientMessage` and sends `on: false` in its cleanup. `connected` comes from the store
      (`web/src/store.ts:112`).
      Keying on `connected` is not optional: `sendClientMessage` silently drops when the socket is
      not OPEN (`web/src/lib/ws.ts:16-18`) and the server releases every watch on close, so without
      it a single reconnect — routine, since `server/package.json`'s dev script is `node --watch` —
      leaves the session with no watch and nothing to re-establish it.

- [ ] 8. Run `pnpm typecheck`. Expect: no output, exit 0. Run `pnpm test`. Expect: no new failures.

- [ ] 9. Verify the headline behaviour, which does not exist today at all. Start `pnpm dev`, open a
      session on `/tmp/sr03-repo`, open the files panel, then from a separate terminal:
      ```bash
      touch /tmp/sr03-repo/from-outside.txt
      ```
      Expect: the file appears in the tree within about a second, with no agent turn involved.
      Then `rm` it and confirm it disappears.

- [ ] 10. Verify the lifecycle: navigate to a different thread and confirm — in the Network tab's WS
      frames — that `fs.watch {on:false}` is sent for the old thread and `{on:true}` for the new.
      Closing only the files panel must **not** stop the watch; the branch chip and file index still
      need it.

- [ ] 11. Verify reconnect. With the session open, restart the server (`touch server/src/index.ts`
      to trigger `node --watch`). After the socket reconnects, `touch` a file from the terminal.
      Expect: the tree still updates. Without step 7's `connected` key it will not.

- [ ] 12. Verify the worktree release: create a worktree, open a session on it, then remove it from
      the worktree panel. Expect: removal succeeds, and the server logs no watch error afterwards.

- [ ] 13. Commit:
      `git add server/src/types.ts web/src/lib/types.ts server/src/index.ts server/src/api.ts web/src/components/ChatView.tsx`
      `git commit -m "feat(files): refresh from a real filesystem watcher"`

**Done when:** a file created outside the app appears in the tree within ~1s, switching threads
moves the watch, a server restart does not permanently break it, and removing a watched worktree
succeeds.

---

## Task 3: Delete the tool-message inference

**Depends on:** Task 2
**Files:** Modify `web/src/store.ts`, `web/src/components/FileTree.tsx`,
`web/src/components/ChatView.tsx`

**What `refreshToken` actually is — read this before step 4.** It is *not* a duplicate of
`fsTick`. `ChatView.tsx:263` declares `const [fsVersion, setFsVersion] = useState(0)` and
`ChatView.tsx:362`'s `savedFile` callback is its only writer — it fires when the user saves a file
in the app's own editor. `fsTick` is the store's `fsVersionByThread`. They are independent, and
both feed the file-index reload (`ChatView.tsx:419`) and the branch chip (`ChatView.tsx:433`).
Once the watcher covers editor saves — it does, they are ordinary writes to the working directory —
`fsVersion` becomes redundant, but it is redundant for a *different reason* than an earlier draft of
this plan claimed. Remove it only after step 5's verification.

**Steps:**

- [ ] 1. Handle the new event in `applyEvent` (`web/src/store.ts:791`, a plain `switch (event.type)`):
      on `fs.changed`, bump `fsVersionByThread[threadId]` directly. No debounce — the server already
      coalesced, and debouncing twice reintroduces the lag this plan removes.

- [ ] 2. Delete `WRITE_TOOLS` (`web/src/store.ts:325`), `FS_SETTLE_MS` (`:326`), `fsTimers` (`:327`),
      `writes()` (`:329`) and `bumpFs` (`:337`), plus both call sites — `:805` (tool message) and
      `:873` (turn ended). Confirm with
      `grep -n "bumpFs\|WRITE_TOOLS\|FS_SETTLE_MS\|fsTimers" web/src/store.ts` returning nothing.

- [ ] 3. Add the change-set floor in `FileTree.tsx`. The refresh effect calls `api.changes`, which
      runs `git status`; at the watcher's 500ms ceiling that is twice the rate of today's 750ms
      trailing debounce. Hold the last run's finish time in a ref and skip the `api.changes` half
      when under 1000ms have passed, scheduling one trailing run instead. The directory listings
      keep refreshing at the full signal rate — only the change set is floored. The spec's
      non-goals call this out.

- [ ] 4. Verify `fsVersion` is now redundant before deleting it: with the watcher running, save a
      file in the app's editor and confirm the tree, the file index and the branch chip all update
      without `fsVersion` firing (comment out `savedFile`'s body temporarily to check).

- [ ] 5. Remove `fsVersion` and `savedFile` from `ChatView.tsx` (`:263`, `:362`), drop them from the
      dependency arrays at `:419` and `:433`, drop the `refreshToken` prop at `:713`, drop
      `onSaved` at `:675`, and remove the prop from `FileTree`'s signature and its effect deps.
      If step 4 showed any consumer *not* updating, stop and keep `fsVersion` — report which one.

- [ ] 6. Run `pnpm typecheck`. Expect: no output, exit 0. Run `pnpm test`. Expect: no new failures.

- [ ] 7. Verify the agent path still refreshes. On `/tmp/sr03-repo`, run a turn that asks the
      provider to create a file. Expect: it appears in the tree *during* the turn, not only at the
      end — which is the improvement over the deleted trailing debounce.

- [ ] 8. Verify no double refresh. With the Network tab filtered to the tree request, run one agent
      turn that writes a single file. Expect: one re-read per coalescing window, not two per write.

- [ ] 9. Verify the git-status floor: start a build or `touch` files in a loop for ten seconds and
      confirm — via a temporary `console.log` in `api.changes`'s server handler — that it runs at
      most once per second. Remove the log afterwards and confirm `git diff server/src/api.ts` is
      empty.

- [ ] 10. Commit:
      `git add web/src/store.ts web/src/components/FileTree.tsx web/src/components/ChatView.tsx`
      `git commit -m "refactor(store): drop tool-message fs inference for the watcher"`

**Done when:** the grep in step 2 is empty, agent writes refresh the tree during the turn, a single
write causes a single re-read, `git status` runs at most once a second under churn, and every
`fsTick` consumer still updates.

## Risks

- **`fs.watch({ recursive: true })` platform support.** Supported on macOS and Windows, and on
  Linux since Node 20. The repo requires Node `>=22.16` (root `package.json` engines), so all three
  targets are covered — but the try/catch in Task 1 is what keeps an unsupported platform degrading
  rather than crashing, and it must not be removed as dead code.
- **A recursive watch covers `node_modules` too,** and the filter deliberately does not drop those
  events, because the tree renders that directory. An `npm install` therefore produces signals at
  the coalescing ceiling for its duration. If that shows up as measurable CPU, the fix is a
  non-recursive watch per expanded directory — a larger change, out of scope. Measure before
  assuming.
- **Task 3 is the revert point, not Task 2.** It deletes the only refresh trigger that exists today.
  If the watcher proves unreliable on your machine, revert Task 3 and the inference comes back.
- **Task 3 step 5 removes `fsVersion`, which has a live consumer today** (the app's own editor
  saves). Step 4 exists to prove the watcher covers it first. If it does not, keep `fsVersion` —
  the rest of the task still stands.
