# Plan: file tab ↔ explorer sync, and chat file links that resolve

Spec: `spec.md` in this folder. Three tasks, each independently shippable, in any order.

## What exploration found

- **Highlight already works.** `ChatView.tsx:386-388` computes `active` (the focused group's file
  tab) and passes it as `openPath` to `<FileTree>` (`ChatView.tsx:660`); `FileTree.tsx:922` sets
  `selected={row.entry.path === openPath}`. What's missing is expanding ancestors and scrolling —
  the tree is virtualized (`useVirtualizer`, `FileTree.tsx:751`), so the row isn't even mounted
  until it's scrolled to.
- **Link flow.** `Markdown.tsx` `useTarget()` first calls `links.resolve(text)` (the client file
  index, `lib/fileref.ts` `createFileIndex`, which already maps absolute paths from any checkout by
  tail-matching); on a miss it calls `links.locate(ref)` → `POST /api/threads/:id/locate`
  (`server/src/api.ts:986`) → `locateEntry` (`server/src/fsbrowse.ts:496`), which opens in-root
  files and already reveals out-of-root files in Finder. On ENOENT the route throws
  `HttpError(404, "File not found")`, which `ChatView.tsx:470` shows as the error — that's the
  "file not found" the user sees.
- **Why real files miss:**
  1. `splitRef` never percent-decodes, so `a%20b.ts` is looked up literally.
  2. `splitRef` keeps a `file://` prefix; worse, `Markdown.tsx`'s `SCHEME` treats `file:` as an
     external URL and renders a plain `<a target=_blank>`.
  3. Ranges `#L42-L50` and `:42-50` don't match `ANCHOR` / `LINE_SUFFIX`, so the suffix stays on
     the path.
  4. The markdown link regex `\(([^)\s]+)\)` rejects any href with a space, including the
     CommonMark `[x](<a b.ts>)` form, so those never become links at all.
  5. `locateEntry` resolves only against `thread.cwd`; a gitignored file named by its main-checkout
     path while the thread is in a worktree goes to Finder instead of opening.

## File map

| File | Change |
|------|--------|
| `web/src/components/FileTree.tsx` | effect: on `openPath` change, add its ancestors to `expanded` and scroll its row into view |
| `web/src/lib/fileref.ts` | `splitRef` decodes `%xx`, strips `file://`, accepts line ranges |
| `web/src/lib/fileref.test.ts` | **new** — unit tests for `splitRef` and `resolve` |
| `web/src/components/Markdown.tsx` | link regex accepts `<...>` hrefs; `file:` hrefs go through `useTarget` |
| `server/src/fsbrowse.ts` | `locateEntry` takes the project checkout and maps checkout paths into the worktree |
| `server/src/fsbrowse.test.ts` | tests for `locateEntry` |
| `server/src/api.ts` | locate route passes the project path; 404 names the path tried |

Commands: `pnpm -C web test`, `pnpm -C server test`, `pnpm typecheck` (all from repo root).

---

## Task 1 — Explorer reveals the active tab

**Files:** `web/src/components/FileTree.tsx` (imports `ancestors` from `../lib/filetree.ts`, which
already exists: `ancestors("a/b/c.ts")` → `["a", "a/b"]`).

1. Add `ancestors` to the existing import from `../lib/filetree.ts` at the top of `FileTree.tsx`.
2. After the auto-expand effect (ends near line 584), add an effect keyed on `[openPath]` that, when
   `openPath` is non-null, calls `setExpanded` adding every entry of `ancestors(openPath)`; return
   `current` unchanged when nothing new was added (same idiom as the effect above it). Never remove
   entries.
3. Add a ref `revealRef = useRef<string | null>(null)`; set `revealRef.current = openPath` inside
   that same effect.
4. Below the `virtualizer` declaration (line ~751), add an effect keyed on `[rows, virtualizer]`:
   if `revealRef.current` is set, find `const index = rows.findIndex((row) => row.entry.path ===
   revealRef.current)`; if `index >= 0`, call `virtualizer.scrollToIndex(index, { align: "auto" })`
   and clear `revealRef.current`. (Rows appear only after the ancestor directories load, so this
   has to wait on `rows`, not on `openPath`.)
5. Run `pnpm typecheck` — expected: exits 0, no errors.
6. Manual check in `pnpm dev` against `/tmp/sr03-repo` (see CLAUDE.md "Testing changes"; add a
   nested file `mkdir -p a/b && echo x > a/b/c.ts` and commit it):
   - collapse `a`, open `a/b/c.ts` via the search palette → `a` and `a/b` expand, `c.ts` row is
     highlighted and visible.
   - open `README.md`, then click the `c.ts` tab → only `c.ts` highlighted; `a`, `a/b` still open.
   - click the chat tab → no row highlighted.
7. Commit: `feat(web): reveal the active tab's file in the explorer`.

## Task 2 — Client-side link normalization

**Files:** `web/src/lib/fileref.ts`, new `web/src/lib/fileref.test.ts`,
`web/src/components/Markdown.tsx`.

