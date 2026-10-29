// A pdf file tab: pdf.js pages on canvases, rasterised as they near the viewport.
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";

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

const SCALE = 1.25;

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
    loadPdfjs()
      .then((pdfjs) => {
        if (cancelled) return;
        task = pdfjs.getDocument({
          url: `/api/threads/${threadId}/pdf?path=${encodeURIComponent(path)}&v=${version}`,
        });
        return task.promise.then((next) => {
          if (cancelled) return;
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
      void task?.destroy();
    };
  }, [threadId, path, version, onMissing]);

  useEffect(() => () => void doc?.destroy(), [doc]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-card/40">
        {error ? (
          <p className="px-4 py-6 text-[12px] text-destructive">{error}</p>
        ) : doc ? (
          <div className="flex flex-col items-center gap-4 p-6">
            {Array.from({ length: doc.numPages }, (_, index) => (
              <PdfPage key={index} doc={doc} pageNumber={index + 1} scale={SCALE} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PdfPage({ doc, pageNumber, scale }: { doc: PDFDocumentProxy; pageNumber: number; scale: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let render: { promise: Promise<void>; cancel: () => void } | undefined;
    doc
      .getPage(pageNumber)
      .then((page) => {
        const element = canvas.current;
        const context = element?.getContext("2d");
        if (cancelled || !element || !context) return;
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale });
        element.width = Math.floor(viewport.width * dpr);
        element.height = Math.floor(viewport.height * dpr);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        render = page.render({
          canvas: element,
          canvasContext: context,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        return render.promise;
      })
      .catch(() => {
        // a cancelled render or a destroyed document rejects; neither is worth surfacing
      });
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [doc, pageNumber, scale]);

  // white is the paper, the one place a non-token colour is intended
  return <canvas ref={canvas} className="rounded-md bg-white shadow-sm" />;
}
