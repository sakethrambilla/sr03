# Task 3: Windowed rendering

**Depends on:** Task 1, Task 2
**Files:**
- Modify: `web/package.json`, `pnpm-lock.yaml`
- Modify: `web/src/components/FileTree.tsx`

**Interfaces:**
- Consumes from `web/src/lib/filetree.ts`: `ROW_HEIGHT`, `OVERSCAN`, and the `rows: TreeRow[]`
  projection Task 2 built
- Produces: no new exports

## The create-row indexing rule

The inline create row occupies a list position with no entry behind it, and getting this wrong is
the most likely way to break the task. Fix the rule once, here, and apply it identically in
`count`, `getItemKey`, and the render map:

```ts
// index of the create row within the virtual list, or -1
const creatingIndex = useMemo(() => {
  if (!creating) return -1;
  if (creating.parent === "") return 0;
  const parentAt = rows.findIndex((row) => row.entry.path === creating.parent);
  return parentAt === -1 ? -1 : parentAt + 1;
}, [creating, rows]);

const count = rows.length + (creatingIndex >= 0 ? 1 : 0);
const rowAt = (index: number): TreeRow | null => {
  if (index === creatingIndex) return null;                       // the create row
  return rows[creatingIndex >= 0 && index > creatingIndex ? index - 1 : index] ?? null;
};
```

`rowAt` is the single accessor. Nothing else may index `rows` directly inside the virtual map.

This replaces Task 2's approach of matching `creating?.parent` during the map — that worked for a
flat `.map` but cannot express a list position, which is what the virtualizer needs.

## Steps

- [ ] 1. Add the dependency: `pnpm -C web add @tanstack/react-virtual`.
      Confirm `git diff web/package.json` shows exactly one added line under `dependencies` and no
      other package changed.

- [ ] 2. Verify the fixed-height assumption before building on it. With the app running and a tree
      open, run in the console:
      ```js
      new Set([...document.querySelectorAll('.group\\/row')].map(el => el.getBoundingClientRect().height))
      ```
      (`group/row` appears only in `FileTree.tsx`, so this needs no panel scoping.)
      Expect: `Set(1) { 22 }`. If more than one height appears, stop — the fixed-size virtualizer
      below is invalid and this task needs `measureElement` instead. Record what you saw.

- [ ] 3. Add the scroll ref and the indexing helpers from the rule above to `FileTree`.

- [ ] 4. Build the virtualizer:
      ```ts
      const virtualizer = useVirtualizer({
        count,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: OVERSCAN,
        getItemKey: (index) => (index === creatingIndex ? "__new" : rowAt(index)?.entry.path ?? `__row_${index}`),
      });
      ```
      `getItemKey` is load-bearing: a path-keyed item carries its identity across refreshes, so a
      re-read returning the same entries does not remount the window.

- [ ] 5. Attach `ref={scrollRef}` to the existing scroll container — the
      `min-h-0 flex-1 overflow-auto py-1` div at the bottom of `FileTree`'s return. Keep its
      classes unchanged.
      Move the panel-level error `<p>` (`FileTree.tsx:674`) **out** of that container, into the
      header. Left inside, it sits above the virtualizer's spacer and offsets every item's
      index↔offset mapping by its own height whenever an error is showing.

- [ ] 6. Replace the flat `.map` inside it with a spacer div of
      `height: virtualizer.getTotalSize()` and `position: relative`, containing one absolutely
      positioned wrapper per virtual item:
      ```tsx
      <div
        key={item.key}
        data-index={item.index}
        className="absolute left-0 right-0"
        style={{ transform: `translateY(${item.start}px)` }}
      >
        {item.index === creatingIndex ? <NewEntryRow … /> : <Row … />}
      </div>
      ```
      `NewEntryRow`'s `depth` is the parent row's depth + 1, or 0 when `creating.parent === ""`.

- [ ] 7. Keep the inline create row on screen. In an effect keyed on `creatingIndex`, when it is
      `>= 0` call `virtualizer.scrollToIndex(creatingIndex, { align: "auto" })`. This is the only
      programmatic scroll in the task — do **not** add one for `openPath`. Scrolling on selection
      change would move the viewport on a non-scroll re-render, which spec criterion 11 forbids.

- [ ] 8. Run `pnpm -C web typecheck`. Expect: no output, exit 0.

- [ ] 9. Verify the window is bounded. Open the `/tmp/sr03-big` fixture from Task 2 step 1, expand
      every `pkg*/src` folder (use the panel's Expand-folder buttons or click through), then:
      ```js
      document.querySelectorAll('.group\\/row').length
      ```
      Expect: a number bounded by the visible row count plus about 40 — under 90 on a full-height
      panel — while the tree holds over 1,600 rows. It must not track the total.

- [ ] 10. Verify continuity by scrolling the full height of that tree: no blank bands, no rows that
      fail to paint, and a scrollbar thumb whose size stays constant.

- [ ] 11. Verify the create row on `/tmp/sr03-repo`: New file at the root puts the input at the top;
      New file inside a folder puts it directly under that folder's row; the input takes focus; Esc
      cancels and the row disappears; committing a name inserts the entry in sorted position.

- [ ] 12. Verify criterion 11 — that a re-render never moves the viewport. Scroll to the middle of
      the `/tmp/sr03-big` tree, then in the console:
      ```js
      const el = document.querySelector('aside .overflow-auto'); const before = el.scrollTop;
      ```
      Click three different files (each changes `openPath` and re-renders the panel), then read
      `el.scrollTop` again. Expect: identical to `before`. A non-zero delta means a programmatic
      scroll slipped in — re-check step 7.

- [ ] 12b. Verify nothing else regressed: clicking a file selects and opens it, expand/collapse does
      not move rows above the toggled folder, rename still works.

- [ ] 13. Commit:
      `git add web/package.json pnpm-lock.yaml web/src/components/FileTree.tsx`
      `git commit -m "perf(files): virtualize the file tree viewport"`

## Done when

A 1,600-row tree renders under ~90 rows, scrolling its full height shows no gaps, the create row
appears at the correct list position and takes focus, and no programmatic scroll fires on selection
change.
