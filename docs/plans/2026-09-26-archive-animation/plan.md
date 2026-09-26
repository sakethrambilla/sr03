# Smooth archive animation — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch / worktree:** `ai/archive-chats-smooth-animation-e2d836` (this worktree)
**Test command:** `pnpm -C web test`
**Lint / typecheck:** `pnpm typecheck`

## Approach
The store gains a `leaving` map, `threadId → delayMs | null`. A thread that is in the map keeps
rendering in its active folder even after its `archived` flag flips. That matters because the
server broadcasts `thread.updated` over the WebSocket, and that can land before the HTTP response
does. A `null` entry pins the row without animating it, which is how rows are held while the
request is in flight. A number entry plays the exit animation after that delay.

Once the exit time for the batch has passed, the entries are removed and the rows drop out
normally. The collapse is pure CSS: each `<li>` becomes a one-row grid that animates
`grid-template-rows` from `1fr` to `0fr`, which gives a smooth height collapse without measuring
anything, together with opacity and `translate`. The curve is `cubic-bezier(0.32,0.72,0,1)`, the
iOS sheet curve (Vaul uses the same one).

We use a store-driven "leaving" state instead of a React exit-animation library, because the
spec forbids new dependencies and because the WebSocket race requires the store to own pinning
anyway.

## Global constraints
- No new dependencies. Use Tailwind classes (arbitrary values are fine) and `sonner`, which is
  already mounted in `web/src/App.tsx:93`.
- Zustand selectors must never return a fresh object or array. Select `state.leaving` whole, or
  `state.leaving[id]`, which is a primitive.
- No server changes. Undo goes through the existing `setArchived(id, false)`.
- One-line comments only, and only where the code can't speak for itself.
- Commits are single-line Conventional Commits, authored as sakethrambilla@gmail.com.

## File map
| File | Create/Modify | Responsibility |
|---|---|---|
| web/src/lib/archive.ts | Create | Exit timing: `EXIT_MS`, `exitDelays(count)`, `exitTotalMs(count)` |
| web/src/lib/archive.test.ts | Create | Unit tests for the timing helpers |
| web/src/store.ts | Modify | `leaving` state; `archiveIdle` and `setArchived` pin, animate, commit; undo toast |
| web/src/components/Sidebar.tsx | Modify | `ThreadRow` collapse classes; `grouped` and `archived` memos honour `leaving` |

## Tasks

### Task 1: Exit timing helpers

**Depends on:** none
**Files:** create `web/src/lib/archive.ts` and `web/src/lib/archive.test.ts`

**Interfaces produced:**
```ts
export const EXIT_MS = 200;
export const STAGGER_MS = 30;
export const MAX_STAGGER_SPAN_MS = 500;
export function exitDelays(count: number): number[];
export function exitTotalMs(count: number): number;
```
- `exitDelays(n)`: element `i` is `Math.round(i * step)`, where
  `step = n <= 1 ? 0 : Math.min(STAGGER_MS, MAX_STAGGER_SPAN_MS / (n - 1))`. `exitDelays(0)` is `[]`.
- `exitTotalMs(n)`: `0` when `n === 0`, otherwise `(exitDelays(n).at(-1) ?? 0) + EXIT_MS`.

Steps:
- [ ] 1. Write `archive.test.ts`, using `node:test` and `node:assert/strict` in the same style
      as `web/src/lib/panels.test.ts`. Cover these cases:
      - `exitDelays(0)` deep-equals `[]`
      - `exitDelays(1)` deep-equals `[0]`
      - `exitDelays(3)` deep-equals `[0, 30, 60]`
      - for `exitDelays(21)`, the last element is `500` and every step is ≤ 30
      - `exitTotalMs(0) === 0`, `exitTotalMs(1) === 200`, `exitTotalMs(3) === 260`, and
        `exitTotalMs(100) === 700`
- [ ] 2. Run `pnpm -C web test`. Expect it to fail with `Cannot find module
      '.../web/src/lib/archive.ts'`.
