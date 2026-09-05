# Editor split groups — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch:** `feat/editor-split-groups`
**Test command:** `pnpm test`
**Lint / typecheck:** `pnpm typecheck`
**Manual harness:** a scratch repo, never a real project —
`mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main && echo hello > README.md && git add . && git commit -qm init`

## Approach

The editor area becomes a **flat list of one to three groups plus an axis**, not a tree. That is
the whole reason this stays small: a group is `{ id, tabs, active }`, the layout is
`{ axis, groups, sizes }`, and every operation is a list operation. VS Code's recursive grid buys
nesting the spec explicitly rules out.

The load-bearing decision is how groups get onto the screen. `FileView` keeps its edited text in an
**uncontrolled textarea plus a `source` ref** ([FileView.tsx:243](../../../web/src/components/FileView.tsx:243)),
so a remount silently destroys unsaved work and the browser's undo stack. Rendering each group's
views inside a per-group container would remount every view whose tab moved between groups. So the
editor area is **one CSS grid**: every tab strip and every view stays a direct child of the same
grid, in one stable flat list keyed by tab, and belonging to a group is expressed purely as a
`gridColumn` / `gridRow` style. Moving a tab between groups changes a style string and nothing else —
the React tree position never moves, so nothing remounts. Sashes are grid children in the gap tracks.

Persistence is a `layout` TEXT column on `threads` and a **dedicated `PATCH /api/threads/:id/layout`
route**, not the existing thread PATCH. The existing one runs inside `withThreadOperation`, queues
behind a running turn, and 409s through `agents.canOperate` when the thread is live in another sr03
instance — all correct for model and permission changes, all wrong for "the user dragged a tab".

