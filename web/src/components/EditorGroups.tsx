// The editor area as one CSS grid. Every tab strip and every view is a direct child of this single
// grid, and which group something belongs to is expressed only as a track style — never as a
// wrapper element. That is what lets a tab move between groups without React re-parenting the view:
// FileView keeps its edited text in an uncontrolled textarea, so a remount would discard it.
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { EditorGroup, EditorLayout, EditorTab } from "../lib/types.ts";
import type { DropZone } from "../lib/layout.ts";
import {
  MAX_GROUPS,
  activeTab,
  dropTargetAt,
  sameTab,
  tabKey,
  trackOf,
  trackTemplate,
} from "../lib/layout.ts";
import { CloseIcon, FileIcon, MessageIcon, cn } from "./ui.tsx";

// a press has to travel this far before it becomes a drag, so an ordinary click still selects
const DRAG_SLOP = 4;

// a group narrower than this loses its tab strip; the model keeps the same floor as a fraction
const MIN_GROUP_PX = 160;

export interface DropTarget {
  group: number;
  zone: DropZone;
  before?: EditorTab;
}

function tabName(tab: EditorTab, title: string): string {
  return tab.kind === "chat" ? title : tab.path.slice(tab.path.lastIndexOf("/") + 1);
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.group !== b.group || a.zone !== b.zone) return false;
  if (!a.before || !b.before) return a.before === b.before;
  return sameTab(a.before, b.before);
}

const OVERLAY: Record<DropZone, string> = {
  center: "inset-0",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  up: "inset-x-0 top-0 h-1/2",
  down: "inset-x-0 bottom-0 h-1/2",
};

