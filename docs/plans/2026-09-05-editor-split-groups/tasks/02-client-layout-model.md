# Task 2: The client layout model and drop geometry

**Depends on:** Task 1 (its types are already in `web/src/lib/types.ts` — import them, do not
redeclare)
**Files:**
- Create: `web/src/lib/layout.ts`
- Create: `web/src/lib/layout.test.ts`
- Modify: `web/package.json` (test script only)
- Modify: `web/tsconfig.json`
- Modify: `package.json` (root)

**Interfaces:** every function is pure — no React, no DOM, no imports outside `./types.ts`.

```ts
import type { EditorGroup, EditorLayout, EditorTab, LayoutAxis } from "./types.ts";

export const CHAT: EditorTab;                       // the single { kind: "chat" } value
export const MAX_GROUPS = 3;
export const MIN_FRACTION = 0.15;                   // a group may not be squeezed below this share

export type DropZone = "left" | "right" | "up" | "down" | "center";
export interface DropAllow { split: boolean; axis: LayoutAxis | null }

export function tabKey(tab: EditorTab): string;                    // React key + equality
export function sameTab(a: EditorTab, b: EditorTab): boolean;
export function singleGroup(tabs?: EditorTab[]): EditorLayout;
export function allTabs(layout: EditorLayout): EditorTab[];
export function groupOf(layout: EditorLayout, tab: EditorTab): number;   // -1 if absent
export function activeTab(group: EditorGroup): EditorTab;

export function openTab(layout: EditorLayout, tab: EditorTab, groupIndex: number): EditorLayout;
export function closeTab(layout: EditorLayout, tab: EditorTab): EditorLayout;
export function selectTab(layout: EditorLayout, groupIndex: number, tab: EditorTab): EditorLayout;
export function moveTab(
  layout: EditorLayout,
  tab: EditorTab,
  target: { group: number; zone: DropZone; before?: EditorTab },
): EditorLayout;
export function resize(layout: EditorLayout, sashIndex: number, fractions: [number, number]): EditorLayout;
export function normalize(layout: EditorLayout | null): EditorLayout;

export function trackTemplate(sizes: number[], axis: LayoutAxis): string;
export function trackOf(groupIndex: number, axis: LayoutAxis, part: "strip" | "view"): number;
export function dropTargetAt(
  rect: { width: number; height: number }, x: number, y: number, allow: DropAllow,
): DropZone;
```

### Three contracts that are easy to get wrong

**`normalize` repairs structure only. It never drops a tab for being absent from a file list.**
It caps at `MAX_GROUPS`, drops groups left with no tabs, re-fits `sizes` to `groups` and clamps each
to `MIN_FRACTION`, clamps every `active` into range, guarantees exactly one `CHAT` tab, and returns
`singleGroup([CHAT])` when handed `null` or something unusable. A file deleted since the layout was
stored is closed by the view that fails to load it (task 3), **not** here — `filesByCwd` is
`git ls-files --cached --others --exclude-standard` output, so pruning against it would silently
close gitignored files that are legitimately open today.

**`dropTargetAt` needs the axis, not just a boolean.** `allow.split === false` returns `"center"`
everywhere. Otherwise `allow.axis === "horizontal"` suppresses `"up"` and `"down"`, and
`"vertical"` suppresses `"left"` and `"right"`; a suppressed zone falls back to `"center"`. This is
what makes the spec's "no split preview across the locked axis" implementable at all — a boolean
cannot express it. `allow.axis === null` means the session has no axis yet, so every zone is live.

The geometry itself follows VS Code: an inner region inset by 10% of width and height on every side
is `"center"`; outside it, the left third is `"left"`, the right third is `"right"`, and the middle
third resolves to `"up"` or `"down"` by which half of the height the pointer is in. (VS Code's
`editorDropTarget.ts`, `positionOverlay` — the thirds mean a pointer near a corner resolves by
column before row, which is deliberate parity, not a bug.)

**The grid has two parts per group.** Horizontal: `2n - 1` columns — group, sash, group — and two
rows, a fixed strip row and a `1fr` view row. So `trackOf(i, "horizontal", "strip")` is the column
`2i + 1` and the caller places it in row 1; `"view"` is the same column in row 2. Vertical: one
column and `3n - 1` rows — strip, view, sash, strip, view — so `trackOf(i, "vertical", "strip")` is
`3i + 1` and `"view"` is `3i + 2`. `trackTemplate` returns the track list for whichever axis is
being sized; the cross-axis template is fixed and belongs in the component.

## Steps

- [ ] 1. In `web/package.json`, add
      `"test": "node --experimental-strip-types --test src/lib/*.test.ts"` to scripts.
      No dependency is added — Node 24 runs TypeScript through `--experimental-strip-types`, the
      same way the server tests already do. `"type": "module"` is already set, so no
      `MODULE_TYPELESS_PACKAGE_JSON` warning arises.

- [ ] 2. In `web/tsconfig.json`, add `"node"` to the `types` array, which currently holds only
      `"vite/client"`. Without it `pnpm -C web typecheck` fails with
      `error TS2307: Cannot find module 'node:test'`. Knock-on: with Node types loaded, a bare
      `setTimeout` types as `NodeJS.Timeout`, so any timer handle stored as a `number` must use
      `window.setTimeout` — which is what `ChatView.tsx:490` already does.

- [ ] 3. In the root `package.json`, change `test` to `"pnpm -C server test && pnpm -C web test"`.

