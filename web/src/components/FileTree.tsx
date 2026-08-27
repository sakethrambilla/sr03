import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";

import { api } from "../lib/api.ts";
import type { ChangedFile, Thread, TreeEntry } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  Dialog,
  DotsIcon,
  CollapseIcon,
  ExpandIcon,
  FileIcon,
  FolderIcon,
  NewFileIcon,
  NewFolderIcon,
  RefreshIcon,
  RenameIcon,
  RevealIcon,
  TrashIcon,
  WorktreeIcon,
  cn,
} from "./ui.tsx";

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

interface RowActions {
  onCreate: (kind: "file" | "dir") => void;
  onReveal: () => void;
  onCopy: (kind: "relative" | "absolute") => void;
  onStartRename: () => void;
  onDelete: () => void;
}

// the same items back both the row's … dropdown and its right-click menu
function RowMenuItems({
  Item,
  Separator,
  entry,
  canReveal,
  actions,
}: {
  Item: ComponentType<{
    children: ReactNode;
    variant?: "default" | "destructive";
    onSelect?: (event: Event) => void;
  }>;
  Separator: ComponentType<Record<string, never>>;
  entry: TreeEntry;
  canReveal: boolean;
  actions: RowActions;
}) {
  return (
    <>
      {entry.isDir ? (
        <>
          <Item onSelect={() => actions.onCreate("file")}>
            <NewFileIcon />
            New file…
          </Item>
          <Item onSelect={() => actions.onCreate("dir")}>
            <NewFolderIcon />
            New folder…
          </Item>
          <Separator />
        </>
      ) : null}
      {canReveal ? (
        <Item onSelect={actions.onReveal}>
          <RevealIcon />
          Reveal in Finder
        </Item>
      ) : null}
      <Item onSelect={() => actions.onCopy("relative")}>
        <CopyIcon />
        Copy relative path
      </Item>
      <Item onSelect={() => actions.onCopy("absolute")}>
        <CopyIcon />
        Copy path
      </Item>
      <Separator />
      <Item onSelect={actions.onStartRename}>
        <RenameIcon />
        Rename…
      </Item>
      <Item variant="destructive" onSelect={actions.onDelete}>
        <TrashIcon />
        Delete…
      </Item>
    </>
  );
}

