import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { ChangedFile, Message, Thread, TreeEntry } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { ChevronIcon, CloseIcon, RefreshIcon, cn } from "./ui.tsx";

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

function Row({
  entry,
  depth,
  status,
  dirty,
  expanded,
  selected,
  onClick,
}: {
  entry: TreeEntry;
  depth: number;
  status: Status | undefined;
  dirty: boolean;
  expanded: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const decoration = status ? DECORATION[status] : null;

  return (
    <button
      onClick={onClick}
      title={entry.path}
      style={{ paddingLeft: depth * 12 + 6 }}
      className={cn(
        "flex h-[22px] w-full items-center gap-1 pr-2 text-left transition hover:bg-accent/50",
        selected && "bg-accent",
      )}
    >
      <span className="grid size-3 shrink-0 place-items-center text-faint">
        {entry.isDir ? (
          <ChevronIcon className={cn("size-3 transition", expanded ? "" : "-rotate-90")} />
        ) : null}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[12px]",
          decoration ? decoration.className : dirty ? "text-git-modified" : "text-muted-foreground",
          status === "deleted" && "line-through",
        )}
      >
        {entry.name}
      </span>
      {decoration ? (
        <span className={cn("shrink-0 font-mono text-[10.5px] font-semibold", decoration.className)}>
          {decoration.letter}
        </span>
      ) : dirty ? (
        <span className="shrink-0 text-[13px] leading-none text-git-modified">•</span>
      ) : null}
    </button>
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

  const hasChangesUnder = (dir: string) => {
    const prefix = `${dir}/`;
    for (const path of changes.keys()) if (path.startsWith(prefix)) return true;
    return false;
  };

  const rows = (path: string, depth: number): React.ReactNode[] =>
    (dirs[path] ?? []).flatMap((entry) => {
      const isExpanded = entry.isDir && expanded.has(entry.path);
      return [
        <Row
          key={entry.path}
          entry={entry}
          depth={depth}
          status={changes.get(entry.path)}
          dirty={entry.isDir && hasChangesUnder(entry.path)}
          expanded={isExpanded}
          selected={entry.path === openPath}
          onClick={() => toggle(entry)}
        />,
        ...(isExpanded ? rows(entry.path, depth + 1) : []),
      ];
    });

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-border/60 bg-card">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <h2 className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Files</h2>
        {changes.size > 0 ? (
          <span className="font-mono text-[10.5px] text-git-modified">{changes.size} changed</span>
        ) : null}
        <div className="flex-1" />
        <button
          onClick={() => setTick((current) => current + 1)}
          title="Refresh"
          className="rounded p-1 text-faint transition hover:bg-accent hover:text-foreground"
        >
          <RefreshIcon />
        </button>
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
