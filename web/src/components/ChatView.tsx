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
  CodeIcon,
  FolderIcon,
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

const NO_MESSAGES: Message[] = [];

function ToolButton({
  onClick,
  title,
  active,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "rounded-md p-1 transition hover:bg-accent hover:text-foreground",
        active ? "bg-accent text-foreground" : "text-faint",
      )}
    >
      {children}
    </button>
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
    <span className="inline-flex h-7 items-center overflow-hidden rounded-md border border-border/70 bg-accent/40 text-[12px] text-muted-foreground">
      <button
        onClick={() => launch(primary.id)}
        title={`Open ${thread.cwd} in ${primary.label} (⌘O)`}
        className="flex h-full items-center gap-1.5 px-2 transition hover:text-foreground"
      >
        <AppIcon id={primary.id} />
        Open
      </button>
      <Separator orientation="vertical" className="h-4" />
      <DropdownMenu>
        <DropdownMenuTrigger
          title="Open in…"
          className="flex h-full items-center px-1 transition hover:text-foreground"
        >
          <ChevronIcon className="size-3" />
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
    </span>
  );
}

export function ChatView({ thread }: { thread: Thread }) {
  const messages = useStore((state) => state.messagesByThread[thread.id] ?? NO_MESSAGES);
  const streaming = useStore((state) => state.streamByThread[thread.id] ?? "");
  const [treeOpen, setTreeOpen] = usePersistedState<boolean>("file-tree", false);
  const [terminalOpen, setTerminalOpen] = usePersistedState<boolean>("terminal", false);
  const [openFile, setOpenFile] = useState<string | null>(null);

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
          <ToolButton
            title={terminalOpen ? "Hide terminal" : "Show terminal"}
            active={terminalOpen}
            onClick={() => setTerminalOpen(!terminalOpen)}
          >
            <TerminalIcon className="size-4" />
          </ToolButton>
          <ToolButton
            title={treeOpen ? "Hide files" : "Show files"}
            active={treeOpen}
            onClick={() => setTreeOpen(!treeOpen)}
          >
            <ChangesIcon className="size-4" />
          </ToolButton>
        </header>

        {openFile ? (
          <FileView thread={thread} path={openFile} onClose={() => setOpenFile(null)} />
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
          openPath={openFile}
          onOpenFile={setOpenFile}
          onClose={() => setTreeOpen(false)}
        />
      ) : null}
    </>
  );
}