export function EditorTabs({
  group,
  index,
  title,
  dirty,
  dragging,
  insertBefore,
  onSelect,
  onClose,
  onTabPointerDown,
}: {
  group: EditorGroup;
  index: number;
  title: string;
  dirty: Set<string>;
  dragging: EditorTab | null;
  insertBefore: EditorTab | null;
  onSelect: (groupIndex: number, tab: EditorTab) => void;
  onClose: (path: string) => void;
  onTabPointerDown: (
    tab: EditorTab,
    groupIndex: number,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}) {
  const active = activeTab(group);

  return (
    <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border/60 bg-background">
      {group.tabs.map((tab) => {
        const selected = sameTab(tab, active);
        const lifted = dragging !== null && sameTab(tab, dragging);
        const marker =
          insertBefore && sameTab(tab, insertBefore) ? (
            <span className="w-0.5 shrink-0 self-stretch bg-primary" />
          ) : null;
        const name = tabName(tab, title);

        return (
          <div key={tabKey(tab)} data-tab={tabKey(tab)} className="flex shrink-0 items-stretch">
            {marker}
            {tab.kind === "chat" ? (
              <button
                onPointerDown={(event) => onTabPointerDown(tab, index, event)}
                onClick={() => onSelect(index, tab)}
                title={title}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 border-r border-border/60 px-3 text-[12px] transition",
                  selected
                    ? "bg-card text-foreground shadow-[inset_0_1px_0_var(--color-primary)]"
                    : "text-muted-foreground hover:text-foreground",
                  lifted && "opacity-40",
                )}
              >
                <MessageIcon className="size-3.5" />
                <span className="max-w-40 truncate">{title}</span>
              </button>
            ) : (
              <div
                onAuxClick={(event) => {
                  if (event.button === 1) onClose(tab.path);
                }}
                className={cn(
                  "group/tab flex h-8 shrink-0 items-center gap-1.5 border-r border-border/60 pr-1.5 pl-3 transition",
                  selected
                    ? "bg-card shadow-[inset_0_1px_0_var(--color-primary)]"
                    : "hover:bg-card/50",
                  lifted && "opacity-40",
                )}
              >
                <button
                  onPointerDown={(event) => onTabPointerDown(tab, index, event)}
                  onClick={() => onSelect(index, tab)}
                  title={tab.path}
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
                  onClick={() => onClose(tab.path)}
                  aria-label={`Close ${name}`}
                  title={
                    dirty.has(tab.path) ? "Unsaved changes — click to close" : `Close ${name}`
                  }
                  className={cn(
                    "group/close grid size-4 shrink-0 place-items-center rounded text-faint transition hover:bg-accent hover:text-foreground",
                    selected || dirty.has(tab.path) ? "" : "opacity-0 group-hover/tab:opacity-100",
                  )}
                >
                  {dirty.has(tab.path) ? (
                    <>
                      <span className="size-1.5 rounded-full bg-git-modified group-hover/close:hidden" />
                      <CloseIcon className="hidden size-3 group-hover/close:block" />
                    </>
                  ) : (
                    <CloseIcon className="size-3" />
                  )}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function EditorGroups({
  layout,
  title,
  dirty,
  onFocusGroup,
  onResize,
  onEqualise,
  onSelect,
  onClose,
  onDrop,
  children,
}: {
  layout: EditorLayout;
  title: string;
  dirty: Set<string>;
  focused: number;
  onFocusGroup: (index: number) => void;
  onResize: (sashIndex: number, fractions: [number, number]) => void;
  onEqualise: () => void;
  onSelect: (groupIndex: number, tab: EditorTab) => void;
  onClose: (path: string) => void;
  onDrop: (tab: EditorTab, target: DropTarget) => void;
  children: ReactNode;
}) {
  const horizontal = layout.axis === "horizontal";
  const template = trackTemplate(layout.sizes, layout.axis);
  const grid = useRef<HTMLDivElement>(null);
  const zones = useRef<Array<HTMLDivElement | null>>([]);
  const strips = useRef<Array<HTMLDivElement | null>>([]);
  const label = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ tab: EditorTab; over: DropTarget | null } | null>(null);

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
      const sizes = layout.sizes.slice();
      sizes[sashIndex] = (first / pairPx) * pair;
      sizes[sashIndex + 1] = ((pairPx - first) / pairPx) * pair;
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

  const targetAt = (x: number, y: number): DropTarget | null => {
    // a strip resolves to a position between tabs, which is how reordering and splitting stay one gesture
    for (const [index, strip] of strips.current.entries()) {
      const box = strip?.getBoundingClientRect();
      if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      const before = [...strip!.querySelectorAll<HTMLElement>("[data-tab]")].find((el) => {
        const rect = el.getBoundingClientRect();
        return x < rect.left + rect.width / 2;
      });
      const match = layout.groups[index]?.tabs.find((tab) => tabKey(tab) === before?.dataset.tab);
      return { group: index, zone: "center", ...(match ? { before: match } : {}) };
    }
    for (const [index, zone] of zones.current.entries()) {
      const box = zone?.getBoundingClientRect();
      if (!box || x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
      return {
        group: index,
        zone: dropTargetAt(box, x - box.left, y - box.top, {
          split: layout.groups.length < MAX_GROUPS,
          // the axis only settles once there are two groups; before that either direction is open
          axis: layout.groups.length > 1 ? layout.axis : null,
        }),
      };
    }
    return null;
  };

  const startTabDrag = (
    tab: EditorTab,
    groupIndex: number,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) return;
    onFocusGroup(groupIndex);
    const originX = event.clientX;
    const originY = event.clientY;
    let started = false;
    let target: DropTarget | null = null;

    const move = (moved: PointerEvent) => {
      if (!started) {
        if (Math.hypot(moved.clientX - originX, moved.clientY - originY) < DRAG_SLOP) return;
        started = true;
        setDrag({ tab, over: null });
      }
      // the label follows through its own style, so React only re-renders when the zone changes
      if (label.current) {
        label.current.style.transform = `translate(${moved.clientX + 12}px, ${moved.clientY + 12}px)`;
      }
      const next = targetAt(moved.clientX, moved.clientY);
      if (sameTarget(next, target)) return;
      target = next;
      setDrag((current) => (current ? { ...current, over: next } : current));
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey, true);
      const dropped = target;
      const dragged = started;
      setDrag(null);
      if (commit && dragged && dropped) onDrop(tab, dropped);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    // FileView's own Esc handler is on window and closes the file, so this one runs in the capture
    // phase and stops the event before it ever gets there. stopImmediatePropagation covers the case
    // where the event is dispatched at window itself, where capture and bubble listeners are peers.
    const onKey = (keyed: KeyboardEvent) => {
      if (keyed.key !== "Escape" || !started) return;
      keyed.preventDefault();
      keyed.stopPropagation();
      keyed.stopImmediatePropagation();
      finish(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey, true);
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
          ref={(el) => {
            strips.current[index] = el;
          }}
          onPointerDownCapture={() => onFocusGroup(index)}
          className="flex min-w-0 flex-col"
          style={
            horizontal
              ? { gridColumn: trackOf(index, layout.axis, "strip"), gridRow: 1 }
              : { gridColumn: 1, gridRow: trackOf(index, layout.axis, "strip") }
          }
        >
          <EditorTabs
            group={group}
            index={index}
            title={title}
            dirty={dirty}
            dragging={drag?.tab ?? null}
            insertBefore={drag?.over?.group === index ? (drag.over.before ?? null) : null}
            onSelect={onSelect}
            onClose={onClose}
            onTabPointerDown={startTabDrag}
          />
        </div>
      ))}

      {children}

      {/* one measuring region per group, spanning its strip and its view, so a drop target resolves
          against the whole group rather than only the part the pointer happens to be over */}
      {layout.groups.map((group, index) => (
        <div
          key={`zone-${group.id}`}
          ref={(el) => {
            zones.current[index] = el;
          }}
          style={
            horizontal
              ? { gridColumn: trackOf(index, layout.axis, "strip"), gridRow: "1 / -1" }
              : {
                  gridColumn: 1,
                  gridRow: `${trackOf(index, layout.axis, "strip")} / ${trackOf(index, layout.axis, "view") + 1}`,
                }
          }
          className="pointer-events-none relative z-30"
        >
          {drag?.over && drag.over.group === index && !drag.over.before ? (
            <div
              className={cn(
                "absolute rounded-lg border border-primary/60 bg-primary/15",
                OVERLAY[drag.over.zone],
              )}
            />
          ) : null}
        </div>
      ))}

      {drag ? (
        <div
          ref={label}
          className="pointer-events-none fixed top-0 left-0 z-50 flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[12px] text-foreground shadow-lg"
        >
          {drag.tab.kind === "chat" ? (
            <MessageIcon className="size-3.5" />
          ) : (
            <FileIcon name={tabName(drag.tab, title)} />
          )}
          <span className="max-w-40 truncate">{tabName(drag.tab, title)}</span>
        </div>
      ) : null}
    </div>
  );
}
