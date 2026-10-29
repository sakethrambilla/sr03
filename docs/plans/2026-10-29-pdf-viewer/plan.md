# PDF viewer — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch / worktree:** `ai/pdf-viewer-feature-0e2469` (worktree `.claude/worktrees/pdf-viewer-feature-0e2469`)
**Test command:** `pnpm test` (server: `pnpm -C server test`)
**Lint / typecheck:** `pnpm typecheck`

## Approach
Mirror the video path. The server gets a `/api/threads/:id/pdf` route that streams the file with
`application/pdf`, reusing `videoRange` so pdf.js can fetch byte ranges. The web gets a
`PdfView` component, which `FileView` picks for `.pdf` the same way it picks `VideoView` for video. `PdfView`
dynamically imports `pdfjs-dist` (like `Mermaid.tsx` does `mermaid`), sets the worker from a
Vite `?url` asset so it loads same-origin, and renders one `<canvas>` per page. Each canvas is
rasterised only once an `IntersectionObserver` says it is near the viewport. The re-render on change
reuses `FileView`'s existing `fsTick` + `reloads` counters as a `version` prop, the same as video.

## Global constraints
- Server: Node built-ins only, `.ts` import extensions, no enums/parameter properties (`erasableSyntaxOnly`).
- Web: shadcn components (`@/components/ui/button` etc.), icons only via `components/ui.tsx` aliases, token colour classes only (`bg-card`, `text-muted-foreground`, `text-destructive`), `rounded-md` interactive / `rounded-lg` panels.
- Zustand selectors never return a fresh object/array.
- `pdfjs-dist` only reachable through a dynamic `import()`. No static import anywhere.
- Don't edit `components/ui/*`.
- Comments: one-liners, only where the code can't speak for itself.
- Commits: single-line Conventional Commits, author email `sakethrambilla@gmail.com`.

## File map
| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/fsbrowse.ts` (after `statWorkspaceVideo`, ~L255) | Modify | `statWorkspacePdf(root, rel)` — containment + `.pdf` check + size |
| `server/src/fsbrowse.test.ts` | Modify | Test for `statWorkspacePdf` |
| `server/src/api.ts` (next to the `/video` route, ~L946) | Modify | `GET /api/threads/:id/pdf` ranged stream |
| `web/package.json` | Modify | add `pdfjs-dist` dependency |
| `web/src/components/PdfView.tsx` | Create | load doc, lazy page canvases, page indicator, zoom, error card |
| `web/src/components/FileView.tsx` | Modify | `PDF` regex, skip `api.file` for pdf, render `PdfView`, reload button, header comment L1-3 |
| `web/src/components/ui.tsx` (`ICONS` ~L231, exports ~L343) | Modify | `FitWidthIcon` alias (lucide `MoveHorizontal`) |
| `CLAUDE.md` (Conventions, preview-libraries bullet) | Modify | name `pdfjs-dist` with mermaid/excalidraw |

## Tasks

### Task 1: Server PDF endpoint
**Depends on:** nothing
**Interfaces produced:** `GET /api/threads/:threadId/pdf?path=<rel>&v=<any>` → 200/206 `content-type: application/pdf`, `accept-ranges: bytes`; 404 for a missing, non-pdf or out-of-root path.

- [ ] 1. In `server/src/fsbrowse.test.ts`, import `statWorkspacePdf` alongside `statWorkspaceVideo` (L9) and add, modelled on the "workspace video stat" test (L46-55):
  `test("workspace pdf stat checks type and containment", …)` — write `a.pdf` (10 bytes) and `notes.txt` into `root`, assert `size === 10`, `type === "application/pdf"`, that `notes.txt` rejects `/not a pdf/`, and that `../x.pdf` rejects `/outside the session folder/`.
- [ ] 2. Run `pnpm -C server test`. Expect FAIL: `statWorkspacePdf is not a function` (or a SyntaxError naming the missing export). Any other failure → stop.
- [ ] 3. In `server/src/fsbrowse.ts` after `statWorkspaceVideo`, add:
  ```ts
  export async function statWorkspacePdf(root: string, rel: string): Promise<{ path: string; size: number; type: string }> {
    const target = safeJoin(root, rel);
    if (path.extname(target).toLowerCase() !== ".pdf") throw new Error("That path is not a pdf");
    const stats = await fs.stat(target);
    if (!stats.isFile()) throw new Error("That path is not a file");
    return { path: target, size: stats.size, type: "application/pdf" };
  }
  ```
- [ ] 4. Run `pnpm -C server test`. Expect PASS including the new test.
- [ ] 5. In `server/src/api.ts`, add `statWorkspacePdf` to the `./fsbrowse.ts` import (L32 area), then extract the body of the `/video` route handler into a local `async function streamRanged(file: { path: string; size: number; type: string }, request, response)` placed above the routes table. Make `/video` call it, and add a sibling route `pattern: /^\/api\/threads\/([^/]+)\/pdf$/` that resolves via `statWorkspacePdf(...).catch(e => { throw new HttpError(404, e.message) })` and calls the same function. Keep the existing `// the player aborts ranges…` comment on the pipeline line, reworded to "a viewer aborts ranges on every seek; …".
- [ ] 6. Run `pnpm typecheck`. Expect exit 0.
- [ ] 7. Manual: `pnpm dev`, add `/tmp/sr03-repo` as a project (scratch repo per CLAUDE.md "Testing changes"), copy any PDF to `/tmp/sr03-repo/sample.pdf`, then `curl -sI "http://127.0.0.1:3399/api/threads/<threadId>/pdf?path=sample.pdf"`. Expect `HTTP/1.1 200` and `content-type: application/pdf`. Same with `?path=README.md` → `404`.
- [ ] 8. Commit: `feat(server): serve workspace pdfs with byte ranges`.

