import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../lib/api.ts";
import type { ChangedFile, Message, Thread, TreeEntry } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import {
  ChevronIcon,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  FileIcon,
  FolderIcon,
  NewFileIcon,
  NewFolderIcon,
  RefreshIcon,
  cn,
} from "./ui.tsx";

const NO_MESSAGES: Message[] = [];

type Status = ChangedFile["status"];

const DECORATION: Record<Status, { letter: string; className: string }> = {
  untracked: { letter: "U", className: "text-git-untracked" },
  added: { letter: "A", className: "text-git-added" },
  modified: { letter: "M", className: "text-git-modified" },
  renamed: { letter: "R", className: "text-git-untracked" },
  deleted: { letter: "D", className: "text-git-deleted" },
};

function ancestors(path: string): string[] {
  const parts = path.split("/");
  parts.pop();
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

const INDENT = 12;

function Guides({ depth }: { depth: number }) {
  // one guide per ancestor level, the way the editor draws them
  return (
    <>
      {Array.from({ length: depth }, (_, level) => (
        <span key={level} style={{ width: INDENT }} className="shrink-0 border-r border-border/50" />
      ))}
    </>
  );
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="grid size-4 place-items-center rounded text-faint transition hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Row({
  entry,
  depth,
  status,
  dirty,
  expanded,
  selected,
  onClick,
  onCreate,
  onReload,
  onToggleSubtree,
}: {
  entry: TreeEntry;
  depth: number;
  status: Status | undefined;
  dirty: boolean;
  expanded: boolean;
  selected: boolean;
  onClick: () => void;
  onCreate: (kind: "file" | "dir") => void;
  onReload: () => void;
  onToggleSubtree: () => void;
}) {
  const decoration = status ? DECORATION[status] : null;
  const tint = entry.ignored
    ? "text-git-ignored"
    : decoration
      ? decoration.className
      : dirty
        ? "text-git-modified"
        : "text-muted-foreground";

  return (
    <div
      className={cn(
        "group/row flex h-[22px] w-full items-stretch transition hover:bg-accent/50",
        selected && "bg-accent",
      )}
    >
      <Guides depth={depth} />
      <button onClick={onClick} title={entry.path} className="flex min-w-0 flex-1 items-center gap-1 pl-1 text-left">
        <span className="grid size-3 shrink-0 place-items-center text-faint">
          {entry.isDir ? (
            <ChevronIcon className={cn("size-3 transition-transform", expanded ? "" : "-rotate-90")} />
          ) : null}
        </span>
        {entry.isDir ? (
          <FolderIcon className={cn("size-3.5", entry.ignored ? "text-git-ignored" : "text-faint")} />
        ) : (
          <FileIcon name={entry.name} muted={entry.ignored} />
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[12px]",
            tint,
            status === "deleted" && "line-through",
          )}
        >
          {entry.name}
        </span>
      </button>

      {entry.isDir ? (
        <span className="hidden items-center gap-0.5 pr-1 group-hover/row:flex">
          <RowAction label="New file" onClick={() => onCreate("file")}>
            <NewFileIcon className="size-3" />
          </RowAction>
          <RowAction label="New folder" onClick={() => onCreate("dir")}>
            <NewFolderIcon className="size-3" />
          </RowAction>
          <RowAction label="Reload folder" onClick={onReload}>
            <RefreshIcon className="size-3" />
          </RowAction>
          <RowAction label={expanded ? "Collapse folder" : "Expand folder"} onClick={onToggleSubtree}>
            {expanded ? <CollapseIcon className="size-3" /> : <ExpandIcon className="size-3" />}
          </RowAction>
        </span>
      ) : null}

      <span className={cn("flex shrink-0 items-center pr-2", entry.isDir && "group-hover/row:hidden")}>
        {decoration ? (
          <span className={cn("font-mono text-[10.5px] font-semibold", decoration.className)}>
            {decoration.letter}
          </span>
        ) : dirty ? (
          <span className="size-1.5 rounded-full bg-git-modified" />
        ) : null}
      </span>
    </div>
  );
}

function NewEntryRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");

  return (
    <div className="flex h-[22px] w-full items-stretch bg-accent/40">
      <Guides depth={depth} />
      <span className="flex min-w-0 flex-1 items-center gap-1 pr-2 pl-1">
        <span className="size-3 shrink-0" />
        {kind === "dir" ? (
          <FolderIcon className="size-3.5 text-faint" />
        ) : (
          <FileIcon name={name || "x"} />
        )}
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) onCommit(name.trim());
            if (event.key === "Escape") onCancel();
          }}
          onBlur={() => onCancel()}
          autoFocus
          spellCheck={false}
          placeholder={kind === "dir" ? "folder name" : "file name"}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:text-faint"
        />
      </span>
    </div>
  );
}

