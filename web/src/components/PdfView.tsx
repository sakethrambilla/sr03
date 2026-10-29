// A pdf file tab: pdf.js pages on canvases, rasterised as they near the viewport.
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Button } from "@/components/ui/button";
import { FitWidthIcon, ZoomInIcon, ZoomOutIcon } from "@/components/ui";

let engine: Promise<typeof import("pdfjs-dist")> | undefined;
function loadPdfjs() {
  engine ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    },
  );
  return engine;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.25;
// the p-6 padding on both sides of the page column, in css px
const GUTTER = 48;

type Size = { width: number; height: number };

export function PdfView({
  threadId,
  path,
  version,
  onMissing,
}: {
  threadId: string;
  path: string;
  version: string;
  onMissing: (path: string) => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> } | undefined;
    let loaded = false;
    loadPdfjs()
      .then((pdfjs) => {
        if (cancelled) return;
        task = pdfjs.getDocument({
          url: `/api/threads/${threadId}/pdf?path=${encodeURIComponent(path)}&v=${version}`,
        });
        return task.promise.then((next) => {
          loaded = true;
          if (cancelled) return void next.destroy();
          setDoc(next);
          setError(null);
        });
      })
      .catch((cause: Error & { status?: number }) => {
        if (cancelled) return;
        if (cause.status === 404 || cause.name === "MissingPDFException") {
          onMissing(path);
          return;
        }
        setError(
          cause.name === "PasswordException"
            ? "This PDF is password-protected."
            : "This file couldn't be read as a PDF.",
        );
      });
    return () => {
      cancelled = true;
      // a resolved document belongs to the [doc] effect, which destroys it once its replacement lands
      if (!loaded) void task?.destroy();
    };
  }, [threadId, path, version, onMissing]);

  useEffect(() => () => void doc?.destroy(), [doc]);

  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [base, setBase] = useState<Size | null>(null);
  const [scale, setScale] = useState(1);
  const [current, setCurrent] = useState(1);
  const lastPage = useRef(1);
  lastPage.current = current;
  const fitted = useRef(false);
  const shown = useRef<PDFDocumentProxy | null>(null);

  const fitWidth = (size: Size | null = base) => {
    if (!size || !scroller) return;
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, (scroller.clientWidth - GUTTER) / size.width)));
  };

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    doc
      .getPage(1)
      .then((page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1 });
        setBase({ width: viewport.width, height: viewport.height });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc]);

  useEffect(() => {
    if (!base || !scroller || fitted.current) return;
    fitted.current = true;
    fitWidth(base);
  }, [base, scroller]);

  useEffect(() => {
    if (!doc || !scroller || !base) return;
    const previous = shown.current;
    shown.current = doc;
    if (!previous || previous === doc) return;
    const page = Math.min(lastPage.current, doc.numPages);
    scroller.querySelector(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" });
  }, [doc, scroller, base]);

  useEffect(() => {
    if (!scroller || !base) return;
    const ratios = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          ratios.set(Number((entry.target as HTMLElement).dataset.page), entry.intersectionRatio);
        }
        let best = 0;
        let bestRatio = 0;
        for (const [page, ratio] of ratios) {
          if (ratio > bestRatio) [best, bestRatio] = [page, ratio];
        }
        if (best) setCurrent(best);
      },
      { root: scroller, threshold: [0.5] },
    );
    for (const element of scroller.querySelectorAll("[data-page]")) observer.observe(element);
    return () => observer.disconnect();
  }, [scroller, base, doc]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {doc && base && !error ? (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-3">
          <span className="font-mono text-[11px] text-muted-foreground">
            {Math.min(current, doc.numPages)} / {doc.numPages}
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-faint"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={scale <= MIN_SCALE}
            onClick={() => setScale((value) => Math.max(MIN_SCALE, value / ZOOM_STEP))}
          >
            <ZoomOutIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-faint"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={scale >= MAX_SCALE}
            onClick={() => setScale((value) => Math.min(MAX_SCALE, value * ZOOM_STEP))}
          >
            <ZoomInIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-faint"
            aria-label="Fit width"
            title="Fit width"
            onClick={() => fitWidth()}
          >
            <FitWidthIcon />
          </Button>
        </div>
      ) : null}
      <div ref={setScroller} className="min-h-0 flex-1 overflow-auto bg-card/40">
        {error ? (
          <p className="px-4 py-6 text-[12px] text-destructive">{error}</p>
        ) : doc && base ? (
          <div className="flex w-max min-w-full flex-col items-center gap-4 p-6">
            {Array.from({ length: doc.numPages }, (_, index) => (
              <PdfPage key={index} doc={doc} pageNumber={index + 1} scale={scale} base={base} root={scroller} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PdfPage({
  doc,
  pageNumber,
  scale,
  base,
  root,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  base: Size;
  root: HTMLElement | null;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [own, setOwn] = useState<Size | null>(null);

  useEffect(() => {
    const element = wrapper.current;
    if (!element || !root) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root,
      rootMargin: "800px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let render: { promise: Promise<void>; cancel: () => void } | undefined;
    doc
      .getPage(pageNumber)
      .then((page) => {
        const element = canvas.current;
        const context = element?.getContext("2d");
        if (cancelled || !element || !context) return;
        const dpr = window.devicePixelRatio || 1;
        const unit = page.getViewport({ scale: 1 });
        setOwn({ width: unit.width, height: unit.height });
        const viewport = page.getViewport({ scale });
        element.width = Math.floor(viewport.width * dpr);
        element.height = Math.floor(viewport.height * dpr);
        render = page.render({
          canvas: element,
          canvasContext: context,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        return render.promise;
      })
      .catch(() => {
        // a cancelled render (RenderingCancelledException) or a destroyed document rejects; neither is worth surfacing
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, pageNumber, scale, near]);

  const size = own ?? base;
  // until drawn a page borrows page 1's size; a far page keeps its old raster, stretched, until it nears again
  return (
    <div
      ref={wrapper}
      data-page={pageNumber}
      className="shrink-0 overflow-hidden rounded-md bg-white shadow-sm"
      style={{ width: size.width * scale, height: size.height * scale }}
    >
      {/* white is the paper, the one place a non-token colour is intended */}
      <canvas ref={canvas} className="block size-full" />
    </div>
  );
}
