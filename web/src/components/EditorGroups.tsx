// The editor area as one CSS grid. Every tab strip and every view is a direct child of this single
// grid, and which group something belongs to is expressed only as a track style — never as a
// wrapper element. That is what lets a tab move between groups without React re-parenting the view:
// FileView keeps its edited text in an uncontrolled textarea, so a remount would discard it.
import type { ReactNode } from "react";

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

export function EditorGroups({
  layout,
  onFocusGroup,
  strip,
  children,
}: {
  layout: EditorLayout;
  focused: number;
  onFocusGroup: (index: number) => void;
  strip: (group: EditorGroup, index: number) => ReactNode;
  children: ReactNode;
}) {
  const horizontal = layout.axis === "horizontal";
  const template = trackTemplate(layout.sizes, layout.axis);

  return (
    <div
      data-editor-grid
      className="grid min-h-0 min-w-0 flex-1"
      style={
        horizontal
          ? { gridTemplateColumns: template, gridTemplateRows: "auto minmax(0, 1fr)" }
          : { gridTemplateColumns: "minmax(0, 1fr)", gridTemplateRows: template }
      }
    >
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
