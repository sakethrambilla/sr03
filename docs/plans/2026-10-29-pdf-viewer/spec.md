# PDF viewer

## Problem
Opening a `.pdf` from the file tree today shows "This is a binary file." Agents regularly produce
or read PDFs (reports, exported docs, papers in a repo), and the user has to leave sr03 to look at
them — unlike markdown, html, mermaid, excalidraw and video, which all preview in their tab.

## Goal
A PDF opens in its editor tab as rendered, scrollable pages, themed to match sr03, and re-renders
when the file changes on disk.

## Non-goals
- Annotating, highlighting, form filling, signing, or editing a PDF.
- Attaching a PDF to the composer or feeding it to the agent.
- Text search inside the PDF, a thumbnail sidebar, an outline/bookmarks panel, printing.
- Text selection / copy (nice to have; not required).
- Password-protected PDFs beyond showing an error.
- PDFs inside chat messages — only file tabs.

## Behaviour
Clicking a `.pdf` in the file tree (or a link to one) opens a tab that renders every page
top-to-bottom on the panel background, each page a light sheet with a small gap between pages. A
toolbar strip at the top shows the current page / page count and zoom out / zoom in / fit-width
controls. Pages render lazily as they scroll near the viewport, so a 300-page PDF opens about as
fast as a 3-page one.

When the agent (or anything else) rewrites the file, the tab re-renders and keeps the reader's
page as close as it can. The existing tab "reload" control does the same on demand.

If the file is missing, it behaves like any other missing file. If the bytes aren't a valid PDF
or are encrypted, the tab shows a one-line error in place of the pages and the rest of the app is
unaffected. The PDF renderer is only downloaded the first time a PDF is opened.

## Acceptance criteria
1. When the user opens `sample.pdf` (3 pages), the tab shows 3 rendered pages and "1 / 3".
2. When the user scrolls so page 2 is mostly in view, the indicator reads "2 / 3".
3. When the user clicks zoom in, pages render larger and stay sharp (re-rasterised, not CSS-scaled);
   fit-width makes the page width equal the panel width minus padding.
4. When `sample.pdf` is overwritten on disk with a 5-page PDF while open, the tab shows 5 pages
   without the user touching anything.
5. When a 300-page PDF is opened, pages far below the viewport are not rasterised until scrolled
   near.
6. When the user opens a `.pdf` that is truncated garbage or encrypted, the tab shows an error
   line, no pages, and no uncaught error reaches the console.
7. When no PDF has been opened, the PDF renderer's code is not loaded by the app.
8. The tab shows no source/raw toggle and no save action for a PDF.
9. Works in light and dark themes and in both `pnpm dev` and the packaged desktop app.
10. `pnpm typecheck` passes and the PDF endpoint returns `content-type: application/pdf`.

## Constraints
- Rendering uses pdf.js, chosen by the user over the browser's built-in viewer so the look matches
  sr03. It must be dynamically imported, like mermaid and excalidraw, and its worker must load
  from the app's own origin (the packaged app has no network guarantee).
- Adding it is a new web dependency; CLAUDE.md's dependency list must name it, as it does the
  other preview libraries.
- UI from shadcn/ui and lucide icons only; colours from tokens.

## Open questions
- Should a very large PDF (say >100 MB) be refused? — assuming no cap; it streams like video.
