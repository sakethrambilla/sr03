// One open session: the header, the transcript and composer, and the panels around them — file
// tree, file tabs, terminal, agents. Owns which files are open, which of them have unsaved edits,
// and the session-scoped shortcuts listed in SHORTCUTS.md.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../lib/api.ts";
import { createFileIndex } from "../lib/fileref.ts";
import type { FileRef } from "../lib/fileref.ts";
import type { Message, Thread, ThreadTask } from "../lib/types.ts";
import { EMPTY_PROVIDER, useStore } from "../store.ts";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { ThreadComposer } from "./Composer.tsx";
import { FileTree } from "./FileTree.tsx";
import { FileView } from "./FileView.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import type { PaletteMode } from "./SearchPalette.tsx";
import { Timeline } from "./Timeline.tsx";
import { SidebarToggle } from "./Sidebar.tsx";
import { Separator } from "@/components/ui/separator";
import {
  AgentIcon,
  BranchIcon,
  ChangesIcon,
  Dialog,
  ChevronIcon,
  CloseIcon,
  CodeIcon,
  CursorIcon,
  FileIcon,
  FolderIcon,
  MessageIcon,
  StatusDot,
  TerminalIcon,
  WorktreeIcon,
  ZedIcon,
  cn,
  usePersistedIdState,
  usePersistedState,
} from "./ui.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const NO_TASKS: ThreadTask[] = [];
const NO_FILES: string[] = [];

// today's h-64; a thread that has never been sized opens here, and double-clicking the sash
// comes back to it
const TERMINAL_HEIGHT = 256;

// xterm is ~490 KB of the main bundle for a panel most sessions never open — load it only
// once someone actually asks for a terminal
const TerminalPanel = lazy(() =>
  import("./TerminalPanel.tsx").then((module) => ({ default: module.TerminalPanel })),
);

function PanelToggle({
  pressed,
  onPressedChange,
  label,
  children,
}: {
  pressed: boolean;
  onPressedChange: (next: boolean) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <Toggle
      size="sm"
      pressed={pressed}
      onPressedChange={onPressedChange}
      aria-label={label}
      className="text-faint data-[state=on]:text-foreground"
    >
      {children}
    </Toggle>
  );
}

// lucide has no brand marks, so these only stand in when the real bundle icon can't be read
const APP_ICONS: Record<string, typeof CodeIcon> = {
  finder: FolderIcon,
  cursor: CursorIcon,
  zed: ZedIcon,
  vscode: CodeIcon,
};