1. Create `web/src/lib/fileref.test.ts` in the style of `web/src/lib/filetree.test.ts`
   (`node:test` + `node:assert/strict`, import with `.ts`). Cases:
   - `splitRef("src/a%20b.ts:42")` → `{ path: "src/a b.ts", line: 42 }`
   - `splitRef("file:///Users/x/repo/src/a.ts")` → `{ path: "/Users/x/repo/src/a.ts" }`
   - `splitRef("src/a.ts#L42-L50")` → `{ path: "src/a.ts", line: 42 }`
   - `splitRef("src/a.ts:42-50")` → `{ path: "src/a.ts", line: 42 }`
   - `splitRef("src/a.ts:42:7")` → `{ path: "src/a.ts", line: 42 }` (already passes; guards regression)
   - `splitRef("src/100%.ts")` → `{ path: "src/100%.ts" }` (malformed escape left as-is)
   - `createFileIndex(["src/a b.ts"]).resolve("/elsewhere/checkout/src/a%20b.ts#L3")` →
     `{ path: "src/a b.ts", line: 3 }`
2. Run `pnpm -C web test` — expected: the new range, `file://` and `%20` cases fail.
3. In `fileref.ts`: change `LINE_SUFFIX` to `/:(\d+)(?:[:-]\d+)?$/` and `ANCHOR` to
   `/#L(\d+)(?:-L?\d+)?$/`. At the top of `splitRef`, after trim/TRAILING, strip `/^file:\/\//i`
   and decode with `try { ref = decodeURIComponent(ref) } catch {}` (a bad escape keeps the raw
   text — write the `catch` with a one-line comment saying so).
4. Run `pnpm -C web test` — expected: all pass.
5. In `Markdown.tsx` `INLINE`, change the href group `\\(([^)\\s]+)\\)` to
   `\\((?:<([^>\\n]+)>|([^)\\s]+))\\)`, and in `inline()` destructure the two groups and use
   whichever is defined as `href` (shift the later group names `bare`, `path` by one).
6. In `LinkSpan`, treat `file:` as local: compute `const local = !SCHEME.test(href) ||
   /^file:/i.test(href)`, pass `local` as `useTarget`'s `loose`, and render the plain external
   `<a>` only when `!local`; a local href that resolves to nothing keeps rendering bare children.
7. Run `pnpm typecheck && pnpm -C web test` — expected: exit 0, all pass.
8. Manual: in a `/tmp/sr03-repo` thread, add `a b.ts`, ask the agent to reply with exactly
   ``[x](<a b.ts>) [y](a%20b.ts#L1) [z](file:///tmp/sr03-repo/README.md:1) `README.md:1-2` ``
   → each opens the file in a tab, no error toast.
9. Commit: `fix(web): resolve encoded, file:// and ranged chat file links`.

## Task 3 — Server locate: worktree mapping and a useful 404

**Files:** `server/src/fsbrowse.ts`, `server/src/fsbrowse.test.ts`, `server/src/api.ts`.

1. In `fsbrowse.test.ts`, add `locateEntry` to the dynamic import on line 8 and add tests (darwin
   Finder side effects are avoided by only testing the in-root and missing cases):
   - root `R/wt` containing `ignored.txt`, checkout `R/main`:
     `locateEntry(wt, path.join(main, "ignored.txt"), main)` → `{ path: "ignored.txt" }`
   - `locateEntry(wt, "nested/x.txt", main)` with that file in `wt` → `{ path: "nested/x.txt" }`
   - `locateEntry(wt, "nope.txt", main)` rejects with `{ code: "ENOENT", path: path.join(wt, "nope.txt") }`
2. Run `pnpm -C server test` — expected: the checkout-mapping test fails (third argument ignored,
   main/ignored.txt doesn't exist so it rejects ENOENT).
3. Change `locateEntry(root, ref)` to `locateEntry(root: string, ref: string, checkout: string)`.
   After computing `target`, if `checkout` resolves to something other than `base` and `target`
   starts with `path.resolve(checkout) + path.sep`, set `target` to the same relative path joined
   onto `base` *when that file exists* (`fs.stat` succeeds and `isFile()`); otherwise keep the
   original. Update the comment above the function to mention the checkout mapping.
4. In `api.ts` locate route (line ~986): pass `requireProject(thread.projectId).path` as the third
   argument, and change the 404 to `new HttpError(404, \`File not found: ${error.path ?? ref}\`)`
   where `ref` is the `requireString(body, "path")` value hoisted into a `const`.
5. Run `pnpm -C server test && pnpm typecheck` — expected: all pass, exit 0.
6. Manual: in a worktree thread on `/tmp/sr03-repo`, create a gitignored file in the main checkout
   *and* the worktree, have the agent link the main-checkout absolute path → it opens in a tab.
   Link `/tmp/sr03-repo/missing.txt` → error reads `File not found: /tmp/sr03-repo/missing.txt`.
   Link `/etc/hosts` → Finder reveals it, no tab opens.
7. Commit: `fix(server): map checkout paths into the worktree when locating links`.
