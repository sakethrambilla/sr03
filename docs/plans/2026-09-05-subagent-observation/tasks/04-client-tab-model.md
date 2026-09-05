# Task 4: A subagent is a tab the client can hold

**Depends on:** Tasks 1–3 for the wire types; on none of their behaviour

**Files:**
- Modify: `web/src/lib/types.ts` — `EditorTab` gains `{ kind: "subagent"; taskId: string }`
- Modify: `web/src/lib/layout.ts` — `tabKey`, and a new `persistable`
- Modify: `web/src/lib/layout.test.ts` — key uniqueness, close/move, and the strip
- Modify: `web/src/lib/api.ts` — `stopTask(threadId, taskId)`
- Modify: `web/src/store.ts` — `streamByTask`, the two task delta events, strip on write
- Modify: `web/src/components/EditorGroups.tsx` — `onClose` takes a tab; subagent chip
- Modify: `web/src/components/ChatView.tsx` — dispatching close path, prune, open

**Interfaces:**
- Produces: `openSubagent(taskId: string)` in `ChatView`, and a tab that `closeTab` / `moveTab` /
  `selectTab` already handle, because they key on `tabKey`.

## Two traps in this task

**The layout has one writer and it is not the store.** `ChatView` seeds
`useState(() => normalize(thread.layout))` once per session (`ChatView.tsx:243`) and its own
comment names it the single writer; `setLayoutState` is called from exactly one place, `commit`
(`ChatView.tsx:292`). Pruning `state.threads[].layout` in the store would mutate a copy nothing
renders and the tab would stay open. The prune goes in `ChatView`.

**A subagent tab reaching the server is a 400, not a silent loss.** `server/src/layout.ts:parseTab`
returns null for unknown kinds and that nulls the whole layout, but `api.ts:876-881` catches it:
```ts
if (body.layout !== null && layout === null) throw new HttpError(400, "`layout` is not a valid editor layout");
```
`threads.setLayout` is never reached. So the symptom is an error banner from `setLayout`'s `.catch`
and a **stale** stored layout — every subsequent split or tab move silently fails to persist. Strip
subagent tabs in the client write path. Do not relax the server guard; its strictness is deliberate.

**Do not widen the dirty-tracking machinery.** `pendingClose`, `openFiles`, `closeAll`,
`promptNextDirty`, `saveAndClose` and `FileView.onClose` / `onMissing` are all path-keyed and only
ever concern files. This task changes the *tab strip's* close callback to take an `EditorTab` and
dispatches on `kind` at the ChatView boundary; everything downstream of that stays as it is.
`FileView.tsx` is not modified.

## Steps

- [ ] 1. In `web/src/lib/types.ts`, extend `EditorTab`:
      `export type EditorTab = { kind: "chat" } | { kind: "file"; path: string } | { kind: "subagent"; taskId: string };`
      Add a one-line comment saying the subagent variant is client-only and deliberately absent
      from `server/src/types.ts`, because the server's layout guard should keep rejecting it.

- [ ] 2. In `web/src/lib/layout.ts`, extend `tabKey` (line 25) with
      `if (tab.kind === "subagent") return \`subagent:${tab.taskId}\`;`, and add:
      ```ts
      // subagent tabs are session-scoped, and the server's layout guard 400s on unknown kinds —
      // which would leave every later layout write failing against a stale stored copy
      export function persistable(layout: EditorLayout): EditorLayout
      ```
      It drops every subagent tab, drops any group left empty, and returns `normalize` of the
      result. It returns a layout, never null: `normalize` always returns one and re-inserts the
      chat tab (`layout.ts:213-220`), so a null branch here would be unreachable.

- [ ] 3. In `web/src/lib/layout.test.ts`, add three tests: `tabKey` is distinct for
      `{ kind: "subagent", taskId: "x" }` and `{ kind: "file", path: "x" }`; `closeTab` and
      `moveTab` handle a subagent tab like any other; `persistable` on a two-group layout whose
      second group holds only a subagent tab returns a single-group layout whose `sizes` sum to 1
      and which still contains exactly one chat tab.

- [ ] 4. Run `pnpm -C web test`.
      Expect: FAIL at module load —
      `SyntaxError: The requested module './layout.ts' does not provide an export named 'persistable'`.
      Note that `node --test` does no typechecking, so the subagent tab literals will not be
      flagged here; `pnpm typecheck` is the check for those.

- [ ] 5. Implement `persistable`, re-run `pnpm -C web test`. Expect: PASS.

