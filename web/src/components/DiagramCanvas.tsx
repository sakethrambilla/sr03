import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";

import { Button } from "@/components/ui/button";
import { fitView, panBy, zoomAt, ZOOM_STEP } from "../lib/panzoom.ts";
import type { Size, View } from "../lib/panzoom.ts";
import { cn, FitIcon, ZoomInIcon, ZoomOutIcon } from "./ui.tsx";

export function DiagramCanvas({ svg, dimmed }: { svg: string; dimmed: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const fitted = useRef(false);
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const viewportRect = (): Size => {
    const rect = viewport.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };

  useLayoutEffect(() => {
    const el = content.current?.querySelector("svg");
    if (!el) return;
    let { width, height } = el.viewBox.baseVal ?? { width: 0, height: 0 };
    if (!width || !height) ({ width, height } = el.getBBox());
    // mermaid emits width="100%" and an inline max-width, which would fight the transform
    el.style.maxWidth = "none";
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    sizeRef.current = { width, height };
    if (!fitted.current) {
      setView(fitView(sizeRef.current, viewportRect()));
      fitted.current = true;
    }
  }, [svg]);

  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    // React's onWheel is passive and can't preventDefault
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = node.getBoundingClientRect();
        const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.01), point));
      } else {
        setView((v) => panBy(v, -e.deltaX, -e.deltaY));
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const last = drag.current;
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((v) => panBy(v, dx, dy));
  };
  const endDrag = () => {
    drag.current = null;
  };

  const zoomCentre = (factor: number) => {
    const { width, height } = viewportRect();
    setView((v) => zoomAt(v, factor, { x: width / 2, y: height / 2 }));
  };

  return (
    <div
      ref={viewport}
      className="relative min-h-0 flex-1 cursor-grab overflow-hidden select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        ref={content}
        style={{
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          transformOrigin: "0 0",
        }}
        className={cn("absolute top-0 left-0", dimmed && "opacity-50")}
        // mermaid runs its own sanitizer under securityLevel: "strict" before this ever renders
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div
        className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomCentre(1 / ZOOM_STEP)}
        >
          <ZoomOutIcon />
        </Button>
        <span className="w-10 text-center font-mono text-[11px] text-muted-foreground">
          {Math.round(view.scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomCentre(ZOOM_STEP)}
        >
          <ZoomInIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Fit to view"
          title="Fit to view"
          onClick={() => setView(fitView(sizeRef.current, viewportRect()))}
        >
          <FitIcon />
        </Button>
      </div>
    </div>
  );
}