**Done when:** spec criterion 10's endpoint half holds; server tests green.

### Task 2: PdfView renders every page
**Depends on:** Task 1
**Interfaces:** `export function PdfView({ threadId, path, version, onMissing }: { threadId: string; path: string; version: string; onMissing: (path: string) => void })`

- [ ] 1. `cd web && pnpm add pdfjs-dist@^5`. Confirm `web/package.json` lists it.
- [ ] 2. Create `web/src/components/PdfView.tsx` with a one-line header comment ("A pdf file tab: pdf.js pages on canvases, rasterised as they near the viewport."). A module-level loader, the same as `Mermaid.tsx` L16:
  ```ts
  let engine: Promise<typeof import("pdfjs-dist")> | undefined;
  function loadPdfjs() {
    engine ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
      ([pdfjs, worker]) => { pdfjs.GlobalWorkerOptions.workerSrc = worker.default; return pdfjs; },
    );
    return engine;
  }
  ```
  If `tsc` rejects the `?url` import, create `web/src/vite-env.d.ts` containing `/// <reference types="vite/client" />` (no such file exists today).
- [ ] 3. In the component, keep state `doc: PDFDocumentProxy | null` and `error: string | null`. Use an effect on `[threadId, path, version]`: `loadPdfjs()` → `getDocument({ url: \`/api/threads/${threadId}/pdf?path=${encodeURIComponent(path)}&v=${version}\` }).promise`. On success, set `doc` (destroying the previous doc). On rejection, if `cause.status === 404` or `cause.name === "MissingPDFException"`, call `onMissing(path)`. Otherwise set `error` to `"This PDF is password-protected."` when `cause.name === "PasswordException"`, else `"This file couldn't be read as a PDF."`. Set a cancelled flag in cleanup. Call `loadingTask.destroy()` on cleanup.
- [ ] 4. Render: an outer `div` `flex min-h-0 flex-1 flex-col`, then a scroller `min-h-0 flex-1 overflow-auto bg-card/40`, then a column `flex flex-col items-center gap-4 p-6`. Render one `PdfPage` child per `1..doc.numPages`. `PdfPage` gets `doc`, `pageNumber` and `scale` (a fixed `1.25` for now). It gets the page, sizes a `<canvas>` to `viewport.width * dpr` × `viewport.height * dpr` with CSS size `viewport.width`×`viewport.height`, and calls `page.render({ canvas, canvasContext, viewport, transform: dpr !== 1 ? [dpr,0,0,dpr,0,0] : undefined }).promise`. The canvas element gets class `rounded-md bg-white shadow-sm`; white is the paper, the one place a non-token colour is intended. Use `bg-white` and note it in a one-line comment. On `error`, render `<p className="px-4 py-6 text-[12px] text-destructive">{error}</p>` in place of the pages.
- [ ] 5. In `web/src/components/FileView.tsx`: add `const PDF = /\.pdf$/i;` beside `VIDEO` (L43); `const pdf = PDF.test(path);` beside `video` (L271); change `if (video) return;` (L295) to `if (video || pdf) return;` and add `pdf` to that effect's deps (L325). Add a branch `) : pdf ? ( <PdfView threadId={thread.id} path={path} version={`${fsTick}-${reloads}`} onMissing={onMissing} /> )` directly after the `video` branch (L570-571). Widen the html-only "Reload preview" button condition (L507) to `(html && preview) || pdf`. Update the file header comment (L3) to list pdf alongside video ("…and a player for video and pdf.").
- [ ] 6. Run `pnpm typecheck`. Expect exit 0.
- [ ] 7. Run `pnpm build`, then `grep -l "GlobalWorkerOptions" web/dist/assets/index-*.js`. Expect no match: pdf.js is in its own chunk (spec criterion 7). Then `ls web/dist/assets | grep -i "pdf.worker"`. Expect one file.
- [ ] 8. Manual (`pnpm dev`, scratch repo, a 3-page `sample.pdf`): open it from the file tree. Expect 3 sharp pages and no eye/preview toggle and no "unsaved" or save affordance (criterion 8). Write `echo garbage > /tmp/sr03-repo/bad.pdf`, then open it. Expect the error line and no uncaught error in the console (criterion 6).
- [ ] 9. In `CLAUDE.md` Conventions, extend the mermaid/excalidraw sentence to name `pdfjs-dist`, for example "The mermaid, excalidraw and pdf file previews are the other — `mermaid`, `@excalidraw/excalidraw` and `pdfjs-dist` on the web, all dynamically imported…". Also add `components/PdfView.tsx` to the Layout block under `SubagentView.tsx` with a one-line description.
- [ ] 10. Commit: `feat(web): render pdf files in their tab with pdf.js`.

