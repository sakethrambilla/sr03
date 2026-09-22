// The session folder's tree: lazily expanded directories, git status decorations, and the row
// actions — open, create, rename, trash, reveal in Finder. Re-reads itself when a turn writes
// to disk, which the store signals through fsVersionByThread.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { api } from "../lib/api.ts";
import {
  INDENT,
  OVERSCAN,
  REFRESH_CONCURRENCY,
  ROW_HEIGHT,
  ancestors,
  createDirLoadTracker,
  dirtyAncestors,
  forEachWithConcurrency,
  projectRows,
  toggleSubtree,
} from "../lib/filetree.ts";
import type { DirLoadTracker, TreeRow } from "../lib/filetree.ts";
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
  SpinnerIcon,
  TrashIcon,
  WorktreeIcon,
  cn,
} from "./ui.tsx";

type Status = ChangedFile["status"];

// stable empty identity for the two loading sets, so an idle render never produces a new set
const EMPTY_DIRS: ReadonlySet<string> = new Set();

// how long a read may take before its row shows a spinner
const SPINNER_DELAY_MS = 150;

// how long the ignore lookup waits for the per-directory setDirs commits of a refresh to settle
const IGNORE_DEBOUNCE_MS = 150;

function withPath(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  if (set.has(path)) return set;
  const next = new Set(set);
  next.add(path);
  return next;
}