Splitting arrives in stages: the grid replaces the current tab strip while still holding a single
group, then `⌘\` makes a second group so the sashes and the persistence round trip can be verified
without any drag code, then chat joins the model, and the drag gesture arrives last as a second way
to drive it. Each stage is a working app.

A stale tab — a file deleted since the layout was stored — is closed by the view that fails to load
it, not by intersecting the layout against a file list. `filesByCwd` comes from
`git ls-files --cached --others --exclude-standard`, so any list-based prune would silently close
gitignored files that are legitimately open today.

## Global constraints

- **No new dependencies, runtime or dev.** Drag, overlays and sashes are hand-built. Tests use
  `node:test` with `--experimental-strip-types`, which is already how the server tests run.
- **Nothing may remount on a tab move.** Any approach that re-parents a `FileView` in the React
  tree is wrong. Verify by typing into a file, moving its tab, and confirming the text survives.
- **Never write `updated_at` when saving a layout.** `threadsList` is `ORDER BY updated_at DESC`
  ([db.ts:280](../../../server/src/db.ts:280)), so reusing `threads.update` would jump the session
  to the top of the sidebar on every drag.
- Server TS is type-stripped: no enums, no parameter properties, explicit `.ts` imports.
- Wire types live in `server/src/types.ts` and are mirrored in `web/src/lib/types.ts` — change both
  in the same commit.
- UI comes from shadcn/ui and icons from `lucide-react` via `components/ui.tsx`. No hand-drawn SVG,
  no text characters standing in for icons.
- Colors are the shadcn token set only. The drop overlay uses `primary` at reduced opacity — no
  one-off oklch, no raw hex.
- Radii: `rounded-md` interactive, `rounded-lg` panels, `rounded-full` only for dots.
- Every shortcut added or changed gets its row in `SHORTCUTS.md` in the same commit.

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/types.ts` | Modify | `EditorLayout`, `EditorGroup`, `LayoutAxis`; `layout` on `Thread` |
| `server/src/layout.ts` | Create | `parseLayout` / `isLayout` — the API boundary's shape guard |
| `server/src/layout.test.ts` | Create | Guard tests: shape, group cap, axis, duplicate tabs, chat count |
| `server/package.json` | Modify | Test glob widened to `src/*.test.ts src/agents/*.test.ts` |
| `server/src/db.ts` | Modify | `layout` column + migration, parse in `toThread`, `threads.setLayout` |
| `server/src/api.ts` | Modify | `PATCH /api/threads/:id/layout`, outside `withThreadOperation` |
| `web/src/lib/types.ts` | Modify | Mirror of the three layout types and the `Thread` field |
| `web/src/lib/layout.ts` | Create | The client model: split, move, close, reorder, normalize, `dropTargetAt` |
| `web/tsconfig.json` | Modify | `"node"` added to `types`, so the new test file typechecks |
| `web/package.json` | Modify | `test` script — `node --experimental-strip-types --test src/lib/*.test.ts` |
| `web/src/lib/layout.test.ts` | Create | Unit tests for every model operation and the drop geometry |
| `package.json` | Modify | Root `test` runs the server's and the web's |
| `web/src/lib/api.ts` | Modify | `setThreadLayout(id, layout)` |
| `web/src/store.ts` | Modify | `setLayout` action, trailing-edge coalesced write |
| `web/src/components/EditorGroups.tsx` | Create | Grid shell, per-group tab strips, sashes, drop overlay |
| `web/src/components/ChatView.tsx` | Modify | Owns layout state; renders the flat child list into the grid |
| `web/src/components/ui.tsx` | Modify | `SplitIcon` / `SplitDownIcon` lucide aliases |
| `web/src/components/FileView.tsx` | Modify | `active` gated on the focused group; report a missing file |
| `SHORTCUTS.md` | Modify | `⌘\`, `⌘K ←/→`, the retargeted `⌘W`, and `Esc` cancelling a drag |
| `CLAUDE.md` | Modify | One line each for `lib/layout.ts` and `EditorGroups.tsx` in Layout |

## Tasks

1. [tasks/01-server-layout-persistence.md](tasks/01-server-layout-persistence.md) — column, guard, route; no client change **(done — c2e0ae4, e280c84)**
2. [tasks/02-client-layout-model.md](tasks/02-client-layout-model.md) — the pure model and drop geometry, with tests
3. [tasks/03-editor-grid.md](tasks/03-editor-grid.md) — the grid and sashes, driven only by existing open/close
4. [tasks/04-group-focus-and-shortcuts.md](tasks/04-group-focus-and-shortcuts.md) — focus, `⌘\`, `⌘K ←/→`, retargeted `⌘W`
5. [tasks/05-chat-as-a-tab.md](tasks/05-chat-as-a-tab.md) — chat becomes movable, still unclosable
6. [tasks/06-drag-and-drop.md](tasks/06-drag-and-drop.md) — the drag gesture, overlay preview, reorder

Tasks 1 and 2 are independent of each other and of the UI; 3 depends on both; 4 depends on 3; 5 and
6 are each independently revertable on top of 4. Task 3 deliberately ships a grid that can only ever
hold one group — task 4 is the first that can create a second one.

## Risks

- **Remount-on-move is the one that will actually bite.** If the grid is built with per-group
  wrapper elements out of habit, everything will look right and unsaved edits will vanish on a
  drag. Task 3 step 12 tests exactly this, before any drag code exists.
- **Grid track math with sashes.** Three groups on one axis means five tracks (group, sash, group,
  sash, group). Getting `gridColumn` indices off by one puts a view under a sash. The model returns
  track indices rather than letting the component compute them, and they are unit-tested in task 2.
- **`⌘\` in the browser.** Chrome does not claim it, but `⌘K` chords and `⌘W` already behave
  differently under `pnpm dev` than in the packaged app. Verify shortcuts in the desktop build if
  they misbehave in a tab; this is a known, documented split in `SHORTCUTS.md`.
- **Layout writes during a running turn.** Every layout change publishes `thread.updated` to all
  sockets. Coalescing the write to drag-end keeps this to one event per gesture; without it a sash
  drag would emit an event per pointer move.
- **A stored layout wider than the window.** Sizes are fractions, so this reduces to a minimum-size
  clamp rather than a reconstruction problem. The clamp lives in the model's `resize` and
  `normalize` (task 2, with tests), not only in the sash's drag handler — otherwise a fraction
  stored below the minimum survives a reload.
- **Two views answering the same keystroke.** `FileView` registers its `⌘S` / `⌘⇧V` / `Esc`
  handlers on `window`, gated only on its `active` prop. With two groups open, two views would be
  `active` at once and every one of those keys would double-fire. Task 4 gates `active` on the
  focused group; task 6's drag `Esc` must additionally listen in the capture phase and stop
  propagation, or cancelling a drag also closes the file underneath it.