export function FileTree({
  thread,
  openPath,
  onOpenFile,
  onClose,
}: {
  thread: Thread;
  openPath: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const messageCount = useStore((state) => (state.messagesByThread[thread.id] ?? NO_MESSAGES).length);
  const [dirs, setDirs] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [changes, setChanges] = useState<Map<string, Status>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "dir" } | null>(null);

  const load = useCallback(
    async (path: string) => {
      const listing = await api.tree(thread.id, path);
      setDirs((current) => ({ ...current, [path]: listing.entries }));
    },
    [thread.id],
  );

  // reloading every open directory keeps files Claude just created from going missing
  useEffect(() => {
    let cancelled = false;
    const open = [...expanded];
    Promise.all([
      api.changes(thread.id),
      Promise.all(open.map((path) => api.tree(thread.id, path).catch(() => null))),
    ])
      .then(([next, listings]) => {
        if (cancelled) return;
        setChanges(new Map(next.files.map((file) => [file.path, file.status])));
        setDirs((current) => {
          const merged = { ...current };
          listings.forEach((listing, index) => {
            if (listing) merged[open[index]!] = listing.entries;
          });
          return merged;
        });
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [thread.id, thread.status, messageCount, tick]);

  // opening straight onto the changed files is the whole point of the panel in a session
  useEffect(() => {
    if (changes.size === 0) return;
    setExpanded((current) => {
      const next = new Set(current);
      for (const path of changes.keys()) for (const dir of ancestors(path)) next.add(dir);
      return next.size === current.size ? current : next;
    });
  }, [changes]);

  useEffect(() => {
    for (const path of expanded) if (!dirs[path]) void load(path).catch(() => undefined);
  }, [expanded, dirs, load]);

  const toggle = (entry: TreeEntry) => {
    if (!entry.isDir) {
      onOpenFile(entry.path);
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
  };

  const startCreate = (parent: string, kind: "file" | "dir") => {
    setExpanded((current) => new Set(current).add(parent));
    setCreating({ parent, kind });
  };

  const commitCreate = async (name: string) => {
    if (!creating) return;
    const target = creating.parent ? `${creating.parent}/${name}` : name;
    setCreating(null);
    try {
      const entry = await api.createEntry(thread.id, target, creating.kind);
      await load(creating.parent);
      if (entry.isDir) setExpanded((current) => new Set(current).add(entry.path));
      else onOpenFile(entry.path);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  // collapsing a folder takes its whole subtree with it; expanding restores what is already loaded
  const toggleSubtree = (dir: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (current.has(dir)) {
        for (const path of current) if (path === dir || path.startsWith(`${dir}/`)) next.delete(path);
      } else {
        next.add(dir);
        for (const path of Object.keys(dirs)) if (path.startsWith(`${dir}/`)) next.add(path);
      }
      return next;
    });
  };

  const hasChangesUnder = (dir: string) => {
    const prefix = `${dir}/`;
    for (const path of changes.keys()) if (path.startsWith(prefix)) return true;
    return false;
  };

  const rows = (path: string, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    if (creating?.parent === path) {
      out.push(
        <NewEntryRow
          key="__new"
          depth={depth}
          kind={creating.kind}
          onCommit={(name) => void commitCreate(name)}
          onCancel={() => setCreating(null)}
        />,
      );
    }
    for (const entry of dirs[path] ?? []) {
      const isExpanded = entry.isDir && expanded.has(entry.path);
      out.push(
        <Row
          key={entry.path}
          entry={entry}
          depth={depth}
          status={changes.get(entry.path)}
          dirty={entry.isDir && hasChangesUnder(entry.path)}
          expanded={isExpanded}
          selected={entry.path === openPath}
          onClick={() => toggle(entry)}
          onCreate={(kind) => startCreate(entry.path, kind)}
          onReload={() => void load(entry.path).catch(() => undefined)}
          onToggleSubtree={() => toggleSubtree(entry.path)}
        />,
      );
      if (isExpanded) out.push(...rows(entry.path, depth + 1));
    }
    return out;
  };

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-border/60 bg-card">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <h2 className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Files</h2>
        {changes.size > 0 ? (
          <span className="font-mono text-[10.5px] text-git-modified">{changes.size} changed</span>
        ) : null}
        <div className="flex-1" />
        <RowAction label="New file" onClick={() => startCreate("", "file")}>
          <NewFileIcon className="size-3.5" />
        </RowAction>
        <RowAction label="New folder" onClick={() => startCreate("", "dir")}>
          <NewFolderIcon className="size-3.5" />
        </RowAction>
        <RowAction label="Refresh" onClick={() => setTick((current) => current + 1)}>
          <RefreshIcon className="size-3.5" />
        </RowAction>
        <RowAction label="Collapse all" onClick={() => setExpanded(new Set([""]))}>
          <CollapseIcon className="size-3.5" />
        </RowAction>
        <Button variant="ghost" onClick={onClose} aria-label="Close files">
          <CloseIcon />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? <p className="px-3 py-4 text-[12px] text-destructive">{error}</p> : null}
        {rows("", 0)}
      </div>
    </aside>
  );
}