function Row({
  entry,
  depth,
  status,
  dirty,
  expanded,
  selected,
  canReveal,
  onClick,
  onReload,
  onToggleSubtree,
  renaming,
  onRename,
  onCancelRename,
  actions,
}: {
  entry: TreeEntry;
  depth: number;
  status: Status | undefined;
  dirty: boolean;
  expanded: boolean;
  selected: boolean;
  canReveal: boolean;
  onClick: () => void;
  onReload: () => void;
  onToggleSubtree: () => void;
  renaming: boolean;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  actions: RowActions;
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
    // modal would trap focus while the menu closes, so Rename's input never gets it
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild disabled={renaming}>
        <div
          className={cn(
            "group/row flex h-[22px] w-full items-stretch transition hover:bg-accent/50",
            selected && "bg-accent",
          )}
        >
          <Guides depth={depth} />
          {renaming ? (
            <span className="flex min-w-0 flex-1 items-center gap-1 pr-2 pl-1">
              <span className="size-3 shrink-0" />
              {entry.isDir ? (
                <FolderIcon className="size-3.5 text-faint" />
              ) : (
                <FileIcon name={entry.name} />
              )}
              <NameInput
                initial={entry.name}
                placeholder="new name"
                onCommit={onRename}
                onCancel={onCancelRename}
              />
            </span>
          ) : (
            <button
              onClick={onClick}
              title={entry.path}
              className="flex min-w-0 flex-1 items-center gap-1 pl-1 text-left"
            >
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
          )}

          {renaming ? null : (
            <span className="hidden items-center gap-0.5 pr-1 group-hover/row:flex has-[[data-state=open]]:flex">
              {entry.isDir ? (
                <>
                  <RowAction label="New file" onClick={() => actions.onCreate("file")}>
                    <NewFileIcon className="size-3" />
                  </RowAction>
                  <RowAction label="New folder" onClick={() => actions.onCreate("dir")}>
                    <NewFolderIcon className="size-3" />
                  </RowAction>
                  <RowAction label="Reload folder" onClick={onReload}>
                    <RefreshIcon className="size-3" />
                  </RowAction>
                  <RowAction label={expanded ? "Collapse folder" : "Expand folder"} onClick={onToggleSubtree}>
                    {expanded ? <CollapseIcon className="size-3" /> : <ExpandIcon className="size-3" />}
                  </RowAction>
                </>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  title="More"
                  aria-label="More"
                  onClick={(event) => event.stopPropagation()}
                  className="grid size-4 place-items-center rounded text-faint outline-none transition hover:bg-accent hover:text-foreground"
                >
                  <DotsIcon className="size-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  className="min-w-36"
                  // closing the menu would otherwise pull focus back to the trigger and
                  // blur the rename input the moment it mounts, cancelling the rename
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <RowMenuItems
                    Item={DropdownMenuItem}
                    Separator={DropdownMenuSeparator}
                    entry={entry}
                    canReveal={canReveal}
                    actions={actions}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )}

          <span className={cn("flex shrink-0 items-center pr-2", "group-hover/row:hidden")}>
            {decoration ? (
              <span className={cn("font-mono text-[10.5px] font-semibold", decoration.className)}>
                {decoration.letter}
              </span>
            ) : dirty ? (
              <span className="size-1.5 rounded-full bg-git-modified" />
            ) : null}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-44"
        // closing the menu would otherwise pull focus back to the row and blur the
        // rename input the moment it mounts, cancelling the rename
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <RowMenuItems
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
          entry={entry}
          canReveal={canReveal}
          actions={actions}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function NameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  // renaming should land with the stem selected, so typing replaces the name but keeps the suffix
  useEffect(() => {
    if (!initial) return;
    const dot = initial.lastIndexOf(".");
    ref.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  return (
    <input
      ref={ref}
      value={name}
      onChange={(event) => setName(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && name.trim()) onCommit(name.trim());
        if (event.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
      autoFocus
      spellCheck={false}
      placeholder={placeholder}
      className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-foreground outline-none placeholder:text-faint"
    />
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
  return (
    <div className="flex h-[22px] w-full items-stretch bg-accent/40">
      <Guides depth={depth} />
      <span className="flex min-w-0 flex-1 items-center gap-1 pr-2 pl-1">
        <span className="size-3 shrink-0" />
        {kind === "dir" ? <FolderIcon className="size-3.5 text-faint" /> : <FileIcon name="x" />}
        <NameInput
          initial=""
          placeholder={kind === "dir" ? "folder name" : "file name"}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </span>
    </div>
  );
}


export function FileTree({
  thread,
  openPath,
  onOpenFile,
  onRenamed,
  onDeleted,
  refreshToken,
  onClose,
}: {
  thread: Thread;
  openPath: string | null;
  onOpenFile: (path: string) => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (path: string) => void;
  refreshToken: number;
  onClose: () => void;
}) {
  const fsTick = useStore((state) => state.fsVersionByThread[thread.id] ?? 0);
  const canReveal = useStore((state) => state.apps.some((app) => app.id === "finder"));
  const [dirs, setDirs] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [changes, setChanges] = useState<Map<string, Status>>(new Map());
  const [branch, setBranch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "dir" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (path: string) => {
      const listing = await api.tree(thread.id, path);
      setDirs((current) => ({ ...current, [path]: listing.entries }));
    },
    [thread.id],
  );

  // reloading every open directory keeps files Claude just created from going missing; the
  // trigger settles a moment after the last write, so a busy turn costs one pass, not fifty
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
        setBranch(next.branch);
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
  }, [thread.id, fsTick, tick, refreshToken]);

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

  const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

  const commitRename = async (entry: TreeEntry, name: string) => {
    setRenaming(null);
    if (name === entry.name) return;
    try {
      const next = await api.renameEntry(thread.id, entry.path, name);
      await load(parentOf(entry.path));
      onRenamed(entry.path, next.path);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await api.trashEntry(thread.id, pendingDelete.path);
      await load(parentOf(pendingDelete.path));
      onDeleted(pendingDelete.path);
      setPendingDelete(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reveal = (rel: string) => {
    api.revealEntry(thread.id, rel).catch((cause: Error) => setError(cause.message));
  };

  const copyPath = (rel: string, kind: "relative" | "absolute") => {
    navigator.clipboard
      .writeText(kind === "relative" ? rel : `${thread.cwd}/${rel}`)
      .catch((cause: Error) => setError(cause.message));
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
          canReveal={canReveal}
          onClick={() => toggle(entry)}
          onReload={() => void load(entry.path).catch(() => undefined)}
          onToggleSubtree={() => toggleSubtree(entry.path)}
          renaming={renaming === entry.path}
          onRename={(name) => void commitRename(entry, name)}
          onCancelRename={() => setRenaming(null)}
          actions={{
            onCreate: (kind) => startCreate(entry.path, kind),
            onReveal: () => reveal(entry.path),
            onCopy: (kind) => copyPath(entry.path, kind),
            onStartRename: () => setRenaming(entry.path),
            onDelete: () => setPendingDelete(entry),
          }}
        />,
      );
      if (isExpanded) out.push(...rows(entry.path, depth + 1));
    }
    return out;
  };

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-border/60 bg-card">
      <header className="flex flex-col gap-1 border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
        <h2 className="shrink-0 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Files</h2>
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
        </div>

        {/* the branch needs the full panel width, so it sits under the title rather than beside it */}
        {branch || changes.size > 0 ? (
          <div className="flex items-center gap-2">
            {branch ? (
              <span
                title={thread.isWorktree ? `Worktree on ${branch}` : `On ${branch}`}
                className={cn(
                  "flex min-w-0 items-center gap-1 font-mono text-[10.5px]",
                  thread.isWorktree ? "text-primary" : "text-faint",
                )}
              >
                {thread.isWorktree ? (
                  <WorktreeIcon className="size-2.5 shrink-0" />
                ) : (
                  <BranchIcon className="size-2.5 shrink-0" />
                )}
                <span className="truncate">{branch}</span>
              </span>
            ) : null}
            {changes.size > 0 ? (
              <span className="shrink-0 font-mono text-[10.5px] text-git-modified">
                {changes.size} changed
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? <p className="px-3 py-4 text-[12px] text-destructive">{error}</p> : null}
        {rows("", 0)}
      </div>

      {pendingDelete ? (
        <Dialog
          title={`Delete ${pendingDelete.name}?`}
          onClose={() => setPendingDelete(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setPendingDelete(null)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
                Move to Trash
              </Button>
            </div>
          }
        >
          <p className="text-[13px] text-muted-foreground">
            <span className="font-mono text-foreground">{pendingDelete.path}</span>
            {pendingDelete.isDir ? " and everything inside it" : ""} moves to your Trash, so you can
            put it back from Finder.
          </p>
        </Dialog>
      ) : null}
    </aside>
  );
}
