# Plan — spawn another agent in the same worktree

Spec: `docs/plans/2026-11-03-worktree-agent/spec.md`

## Approach
The server already creates a thread on any existing cwd (`POST /api/threads` with `cwd`, which 400s
"Working directory does not exist" when it's gone), and WS events already update every loaded
thread's messages, not just the active one. So the work is the editor layout and the composer:

- Two new tab kinds. `{ kind: "spawn"; id: string; providerId: ProviderId }` is the unsent
  "New agent" draft — session-scoped, stripped by `persistable()` like `subagent`.
  `{ kind: "thread"; threadId: string }` is a sent child — persisted, so the server guard learns it.
- Store actions that today read `activeThreadId` (`send`, `interrupt`, `patchActive`) take an
  optional thread id, so a composer in a child tab acts on the child, not the parent.
- A new `spawnThread` store action creates the child on the parent's cwd and sends its first turn
  without changing `activeThreadId`; a new `loadThread` fetches a thread's transcript without
  activating it (for a `thread` tab mounted after reload).

## Global constraints
- No new dependencies. UI from existing shadcn wrappers in `web/src/components/ui.tsx` (`Menu`,
  `Chip`, icon aliases); no hand-drawn SVG, no raw hex.
- `server/src/types.ts` and `web/src/lib/types.ts` change together.
- Zustand selectors never return a fresh object/array; use module-level empty constants.
- Server TS is type-stripped: no enums, no parameter properties, `.ts` import extensions.
- No keyboard shortcut (so `SHORTCUTS.md` is untouched). No sidebar changes.
- Comments: one-liners, only where the code can't speak for itself.

## File map
| File | Change |
|---|---|
| `server/src/types.ts:32` | `EditorTab` gains `{ kind: "thread"; threadId: string }` |
| `server/src/layout.ts` | `parseTab` accepts `thread`; `parseLayout` rejects duplicate `threadId`s |
| `server/src/layout.test.ts` | cases for accepted thread tab and duplicate rejection |
| `web/src/lib/types.ts:32` | `EditorTab` gains `thread` and `spawn` kinds |
| `web/src/lib/layout.ts` | `tabKey` for both kinds; `persistable` also strips `spawn` |
| `web/src/lib/layout.test.ts` | `tabKey` distinctness + `persistable` strips `spawn`, keeps `thread` |
| `web/src/store.ts` | `send`/`interrupt`/`patchActive` take optional `threadId`; add `loadThread`, `spawnThread` |
| `web/src/components/Composer.tsx:1022` | `ThreadComposer` passes `thread.id` to those actions |
| `web/src/components/SpawnView.tsx` (new) | the New agent tab body: locked chips + `Composer` |
| `web/src/components/ThreadTabView.tsx` (new) | a child thread's tab body: `Timeline` + `ThreadComposer` |
| `web/src/components/EditorGroups.tsx` | tab strip + drag ghost render `thread` and `spawn` tabs |
| `web/src/components/ChatView.tsx` | `+ Agent` header menu; open/replace/close the new tabs; render bodies |

## Tasks
1. **Layout model** — the two tab kinds in types, guard and pure layout helpers. Verified by `pnpm test` + `pnpm typecheck`.
2. **Thread-scoped store actions** — `send`/`interrupt`/`patchActive` by id, `loadThread`, `spawnThread`. Verified by `pnpm typecheck` and the existing app behaving unchanged.
3. **UI** — `+ Agent` menu, `SpawnView`, `ThreadTabView`, tab strip. Verified by hand against the scratch repo, criterion by criterion.

---

## Task 1 — Layout model

**Files:** `server/src/types.ts`, `server/src/layout.ts`, `server/src/layout.test.ts`,
`web/src/lib/types.ts`, `web/src/lib/layout.ts`, `web/src/lib/layout.test.ts`

**Produces:**
- server `EditorTab = { kind: "chat" } | { kind: "file"; path: string } | { kind: "thread"; threadId: string }`
- web `EditorTab` = the above plus `{ kind: "subagent"; taskId: string }` (existing) and
  `{ kind: "spawn"; id: string; providerId: ProviderId }`
- `tabKey`: `thread:<threadId>`, `spawn:<id>`

**Steps**
- [ ] 1. In `server/src/layout.test.ts` add, using the existing `clone()`/`groupsOf()` helpers:
  - `test("accepts a thread tab")` — push `{ kind: "thread", threadId: "t2" }` onto group 2's tabs; `assert.deepEqual(parseLayout(layout)?.groups[1]?.tabs[1], { kind: "thread", threadId: "t2" })`.
  - `test("rejects a thread tab with no id")` — push `{ kind: "thread" }`; expect `null`.
  - `test("rejects the same thread open twice")` — push `{ kind: "thread", threadId: "t2" }` onto both groups; expect `null`.
- [ ] 2. `pnpm -C server test` → the three new tests FAIL (first returns null; the other two may pass by accident — the first must fail).
- [ ] 3. `server/src/types.ts:32`: add the `thread` member. `server/src/layout.ts` `parseTab`: `if (value.kind === "thread" && nonEmptyString(value.threadId)) return { kind: "thread", threadId: value.threadId };`. In `parseLayout`, next to the `paths` duplicate check, build `threadIds` the same way and `return null` on a duplicate; extend that block's one-line comment to "one transcript, and at most one tab per file or thread, across the whole layout".
- [ ] 4. `pnpm -C server test` → all PASS.
- [ ] 5. In `web/src/lib/layout.test.ts` add: `tabKey({ kind: "thread", threadId: "a" })` ≠ `tabKey({ kind: "spawn", id: "a", providerId: "claude" })` ≠ `tabKey(file("a"))`; and `persistable` of a layout whose group holds `[CHAT, spawnTab, threadTab]` yields tabs `[CHAT, threadTab]`. (Check the line-40 mapper in that file still compiles once the union widens — add the two kinds to it.)
- [ ] 6. `pnpm -C web test` → new tests FAIL.
- [ ] 7. `web/src/lib/types.ts:32`: add both members (import `ProviderId` is already in that file). `web/src/lib/layout.ts` `tabKey`: two branches before the `file:` fallback. `persistable`: filter `tab.kind !== "subagent" && tab.kind !== "spawn"`; update its comment to "subagent and spawn tabs are session-scoped, …".
- [ ] 8. `pnpm test` → PASS. `pnpm typecheck` → it will now FAIL in `EditorGroups.tsx`/`ChatView.tsx` where `tab.path` is read in the `else` branch. Fix only by narrowing: make those fallbacks `tab.kind === "file" ? … : null` (render nothing for the new kinds yet). `tabName` in `EditorGroups.tsx`: return `"New agent"` for `spawn`, `"Agent"` for `thread` (Task 3 replaces this with the title).
- [ ] 9. `pnpm typecheck` → PASS; `pnpm test` → PASS.
- [ ] 10. Commit: `feat(layout): add thread and spawn editor tab kinds`

**Done when:** `pnpm test && pnpm typecheck` exits 0.

---

## Task 2 — Thread-scoped store actions

**Files:** `web/src/store.ts`, `web/src/components/Composer.tsx`

**Produces (store interface, ~line 164–185):**
- `send: (text: string, threadId?: string) => Promise<void>` — `const id = threadId ?? get().activeThreadId`
- `interrupt: (threadId?: string) => Promise<void>` — same
- `patchActive: (patch, threadId?: string) => Promise<void>` — same; keep the name
- `loadThread: (id: string) => Promise<void>` — the fetch half of `openThread` (lines 513–524): `api.thread(id)` and the `threads`/`messagesByThread`/`tasksByThread`/`loadedThreads` set, without touching `activeThreadId`, `draft`, `settingsOpen` or `finished`. Then make `openThread` call it after its first `set`, instead of duplicating it.
- `spawnThread: (input: { parentId: string; providerId: ProviderId; model: string; permissionMode: PermissionMode; effort: Effort; fast: boolean; text: string }) => Promise<Thread>` — look up the parent in `get().threads`; `api.createThread({ projectId: parent.projectId, providerId, cwd: parent.cwd, model, permissionMode, effort, fast })`; set `threads` (upsertThread), `messagesByThread[id] = []`, `loadedThreads[id] = true`; `await api.sendTurn(thread.id, text)`; return the thread. Throws on API error — no `set({ error })`, the caller shows it (same contract as `startFromDraft`).

**Steps**
- [ ] 1. Change the three signatures and bodies as above.
- [ ] 2. Extract `loadThread`; rewire `openThread`.
- [ ] 3. Add `spawnThread`.
- [ ] 4. `Composer.tsx` `ThreadComposer`: `patchActive({ model }, thread.id)` (all four pickers), `send(text, thread.id)`, `interrupt(thread.id)`.
- [ ] 5. `pnpm typecheck` → PASS.
- [ ] 6. `pnpm dev`, open http://localhost:5399, open an existing scratch thread (see Task 3 setup), send a message, change the model, interrupt — all still act on that thread.
- [ ] 7. Commit: `refactor(web): scope composer actions to their thread`

**Done when:** typecheck passes and the manual check in step 6 behaves as before.

---

## Task 3 — UI

**Files:** `web/src/components/SpawnView.tsx` (new), `web/src/components/ThreadTabView.tsx` (new),
`web/src/components/EditorGroups.tsx`, `web/src/components/ChatView.tsx`

**Setup (once):** scratch repo per `CLAUDE.md` → "Testing changes" (`/tmp/sr03-repo`). `pnpm dev`, add
it as a project, start a New thread with worktree ticked, send "say hi".

**Steps**
- [ ] 1. `ThreadTabView.tsx`: `export function ThreadTabView({ threadId, files, onRun }: { threadId: string; files: FileLinks; onRun: (command: string) => void })`. Selects the thread from `state.threads`; `useEffect` calls `loadThread(threadId)` when `!loadedThreads[threadId]`. If the thread isn't in the store (deleted), render a muted `<p>` "This session no longer exists." Otherwise render `<Timeline threadId running={status==="running"} files onRun />` + `<ThreadComposer thread />` — the same pair the `chat` branch in `ChatView.tsx:599` renders, minus rewind/subagent props.
- [ ] 2. `SpawnView.tsx`: `export function SpawnView({ parent, providerId, onSent }: { parent: Thread; providerId: ProviderId; onSent: (thread: Thread) => void })`. Local `useState` for model/permissionMode/effort/fast seeded from `providerCatalog(providers, providerId).defaults` and `tuneForModel` (`providerCatalog` is exported from `store.ts:243`; add `export` to `tuneForModel` at `store.ts:252`). Renders `Composer` with `chips` = a non-interactive `Chip` with `BranchIcon` + `parent.branch` and a `ProviderLogo` chip with the provider label (no `onClick` on either — that is what locks location, criterion 8), `cwd={parent.cwd}`, placeholder `Ask ${label}…`, `onSubmit` = `await spawnThread({...})` then `onSent(thread)`; on throw, set a local `error` string rendered in `above` as `<p className="px-1 text-xs text-destructive">` and rethrow (Composer keeps the text, as `DraftView` relies on).
- [ ] 3. `EditorGroups.tsx`: `EditorTabs` and `EditorGroups` take a new `threadTitles: Record<string, string>` prop. `tabName`: `spawn` → `"New agent"`, `thread` → `threadTitles[tab.threadId] ?? "Agent"`. Render `spawn` and `thread` tabs with the same closable markup as the `subagent` branch (line 113), icon `AgentIcon`; add both to the drag-ghost icon switch (line 475).
- [ ] 4. `ChatView.tsx` header (line ~533, after the provider chip): a `Menu` with `title="New agent in this folder"`, `trigger="Agent"`, `triggerIcon={<PlusIcon className="size-3.5" />}`, items = providers ordered with `thread.providerId` first, each `{ id, label, hint, icon: <ProviderLogo id /> }`; `onPick={(id) => commit(openTab(layoutRef.current, { kind: "spawn", id: crypto.randomUUID(), providerId: id as ProviderId }, focusedRef.current))}`.
- [ ] 5. `ChatView.tsx`: `threadTitles` via a `useStore` selector returning `state.threads` (stable) then `useMemo` to the map; pass to `EditorGroups`. `closeTabRequest`: `spawn` and `thread` → `commit(closeTab(layoutRef.current, tab))` (never stops the child — criterion 7). In the body switch render `spawn` → `<SpawnView parent={thread} providerId={tab.providerId} onSent={(child) => commit(replaceTab(layoutRef.current, tab, { kind: "thread", threadId: child.id }))} />`, `thread` → `<ThreadTabView threadId={tab.threadId} files={links} onRun={runCommand} />`.
- [ ] 6. `replaceTab` does not exist — add `export function replaceTab(layout, from, to): EditorLayout` to `web/src/lib/layout.ts` (swap in place, same group, same index, stays active) with a test in `layout.test.ts`; `pnpm -C web test` → PASS.
- [ ] 7. `pnpm typecheck && pnpm test` → PASS.
- [ ] 8. Manual, against the scratch worktree thread — one check per spec criterion:
  1. Click Agent → menu shows Claude/Codex/Cursor, current provider first.
  2. Pick Codex → "New agent" tab appears and is active in the same group; chat tab still there.
  3. Send "list files" → sidebar shows a new thread with the same branch chip; `sqlite3 ~/.sr03/*.db "select cwd from threads order by created_at desc limit 2"` prints the same path twice.
  4. Tab title becomes the child's title; send a long turn in the parent tab, switch back — both stream.
  5. Reload → child tab still there; open a second New agent, don't send, reload → it's gone.
  6. Open a New agent tab, `git -C /tmp/sr03-repo worktree remove --force <path>`, send → tab shows "Working directory does not exist"; sidebar unchanged.
  7. Start a turn in a child tab, close the tab → thread keeps running (sidebar status dot).
  8. New agent tab shows no clickable folder/branch/worktree control.
- [ ] 9. Commit: `feat(web): spawn an agent session in the same worktree`

**Done when:** `pnpm typecheck && pnpm test` exits 0 and all eight manual checks pass.

## Risks
- `ChatView` remounts per active thread; a `thread` tab's child is a different thread, so the
  child's approvals render in its own tab via `ThreadComposer` — matching the spec's assumption.
  The tab has no attention marker yet; if the user wants one, it's a follow-up.
- The child's own `thread.layout` is untouched; opening it from the sidebar shows its own chat.
