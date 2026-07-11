import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../lib/api.ts";
import type { Message, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { ThreadComposer } from "./Composer.tsx";
import { FileTree } from "./FileTree.tsx";
import { FileView } from "./FileView.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { Timeline } from "./Timeline.tsx";
import { SidebarToggle } from "./Sidebar.tsx";
import { Separator } from "@/components/ui/separator";
import {
  ChangesIcon,
  ChevronIcon,
  CloseIcon,
  CodeIcon,
  FileIcon,
  FolderIcon,
  MessageIcon,
  StatusDot,
  TerminalIcon,
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Toggle
            size="sm"
            pressed={pressed}
            onPressedChange={onPressedChange}
            aria-label={label}
            className="text-faint data-[state=on]:text-foreground"
          >
            {children}
          </Toggle>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function AppIcon({ id }: { id: string }) {
  return id === "finder" ? <FolderIcon /> : <CodeIcon />;
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
  onSelect,
  onClose,
}: {
  title: string;
  files: string[];
  active: string | null;
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
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded text-faint transition hover:bg-accent hover:text-foreground",
                path === active ? "" : "opacity-0 group-hover/tab:opacity-100",
              )}
            >
              <CloseIcon className="size-3" />
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
  const [treeOpen, setTreeOpen] = usePersistedState<boolean>("file-tree", false);
  const [terminalOpen, setTerminalOpen] = usePersistedState<boolean>("terminal", false);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const openFile = (path: string) => {
    setOpenFiles((files) => (files.includes(path) ? files : [...files, path]));
    setActive(path);
  };

  // closing the active tab lands on its neighbour, falling back to the chat
  const closeFile = (path: string) => {
    const index = openFiles.indexOf(path);
    const next = openFiles.filter((file) => file !== path);
    setOpenFiles(next);
    if (active === path) setActive(next[index] ?? next[index - 1] ?? null);
  };

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
        <header className="flex items-center gap-2.5 border-b border-border/60 px-5 py-3">
          <SidebarToggle />
          <StatusDot status={thread.status} />
          <h1 className="min-w-0 truncate text-[13.5px] font-medium">{thread.title}</h1>
          <div className="flex-1" />
          <span className="truncate font-mono text-[11px] text-faint" title={thread.cwd}>
            {thread.cwd.replace(/^\/Users\/[^/]+/, "~")}
          </span>
          <OpenMenu thread={thread} />
          <PanelToggle pressed={terminalOpen} onPressedChange={setTerminalOpen} label="Terminal">
            <TerminalIcon className="size-4" />
          </PanelToggle>
          <PanelToggle pressed={treeOpen} onPressedChange={setTreeOpen} label="Files">
            <ChangesIcon className="size-4" />
          </PanelToggle>
        </header>

        {openFiles.length > 0 ? (
          <EditorTabs
            title={thread.title}
            files={openFiles}
            active={active}
            onSelect={setActive}
            onClose={closeFile}
          />
        ) : null}

        {active ? (
          <FileView thread={thread} path={active} onClose={() => closeFile(active)} />
        ) : (
          <>
            <Timeline messages={messages} streaming={streaming} running={thread.status === "running"} />
            <ThreadComposer thread={thread} />
          </>
        )}

        {terminalOpen ? (
          <TerminalPanel thread={thread} onClose={() => setTerminalOpen(false)} />
        ) : null}
      </main>
      {treeOpen ? (
        <FileTree
          thread={thread}
          openPath={active}
          onOpenFile={openFile}
          onRenamed={renamed}
          onDeleted={deleted}
          onClose={() => setTreeOpen(false)}
        />
      ) : null}
    </>
  );
}
