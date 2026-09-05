# Task 4: Second and third groups — focus, sashes, and the split shortcuts

**Depends on:** Task 3
**Files:**
- Modify: `web/src/components/EditorGroups.tsx`
- Modify: `web/src/components/ChatView.tsx`
- Modify: `web/src/components/FileView.tsx`
- Modify: `web/src/components/ui.tsx`
- Modify: `SHORTCUTS.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `moveTab`, `resize`, `trackOf`, `trackTemplate`, `MIN_FRACTION` from task 2, and
  `EditorGroups` / `commit` from task 3.
- Adds to `EditorGroups`' props: `onResize: (sashIndex: number, fractions: [number, number]) => void`.
- No new exports elsewhere.

This is the first task in which more than one group can exist, so it is also the first that can
verify a sash.

## The double-fire trap

`FileView` registers its `⌘S`, `⌘⇧V` and `Esc` handlers on `window`, gated only on its `active`
prop ([FileView.tsx:383](../../../../web/src/components/FileView.tsx:383)). Once two groups are on
screen, two views are each their own group's active tab — so without a change, `⌘S` saves both,
`⌘⇧V` toggles preview in both, and `Esc` closes both. `active` must mean "active **and** in the
focused group". If `FileView` needs the old meaning for rendering, add a separate `visible` prop
rather than widening `active`.

## Steps

- [ ] 1. In `web/src/components/ui.tsx`, add the split icons. This is a three-part edit, matching
      how the file already works: import `SquareSplitHorizontal` and `SquareSplitVertical` from
      `lucide-react`, add them to the `ICONS` map at
      [ui.tsx:216](../../../../web/src/components/ui.tsx:216), then export
      `SplitIcon` and `SplitDownIcon` through the same `icon(...)` wrapper the neighbours use.

- [ ] 2. In `ChatView`, pass `focused` and `setFocused` to `EditorGroups`, and change the `FileView`
      props from `active={isActiveInGroup}` to
      `active={isActiveInGroup && groupIndex === focused}` plus `visible={isActiveInGroup}`.

- [ ] 3. In `FileView`, take the new `visible` prop and use it for anything that is about being on
      screen (the reveal/scroll effects), keeping `active` for the keyboard handlers only. If
      nothing needs `visible`, do not add it — say so instead of adding an unused prop.

- [ ] 4. In `EditorGroups`, render one sash per gap track, `role="separator"` with an
      `aria-orientation` matching the axis. Follow the pointer-capture pattern in
      [TerminalPanel.tsx:248](../../../../web/src/components/TerminalPanel.tsx:248): capture the
      pointer, listen for `pointermove` on `window`, and register `pointercancel` alongside
      `pointerup` so a cancelled pointer cannot leave the handler resizing forever.
      During the drag write the fractions straight to the grid container's `style` — not React
      state, which would re-render every view on each frame. On `pointerup` call `onResize` once.

- [ ] 5. Clamp the drag so neither adjacent group falls below `MIN_FRACTION` of the container, and
      make double-clicking a sash restore equal fractions across all groups.

- [ ] 6. In `ChatView`, wire `onResize` to `commit(resize(layout, sashIndex, fractions))`.

- [ ] 7. Add `⌘\` to the existing `keydown` effect: `commit(moveTab(layout, activeTabOfFocused,
      { group: focused, zone: layout.groups.length === 1 ? "right" : nextZone }))`, where the zone
      is `"right"` / `"down"` according to the session's axis, defaulting to `"right"` when there is
      no axis yet. With three groups already open the model returns the layout unchanged, so no
      guard is needed here — but confirm that is what happens rather than assuming it.

- [ ] 8. Add `⌘K ←` and `⌘K →` to the existing `⌘K` chord, moving `focused` by one and clamping at
      the ends. The chord already exists for `⌘K W`; extend it rather than adding a second one.

- [ ] 9. Retarget `⌘W` to close the focused group's active tab, and confirm `⌘K W` still closes
      every file tab across all groups. `⌘W` on a group whose active tab is chat does nothing.

- [ ] 10. Add rows to the **Session view** table in `SHORTCUTS.md` for `⌘\` and `⌘K ←/→`, and
      correct the `⌘W` row to say it closes the focused group's active file. In the **File editor**
      table, change the section note to say those shortcuts act on the focused group's file.

- [ ] 11. In `CLAUDE.md`, add one line each to the Layout section for `web/src/lib/layout.ts` and
      `web/src/components/EditorGroups.tsx`, matching the style of the neighbouring entries.

- [ ] 12. Run `pnpm typecheck` and `pnpm test`. Expect: both clean.

- [ ] 13. **The split check.** With `pnpm dev` and the scratch repo: open two files, `⌘\`. Expect:
      two groups side by side, the active tab moved into the right-hand one, each group with its own
      strip. `⌘\` again with a file focused: three groups. `⌘\` a third time: nothing changes.

- [ ] 14. **The sash check.** Drag the sash between two groups. Expect: they resize together, the
      drag is smooth, and neither collapses past roughly 15% of the width. Double-click it: equal
      thirds. Reload: the proportions you dragged to are still there.

- [ ] 15. **The double-fire check.** Open a different file in each of two groups and type an unsaved
      change into both. Focus the left group and press `⌘S`. Expect: **only** the left file is
      saved — the right one still shows its dirty dot. Then press `Esc`: only the left file closes.

- [ ] 16. **The focus check.** With two groups open, `⌘K →`, then `⌘W`. Expect: the tab that closes
      is the right-hand group's, not the left's. Then open a file from `⌘P`. Expect: it opens in the
      focused group — this is spec criterion 12.

- [ ] 17. **The collapse check.** Close the last tab in one group. Expect: the group disappears and
      the survivors expand. Close every file. Expect: one group, and the editor is again
      indistinguishable from before the feature.

- [ ] 18. Commit:
      `git add web/src/components/EditorGroups.tsx web/src/components/ChatView.tsx web/src/components/FileView.tsx web/src/components/ui.tsx SHORTCUTS.md CLAUDE.md`
      `git commit -m "feat(editor): split into groups with the keyboard"`

## Done when
`⌘\` creates a second and third group on one axis and refuses a fourth, sashes re-proportion with a
minimum that survives a reload, `⌘K ←/→` moves focus, `⌘W` and `⌘S` act only on the focused group,
and closing a group's last tab collapses it.
