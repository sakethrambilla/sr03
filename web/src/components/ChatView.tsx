import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../lib/api.ts";
import { createFileIndex } from "../lib/fileref.ts";
import type { FileRef } from "../lib/fileref.ts";
import type { Message, Thread, ThreadTask } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { ThreadComposer } from "./Composer.tsx";
import { FileTree } from "./FileTree.tsx";
import { FileView } from "./FileView.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { SidebarToggle } from "./Sidebar.tsx";
import { Separator } from "@/components/ui/separator";
import {
  AgentIcon,
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
  ZedIcon,
  cn,
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

const NO_MESSAGES: Message[] = [];
const NO_TASKS: ThreadTask[] = [];
const NO_FILES: string[] = [];

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

function OpenMenu({ thread }: { thread: Thread }) {
  const apps = useStore((state) => state.apps);
  const setError = useStore((state) => state.setError);
  const [preferred, setPreferred] = usePersistedState<string>("open-app", "");

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
  const messages = useStore((state) => state.messagesByThread[thread.id] ?? NO_MESSAGES);
  const streaming = useStore((state) => state.streamByThread[thread.id] ?? "");
  const tasks = useStore((state) => state.tasksByThread[thread.id] ?? NO_TASKS);
  const workspace = useStore((state) => state.filesByCwd[thread.cwd] ?? NO_FILES);
  const loadFiles = useStore((state) => state.loadFiles);
  const [treeOpen, setTreeOpen] = usePersistedState<boolean>("file-tree", false);
  const [terminalOpen, setTerminalOpen] = usePersistedState<boolean>("terminal", false);
  const [agentsOpen, setAgentsOpen] = usePersistedState<boolean>("agents", false);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ path: string; line: number; key: number } | null>(null);
  const [command, setCommand] = useState<{ text: string; key: number } | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const [fsVersion, setFsVersion] = useState(0);

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

  const openFile = useCallback((path: string, line?: number) => {
    setOpenFiles((files) => (files.includes(path) ? files : [...files, path]));
    setActive(path);
    // the key is what makes clicking the same reference twice jump again
    if (line) setReveal((current) => ({ path, line, key: (current?.key ?? 0) + 1 }));
  }, []);

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

  // a finished turn may have added or renamed files, so the index is re-read with each one
  useEffect(() => {
    void loadFiles(thread.id, thread.cwd);
  }, [loadFiles, thread.id, thread.cwd, thread.status, fsVersion]);

  // the panel owns the terminals, so it is left to decide which one a command lands in
  const runCommand = useCallback(
    (text: string) => {
      setTerminalOpen(true);
      setCommand((current) => ({ text, key: (current?.key ?? 0) + 1 }));
    },
    [setTerminalOpen],
  );

  const index = useMemo(() => createFileIndex(workspace), [workspace]);
  const links = useMemo(
    () => ({ resolve: index.resolve, open: (ref: FileRef) => openFile(ref.path, ref.line) }),
    [index, openFile],
  );

  // a fresh burst of subagents pops the panel open; closing it mid-burst keeps it closed
  const working = tasks.filter((task) => task.status === "running").length;
  const wasWorking = useRef(0);

  useEffect(() => {
    if (working > 0 && wasWorking.current === 0) setAgentsOpen(true);
    wasWorking.current = working;
  }, [working]);

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
      if (key === "a" && event.shiftKey) {
        event.preventDefault();
        setAgentsOpen(!agentsOpen);
        return;
      }
      if (key === "j" && !event.shiftKey) {
        event.preventDefault();
        setTerminalOpen(!terminalOpen);
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
  }, [active, treeOpen, terminalOpen, agentsOpen, openFiles, dirty]);

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
          <div className="flex-1" />
          {/* the toggles are icon buttons with padding of their own, so they sit tighter than the header gap */}
          <div className="flex items-center gap-1">
            <OpenMenu thread={thread} />
            <PanelToggle pressed={agentsOpen} onPressedChange={setAgentsOpen} label="Agents">
              <AgentIcon className="size-4" />
            </PanelToggle>
            <PanelToggle pressed={terminalOpen} onPressedChange={setTerminalOpen} label="Terminal">
              <TerminalIcon className="size-4" />
            </PanelToggle>
            <PanelToggle pressed={treeOpen} onPressedChange={setTreeOpen} label="Files">
              <ChangesIcon className="size-4" />
            </PanelToggle>
          </div>
        </header>

        {openFiles.length > 0 ? (
          <EditorTabs
            title={thread.title}
            files={openFiles}
            active={active}
            dirty={dirty}
            onSelect={setActive}
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
              onClose={() => requestClose(path)}
              onDirtyChange={(isDirty) => markDirty(path, isDirty)}
              onSaved={() => setFsVersion((current) => current + 1)}
              registerSave={registerSave}
              reveal={reveal?.path === path ? reveal : null}
            />
          </div>
        ))}

        {active === null ? (
          <>
            <Timeline
              threadId={thread.id}
              messages={messages}
              streaming={streaming}
              running={thread.status === "running"}
              files={links}
              onRun={runCommand}
            />
            <ThreadComposer thread={thread} />
          </>
        ) : null}

        {terminalOpen ? (
          <TerminalPanel thread={thread} command={command} onClose={() => setTerminalOpen(false)} />
        ) : null}
      </main>
      {agentsOpen ? <AgentsPanel thread={thread} onClose={() => setAgentsOpen(false)} /> : null}
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