function withoutPath(set: ReadonlySet<string>, path: string): ReadonlySet<string> {
  if (!set.has(path)) return set;
  const next = new Set(set);
  next.delete(path);
  return next.size === 0 ? EMPTY_DIRS : next;
}

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
  ignored,
  expanded,
  selected,
  isLoading,
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
  ignored: boolean;
  expanded: boolean;
  selected: boolean;
  isLoading: boolean;
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
  const tint = ignored
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
                // the spinner takes the folder icon's slot, so the chevron stays turned
                isLoading ? (
                  <SpinnerIcon className="size-3.5 animate-spin text-faint" />
                ) : (
                  <FolderIcon className={cn("size-3.5", ignored ? "text-git-ignored" : "text-faint")} />
                )
              ) : (
                <FileIcon name={entry.name} muted={ignored} />
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
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(EMPTY_DIRS);
  const [slowDirs, setSlowDirs] = useState<ReadonlySet<string>>(EMPTY_DIRS);
  const [ignoredSet, setIgnoredSet] = useState<ReadonlySet<string>>(EMPTY_DIRS);
  const [tick, setTick] = useState(0);
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "dir" } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ entry: TreeEntry; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackerRef = useRef<DirLoadTracker | null>(null);
  if (trackerRef.current === null) trackerRef.current = createDirLoadTracker();
  const ignoreTrackerRef = useRef<DirLoadTracker | null>(null);
  if (ignoreTrackerRef.current === null) ignoreTrackerRef.current = createDirLoadTracker();
  const slowTimersRef = useRef<Map<string, number>>(new Map());
  // read through a ref so load's identity does not change with every listing, which would
  // rebuild the row callbacks and defeat Row's memo
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  const load = useCallback(
    async (path: string, options?: { force?: boolean }) => {
      if (!options?.force && (dirsRef.current[path]?.length ?? 0) > 0) return;
      const token = trackerRef.current!.begin(path);
      setLoadingDirs((current) => withPath(current, path));

      const clearTimer = () => {
        const timer = slowTimersRef.current.get(path);
        if (timer === undefined) return;
        window.clearTimeout(timer);
        slowTimersRef.current.delete(path);
      };
      const settle = () => {
        clearTimer();
        setLoadingDirs((current) => withoutPath(current, path));
        setSlowDirs((current) => withoutPath(current, path));
      };

      // a forced re-read skips the delay entirely: a refresh must not flash a spinner on every
      // open folder whose contents did not change
      if (!options?.force) {
        clearTimer();
        slowTimersRef.current.set(
          path,
          window.setTimeout(() => {
            slowTimersRef.current.delete(path);
            setSlowDirs((current) => withPath(current, path));
          }, SPINNER_DELAY_MS),
        );
      }

      try {
        const listing = await api.tree(thread.id, path);
        if (!trackerRef.current!.isCurrent(token)) return;
        setDirs((current) => ({ ...current, [path]: listing.entries }));
        setDirErrors((current) => {
          if (current[path] === undefined) return current;
          const next = { ...current };
          delete next[path];
          return next;
        });
        settle();
      } catch (cause) {
        if (!trackerRef.current!.isCurrent(token)) return;
        setDirErrors((current) => ({ ...current, [path]: (cause as Error).message }));
        // a failed root read is the panel's own error, so it stays distinguishable from an empty root
        if (path === "") setError((cause as Error).message);
        settle();
      }
    },
    [thread.id],
  );

  // reloading every open directory keeps files Claude just created from going missing; the
  // trigger settles a moment after the last write, so a busy turn costs one pass, not fifty.
  // The directory half needs no cancellation flag — load's per-directory tokens supersede a
  // stale read, and a thread change unmounts the panel.
  useEffect(() => {
    let cancelled = false;
    const open = [...expanded];
    void (async () => {
      try {
        const next = await api.changes(thread.id);
        if (!cancelled) {
          setChanges(new Map(next.files.map((file) => [file.path, file.status])));
          setBranch(next.branch);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
      await forEachWithConcurrency(open, REFRESH_CONCURRENCY, (path) =>
        load(path, { force: true }),
      );
    })();
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

  // the loadingDirs and dirErrors clauses both prevent a re-load loop: a read in flight would be
  // restarted whenever another directory resolves, and a failed read would retry without limit
  useEffect(() => {
    for (const path of expanded)
      if (!dirs[path] && !loadingDirs.has(path) && !dirErrors[path]) void load(path);
  }, [expanded, dirs, loadingDirs, dirErrors, load]);

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
      await load(creating.parent, { force: true });
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
        await load(parentOf(entry.path), { force: true });
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
      await load(parentOf(pendingDelete.path), { force: true });
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

  // keyed on content, not array identity: the projection is rebuilt whenever dirs commits
  const visiblePaths = useMemo(() => rows.map((row) => row.entry.path), [rows]);
  const ignoreKey = useMemo(() => visiblePaths.join("\n"), [visiblePaths]);

  // debounced because a refresh commits one setDirs per directory, which would otherwise be one
  // lookup per open folder; fsTick/tick re-ask when .gitignore changed but the path set did not
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const token = ignoreTrackerRef.current!.begin("ignored");
      const paths = ignoreKey === "" ? [] : ignoreKey.split("\n");
      api
        .ignored(thread.id, paths)
        .then((answer) => {
          if (!ignoreTrackerRef.current!.isCurrent(token)) return;
          setIgnoredSet(answer.ignored.length === 0 ? EMPTY_DIRS : new Set(answer.ignored));
        })
        .catch(() => undefined);
    }, IGNORE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [ignoreKey, fsTick, tick, thread.id]);

  // the most recently failed directory — one strip in the header, never a row in the list; the
  // root's failure is reported through the panel-level error instead
  const failedDir = Object.keys(dirErrors)
    .filter((path) => path !== "")
    .at(-1);

  // index of the create row within the virtual list, or -1
  const creatingIndex = useMemo(() => {
    if (!creating) return -1;
    if (creating.parent === "") return 0;
    const parentAt = rows.findIndex((row) => row.entry.path === creating.parent);
    return parentAt === -1 ? -1 : parentAt + 1;
  }, [creating, rows]);

  const count = rows.length + (creatingIndex >= 0 ? 1 : 0);
  const rowAt = (index: number): TreeRow | null => {
    if (index === creatingIndex) return null;
    return rows[creatingIndex >= 0 && index > creatingIndex ? index - 1 : index] ?? null;
  };

  const creatingDepth =
    creatingIndex > 0 ? (rows[creatingIndex - 1]?.depth ?? 0) + 1 : 0;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) =>
      index === creatingIndex ? "__new" : (rowAt(index)?.entry.path ?? `__row_${index}`),
  });

  useEffect(() => {
    if (creatingIndex >= 0) virtualizer.scrollToIndex(creatingIndex, { align: "auto" });
  }, [creatingIndex]);

  // per-action props rather than one object: an inline actions literal is a fresh object every
  // render and would defeat Row's memo
  const onReloadEntry = useCallback(
    (entry: TreeEntry) => void load(entry.path, { force: true }),
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

        {/* outside the scroll container: inside, it would offset every virtual item's position */}
        {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
        {failedDir !== undefined ? (
          <p className="truncate text-[12px] text-destructive">
            Could not read <span className="font-mono">{failedDir}</span>
          </p>
        ) : null}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto py-1">
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rowAt(item.index);
            return (
              <div
                key={item.key}
                data-index={item.index}
                className="absolute left-0 right-0"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {item.index === creatingIndex && creating ? (
                  <NewEntryRow
                    depth={creatingDepth}
                    kind={creating.kind}
                    onCommit={(name) => void commitCreate(name)}
                    onCancel={() => setCreating(null)}
                  />
                ) : row ? (
                  <Row
                    entry={row.entry}
                    depth={row.depth}
                    status={changes.get(row.entry.path)}
                    dirty={row.entry.isDir && dirtyDirs.has(row.entry.path)}
                    ignored={ignoredSet.has(row.entry.path)}
                    expanded={row.entry.isDir && expanded.has(row.entry.path)}
                    selected={row.entry.path === openPath}
                    isLoading={row.entry.isDir && slowDirs.has(row.entry.path)}
                    onActivate={toggle}
                    onReload={onReloadEntry}
                    onToggleSubtree={onToggleSubtreeEntry}
                    onCreateIn={onCreateIn}
                    onOpenMenu={onOpenMenu}
                    renaming={renaming === row.entry.path}
                    onRename={onRenameEntry}
                    onCancelRename={onCancelRename}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
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
