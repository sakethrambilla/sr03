# Task 2: One menu for the panel, memoized row, flat projection

**Depends on:** Task 1
**Files:**
- Modify: `web/src/components/FileTree.tsx`

**Interfaces:**
- Consumes from `web/src/lib/filetree.ts`: `projectRows`, `dirtyAncestors`, `toggleSubtree`,
  `ancestors`, `INDENT`, and the `TreeRow` type
- Produces: no new exports; `FileTree`'s props are unchanged

## The problem being fixed

`FileTree.tsx:209` wraps every row in a Radix `ContextMenu`, and `FileTree.tsx:279` mounts a
`DropdownMenu` inside every row, alongside four `RowAction` buttons hidden only by CSS
(`hidden … group-hover/row:flex` — present in the DOM, not conditionally rendered). A tree with
800 visible rows carries 1,600 Radix roots and roughly 3,200 always-mounted buttons, and because
`Row` is not memoized, all of them re-render whenever any panel state changes.

## Two decisions the implementer must not re-litigate

**Use `DropdownMenu`, not `ContextMenu`, for the panel-level menu.** Radix's `ContextMenu.Root` is
deliberately uncontrolled — it has no `open` prop and opens only from its own Trigger's
`contextmenu` event, so it cannot be opened by setting state. `DropdownMenu.Root` takes
`open` / `onOpenChange` and can be anchored to a zero-size positioned trigger. `RowMenuItems`
already parameterises `Item` and `Separator` for exactly this reason, so it is reused as-is with
`DropdownMenuItem` / `DropdownMenuSeparator`.

**File rows lose their hover `…` button and gain nothing.** Today every row has a dropdown but
only directory rows have the four `RowAction` buttons (`FileTree.tsx:263-275` gates all four on
`entry.isDir`). After this task, file rows have no hover affordance at all and their actions —
rename, delete, copy path, reveal — are right-click only. That is a real affordance regression and
is accepted deliberately: the alternative is keeping a Radix root per row, which is the thing this
task exists to remove. Directory rows keep their four buttons.

## Steps

- [ ] 1. Capture the baseline. Start `pnpm dev`, open a session on the fixture repo below, expand
      several folders, and run in the browser console — note the selector is scoped to the files
      panel, because `Sidebar.tsx` is also an `<aside>` and has its own dropdown triggers:
      ```js
      const panel = [...document.querySelectorAll('aside')].find(el => el.querySelector('h2')?.textContent === 'Files');
      panel.querySelectorAll('[data-slot="context-menu-trigger"], [data-slot="dropdown-menu-trigger"]').length
      ```
      Record the number in `progress.md`. It should be roughly twice the visible row count.

      Fixture repo, if you do not already have a large one — build it once and reuse it for
      Tasks 2, 3 and 5:
      ```bash
      mkdir -p /tmp/sr03-big && cd /tmp/sr03-big && git init -q -b main
      for d in $(seq 1 40); do mkdir -p "pkg$d/src"; for f in $(seq 1 40); do echo "export const v$f = $f;" > "pkg$d/src/m$f.ts"; done; done
      printf 'pkg39/\npkg40/\n' > .gitignore && git add -A && git commit -qm init
      ```
      That is 1,600 files across 40 folders, with two folders gitignored.

- [ ] 2. Replace the recursive `rows(path, depth)` (`FileTree.tsx:577`) with a flat projection:
      `const rows = useMemo(() => projectRows(dirs, expanded), [dirs, expanded])`.

- [ ] 2b. Update the render call site. `FileTree.tsx:675` currently calls `{rows("", 0)}`; it
      becomes `{rows.map((row) => …)}` returning one `<Row>` per entry. The inline create row is
      rendered by checking `creating?.parent` against each row's entry path during the map, plus one
      check before the loop for `creating.parent === ""`. Task 3 replaces this indexing with a
      single accessor — do not invest in it beyond making it work.

- [ ] 3. Replace `hasChangesUnder` (`FileTree.tsx:571`) with
      `const dirtyDirs = useMemo(() => dirtyAncestors(changes.keys()), [changes])`. Delete the
      old function. At the row call site (`FileTree.tsx:598`) pass
      `dirty={entry.isDir && dirtyDirs.has(entry.path)}`. Use the name `dirtyDirs` throughout —
      do not introduce a second name for the same value.

- [ ] 4. Delete the three now-duplicated module locals and use Task 1's versions instead, or
      `pnpm -C web typecheck` will fail: `web/tsconfig.json:10` sets `"noUnusedLocals": true`.
      - `function ancestors` (`FileTree.tsx:56`) — its only caller is the auto-expand effect at
        `:477`; import `ancestors` from the lib instead
      - `const INDENT = 12` (`FileTree.tsx:62`) — `Guides` at `:64` is its only consumer; import it
      - `const toggleSubtree` (`FileTree.tsx:558`) — **rename the component wrapper to
        `toggleSubtreeAt`** and have it call `setExpanded((current) => toggleSubtree(current, dirs, dir))`.
        Keeping the wrapper's old name would shadow the import inside `FileTree`'s block scope, so
        the call would resolve to itself — a 1-argument local invoked with 3 — and `noUnusedLocals`
        would then flag the import. Update its one call site (`onToggleSubtree` at `FileTree.tsx:601`).
      Leave `const parentOf` (`FileTree.tsx:518`) alone — Task 6 replaces it, and removing it now
      leaves `commitRename` and `confirmDelete` without a caller for it.

- [ ] 5. Add panel-level menu state to `FileTree`:
      ```ts
      const [menu, setMenu] = useState<{ entry: TreeEntry; x: number; y: number } | null>(null);
      ```

