# Progress — PDF viewer

**Plan:** ./plan.md
**Status:** complete (light-theme check not run)
**Current:** —

## Log
- 2026-10-29 Task 1 — done, commit e1c5d0a. Server tests 118/118, typecheck green, GET .pdf → 200 application/pdf, Range → 206, README.md → 404.
- 2026-10-29 Task 2 — done, commit 4c3a91b. Typecheck + build green; pdf.js in its own `pdf-*.js` chunk; node sanity: real PDF opens, garbage → InvalidPDFException. Browser visual checks pending (coordinator).
- 2026-10-29 Task 3 — done, commit 6071b0f. Typecheck + build green.
- 2026-10-29 Task 4 — done, commit c2afd44. pnpm test + typecheck green.
- 2026-10-29 Browser QA on built app (`pnpm start`, scratch repo): 3 pages sharp at dpr 2, "2 / 3" on scroll, zoom re-rasterises, overwrite → "2 / 5" same page + zoom kept, 300-page doc draws 2 canvases, garbage → error line with clean console, deleted file closes tab, worker served as text/javascript.
- 2026-10-29 `pnpm dmg` built sr03-0.2.3-arm64.dmg. Ran its bundled payload server (installed app was open, single-instance lock): PDFs render, worker .mjs served as text/javascript, no console errors.

## Blocked / needs a decision
- (none) — the per-tick PDF re-download is fixed: the pdf route sends an etag (size + mtime), PdfView probes 1 byte per fsTick and reloads only when the etag changes. Verified: unrelated edits → 0 reloads/0 workers; PDF overwrite → 1 reload; reload button forces 1; bad.pdf error; delete closes tab.

## Deviations
- Task 1 step 7: plan said `curl -sI`; router has no HEAD handling (404 for /video too), so verified with GET + `-D -`. Ran server directly on port 3499 with a scratch SR03_DATA_DIR.
- Task 2: added `.mjs` → text/javascript to the server's static MIME map (`server/src/index.ts`), else the built app serves the worker as octet-stream. Not in plan.
- Task 2 step 7: grep for GlobalWorkerOptions matches index only via PdfView's own assignment; library itself is in `pdf-*.js`. Worker emits two files (worker + 70-byte url stub).
- Task 2: pdf.js v5 has no MissingPDFException; 404 caught via `cause.status`. No vite-env.d.ts needed.
- Task 3: rendered pages size to their own viewport (mixed sizes); fit-width clamped 0.5–4; column `w-max min-w-full` for horizontal scroll. Every page mounts an empty canvas, so criterion 5 check counts drawn canvases (`width > 0`) instead of all canvases.