- [ ] 6. In `web/src/store.ts`, change `setLayout` (line 586) so the optimistic local
      `upsertThread` keeps the full layout but the debounced `api.setThreadLayout` call sends
      `persistable(layout)`. The local copy and the persisted copy differing is the point.

- [ ] 7. In `web/src/store.ts`, add `streamByTask: Record<string, Record<string, string>>` keyed
      thread → task → text, initialised `{}` beside `streamByThread` (line 359). In `applyEvent`:
      `thread.task.delta` appends to that task's entry; `thread.task.delta.end` deletes it. In the
      existing `thread.truncated` case (line ~789), clear the thread's whole entry beside the
      `tasksByThread` reset that is already there.

- [ ] 8. In `web/src/lib/api.ts`, add
      `stopTask: (threadId: string, taskId: string) => post(\`/api/threads/${threadId}/tasks/${taskId}/stop\`)`,
      matching the shape of the neighbouring interrupt call.

- [ ] 9. In `web/src/components/EditorGroups.tsx`, change `EditorTabs`'s prop from
      `onClose: (path: string) => void` to `onClose: (tab: EditorTab) => void`, and update its two
      call sites in that file — the close button (line ~82) and the middle-click `onAuxClick`
      (line ~59) — to pass `tab`. Add a `labels: Record<string, string>` prop mapping task id to
      description, and a third branch rendering a subagent chip: `AgentIcon` (the existing lucide
      `Bot` alias at `ui.tsx:219` — do not add a new one), `labels[tab.taskId] ?? "Subagent"`
      truncated with `max-w-40`, and the same close button the file branch uses, with no dirty
      indicator.

- [ ] 10. In `web/src/components/ChatView.tsx`, add
       ```ts
       const closeTabRequest = (tab: EditorTab) => {
         if (tab.kind === "file") requestClose(tab.path);
         else if (tab.kind === "subagent") commit(closeTab(layoutRef.current, tab));
       };
       ```
       and pass it as `EditorTabs`'s `onClose`. Leave `requestClose`, `closeFileTab`,
       `pendingClose`, `closeAll` and `FileView`'s props exactly as they are. Change the `⌘W`
       handler (line ~509) from `if (active) requestClose(active)` to
       `closeTabRequest(focusedTab)` — `focusedTab` is already computed at line ~367 and the chat
       branch is a no-op, which preserves today's pinned-chat behaviour.

- [ ] 11. In `ChatView.tsx`, build the `labels` map from
       `useStore((state) => state.tasksByThread[thread.id] ?? NO_TASKS)` with a module-level
       `NO_TASKS` constant, in a `useMemo`, and pass it to `EditorTabs`.

- [ ] 12. In `ChatView.tsx`, add an effect that prunes stale subagent tabs: when the task list
       changes, `commit` a layout with every `subagent` tab whose `taskId` is absent from it
       closed. Because `thread.truncated` already empties `tasksByThread` (`store.ts:799`), this
       one effect also implements the spec's rewind open question — no server change is needed.
       Guard it so it never calls `commit` when nothing changed, or it will loop.

- [ ] 13. In `ChatView.tsx`, add
       `const openSubagent = (taskId: string) => commit(openTab(layoutRef.current, { kind: "subagent", taskId }, focusedRef.current));`
       — note the third argument is `focusedRef.current`, an index, not the `focusedGroup` object.
       Leave it unused this task; task 5 wires the panel to it. Add a placeholder `null` for the
       `subagent` case in the tab-body list, with a comment pointing at task 5.

- [ ] 14. Run `pnpm typecheck`. Expect: PASS. Run `pnpm test`. Expect: PASS.

- [ ] 15. Start `pnpm dev` and regression-check the editor, which this task retargeted: open two
       files, split, close one with the tab's × and one with middle-click, close a third with
       `⌘W`, edit a file and confirm the unsaved-changes prompt still appears on close, then
       reload and confirm the layout returns. None of this should differ from before.

- [ ] 16. `git add web/src/lib/types.ts web/src/lib/layout.ts web/src/lib/layout.test.ts web/src/lib/api.ts web/src/store.ts web/src/components/EditorGroups.tsx web/src/components/ChatView.tsx`
       `git commit -m "feat(threads): model a subagent as an editor tab"`

## Done when

A subagent tab can exist in the layout model, is keyed distinctly, is stripped before every write
to the server, and is closed when its task disappears — with file-and-chat tab behaviour, the
unsaved-changes prompt and layout persistence all unchanged through a reload.