- [ ] 6. Strip the menus out of `Row`. Remove `ContextMenu`, `ContextMenuTrigger`,
      `ContextMenuContent` and the whole per-row `DropdownMenu` block. Then remove the imports this
      orphans, or `noUnusedLocals` fails step 13: `ContextMenuItem` and `ContextMenuSeparator`
      (`FileTree.tsx:21-22`, used only at `:325-326`) and `DotsIcon` (`:31`, used only at `:286` —
      the panel-level trigger renders no icon). Add `memo` and `useMemo` to the `react` import at
      `:4`. `Row`'s `canReveal` prop also becomes unused once the menus leave — drop it from the
      props type and the call site; `RowMenuItems` still needs it at panel level. `Row` now returns the plain
      `<div className="group/row …">` it currently wraps. Add to that div:
      `onContextMenu={(event) => { event.preventDefault(); onOpenMenu(entry, event.clientX, event.clientY); }}`
      via a new `onOpenMenu` prop.

- [ ] 7. Preserve the mid-rename guard. `ContextMenuTrigger` currently carries
      `disabled={renaming}` (`FileTree.tsx:210`); without it, right-clicking a row while its
      rename input is open blurs the input and cancels the rename. Reproduce it by returning early
      from the new `onContextMenu` handler when `renaming` is true.

- [ ] 8. Render the hover strip conditionally rather than with `hidden` / `group-hover/row:flex`,
      so hidden buttons leave the DOM. Hold a `hovered` boolean in `Row`'s own `useState`, driven
      by `onMouseEnter` / `onMouseLeave` on the row div — row-local state so a hover re-renders one
      row, not the panel.

- [ ] 9. Render exactly one menu in `FileTree`'s returned tree, outside the scroll container:
      ```tsx
      <DropdownMenu modal={false} open={menu !== null} onOpenChange={(open) => { if (!open) setMenu(null); }}>
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          className="fixed size-0"
          style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
        />
        <DropdownMenuContent
          align="start"
          className="min-w-44"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {menu ? <RowMenuItems Item={DropdownMenuItem} Separator={DropdownMenuSeparator} entry={menu.entry} canReveal={canReveal} actions={menuActions} /> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      ```
      Keep **both** focus fixes the per-row menus carried, for the same reasons their comments give:
      `onCloseAutoFocus` (comment at `FileTree.tsx:320-321` — focus returning to the trigger blurs a
      rename input the moment it mounts) and `modal={false}` (comment at `:208` — a modal traps focus
      while the menu closes, so Rename's input never gets it). Carry both comments over.

- [ ] 10. Build `menuActions` at panel level. `RowMenuItems` requires an `actions: RowActions`
      object (`FileTree.tsx:99`) whose callbacks take no arguments, so it must be rebuilt for
      `menu.entry`:
      ```ts
      const menuActions = useMemo<RowActions>(() => ({
        onCreate: (kind) => menu && startCreate(menu.entry.path, kind),
        onReveal: () => menu && reveal(menu.entry.path),
        onCopy: (kind) => menu && copyPath(menu.entry.path, kind),
        onStartRename: () => menu && setRenaming(menu.entry.path),
        onDelete: () => menu && setPendingDelete(menu.entry),
      }), [menu]);
      ```

- [ ] 11. Give `Row` per-action props instead of an object. The inline `actions={{…}}` literal at
      `FileTree.tsx:608` is a fresh object every render and would defeat `memo` entirely. Replace it
      with individual `useCallback` props on `FileTree` that take the entry as their first
      argument — `onCreateIn(entry, kind)`, `onRevealEntry(entry)`, and so on — and have `Row` close
      over its own `entry` when calling them.

- [ ] 12. Wrap `Row` in `memo`. Confirm every remaining prop is a primitive, a stable `useCallback`,
      or a value that genuinely differs per row.

- [ ] 13. Run `pnpm -C web typecheck`. Expect: no output, exit 0. An error naming `ancestors`,
      `INDENT` or `toggleSubtree` as unused means step 4 was not completed.

- [ ] 14. Re-run the console snippet from step 1 against the same fixture and the same expanded
      folders. Expect: `1`.

- [ ] 15. Verify the menu by hand on `/tmp/sr03-repo`: right-click a file row opens the menu at the
      pointer; reveal, copy relative, copy absolute, rename and delete all work from it; right-click
      a folder row additionally offers New file / New folder; Escape closes it; right-clicking a
      row whose rename input is open does nothing and leaves the input focused.

- [ ] 16. Verify the row itself: hovering a folder row shows its four action buttons and each works;
      hovering a file row shows none, which is the accepted regression above; starting a rename from
      the menu lands focus in the input with the stem selected.

- [ ] 17. Verify spec criterion 5 — that typing in a rename input re-renders only that row. Open
      React DevTools, turn on **Profiler → Record why each component rendered**, start a recording,
      start a rename on a row in the `/tmp/sr03-big` fixture, type five characters, and stop.
      Expect: the committed renders name only `NameInput` (and its own `Row`) — no other `Row`
      appears in any commit. `NameInput` (defined at `FileTree.tsx:336`, its `useState` at `:347`)
      already owns its value locally, so
      this should hold once `memo` is in place; the point of the step is to prove it rather than
      assume it. If other rows appear, a prop is unstable — re-check step 11.

- [ ] 18. Commit:
      `git add web/src/components/FileTree.tsx`
      `git commit -m "perf(files): hoist the row menu to the panel and memoize rows"`

## Done when

The scoped console snippet returns `1`, `pnpm -C web typecheck` is clean with no unused-local
errors, every menu item and directory row action still works, a right-click during a rename is a
no-op, and the profiler shows no unrelated `Row` re-rendering while typing a rename.