function AppIcon({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  const Fallback = APP_ICONS[id] ?? CodeIcon;

  if (failed) return <Fallback />;
  return (
    <img
      src={`/api/apps/${id}/icon`}
      alt=""
      onError={() => setFailed(true)}
      className="size-4 shrink-0"
    />
  );
}

// the worktree/branch icon pair matches the file tree's footer, so the two never disagree
function BranchChip({ branch, isWorktree }: { branch: string; isWorktree: boolean }) {
  return (
    <span
      title={isWorktree ? `Worktree on ${branch}` : `On ${branch}`}
      className={cn(
        "flex min-w-0 max-w-48 items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 font-mono text-[10.5px]",
        isWorktree ? "text-primary" : "text-faint",
      )}
    >
      {isWorktree ? (
        <WorktreeIcon className="size-2.5 shrink-0" />
      ) : (
        <BranchIcon className="size-2.5 shrink-0" />
      )}
      <span className="truncate">{branch}</span>
    </span>
  );
}

function OpenMenu({ thread }: { thread: Thread }) {
  const apps = useStore((state) => state.apps);
  const setError = useStore((state) => state.setError);
  const [preferred, setPreferred] = usePersistedState<string>("open-app", "vscode");

  const primary = apps.find((app) => app.id === preferred) ?? apps[0] ?? null;

  const launch = (id: string) => {
    setPreferred(id);
    api.openIn(thread.id, id).catch((cause: Error) => setError(cause.message));
  };

  useEffect(() => {
    if (!primary) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "o") return;
      event.preventDefault();
      launch(primary.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [primary?.id, thread.id]);

  if (!primary) return null;

  return (
    <div className="flex h-7 shrink-0 items-center rounded-md border border-border/70 bg-accent/40">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            onClick={() => launch(primary.id)}
            className="h-full gap-1.5 rounded-r-none px-2 text-[12px] font-normal text-muted-foreground"
          >
            <AppIcon id={primary.id} />
            Open
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Open in {primary.label} <span className="text-faint">⌘O</span>
        </TooltipContent>
      </Tooltip>
      <Separator orientation="vertical" className="h-4" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            aria-label="Open in…"
            className="h-full rounded-l-none px-1 text-muted-foreground"
          >
            <ChevronIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {apps.map((app) => (
            <DropdownMenuItem key={app.id} onSelect={() => launch(app.id)}>
              <AppIcon id={app.id} />
              <span className="min-w-0 flex-1 truncate">{app.label}</span>
              {app.id === primary.id ? <DropdownMenuShortcut>⌘O</DropdownMenuShortcut> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}


function EditorTabs({
  title,
  files,
  active,
  dirty,
  onSelect,
  onClose,
}: {
  title: string;
  files: string[];
  active: string | null;
  dirty: Set<string>;
  onSelect: (path: string | null) => void;
  onClose: (path: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border/60 bg-background">
      <button
        onClick={() => onSelect(null)}
        title={title}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 border-r border-border/60 px-3 text-[12px] transition",
          active === null
            ? "bg-card text-foreground shadow-[inset_0_1px_0_var(--color-primary)]"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <MessageIcon className="size-3.5" />
        <span className="max-w-40 truncate">{title}</span>
      </button>

      {files.map((path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        return (
          <div
            key={path}
            onAuxClick={(event) => {
              if (event.button === 1) onClose(path);
            }}
            className={cn(
              "group/tab flex h-8 shrink-0 items-center gap-1.5 border-r border-border/60 pr-1.5 pl-3 transition",
              path === active
                ? "bg-card shadow-[inset_0_1px_0_var(--color-primary)]"
                : "hover:bg-card/50",
            )}
          >
            <button
              onClick={() => onSelect(path)}
              title={path}
              className="flex min-w-0 items-center gap-1.5 text-[12px]"
            >
              <FileIcon name={name} />
              <span
                className={cn(
                  "max-w-40 truncate",
                  path === active ? "text-foreground" : "text-muted-foreground",
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
                path === active || dirty.has(path) ? "" : "opacity-0 group-hover/tab:opacity-100",
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

export function ChatView({ thread }: { thread: Thread }) {
  const setError = useStore((state) => state.setError);
  const provider = useStore(
    (state) => state.providers.find((entry) => entry.id === thread.providerId) ?? EMPTY_PROVIDER,
  );
  const tasks = useStore((state) => state.tasksByThread[thread.id] ?? NO_TASKS);
  const workspace = useStore((state) => state.filesByCwd[thread.cwd] ?? NO_FILES);
  const loadFiles = useStore((state) => state.loadFiles);
  const fsTick = useStore((state) => state.fsVersionByThread[thread.id] ?? 0);
  const [treeOpen, setTreeOpen] = usePersistedState<boolean>("file-tree", false);
  // the terminal panel is per thread: a shared flag would open it — and spawn a shell — in
  // every session you merely pass through
  const [terminalOpen, setTerminalOpen] = usePersistedIdState<boolean>(
    "terminal.open",
    thread.id,
    false,
  );
  const [terminalHeight, setTerminalHeight] = usePersistedIdState<number>(
    "terminal.height",
    thread.id,
    TERMINAL_HEIGHT,
  );
  const [terminalMax, setTerminalMax] = usePersistedIdState<boolean>(
    "terminal.max",
    thread.id,
    false,
  );
  const [agentsOpen, setAgentsOpen] = usePersistedState<boolean>("agents", false);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ path: string; line: number; key: number } | null>(null);
  const [command, setCommand] = useState<{ text: string; key: number } | null>(null);
  const [restore, setRestore] = useState<{ text: string; key: number } | null>(null);
  const [pendingRewind, setPendingRewind] = useState<Message | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [palette, setPalette] = useState<PaletteMode | null>(null);
  const [fsVersion, setFsVersion] = useState(0);
  // seeded from the stored value so the chip paints on the first frame, then kept live: the
  // column is written once at creation and any checkout since would leave it stale
  const [branch, setBranch] = useState<string | null>(thread.branch);

  // each open FileView registers its own save, since only it holds the edited text
  const savers = useRef(new Map<string, () => Promise<boolean>>());
  const registerSave = useCallback((path: string, save: (() => Promise<boolean>) | null) => {
    if (save) savers.current.set(path, save);
    else savers.current.delete(path);
  }, []);

  const markDirty = useCallback((path: string, isDirty: boolean) => {
    setDirty((current) => {
      if (current.has(path) === isDirty) return current;
      const next = new Set(current);
      if (isDirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  // a maximized terminal covers the editor, so anything that needs the editor gives it back.
  // through a ref because openFile must stay stable — every FileView holds it via links
  const restorePanel = useRef(() => {});
  restorePanel.current = () => {
    if (terminalMax) setTerminalMax(false);
  };

  const openFile = useCallback((path: string, line?: number) => {
    setOpenFiles((files) => (files.includes(path) ? files : [...files, path]));
    setActive(path);
    restorePanel.current();
    // the key is what makes clicking the same reference twice jump again
    if (line) setReveal((current) => ({ path, line, key: (current?.key ?? 0) + 1 }));
  }, []);

  const selectTab = (path: string | null) => {
    setActive(path);
    restorePanel.current();
  };

  // closing the active tab lands on its neighbour, falling back to the chat
  const closeFile = (path: string) => {
    const index = openFiles.indexOf(path);
    const next = openFiles.filter((file) => file !== path);
    setOpenFiles(next);
    markDirty(path, false);
    if (active === path) setActive(next[index] ?? next[index - 1] ?? null);
    promptNextDirty(next, path);
  };

  const requestClose = (path: string) => {
    if (dirty.has(path)) setPendingClose(path);
    else closeFile(path);
  };

  // every mounted file view gets the same function objects, so a streaming frame that
  // re-renders this component doesn't re-render each of them too
  const latestRequestClose = useRef(requestClose);
  latestRequestClose.current = requestClose;
  const closeFileTab = useCallback((path: string) => latestRequestClose.current(path), []);
  const savedFile = useCallback(() => setFsVersion((current) => current + 1), []);

  const saveAndClose = async (path: string) => {
    const saved = await savers.current.get(path)?.();
    setPendingClose(null);
    // a failed write keeps the tab open so the edits are not lost
    if (saved) closeFile(path);
  };

  // closing several tabs asks about each unsaved one in turn, so nothing is lost
  const closingAll = useRef(false);

  const promptNextDirty = (remaining: string[], justClosed: string) => {
    const next = remaining.find((file) => file !== justClosed && dirty.has(file));
    if (closingAll.current && next) setPendingClose(next);
    else closingAll.current = false;
  };

  const closeAll = () => {
    const unsaved = openFiles.filter((file) => dirty.has(file));
    setOpenFiles(unsaved);
    setActive(unsaved[0] ?? null);
    closingAll.current = unsaved.length > 0;
    if (unsaved[0]) setPendingClose(unsaved[0]);
  };

  // a turn that wrote to disk may have added or renamed files, so the index follows it
  useEffect(() => {
    void loadFiles(thread.id, thread.cwd);
  }, [loadFiles, thread.id, thread.cwd, fsTick, fsVersion]);

  useEffect(() => {
    let cancelled = false;
    setBranch(thread.branch);
    api
      .threadGit(thread.id)
      .then((info) => {
        if (!cancelled) setBranch(info.branch);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [thread.id, thread.branch, fsTick, fsVersion]);

  // the panel owns the terminals, so it is left to decide which one a command lands in
  const runCommand = useCallback(
    (text: string) => {
      setTerminalOpen(true);
      setCommand((current) => ({ text, key: (current?.key ?? 0) + 1 }));
    },
    [setTerminalOpen],
  );

  // the transcript is the only copy of a turn, so a rewind asks before dropping any of it
  const rewind = async (message: Message) => {
    setPendingRewind(null);
    try {
      const { text } = await api.rewind(thread.id, message.id);
      setRestore((current) => ({ text, key: (current?.key ?? 0) + 1 }));
    } catch (error) {
      setError((error as Error).message);
    }
  };

  const index = useMemo(() => createFileIndex(workspace), [workspace]);
  const links = useMemo(
    () => ({
      resolve: index.resolve,
      imports: index.imports,
      bindings: index.bindings,
      open: (ref: FileRef) => openFile(ref.path, ref.line),
    }),
    [index, openFile],
  );

  // a fresh burst of subagents pops the panel open; closing it mid-burst keeps it closed
  const working = tasks.filter((task) => task.status === "running").length;
  const wasWorking = useRef(0);

  useEffect(() => {
    if (provider.capabilities.tasks && working > 0 && wasWorking.current === 0) setAgentsOpen(true);
    wasWorking.current = working;
  }, [provider.capabilities.tasks, working]);

  const chord = useRef<number | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      // cmd+k arms a chord; the next key decides what it meant
      if (chord.current !== null) {
        window.clearTimeout(chord.current);
        chord.current = null;
        if (key === "w") {
          event.preventDefault();
          closeAll();
          return;
        }
      }
      if (!meta) return;

      if (key === "k") {
        event.preventDefault();
        chord.current = window.setTimeout(() => (chord.current = null), 2000);
        return;
      }
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        setTreeOpen(!treeOpen);
        return;
      }
      if (key === "a" && event.shiftKey && provider.capabilities.tasks) {
        event.preventDefault();
        setAgentsOpen(!agentsOpen);
        return;
      }
      if (key === "j" && !event.shiftKey) {
        event.preventDefault();
        setTerminalOpen(!terminalOpen);
        return;
      }
      // a browser tab would print instead, so this one is taken back by hand
      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        setPalette("files");
        return;
      }
      if (key === "f" && event.shiftKey) {
        event.preventDefault();
        setPalette("text");
        return;
      }
      // the chat tab is pinned, so cmd+w only ever closes a file
      if (key === "w" && !event.shiftKey) {
        event.preventDefault();
        if (active) requestClose(active);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, treeOpen, terminalOpen, agentsOpen, openFiles, dirty, provider.capabilities.tasks]);

  const renamed = (from: string, to: string) => {
    const moved = (path: string) =>
      path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
    setOpenFiles((files) => files.map(moved));
    setActive((current) => (current === null ? null : moved(current)));
  };

  const deleted = (path: string) => {
    const gone = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
    const next = openFiles.filter((file) => !gone(file));
    setOpenFiles(next);
    if (active !== null && gone(active)) setActive(next[0] ?? null);
  };

  return (
    <>
      <main className="flex h-full min-w-0 flex-1 flex-col">
        <header data-titlebar className="flex h-15 shrink-0 items-center gap-2.5 border-b border-border/60 px-5">
          <SidebarToggle />
          <StatusDot status={thread.status} />
          <h1 className="min-w-0 truncate text-[13.5px] font-medium" title={thread.cwd}>
            {thread.title}
          </h1>
          <span className="shrink-0 rounded-md border border-border/70 px-1.5 py-0.5 text-[10.5px] text-faint">
            {provider.label}
          </span>
          {branch ? <BranchChip branch={branch} isWorktree={thread.isWorktree} /> : null}
          <div className="flex-1" />
          {/* the toggles are icon buttons with padding of their own, so they sit tighter than the header gap */}
          <div className="flex items-center gap-1">
            <OpenMenu thread={thread} />
            {provider.capabilities.tasks ? (
              <PanelToggle pressed={agentsOpen} onPressedChange={setAgentsOpen} label="Agents">
                <AgentIcon className="size-4" />
              </PanelToggle>
            ) : null}
            <PanelToggle pressed={terminalOpen} onPressedChange={setTerminalOpen} label="Terminal">
              <TerminalIcon className="size-4" />
            </PanelToggle>
            <PanelToggle pressed={treeOpen} onPressedChange={setTreeOpen} label="Files">
              <ChangesIcon className="size-4" />
            </PanelToggle>
          </div>
        </header>

        {/* a maximized terminal hides all of this rather than unmounting it, so scroll
            positions, unsaved edits and the composer's draft survive the round trip */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            terminalOpen && terminalMax && "hidden",
          )}
        >
          {openFiles.length > 0 ? (
            <EditorTabs
              title={thread.title}
              files={openFiles}
              active={active}
              dirty={dirty}
              onSelect={selectTab}
              onClose={requestClose}
            />
          ) : null}

          {/* every open file stays mounted so an unsaved draft survives a tab switch */}
          {openFiles.map((path) => (
            <div
              key={path}
              className={cn("flex min-h-0 flex-1 flex-col", path === active ? "" : "hidden")}
            >
              <FileView
                thread={thread}
                path={path}
                active={path === active}
                onClose={closeFileTab}
                onDirtyChange={markDirty}
                onSaved={savedFile}
                registerSave={registerSave}
                reveal={reveal?.path === path ? reveal : null}
                links={links}
              />
            </div>
          ))}

          {active === null ? (
            <>
              <Timeline
                threadId={thread.id}
                running={thread.status === "running"}
                files={links}
                onRun={runCommand}
                onRewind={setPendingRewind}
              />
              <ThreadComposer thread={thread} restore={restore} />
            </>
          ) : null}
        </div>

        {terminalOpen ? (
          <Suspense fallback={null}>
            <TerminalPanel
              thread={thread}
              command={command}
              height={terminalHeight}
              defaultHeight={TERMINAL_HEIGHT}
              maximized={terminalMax}
              onHeightChange={setTerminalHeight}
              onToggleMaximize={() => setTerminalMax(!terminalMax)}
              onClose={() => setTerminalOpen(false)}
            />
          </Suspense>
        ) : null}
      </main>
      {agentsOpen && provider.capabilities.tasks ? (
        <AgentsPanel thread={thread} onClose={() => setAgentsOpen(false)} />
      ) : null}
      {treeOpen ? (
        <FileTree
          thread={thread}
          openPath={active}
          onOpenFile={openFile}
          onRenamed={renamed}
          onDeleted={deleted}
          refreshToken={fsVersion}
          onClose={() => setTreeOpen(false)}
        />
      ) : null}

      {palette ? (
        <SearchPalette
          thread={thread}
          files={workspace}
          mode={palette}
          onOpenFile={openFile}
          onClose={() => setPalette(null)}
        />
      ) : null}

      {pendingRewind ? (
        <Dialog
          title="Rewind to here?"
          onClose={() => setPendingRewind(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPendingRewind(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void rewind(pendingRewind)}>
                Rewind
              </Button>
            </div>
          }
        >
          <p className="text-[13px] text-muted-foreground">
            This message and everything after it are deleted, and its text goes back in the
            composer. Files on disk are left alone, and the next turn starts {provider.label} with
            an empty context.
          </p>
        </Dialog>
      ) : null}

      {pendingClose ? (
        <Dialog
          title="Save changes?"
          onClose={() => setPendingClose(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button
                variant="destructive"
                onClick={() => {
                  closeFile(pendingClose);
                  setPendingClose(null);
                }}
              >
                Undo changes
              </Button>
              <Button variant="default" onClick={() => void saveAndClose(pendingClose)}>
                Save
              </Button>
            </div>
          }
        >
          <p className="text-[13px] text-muted-foreground">
            <span className="font-mono text-foreground">{pendingClose}</span> has edits that were
            never saved.
          </p>
        </Dialog>
      ) : null}
    </>
  );
}
