import type { PointerEvent as ReactPointerEvent } from "react";

import { MIN_MAIN_PX, PANEL_DEFAULTS, clampPanelWidth, resizedWidth } from "../lib/panels.ts";
import type { PanelEdge, PanelId } from "../lib/panels.ts";
import { useStore } from "../store.ts";
import { cn } from "./ui.tsx";

export function PanelResize({ panel, edge }: { panel: PanelId; edge: PanelEdge }) {
  const setPanelWidth = useStore((state) => state.setPanelWidth);

  // the width is written straight to the panel during the drag, as the editor sash does, so the
  // views beside it don't re-render on every pointer move
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget.parentElement;
    if (!element) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const start = element.getBoundingClientRect().width;
    const main = element.parentElement?.querySelector<HTMLElement>(":scope > main");
    const room = main ? start + main.getBoundingClientRect().width - MIN_MAIN_PX : Infinity;
    const origin = event.clientX;
    let settled = start;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (moved: PointerEvent) => {
      settled = clampPanelWidth(resizedWidth(start, moved.clientX - origin, edge), room);
      element.style.width = `${settled}px`;
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setPanelWidth(panel, settled);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      data-panel-resize
      onPointerDown={startResize}
      onDoubleClick={() => setPanelWidth(panel, PANEL_DEFAULTS[panel])}
      className={cn(
        "absolute inset-y-0 z-30 w-2 cursor-col-resize transition-colors delay-150 hover:bg-primary/70",
        edge === "right" ? "-right-1" : "-left-1",
      )}
    />
  );
}