**Done when:** criteria 1, 6, 7, 8 hold by the checks above.

### Task 3: Lazy pages, page indicator, zoom
**Depends on:** Task 2

- [ ] 1. In `PdfView`, after the doc loads, read page 1's `getViewport({ scale: 1 })`. Use it as the placeholder size for every page: each `PdfPage` renders a sized `div` until rasterised, so the scrollbar is right before anything draws.
- [ ] 2. In `PdfPage`, observe the wrapper with an `IntersectionObserver` rooted on the scroller, using `rootMargin: "800px 0px"`. Render only once it intersects, and re-render when `scale` changes while visible. Cancel an in-flight `renderTask` (`renderTask.cancel()`) on unmount or rescale, and ignore the resulting `RenderingCancelledException`.
- [ ] 3. Track the current page with a second `IntersectionObserver` using `threshold: [0.5]`. The page with the largest visible ratio wins. Hold it in state `current`.
- [ ] 4. Add a toolbar row above the scroller: `flex h-8 shrink-0 items-center gap-1 border-b border-border px-3`, containing `<span className="font-mono text-[11px] text-muted-foreground">{current} / {doc.numPages}</span>`, a flex spacer, and three `Button variant="ghost" size="icon" className="size-6 text-faint"`: zoom out (`ZoomOutIcon`, `scale / 1.25`, min 0.5), zoom in (`ZoomInIcon`, `scale * 1.25`, max 4), and fit width (`FitWidthIcon`, `scale = (scroller.clientWidth - 48) / page1Width`). Each has `aria-label` and `title`. Default `scale` is fit-width once the doc loads. In `components/ui.tsx`, add `FitWidthIcon: MoveHorizontal` to `ICONS` (and import `MoveHorizontal` from lucide-react), export `FitWidthIcon`. `ZoomInIcon` and `ZoomOutIcon` already exist (L343-344).
- [ ] 5. Run `pnpm typecheck`. Expect exit 0.
- [ ] 6. Manual: with a 3-page PDF, scroll until page 2 dominates. Expect "2 / 3" (criterion 2). Click zoom in: text stays crisp, not blurry (criterion 3). Click fit width: page edges sit ~24px from the panel sides. Open a 300-page PDF (e.g. generate with `for i in $(seq 300); do echo "page $i"; done | enscript -o - | ps2pdf - /tmp/sr03-repo/long.pdf`, or any long PDF). In DevTools, check that `document.querySelectorAll("canvas").length` is well under 300 at the top (criterion 5).
- [ ] 7. Commit: `feat(web): lazy pdf pages with zoom and page indicator`.

