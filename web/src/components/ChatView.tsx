// One open session: the header, the transcript and composer, and the panels around them — file
// tree, file tabs, terminal, agents. Owns which files are open, which of them have unsaved edits,
// and the session-scoped shortcuts listed in SHORTCUTS.md.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../lib/api.ts";
import { createFileIndex } from "../lib/fileref.ts";
import type { FileRef } from "../lib/fileref.ts";
import type { EditorLayout, EditorTab, Message, Thread, ThreadTask } from "../lib/types.ts";
import {
  MAX_GROUPS,
  activeTab,
  allTabs,
  closeTab,
  moveTab,
  normalize,
  openTab,
  resize as resizeGroups,
  sameTab,
  selectTab as selectInGroup,
  tabKey,
  trackOf,
} from "../lib/layout.ts";
import { EMPTY_PROVIDER, useStore } from "../store.ts";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { EditorGroups, EditorTabs } from "./EditorGroups.tsx";
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
  CodeIcon,
  CursorIcon,
  FolderIcon,
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
  // ChatView is keyed by thread.id in App.tsx, so this is seeded once per session and is the single
  // writer for the layout — the thread.updated events setLayout provokes are echoes of these writes
  const [layout, setLayoutState] = useState(() => normalize(thread.layout));
  const [focused, setFocused] = useState(0);
  const setLayout = useStore((state) => state.setLayout);
  // read by openFile, which must stay stable — every FileView holds it through `links`
  const focusedRef = useRef(focused);
  focusedRef.current = Math.min(focused, layout.groups.length - 1);
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

  // every mutation goes through here, so the optimistic state and the server write never diverge.
  // the ref is what lets openFile stay stable while still reading the current layout
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const commit = useCallback(
    (next: EditorLayout) => {
      layoutRef.current = next;
      setLayoutState(next);
      setLayout(thread.id, next);
    },
    [setLayout, thread.id],
  );

  const openFile = useCallback(
    (path: string, line?: number) => {
      commit(openTab(layoutRef.current, { kind: "file", path }, focusedRef.current));
      restorePanel.current();
      // the key is what makes clicking the same reference twice jump again
      if (line) setReveal((current) => ({ path, line, key: (current?.key ?? 0) + 1 }));
    },
    [commit],
  );

  const selectTab = (groupIndex: number, tab: EditorTab) => {
    setFocused(groupIndex);
    commit(selectInGroup(layoutRef.current, groupIndex, tab));
    restorePanel.current();
  };

  const closeFile = (path: string) => {
    const next = closeTab(layoutRef.current, { kind: "file", path });
    commit(next);
    markDirty(path, false);
    promptNextDirty(
      allTabs(next).flatMap((tab) => (tab.kind === "file" ? [tab.path] : [])),
      path,
    );
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
    let next = layoutRef.current;
    for (const path of openFiles) {
      if (!dirty.has(path)) next = closeTab(next, { kind: "file", path });
    }
    commit(next);
    closingAll.current = unsaved.length > 0;
    if (unsaved[0]) setPendingClose(unsaved[0]);
  };

  // the shortcuts and the dirty tracking still think in terms of one strip; these keep them
  // working while the layout underneath is the real state
  const openFiles = allTabs(layout).flatMap((tab) => (tab.kind === "file" ? [tab.path] : []));
  const focusedGroup = layout.groups[focusedRef.current] ?? layout.groups[0]!;
  const focusedTab = activeTab(focusedGroup);
  const active = focusedTab.kind === "file" ? focusedTab.path : null;

  // the first split settles the axis; afterwards a split can only extend the same row or column
  const splitFocused = () => {
    const current = layoutRef.current;
    if (current.groups.length >= MAX_GROUPS) return;
    const group = current.groups[focusedRef.current] ?? current.groups[0]!;
    if (group.tabs.length < 2 && current.groups.length > 1) return;
    const zone = current.groups.length > 1 && current.axis === "vertical" ? "down" : "right";
    const next = moveTab(current, activeTab(group), { group: focusedRef.current, zone });
    if (next === current) return;
    commit(next);
    setFocused(Math.min(focusedRef.current + 1, next.groups.length - 1));
  };

  const moveFocus = (step: number) =>
    setFocused((current) =>
      Math.min(Math.max(current + step, 0), layoutRef.current.groups.length - 1),
    );

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
        if (key === "arrowleft" || key === "arrowright") {
          event.preventDefault();
          moveFocus(key === "arrowleft" ? -1 : 1);
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
      if (key === "\\" && !event.shiftKey) {
        event.preventDefault();
        splitFocused();
        return;
      }
      // the chat tab is pinned, so cmd+w only ever closes a file — and only in the focused group
      if (key === "w" && !event.shiftKey) {
        event.preventDefault();
        if (active) requestClose(active);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, treeOpen, terminalOpen, agentsOpen, openFiles, dirty, layout, focused, provider.capabilities.tasks]);

  const renamed = (from: string, to: string) => {
    const moved = (path: string) =>
      path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path;
    commit({
      ...layoutRef.current,
      groups: layoutRef.current.groups.map((group) => ({
        ...group,
        tabs: group.tabs.map((tab) =>
          tab.kind === "file" ? { kind: "file" as const, path: moved(tab.path) } : tab,
        ),
      })),
    });
  };

  const deleted = (path: string) => {
    const gone = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
    let next = layoutRef.current;
    for (const tab of allTabs(next)) {
      if (tab.kind === "file" && gone(tab.path)) next = closeTab(next, tab);
    }
    commit(next);
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
          <EditorGroups
            layout={layout}
            focused={focusedRef.current}
            onFocusGroup={setFocused}
            onResize={(sashIndex, fractions) =>
              commit(resizeGroups(layoutRef.current, sashIndex, fractions))
            }
            onEqualise={() =>
              commit({
                ...layoutRef.current,
                sizes: layoutRef.current.sizes.map(() => 1),
              })
            }
            strip={(group, index) => (
              <EditorTabs
                group={group}
                index={index}
                title={thread.title}
                dirty={dirty}
                onSelect={selectTab}
                onClose={requestClose}
              />
            )}
          >
            {/* One flat list, every entry a direct child of the grid and keyed by its tab, so a tab
                moving between groups only changes a track style. Re-parenting these into per-group
                wrappers would remount FileView and lose its uncontrolled edits. */}
            {layout.groups.flatMap((group, index) =>
              group.tabs.map((tab) => {
                const showing = sameTab(tab, activeTab(group));
                const cell =
                  layout.axis === "horizontal"
                    ? { gridColumn: trackOf(index, layout.axis, "view"), gridRow: 2 }
                    : { gridColumn: 1, gridRow: trackOf(index, layout.axis, "view") };
                return (
                  <div
                    key={tabKey(tab)}
                    style={cell}
                    // clicking into an editor is how a group is focused, not just clicking its tab
                    onPointerDownCapture={() => setFocused(index)}
                    className={cn("flex min-h-0 min-w-0 flex-col", showing ? "" : "hidden")}
                  >
                    {tab.kind === "chat" ? (
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
                    ) : (
                      <FileView
                        thread={thread}
                        path={tab.path}
                        // FileView's cmd+S / cmd+shift+V / Esc handlers sit on window, so without
                        // the focus test two groups would both answer every one of those keys
                        active={showing && index === focusedRef.current}
                        onClose={closeFileTab}
                        onMissing={closeFileTab}
                        onDirtyChange={markDirty}
                        onSaved={savedFile}
                        registerSave={registerSave}
                        reveal={reveal?.path === tab.path ? reveal : null}
                        links={links}
                      />
                    )}
                  </div>
                );
              }),
            )}
          </EditorGroups>
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
