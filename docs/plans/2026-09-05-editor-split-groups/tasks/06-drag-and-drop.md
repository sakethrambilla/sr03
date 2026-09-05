# Task 6: Dragging a tab, with the drop overlay

**Depends on:** Task 5
**Files:**
- Modify: `web/src/components/EditorGroups.tsx`
- Modify: `web/src/components/ChatView.tsx`
- Modify: `SHORTCUTS.md`

**Interfaces:**
- Consumes: `dropTargetAt`, `moveTab`, `DropZone` and `DropAllow` from task 2. **This task adds no
  model logic** — if a rule seems to be missing, it belongs in `layout.ts` with a test, not here.
- Produces: drag state internal to `EditorGroups` —
  `{ tab: EditorTab; over: { group: number; zone: DropZone; before?: EditorTab } | null } | null`.

## Why pointer events, not HTML5 drag-and-drop

The native API cannot give a continuously updated overlay without fighting the browser's own drag
image, cannot be cancelled cleanly with `Esc` on every platform, and has inconsistent drop effects
inside Electron. The sash from task 4 already establishes the pointer-capture pattern; follow it.

## The Esc collision

`FileView`'s `Esc` handler is on `window` and closes the file
([FileView.tsx:397](../../../../web/src/components/FileView.tsx:397)). A drag's own `Esc` listener
would fire alongside it, so cancelling a drag would also close the file underneath. The drag's
listener must be registered in the **capture** phase and call both `stopPropagation()` and
`preventDefault()`.

## Steps

- [ ] 1. In `EditorTabs`, add `onPointerDown` to each tab. Do not start a drag immediately: record
      the origin and enter the drag only once the pointer has moved more than 4 px, so an ordinary
      click still selects the tab. Call `setPointerCapture` at that threshold.

- [ ] 2. While dragging, render the source tab at reduced opacity in its own strip, and follow the
      pointer with a small floating label carrying the tab's icon and name. Position it by writing
      a `transform` directly to the element's style on each `pointermove` — never React state, which
      would re-render every view on every frame of the gesture.

- [ ] 3. On each `pointermove`, find the group under the pointer from the grid children's bounding
      rects, then call
      `dropTargetAt(rect, x - rect.left, y - rect.top, { split: layout.groups.length < MAX_GROUPS, axis: layout.groups.length > 1 ? layout.axis : null })`.
      Passing the axis is what suppresses the cross-axis zones; passing only a boolean would let a
      top-edge hover preview a split that the model then refuses on release.

- [ ] 4. When the pointer is over a **strip** rather than a view, resolve to a `before` tab instead
      of a zone, and render a thin insertion indicator between tabs. That is what makes reordering
      within a strip the same gesture as a split.

- [ ] 5. Render the overlay as an absolutely positioned element inside the hovered group's view
      track: full-bleed for `"center"`, the corresponding half for each split zone. Use
      `bg-primary/15`, `border border-primary/60` and `rounded-lg`, with a short opacity transition
      so it appears rather than snaps. Tokens only — no raw hex, no one-off oklch.

- [ ] 6. On `pointerup`, call `commit(moveTab(layout, tab, target))`. A target the model rejects —
      a cross-axis split, a fourth group, a tab dropped on its own group's centre — returns the same
      layout, so do **not** special-case any of them here.

- [ ] 7. Cancel cleanly on `Esc` (capture phase, per the note above), on `pointercancel`, and on a
      `pointerup` outside every group: remove the overlay and the floating label and leave both the
      layout and the tab's position untouched. Register the `keydown` listener only for the duration
      of the drag and remove it in the same teardown as the pointer listeners.

- [ ] 8. Add an `Esc` row to the **Session view** table in `SHORTCUTS.md`: "Cancel a tab drag".

- [ ] 9. Run `pnpm typecheck` and `pnpm test`. Expect: both clean.

- [ ] 10. **The zone check**, with `pnpm dev` and the scratch repo. Open two files. Drag one and,
      without releasing, move slowly across a group:
      - middle → the overlay covers the whole group;
      - within ~10% of the left edge → the left half; right edge → the right half;
      - top edge, middle third horizontally → the top half; bottom edge, middle third → bottom half.
      Release on the right edge. Expect: two groups, horizontal, the dragged file alone on the right.

- [ ] 11. **The axis-lock check** — spec criterion 3. With that horizontal split open, drag the other
      file to the top edge of either group. Expect: **no half-overlay appears at all** — the
      whole-group overlay instead — and releasing creates no third group above or below.

- [ ] 12. **The cap check** — criterion 4. Split to three groups, then drag a tab to any edge.
      Expect: whole-group overlays everywhere, no split preview on any edge of any group.

- [ ] 13. **The reorder check.** Drag a tab sideways onto another position in the same strip.
      Expect: an insertion indicator, and on release the tab has moved within that strip with the
      group count unchanged.

- [ ] 14. **The chat check** — criterion 5. Drag the chat tab to the right edge. Expect: it splits
      out like any other tab and the transcript renders in the new group. Drag it back onto the
      first group's middle: it merges back, leaving no empty group.

- [ ] 15. **The cancel check** — criterion 11. Start a drag and press `Esc` mid-gesture. Expect:
      overlay and floating label gone, layout unchanged, tab still in its original strip, **and the
      file underneath still open** — that last part is the collision guard. Repeat, releasing over
      the sidebar instead: same result.

- [ ] 16. **The unsaved-edit check, again.** Type into a file without saving, then drag its tab into
      the other group. Expect: the text survives, the dirty dot stays, `⌘Z` still works. Same
      failure mode as task 3 step 13, reached by a different path.

- [ ] 17. Commit:
      `git add web/src/components/EditorGroups.tsx web/src/components/ChatView.tsx SHORTCUTS.md`
      `git commit -m "feat(editor): drag tabs to split the editor area"`

## Done when
Dragging any tab previews a drop target matching VS Code's zones, releasing performs the split,
merge or reorder it previewed, the axis lock and the three-group cap suppress the preview rather
than failing on release, `Esc` and out-of-bounds releases cancel without touching the file
underneath, and no drag has cost an unsaved edit.