**Done when:** criteria 2, 3, 5 hold.

### Task 4: Reload on change and keeping the page
**Depends on:** Task 3

- [ ] 1. In `PdfView`, keep a ref `lastPage` updated from `current`. When a new doc arrives for a changed `version`, scroll the wrapper of `Math.min(lastPage, numPages)` into view (`scrollIntoView({ block: "start" })`) once its placeholder mounts. Keep the old doc visible until the new one resolves, so the tab doesn't flash empty.
- [ ] 2. Run `pnpm typecheck`. Expect exit 0.
- [ ] 3. Manual: open `sample.pdf` (3 pages) and scroll to page 2. From a shell, overwrite it with a 5-page PDF (`cp five.pdf /tmp/sr03-repo/sample.pdf`). Expect "x / 5" without interaction, still around page 2 (criterion 4). Click the reload button. Expect a re-render, same page. Delete the file. Expect the tab closes, like other missing files.
- [ ] 4. Manual: switch the theme light ↔ dark. Expect pages to stay white on the `bg-card/40` surround and the toolbar to follow the theme. Run `pnpm dmg`, install, open the same PDF. Expect identical behaviour with no network (criterion 9).
- [ ] 5. Run `pnpm test && pnpm typecheck`. Expect both green.
- [ ] 6. Commit: `feat(web): reload open pdfs when the file changes`.

**Done when:** criteria 4 and 9 hold; full suite and typecheck green.

## Criteria → tasks
1→T2 · 2→T3 · 3→T3 · 4→T4 · 5→T3 · 6→T2 · 7→T2 · 8→T2 · 9→T4 · 10→T1 (endpoint) + every task (typecheck)

## Risks
- **Worker URL import under Vite/Electron.** If `?url` doesn't resolve in the packaged app, fall back to `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`. Stop and report rather than loading the worker from a CDN.
- **pdf.js v5 needs modern JS** (`Promise.withResolvers`, `Map.prototype.getOrInsert` in later 5.x). Electron and current Chrome are fine. If `pnpm build` targets older syntax and fails, pin `pdfjs-dist@5.4` and report.
- **`fsTick` bumps on any file change in the thread**, so an unrelated edit refetches the PDF. That's acceptable at this scope (the image preview behaves the same). Range requests keep it cheap.
- **`enscript`/`ps2pdf` may not be installed.** Any long PDF works for Task 3 step 6.
