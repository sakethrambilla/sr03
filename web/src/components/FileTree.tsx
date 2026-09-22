// The session folder's tree: lazily expanded directories, git status decorations, and the row
// actions — open, create, rename, trash, reveal in Finder. Re-reads itself when a turn writes
// to disk, which the store signals through fsVersionByThread.
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";

import { api } from "../lib/api.ts";
import {
  INDENT,
  ancestors,
  dirtyAncestors,
  projectRows,
  toggleSubtree,
} from "../lib/filetree.ts";
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
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  Dialog,
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

// the panel's one right-click menu, parameterised over Item/Separator so the menu kind can change
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

const Row = memo(function Row({
  entry,
  depth,
  status,
  dirty,
  expanded,
  selected,
  onActivate,
  onReload,
  onToggleSubtree,
  onCreateIn,
  onOpenMenu,
  renaming,
  onRename,
  onCancelRename,
}: {
  entry: TreeEntry;
  depth: number;
  status: Status | undefined;
  dirty: boolean;
  expanded: boolean;
  selected: boolean;
  onActivate: (entry: TreeEntry) => void;
  onReload: (entry: TreeEntry) => void;
  onToggleSubtree: (entry: TreeEntry) => void;
  onCreateIn: (entry: TreeEntry, kind: "file" | "dir") => void;
  onOpenMenu: (entry: TreeEntry, x: number, y: number) => void;
  renaming: boolean;
  onRename: (entry: TreeEntry, name: string) => void;
  onCancelRename: () => void;
}) {
  const [hovered, setHovered] = useState(false);
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
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onContextMenu={(event) => {
            // right-clicking mid-rename would blur the input and cancel the rename
            if (renaming) return;
            event.preventDefault();
            onOpenMenu(entry, event.clientX, event.clientY);
          }}
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
                onCommit={(name) => onRename(entry, name)}
                onCancel={onCancelRename}
              />
            </span>
          ) : (
            <button
              onClick={() => onActivate(entry)}
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

          {!renaming && hovered && entry.isDir ? (
            <span className="flex items-center gap-0.5 pr-1">
              <RowAction label="New file" onClick={() => onCreateIn(entry, "file")}>
                <NewFileIcon className="size-3" />
              </RowAction>
              <RowAction label="New folder" onClick={() => onCreateIn(entry, "dir")}>
                <NewFolderIcon className="size-3" />
              </RowAction>
              <RowAction label="Reload folder" onClick={() => onReload(entry)}>
                <RefreshIcon className="size-3" />
              </RowAction>
              <RowAction
                label={expanded ? "Collapse folder" : "Expand folder"}
                onClick={() => onToggleSubtree(entry)}
              >
                {expanded ? <CollapseIcon className="size-3" /> : <ExpandIcon className="size-3" />}
              </RowAction>
            </span>
          ) : null}

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
  );
});

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
  const [menu, setMenu] = useState<{ entry: TreeEntry; x: number; y: number } | null>(null);

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

  const toggle = useCallback(
    (entry: TreeEntry) => {
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
    },
    [onOpenFile],
  );

  const startCreate = useCallback((parent: string, kind: "file" | "dir") => {
    setExpanded((current) => new Set(current).add(parent));
    setCreating({ parent, kind });
  }, []);

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

  const commitRename = useCallback(
    async (entry: TreeEntry, name: string) => {
      setRenaming(null);
      if (name === entry.name) return;
      try {
        const next = await api.renameEntry(thread.id, entry.path, name);
        await load(parentOf(entry.path));
        onRenamed(entry.path, next.path);
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [thread.id, load, onRenamed],
  );

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
  const toggleSubtreeAt = (dir: string) => {
    setExpanded((current) => toggleSubtree(current, dirs, dir));
  };

  const dirtyDirs = useMemo(() => dirtyAncestors(changes.keys()), [changes]);
  const rows = useMemo(() => projectRows(dirs, expanded), [dirs, expanded]);

  // per-action props rather than one object: an inline actions literal is a fresh object every
  // render and would defeat Row's memo
  const onReloadEntry = useCallback(
    (entry: TreeEntry) => void load(entry.path).catch(() => undefined),
    [load],
  );
  const onToggleSubtreeEntry = useCallback((entry: TreeEntry) => toggleSubtreeAt(entry.path), [dirs]);
  const onCreateIn = useCallback(
    (entry: TreeEntry, kind: "file" | "dir") => startCreate(entry.path, kind),
    [startCreate],
  );
  const onRenameEntry = useCallback(
    (entry: TreeEntry, name: string) => void commitRename(entry, name),
    [commitRename],
  );
  const onCancelRename = useCallback(() => setRenaming(null), []);
  const onOpenMenu = useCallback(
    (entry: TreeEntry, x: number, y: number) => setMenu({ entry, x, y }),
    [],
  );

  // RowMenuItems' callbacks take no arguments, so they are rebuilt for whichever row opened the menu
  const menuActions = useMemo<RowActions>(
    () => ({
      onCreate: (kind) => menu && startCreate(menu.entry.path, kind),
      onReveal: () => menu && reveal(menu.entry.path),
      onCopy: (kind) => menu && copyPath(menu.entry.path, kind),
      onStartRename: () => menu && setRenaming(menu.entry.path),
      onDelete: () => menu && setPendingDelete(menu.entry),
    }),
    [menu],
  );

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
        {creating?.parent === "" ? (
          <NewEntryRow
            depth={0}
            kind={creating.kind}
            onCommit={(name) => void commitCreate(name)}
            onCancel={() => setCreating(null)}
          />
        ) : null}
        {rows.map(({ entry, depth }) => (
          <Fragment key={entry.path}>
            <Row
              entry={entry}
              depth={depth}
              status={changes.get(entry.path)}
              dirty={entry.isDir && dirtyDirs.has(entry.path)}
              expanded={entry.isDir && expanded.has(entry.path)}
              selected={entry.path === openPath}
              onActivate={toggle}
              onReload={onReloadEntry}
              onToggleSubtree={onToggleSubtreeEntry}
              onCreateIn={onCreateIn}
              onOpenMenu={onOpenMenu}
              renaming={renaming === entry.path}
              onRename={onRenameEntry}
              onCancelRename={onCancelRename}
            />
            {creating?.parent === entry.path ? (
              <NewEntryRow
                depth={depth + 1}
                kind={creating.kind}
                onCommit={(name) => void commitCreate(name)}
                onCancel={() => setCreating(null)}
              />
            ) : null}
          </Fragment>
        ))}
      </div>

      {/* modal would trap focus while the menu closes, so Rename's input never gets it */}
      <DropdownMenu
        modal={false}
        open={menu !== null}
        onOpenChange={(open) => {
          if (!open) setMenu(null);
        }}
      >
        <DropdownMenuTrigger
          aria-hidden
          tabIndex={-1}
          className="fixed size-0"
          style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
        />
        <DropdownMenuContent
          align="start"
          className="min-w-44"
          // closing the menu would otherwise pull focus back to the trigger and blur the
          // rename input the moment it mounts, cancelling the rename
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {menu ? (
            <RowMenuItems
              Item={DropdownMenuItem}
              Separator={DropdownMenuSeparator}
              entry={menu.entry}
              canReveal={canReveal}
              actions={menuActions}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

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
