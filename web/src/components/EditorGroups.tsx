// The editor area as one CSS grid. Every tab strip and every view is a direct child of this single
// grid, and which group something belongs to is expressed only as a track style — never as a
// wrapper element. That is what lets a tab move between groups without React re-parenting the view:
// FileView keeps its edited text in an uncontrolled textarea, so a remount would discard it.
import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { EditorGroup, EditorLayout, EditorTab } from "../lib/types.ts";
import { activeTab, sameTab, tabKey, trackOf, trackTemplate } from "../lib/layout.ts";
import { CloseIcon, FileIcon, MessageIcon, cn } from "./ui.tsx";

export function EditorTabs({
  group,
  index,
  title,
  dirty,
  onSelect,
  onClose,
}: {
  group: EditorGroup;
  index: number;
  title: string;
  dirty: Set<string>;
  onSelect: (groupIndex: number, tab: EditorTab) => void;
  onClose: (path: string) => void;
}) {
  const active = activeTab(group);

  return (
    <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border/60 bg-background">
      {group.tabs.map((tab) => {
        const selected = sameTab(tab, active);

        if (tab.kind === "chat") {
          return (
            <button
              key={tabKey(tab)}
              onClick={() => onSelect(index, tab)}
              title={title}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1.5 border-r border-border/60 px-3 text-[12px] transition",
                selected
                  ? "bg-card text-foreground shadow-[inset_0_1px_0_var(--color-primary)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <MessageIcon className="size-3.5" />
              <span className="max-w-40 truncate">{title}</span>
            </button>
          );
        }

        const path = tab.path;
        const name = path.slice(path.lastIndexOf("/") + 1);
        return (
          <div
            key={tabKey(tab)}
            onAuxClick={(event) => {
              if (event.button === 1) onClose(path);
            }}
            className={cn(
              "group/tab flex h-8 shrink-0 items-center gap-1.5 border-r border-border/60 pr-1.5 pl-3 transition",
              selected ? "bg-card shadow-[inset_0_1px_0_var(--color-primary)]" : "hover:bg-card/50",
            )}
          >
            <button
              onClick={() => onSelect(index, tab)}
              title={path}
              className="flex min-w-0 items-center gap-1.5 text-[12px]"
            >
              <FileIcon name={name} />
              <span
                className={cn(
                  "max-w-40 truncate",
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {name}
              </span>
            </button>
            <button
              onClick={() => onClose(path)}
              aria-label={`Close ${name}`}
              title={dirty.has(path) ? "Unsaved changes — click to close" : `Close ${name}`}
              className={cn(
                "group/close grid size-4 shrink-0 place-items-center rounded text-faint transition hover:bg-accent hover:text-foreground",
                selected || dirty.has(path) ? "" : "opacity-0 group-hover/tab:opacity-100",
              )}
            >
              {dirty.has(path) ? (
                <>
                  <span className="size-1.5 rounded-full bg-git-modified group-hover/close:hidden" />
                  <CloseIcon className="hidden size-3 group-hover/close:block" />
                </>
              ) : (
                <CloseIcon className="size-3" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// a group narrower than this loses its tab strip; the model keeps the same floor as a fraction
const MIN_GROUP_PX = 160;

export function EditorGroups({
  layout,
  onFocusGroup,
  onResize,
  onEqualise,
  strip,
  children,
}: {
  layout: EditorLayout;
  focused: number;
  onFocusGroup: (index: number) => void;
  onResize: (sashIndex: number, fractions: [number, number]) => void;
  onEqualise: () => void;
  strip: (group: EditorGroup, index: number) => ReactNode;
  children: ReactNode;
}) {
  const horizontal = layout.axis === "horizontal";
  const template = trackTemplate(layout.sizes, layout.axis);
  const grid = useRef<HTMLDivElement>(null);

  // the fractions are written straight to the grid during the drag; letting React own them would
  // re-render every mounted view on each pointer move
  const startResize = (sashIndex: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = grid.current;
    if (!container) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const box = container.getBoundingClientRect();
    const span = horizontal ? box.width : box.height;
    const origin = horizontal ? event.clientX : event.clientY;
    const pair = layout.sizes[sashIndex]! + layout.sizes[sashIndex + 1]!;
    const total = layout.sizes.reduce((sum, size) => sum + size, 0);
    // the pair's own slice of the container is all the drag can redistribute
    const pairPx = (pair / total) * span;
    const floor = Math.min(MIN_GROUP_PX, pairPx / 2);
    let settled: [number, number] = [layout.sizes[sashIndex]!, layout.sizes[sashIndex + 1]!];

    const move = (moved: PointerEvent) => {
      const delta = (horizontal ? moved.clientX : moved.clientY) - origin;
      const first = Math.min(Math.max((settled[0] / pair) * pairPx + delta, floor), pairPx - floor);
      const shares: [number, number] = [first / pairPx, (pairPx - first) / pairPx];
      const sizes = layout.sizes.slice();
      sizes[sashIndex] = shares[0] * pair;
      sizes[sashIndex + 1] = shares[1] * pair;
      settled = [sizes[sashIndex]!, sizes[sashIndex + 1]!];
      const next = trackTemplate(sizes, layout.axis);
      if (horizontal) container.style.gridTemplateColumns = next;
      else container.style.gridTemplateRows = next;
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      onResize(sashIndex, settled);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    // a cancelled pointer would otherwise leave the move listener resizing forever
    window.addEventListener("pointercancel", done);
  };

  return (
    <div
      ref={grid}
      data-editor-grid
      className="grid min-h-0 min-w-0 flex-1"
      style={
        horizontal
          ? { gridTemplateColumns: template, gridTemplateRows: "auto minmax(0, 1fr)" }
          : { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: template }
      }
    >
      {layout.groups.slice(0, -1).map((group, index) => (
        <div
          key={`sash-${group.id}`}
          style={
            horizontal
              ? { gridColumn: trackOf(index, layout.axis, "view") + 1, gridRow: "1 / -1" }
              : { gridColumn: 1, gridRow: trackOf(index, layout.axis, "view") + 1 }
          }
          className="relative z-20 bg-border/60"
        >
          {/* the track itself is 1px, which is far too thin to grab, so the handle overflows it
              on both sides without taking any layout space of its own */}
          <div
            role="separator"
            aria-orientation={horizontal ? "vertical" : "horizontal"}
            aria-label="Resize editor group"
            onPointerDown={startResize(index)}
            onDoubleClick={onEqualise}
            className={cn(
              "absolute transition-colors delay-150 hover:bg-primary/70",
              horizontal
                ? "inset-y-0 -left-1 -right-1 cursor-ew-resize"
                : "inset-x-0 -top-1 -bottom-1 cursor-ns-resize",
            )}
          />
        </div>
      ))}
      {layout.groups.map((group, index) => (
        <div
          key={group.id}
          data-group={index}
          onPointerDownCapture={() => onFocusGroup(index)}
          className="flex min-w-0 flex-col"
          style={
            horizontal
              ? { gridColumn: trackOf(index, layout.axis, "strip"), gridRow: 1 }
              : { gridColumn: 1, gridRow: trackOf(index, layout.axis, "strip") }
          }
        >
          {strip(group, index)}
        </div>
      ))}
      {children}
    </div>
  );
}