- [ ] 4. Create `web/src/lib/layout.test.ts` with the full suite, before any implementation exists.
      Use `node:test` and `node:assert/strict`, in the style of `server/src/layout.test.ts`.
      Cover at minimum:

      *Identity and construction*
      - `tabKey` differs for `{kind:"chat"}` and `{kind:"file",path:"chat"}`; `sameTab` agrees.
      - `singleGroup()` returns one group holding only `CHAT`, `active` 0, `sizes` `[1]`.

      *Opening, selecting, closing*
      - `openTab` into group 1 of a two-group layout appends it and makes it active.
      - `openTab` for a tab already in group 0 activates it there, does not duplicate it, and does
        not move it to the requested group.
      - `selectTab` sets that group's `active` index and leaves other groups untouched.
      - `closeTab` on a group's last tab removes the group; `sizes` stays the same length as
        `groups` and the survivors stay proportional to each other.
      - `closeTab` adjusts a surviving `active` index that sat after the removed tab.
      - `closeTab` on the last file in a one-group layout leaves one group holding `CHAT`.
      - `closeTab(CHAT)` returns the layout unchanged — chat is never closable.

      *Moving and splitting*
      - `moveTab` zone `"right"` from a one-group layout gives two groups, axis `"horizontal"`,
        the moved tab alone in group 1, equal `sizes`.
      - `moveTab` zone `"down"` from a one-group layout gives axis `"vertical"`.
      - `moveTab` zone `"down"` on an already-`"horizontal"` layout returns it **unchanged**.
      - `moveTab` that would make a fourth group returns the layout unchanged.
      - `moveTab` zone `"center"` moves the tab into that group and leaves the group count alone.
      - `moveTab` with `before` reorders within one strip, group count unchanged.
      - `moveTab` of a group's only tab into another group removes the emptied group.
      - `moveTab` of a tab onto its own group's `"center"` is a no-op, not a duplicate.

      *Sizing*
      - `resize` on sash 0 of two groups sets both fractions and leaves the sum positive.
      - `resize` clamps below `MIN_FRACTION` rather than accepting it.
      - `groupOf` finds a tab by value, not reference, and returns -1 for an absent one.

      *Repair*
      - `normalize(null)` returns a single group holding `CHAT`.
      - `normalize` on a layout with no chat tab reinserts one into the first group.
      - `normalize` on a layout with two chat tabs keeps one.
      - `normalize` on four groups keeps the first three and re-fits `sizes`.
      - `normalize` on `sizes` shorter than `groups` re-fits to equal fractions.
      - `normalize` on a `sizes` entry below `MIN_FRACTION` raises it.
      - `normalize` on an out-of-range `active` clamps it into the group.
      - `normalize` **keeps** a file tab whose path is not in any workspace list — it has no such
        list, and this is the regression guard for the gitignore case.

      *Grid tracks*
      - `trackTemplate([1,1], "horizontal")` is `"1fr 1px 1fr"`.
      - `trackOf(0,"horizontal","strip")` is 1, `trackOf(1,"horizontal","strip")` is 3,
        `trackOf(2,"horizontal","view")` is 5.
      - `trackOf(0,"vertical","strip")` is 1, `trackOf(0,"vertical","view")` is 2,
        `trackOf(1,"vertical","strip")` is 4, `trackOf(1,"vertical","view")` is 5.

      *Drop geometry* — `R = {width:1000,height:1000}`, `FREE = {split:true,axis:null}`
      - `dropTargetAt(R,500,500,FREE)` is `"center"`.
      - `dropTargetAt(R,20,500,FREE)` is `"left"`; `(R,980,500,FREE)` is `"right"`.
      - `dropTargetAt(R,500,20,FREE)` is `"up"`; `(R,500,980,FREE)` is `"down"`.
      - `dropTargetAt(R,20,500,{split:false,axis:null})` is `"center"`.
      - `dropTargetAt(R,500,20,{split:true,axis:"horizontal"})` is `"center"` — the axis lock.
      - `dropTargetAt(R,20,500,{split:true,axis:"vertical"})` is `"center"`.
      - `dropTargetAt(R,20,500,{split:true,axis:"horizontal"})` is still `"left"`.

- [ ] 5. Run `pnpm -C web test`.
      Expect: FAIL — `Cannot find module './layout.ts'`. If it instead reports zero tests found, the
      glob in step 1 is wrong; fix that before writing any implementation.

- [ ] 6. Create `web/src/lib/layout.ts` and implement until `pnpm -C web test` passes.
      Every function returns a new object — the store and React both rely on identity changing.
      Group ids come from `crypto.randomUUID()`, never derived from an index, since indices shift.
      (`randomUUID` needs a secure context: fine on `localhost` and the desktop shell's `127.0.0.1`,
      absent over plain-http LAN access, which sr03 does not support.)

- [ ] 7. Run `pnpm test` from the root. Expect: PASS — server and web suites, no skips.

- [ ] 8. Run `pnpm typecheck`. Expect: both packages clean. If web fails on `node:test`, step 2 was
      skipped.

- [ ] 9. Commit:
      `git add web/src/lib/layout.ts web/src/lib/layout.test.ts web/package.json web/tsconfig.json package.json`
      `git commit -m "feat(web): add the editor layout model and drop geometry"`

## Done when
`pnpm test` runs both packages' suites and all pass, the model enforces the three-group cap, the
axis lock and the minimum fraction, `normalize` never drops a tab for absence, and `dropTargetAt`
suppresses cross-axis zones. Nothing renders differently yet.
