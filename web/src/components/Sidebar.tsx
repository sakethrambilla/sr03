import { useMemo, useState } from "react";

import type { Project, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ChevronIcon,
  DotsIcon,
  PlusIcon,
  SidebarIcon,
  StatusDot,
  WorktreeIcon,
  cn,
} from "./ui.tsx";
import { WorktreePanel } from "./WorktreePanel.tsx";

export function SidebarToggle() {
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const toggleSidebar = useStore((state) => state.toggleSidebar);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          className="-ml-1.5 text-faint"
        >
          <SidebarIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{sidebarOpen ? "Hide sidebar" : "Show sidebar"}</TooltipContent>
    </Tooltip>
  );
}

function ThreadRow({ thread }: { thread: Thread }) {
  const activeThreadId = useStore((state) => state.activeThreadId);
  const openThread = useStore((state) => state.openThread);
  const renameThread = useStore((state) => state.renameThread);
  const forkThread = useStore((state) => state.forkThread);
  const setArchived = useStore((state) => state.setArchived);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const active = thread.id === activeThreadId;

  const actions = useMemo(
    () => [
      { key: "r", label: "Rename", run: () => setRenaming(true) },
      { key: "f", label: "Fork", run: () => void forkThread(thread.id) },
      {
        key: "a",
        label: thread.archived ? "Unarchive" : "Archive",
        run: () => void setArchived(thread.id, !thread.archived),
      },
    ],
    [thread.id, thread.archived, forkThread, setArchived],
  );

  return (
    <li className="group">
      <div
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition",
          active ? "bg-accent" : "hover:bg-accent/50",
        )}
        onClick={() => void openThread(thread.id)}
      >
        <StatusDot status={thread.status} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <Input
              autoFocus
              defaultValue={thread.title}
              spellCheck={false}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => {
                setRenaming(false);
                const value = event.target.value.trim();
                if (value && value !== thread.title) void renameThread(thread.id, value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.currentTarget.value = thread.title;
                  event.currentTarget.blur();
                }
              }}
              className="h-6 px-1 py-0 text-[13px]"
            />
          ) : (
            <p className={cn("truncate text-[13px]", active ? "text-foreground" : "text-muted-foreground")}>
              {thread.title}
            </p>
          )}
          {thread.isWorktree && thread.branch ? (
            <p className="flex items-center gap-1 truncate font-mono text-[10px] text-faint">
                          <WorktreeIcon className="size-2.5" />
                          {thread.branch}
                        </p>
          ) : null}
        </div>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              title="Options"
              onClick={(event) => event.stopPropagation()}
              className={cn(
                "size-6 shrink-0 text-faint",
                menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            >
              <DotsIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-44"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              const action = actions.find((item) => item.key === event.key.toLowerCase());
              if (!action) return;
              event.preventDefault();
              setMenuOpen(false);
              action.run();
            }}
          >
            {actions.map((action) => (
              <DropdownMenuItem key={action.key} onSelect={action.run}>
                {action.label}
                <DropdownMenuShortcut className="uppercase">{action.key}</DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

      </div>
    </li>
  );
}

export function Sidebar() {
  const { projects, threads, connected, draft } = useStore();
  const startDraft = useStore((state) => state.startDraft);
  const [worktreeProject, setWorktreeProject] = useState<Project | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // folders are derived from threads — a folder with no session isn't listed
  const grouped = useMemo(
    () =>
      projects
        .map((project) => ({
          project,
          threads: threads.filter((thread) => thread.projectId === project.id && !thread.archived),
        }))
        .filter((group) => group.threads.length > 0),
    [projects, threads],
  );

  const archived = useMemo(() => threads.filter((thread) => thread.archived), [threads]);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border/60 bg-card">
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <span className="font-mono text-[13px] font-semibold tracking-tight">sr03</span>
      </header>

      <div className="px-2 pb-2">
        <Button
          variant="secondary"
          onClick={() => startDraft()}
          className={cn("h-8 w-full justify-start gap-2 font-normal", draft && "bg-accent")}
        >
          <PlusIcon />
          New
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {grouped.length === 0 && archived.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-faint">
            No sessions yet. Start one with New.
          </p>
        ) : null}

        {grouped.map(({ project, threads: projectThreads }) => (
          <section key={project.id} className="mb-4">
            <div className="group flex items-center gap-0.5 px-2 py-1">
              <span
                className="min-w-0 flex-1 truncate text-[12px] font-medium text-faint"
                title={project.path}
              >
                {project.name}
              </span>
              {project.isGit ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setWorktreeProject(project)}
                      aria-label="Worktrees"
                      className="size-6 text-faint opacity-0 group-hover:opacity-100"
                    >
                      <WorktreeIcon className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Worktrees</TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => startDraft({ projectId: project.id })}
                    aria-label="New thread"
                    className="size-6 text-faint"
                  >
                    <PlusIcon className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New thread</TooltipContent>
              </Tooltip>
            </div>

            <ul className="mt-0.5">
              {projectThreads.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} />
              ))}
            </ul>
          </section>
        ))}

        {archived.length > 0 ? (
          <section className="mb-4">
            <Button
              variant="ghost"
              onClick={() => setShowArchived((open) => !open)}
              className="h-auto w-full justify-start gap-1.5 px-2 py-1 text-[12px] font-medium text-faint"
            >
              <ChevronIcon className={cn("size-3 transition-transform", !showArchived && "-rotate-90")} />
              Archived ({archived.length})
            </Button>
            {showArchived ? (
              <ul className="mt-0.5">
                {archived.map((thread) => (
                  <ThreadRow key={thread.id} thread={thread} />
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>

      <footer className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5">
        <span
          className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-destructive")}
          title={connected ? "Connected" : "Disconnected"}
        />
        <span className="text-[11px] text-faint">{connected ? "connected" : "reconnecting…"}</span>
      </footer>

      {worktreeProject ? (
        <WorktreePanel project={worktreeProject} onClose={() => setWorktreeProject(null)} />
      ) : null}
    </aside>
  );
}