- [ ] 3. Write `archive.ts` with the exports above. Put a one-line comment on
      `MAX_STAGGER_SPAN_MS`: `// caps the wave so a large batch still finishes in ~700ms`.
- [ ] 4. Run `pnpm -C web test`. Expect everything to pass, including the new archive tests.
- [ ] 5. Commit `web/src/lib/archive.ts` and `web/src/lib/archive.test.ts` as
      `feat(web): add staggered exit timing for archived rows`.

**Done when** the suite is green and `pnpm typecheck` passes.

### Task 2: Leaving state and row collapse

**Depends on:** Task 1
**Files:** modify `web/src/store.ts` and `web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes `exitDelays` and `exitTotalMs` from `./lib/archive.ts`.
- Produces `leaving: Record<string, number | null>` on the store, initialised to a module-level
  `const NO_LEAVING: Record<string, number | null> = {}` so the empty value is never a fresh
  object.

Steps:
- [ ] 1. In `web/src/store.ts`, add `leaving: Record<string, number | null>;` to the state
      interface, next to `archiveIdle` (around line 169). Add `NO_LEAVING` near `EMPTY` (line
      204) and `leaving: NO_LEAVING` in the initial state. Add
      `const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));`
      at module level.
- [ ] 2. Add a private helper above the `create(...)` call:
      ```ts
      function withoutKeys(map: Record<string, number | null>, ids: string[]) {
        const next = { ...map };
        for (const id of ids) delete next[id];
        return Object.keys(next).length ? next : NO_LEAVING;
      }
      ```
- [ ] 3. Rewrite `archiveIdle` (currently `web/src/store.ts:618-625`):
      1. Compute `candidates`, the ids of `get().threads` where `projectId === projectId && !archived
         && status !== "running" && id !== activeThreadId`. This is the same predicate as
         `ArchiveIdleButton`, `Sidebar.tsx:272-282`. If it's empty, return.
      2. Before the request, set `leaving` to `{ ...state.leaving, [id]: null }` for every
         candidate.
      3. Run `await api.archiveIdle(...)` inside a `try`. In the `catch`, set `leaving` to
         `withoutKeys(state.leaving, candidates)`, set `error`, and return.
      4. Put the archived ids in current `state.threads` order. Call that `ids`, and get
         `delays = exitDelays(ids.length)`. Set `leaving`: drop the candidates that aren't in
         `ids`, and add `ids[i] → delays[i]`. Also upsert the returned threads.
      5. `await sleep(exitTotalMs(ids.length))`, then set `leaving` to
         `withoutKeys(state.leaving, ids)`.
- [ ] 4. Rewrite the archive branch of `setArchived` (`web/src/store.ts:627-639`). When
      `archived` is true, set `leaving[id] = null` before `api.patchThread`, and remove it in
      the `catch`. After the request succeeds, set `leaving[id] = 0` and upsert, `await
      sleep(exitTotalMs(1))`, and remove it again. The existing move to the next thread stays
      after the sleep. Unarchive (`archived === false`) keeps today's code path, with no
      `leaving`.
- [ ] 5. In `Sidebar.tsx`'s `Sidebar()`, add `const leaving = useStore((state) => state.leaving);`.
      In the `grouped` memo (line 441), change the active predicate to
      `(statusFilter === "archived" ? thread.archived && !(thread.id in leaving) : !thread.archived || thread.id in leaving)`.
      In the `archived` memo (line 458), add `&& !(thread.id in leaving)`. Add `leaving` to
      both dependency arrays.
- [ ] 6. In `ThreadRow`, add `const exitDelay = useStore((state) => state.leaving[thread.id]);`.
      Change the root `<li className="group">` to:
      ```tsx
      <li
        data-leaving={typeof exitDelay === "number" || undefined}
        style={typeof exitDelay === "number" ? { transitionDelay: `${exitDelay}ms` } : undefined}
        className={cn(
          "group grid transition-[grid-template-rows,opacity,translate] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]",
          typeof exitDelay === "number"
            ? "pointer-events-none -translate-x-3 grid-rows-[0fr] opacity-0"
            : "grid-rows-[1fr]",
        )}
      >
      ```
      Wrap the `<li>`'s existing children in a single `<div className="min-h-0 overflow-hidden">`,
      so the grid row can shrink below its content height.
- [ ] 7. Run `pnpm typecheck`. Expect exit code 0.
- [ ] 8. Check it by hand against the scratch repo from CLAUDE.md "Testing changes", with
      `pnpm dev` at http://localhost:5399. Add `/tmp/sr03-repo` as a project, create 4 sessions
      and send a turn in each so they're idle, keep a fifth one open, and press ⌘⇧X. Expect the
      4 rows to fade and slide left in a top-to-bottom wave, with the list closing up smoothly
      and no jump. The open session stays. In the browser pane, run
      `document.querySelectorAll('li[data-leaving]').length` straight after ⌘⇧X: expect `4`, and
      `0` about one second later. Archive a single session from its menu: expect the same exit
      animation with no stagger. Stop the server (`pnpm dev` is killed), then press ⌘⇧X: expect
      no row to animate and the usual error to show.
- [ ] 9. Commit `web/src/store.ts` and `web/src/components/Sidebar.tsx` as
      `feat(web): animate archived sessions out of the sidebar`.

**Done when** spec criteria 1, 2, 3, 6, 7 and 8 all hold in the manual check, and typecheck and
tests are green.

### Task 3: Undo toast

**Depends on:** Task 2
**Files:** modify `web/src/store.ts`

Steps:
- [ ] 1. Add `import { toast } from "sonner";` to `web/src/store.ts`.
- [ ] 2. At the end of `archiveIdle`, after the `leaving` entries are removed and only if
      `ids.length > 0`, call:
      ```ts
      toast(`Archived ${ids.length} ${ids.length === 1 ? "session" : "sessions"}`, {
        action: {
          label: "Undo",
          onClick: () => void Promise.all(ids.map((id) => get().setArchived(id, false))),
        },
      });
      ```
- [ ] 3. Run `pnpm typecheck`. Expect exit code 0.
- [ ] 4. Check by hand, with the same setup as Task 2 step 8. After ⌘⇧X on 3 idle sessions,
      expect a bottom-centre toast reading "Archived 3 sessions" with an Undo button. Click Undo:
      expect all 3 to reappear in their folder, with no animation, and the toast to close. Repeat
      with 1 idle session: expect "Archived 1 session". Archive a single session from its menu:
      expect no toast.
- [ ] 5. Run `pnpm -C web test`. Expect everything to pass.
- [ ] 6. Commit `web/src/store.ts` as `feat(web): offer undo after archiving idle sessions`.

**Done when** spec criteria 4 and 5 hold in the manual check.

## Criteria → tasks
1 → T1, T2 · 2 → T2 · 3 → T2 · 4 → T3 · 5 → T3 · 6 → T2 · 7 → T2 (the empty-candidates early
return) · 8 → T2 (the candidate predicate excludes the active thread)

## Risks
- **Grid-rows transitions.** Animating `grid-template-rows` needs a Chromium from 2023 or later.
  Electron 44 and current browsers support it. If a browser doesn't, the rows still fade and
  disappear; they just don't collapse.
- **`translate` transitions.** Tailwind v4's `-translate-x-3` sets the `translate` property, not
  `transform`, which is why the transition list names `translate`. If the slide doesn't animate,
  inspect the computed `transition-property` before changing anything else.
- **Overlapping archive-idle calls.** Two quick presses can overlap. `withoutKeys` removes only
  its own ids, so the batches can't clear each other's rows.
- **A snap from another window.** A second window gets the WebSocket upsert without `leaving`,
  so its rows vanish abruptly. The spec accepts this.
