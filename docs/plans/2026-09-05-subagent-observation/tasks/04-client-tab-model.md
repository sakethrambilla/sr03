# Task 4: A subagent is a tab the client can hold

**Depends on:** Tasks 1–3 for the wire types; on none of their behaviour

**Files:**
- Modify: `web/src/lib/types.ts` — `EditorTab` gains `{ kind: "subagent"; taskId: string }`
- Modify: `web/src/lib/layout.ts` — `tabKey`, and a new `persistable` filter
- Modify: `web/src/lib/layout.test.ts` — key uniqueness, close/move, and the strip
- Modify: `web/src/lib/api.ts` — `stopTask(threadId, taskId)`
- Modify: `web/src/store.ts` — `streamByTask`, task delta events, strip on write, prune on rewind
- Modify: `web/src/components/EditorGroups.tsx` — `onClose` takes a tab; subagent tab chip
- Modify: `web/src/components/ChatView.tsx` — the retargeted close path

**Interfaces:**
- Produces: `openSubagent(taskId)` reachable from `ChatView`, and a tab that survives
  `closeTab` / `moveTab` / `selectTab` unchanged, because those already key on `tabKey`.

## The trap in this task

`server/src/layout.ts:parseTab` returns `null` for any tab kind it does not know, `parseGroup`
returns `null` for the whole group when one tab fails, and `parseLayout` therefore returns `null`
for the whole layout. So a subagent tab reaching `PATCH /api/threads/:id/layout` does not degrade —
**it silently discards the thread's entire stored layout**, split and all.

Subagent tabs are session-scoped by design (the spec's non-goal: no surviving a restart) and server
task state is in-memory anyway, so the fix is to never send them. Strip them in the client's write
path with a `persistable` helper, and cover it with a test. Do not relax the server guard: its
strictness is deliberate, and a second place that tolerates unknown kinds is a second place that
can silently drop a layout.

## Steps

- [ ] 1. In `web/src/lib/types.ts`, extend `EditorTab`:
      `export type EditorTab = { kind: "chat" } | { kind: "file"; path: string } | { kind: "subagent"; taskId: string };`
      Do **not** mirror this into `server/src/types.ts` — the server never stores this kind, and
      adding it there would make `parseTab` accept something the guard should keep rejecting.
      Leave a one-line comment saying so.

- [ ] 2. In `web/src/lib/layout.ts`, extend `tabKey` (line 25) with
      `if (tab.kind === "subagent") return \`subagent:${tab.taskId}\`;`, and add:
      ```ts
      // subagent tabs are session-scoped; the server's layout guard rejects unknown kinds outright,
      // which would discard the whole stored layout — so they never reach the write path
      export function persistable(layout: EditorLayout): EditorLayout | null
      ```
      It drops every subagent tab, drops any group left empty, re-fits `sizes` to the surviving
      groups via the existing `normalize`, and returns `null` when nothing is left.

- [ ] 3. In `web/src/lib/layout.test.ts`, add three tests: `tabKey` is distinct for a subagent tab
      and a file named the same as its task id; `closeTab` and `moveTab` handle a subagent tab
      like any other; `persistable` on a two-group layout whose second group holds only a subagent
      tab returns a single-group layout with `sizes` summing to 1.

- [ ] 4. Run `pnpm -C web test`.
      Expect: FAIL — `persistable is not a function`, and a type error on the subagent tab literal
      if the file is typechecked first. If `tabKey` passes already, you skipped step 2.

- [ ] 5. Implement `persistable`, re-run `pnpm -C web test`. Expect: PASS.

- [ ] 6. In `web/src/store.ts`, change `setLayout` (line 586) so the optimistic local
      `upsertThread` keeps the full layout but the debounced `api.setThreadLayout` call sends
      `persistable(layout)`. The local copy and the persisted copy differing is the point.

- [ ] 7. In `web/src/store.ts`, add `streamByTask: Record<string, Record<string, string>>` keyed
      thread → task → text, initialised `{}` beside `streamByThread` (line 359), and handle the
      two new events in `applyEvent`: `thread.task.delta` appends, `thread.task.delta.end` clears
      that task's entry. Clear the thread's whole entry in the `thread.truncated` case (line 789)
      beside the existing `tasksByThread` reset.

- [ ] 8. In `web/src/store.ts`, in the `thread.tasks` case, prune the thread's layout: any
      `subagent` tab whose `taskId` is absent from the incoming list is closed with `closeTab`.
      This is what closes a tab when a rewind drops its task, and it is the whole implementation of
      the spec's rewind open question.

- [ ] 9. In `web/src/lib/api.ts`, add
      `stopTask: (threadId: string, taskId: string) => post(\`/api/threads/${threadId}/tasks/${taskId}/stop\`)`,
      matching the shape of the neighbouring interrupt call.

- [ ] 10. In `web/src/components/EditorGroups.tsx`, change `EditorTabs`'s prop from
       `onClose: (path: string) => void` to `onClose: (tab: EditorTab) => void`, update the two
       call sites in that file (the close button and the middle-click `onAuxClick`), and add a
       third branch rendering a subagent tab chip: a `UserRound` lucide alias added to
       `components/ui.tsx`, the task description truncated to `max-w-40`, and the same close button
       the file branch uses. Do not give it a dirty indicator.

- [ ] 11. In `web/src/components/ChatView.tsx`, update `requestClose` and `closeFileTab` to take an
       `EditorTab`. Keep the unsaved-changes confirm on the `file` branch only — a subagent tab has
       nothing to lose, so it closes immediately.

- [ ] 12. Run `pnpm typecheck`. Expect: PASS. Run `pnpm test`. Expect: PASS.
       There is no tab body yet, so `ChatView`'s tab-body list will fail to typecheck the
       `subagent` case unless you add a placeholder — add `null` for it, with a comment pointing at
       task 5. A rendered-nothing tab is the correct half-state here.

- [ ] 13. Start `pnpm dev`, open a thread, and confirm the editor still behaves exactly as before:
       open two files, split, close one, reload, and the layout returns. This is a regression
       check on the retargeted `onClose`.

- [ ] 14. `git add web/src/lib/types.ts web/src/lib/layout.ts web/src/lib/layout.test.ts web/src/lib/api.ts web/src/store.ts web/src/components/EditorGroups.tsx web/src/components/ChatView.tsx`
       `git commit -m "feat(threads): model a subagent as an editor tab"`

## Done when

A subagent tab can exist in the layout model, is keyed distinctly, is never sent to the server, and
is dropped when its task disappears — with the existing file-and-chat tab behaviour unchanged
through a reload.
