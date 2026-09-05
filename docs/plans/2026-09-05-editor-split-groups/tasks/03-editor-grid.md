# Task 3: Put the editor area on the layout model

**Depends on:** Task 1, Task 2
**Files:**
- Create: `web/src/components/EditorGroups.tsx`
- Modify: `web/src/components/ChatView.tsx`
- Modify: `web/src/components/FileView.tsx`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/store.ts`

**Interfaces:**
- Consumes: everything task 2 exports, and `Thread.layout` from task 1.
- Produces in `web/src/lib/api.ts`:
  `setThreadLayout: (id: string, layout: EditorLayout | null) => Promise<Thread>`, calling
  `PATCH /api/threads/:id/layout`, shaped like the neighbouring `patchThread`.
- Produces in `web/src/store.ts`:
  `setLayout: (id: string, layout: EditorLayout) => void` — updates `threads` optimistically through
  the existing `upsertThread`, then writes to the server on a trailing 250 ms coalesce so a sash
  drag emits one request rather than one per pointer move. The timer handles live in a module-level
  `Map<string, number>` keyed by thread id, using `window.setTimeout` (a bare `setTimeout` types as
  `NodeJS.Timeout` once task 2 adds Node types).
- Produces `EditorGroups`, exported from `web/src/components/EditorGroups.tsx`:
  ```tsx
  export function EditorGroups({ layout, focused, onFocusGroup, strip, children }: {
    layout: EditorLayout;
    focused: number;
    onFocusGroup: (index: number) => void;
    strip: (group: EditorGroup, index: number) => ReactNode;
    children: ReactNode;   // the flat, stable list of view elements
  }): ReactElement;
  ```
  It owns the grid container and places each group's `strip(...)` at its own track. It renders
  `children` untouched, and knows nothing about files, chat, or dragging. Sashes arrive in task 4.

**This task must not change what the user sees.** One group is the only reachable state until task
4, so the editor should look and behave exactly as it does on `main` — with two exceptions: the
active tab now survives a reload, and a file deleted on disk closes its own tab.

## Who owns the layout

`ChatView` is keyed by `thread.id` in [App.tsx:83](../../../../web/src/App.tsx:83), so it remounts
whenever the thread changes. Its `useState` is therefore the **single writer**: seeded once at mount
from `normalize(thread.layout)`, and never re-seeded afterwards. The `thread.updated` events that
`setLayout` provokes are echoes of writes this component already made — folding them back in would
let a 250 ms-stale echo overwrite a newer local change. Read `thread.layout` at mount only.

## Steps

- [ ] 1. In `web/src/lib/api.ts`, add `setThreadLayout` next to `patchThread`.

- [ ] 2. In `web/src/store.ts`, add `setLayout` to the `Store` interface and implement it as
      described above. On a rejected write, set `error` — the toast is how a failed persist surfaces.

- [ ] 3. Create `web/src/components/EditorGroups.tsx` with the signature above. The container is
      `display: grid`; for `"horizontal"` it sets `gridTemplateColumns` from
      `trackTemplate(layout.sizes, "horizontal")` and `gridTemplateRows` to `auto 1fr`; for
      `"vertical"` it sets `gridTemplateRows` from `trackTemplate(...)` and a single column. Each
      strip is placed with `trackOf(index, axis, "strip")`, and clicking anywhere in a group calls
      `onFocusGroup(index)`.

- [ ] 4. Move `EditorTabs` out of `ChatView.tsx` and into `EditorGroups.tsx`, changing it to take
      one `EditorGroup` plus its index. It renders that group's `tabs` in order, marking
      `group.tabs[group.active]` as selected. Chat is still rendered separately by `ChatView` in
      this task — `EditorTabs` renders `kind: "file"` tabs only, and skips a chat tab it finds.
      Keep the existing markup and token classes exactly; this is a move, not a restyle.

- [ ] 5. In `ChatView`, replace the `openFiles` / `active` state pair with
      `const [layout, setLayoutState] = useState(() => normalize(thread.layout))` plus
      `const [focused, setFocused] = useState(0)`. Add one `commit(next: EditorLayout)` helper that
      calls `setLayoutState(next)` and `setLayout(thread.id, next)` together, and route every
      mutation through it — nothing else may call `setLayoutState`.

- [ ] 6. Rewrite the call sites onto the model, one per line, keeping their current behaviour:
      `openFile` → `openTab(layout, {kind:"file",path}, focused)`;
      `selectTab` → `selectTab(layout, groupIndex, tab)`;
      `closeFile` → `closeTab`; `closeAll` → keep only dirty files, then `normalize`;
      `renamed` → map the path across every group's tabs; `deleted` → `closeTab` for the path and
      each path beneath it.

- [ ] 7. Derive the old locals rather than deleting their uses wholesale: `openFiles` becomes
      `allTabs(layout)` filtered to files, and `active` becomes the focused group's active tab.
      This keeps the `⌘W`, `⌘K W` and dirty-tracking code compiling unchanged — task 4 retargets it.

- [ ] 8. Render the views as one flat list, `allTabs(layout)` filtered to files, each `<FileView>`
      wrapped in a `<div>` carrying `gridColumn` / `gridRow` from
      `trackOf(groupIndex, layout.axis, "view")` and hidden unless it is its own group's active tab.
      Keep `key={path}`. **Every view stays a direct child of the single grid, in one flat list, for
      the life of the session** — see the plan's Approach. Do not introduce a per-group wrapper.

- [ ] 9. Keep the chat pane exactly where it is for now: rendered when the focused group's active
      tab is the chat tab, in its current position, with its current classes. The
      `terminalOpen && terminalMax && "hidden"` wrapper at
      [ChatView.tsx:576](../../../../web/src/components/ChatView.tsx:576) now wraps the grid; leave
      that class on the wrapper, not on the grid container.

- [ ] 10. In `FileView`, add an `onMissing?: (path: string) => void` prop and call it when the
      initial load fails because the file does not exist — distinguish that from a read error, and
      call it at most once per mount. In `ChatView`, pass `onMissing={closeFileTab}`. This is what
      satisfies spec criterion 9: a stale tab is closed by the view that cannot load it, never by
      intersecting the layout against `filesByCwd`, which is `git ls-files` output and would
      silently close gitignored files.

- [ ] 11. Run `pnpm typecheck` and `pnpm test`. Expect: both clean, task 2's suite still green.

- [ ] 12. **The no-change check.** With `pnpm dev` and the scratch repo from `plan.md`: open a
      session, open two files, switch between them and the chat, close one, close all. Expect:
      indistinguishable from `main` — one strip, one view area, chat where it has always been.

- [ ] 13. **The remount check.** Open a file, type an unsaved line, switch to the chat tab and back.
      Expect: the text is still there, the dirty dot still shows, and `⌘Z` still undoes the typing.

- [ ] 14. **The persistence check.** Open two files, leave the second one active, reload the browser.
      Expect: both tabs reopen with the second still active. Then restart the server and reload
      again: same. Confirm in a second browser tab that the session did **not** jump to the top of
      the sidebar.

- [ ] 15. **The stale-tab check.** With a file open, `rm` it from the scratch repo and reload.
      Expect: the session opens, that tab closes itself, no error toast, no empty view area.

- [ ] 16. **The gitignore check** — the regression guard for defect 2. In the scratch repo:
      `echo secret.txt > .gitignore && echo hi > secret.txt`. Open `secret.txt` through the file
      tree, then touch another file so the workspace index reloads. Expect: `secret.txt` stays open.

- [ ] 17. Commit:
      `git add web/src/components/EditorGroups.tsx web/src/components/ChatView.tsx web/src/components/FileView.tsx web/src/lib/api.ts web/src/store.ts`
      `git commit -m "refactor(editor): drive the editor area from the layout model"`

## Done when
The editor looks and behaves as it did before, but is driven by the layout model; the open tabs and
the active tab survive a reload and a server restart without reordering the sidebar; a file deleted
on disk closes its own tab; a gitignored file stays open; and switching tabs never costs an unsaved
edit.
