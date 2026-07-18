import { useMemo, useState } from "react";

import type { Project, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CheckIcon,
  ChevronIcon,
  DotsIcon,
  FolderIcon,
  PlusIcon,
  SettingsIcon,
  SidebarIcon,
  StatusDot,
  WorktreeIcon,
  cn,
  usePersistedState,
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

function WorktreeButton({
  project,
  onOpen,
  hover,
}: {
  project: Project;
  onOpen: (project: Project) => void;
  hover?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onOpen(project)}
          aria-label="Worktrees"
          className={cn("size-6 shrink-0 text-faint", hover && "opacity-0 group-hover:opacity-100")}
        >
          <WorktreeIcon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Worktrees</TooltipContent>
    </Tooltip>
  );
}

function NewSessionButton({ project, hover }: { project: Project; hover?: boolean }) {
  const startDraft = useStore((state) => state.startDraft);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => startDraft({ projectId: project.id })}
          aria-label="New session in this folder"
          className={cn("size-6 shrink-0 text-faint", hover && "opacity-0 group-hover:opacity-100")}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>New session in this folder</TooltipContent>
    </Tooltip>
  );
}

const ALL_PROJECTS = "all";

function ProjectFilter({
  projects,
  selected,
  onSelect,
}: {
  projects: Project[];
  selected: Project | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 font-normal">
          <FolderIcon className="text-faint" />
          <span className="min-w-0 flex-1 truncate text-left text-[13px]">
            {selected ? selected.name : "All projects"}
          </span>
          <ChevronIcon className="size-3 text-faint" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder="Search projects…" />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-[12px] text-faint">
              No projects.
            </CommandEmpty>
            <CommandItem value="All projects" onSelect={() => pick(ALL_PROJECTS)}>
              <FolderIcon className="text-faint" />
              <span className="min-w-0 flex-1 truncate text-[13px]">All projects</span>
              {selected ? null : <CheckIcon className="text-primary" />}
            </CommandItem>
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                // searchable by either, since a folder is as often known by its path
                value={`${project.name} ${project.path}`}
                onSelect={() => pick(project.id)}
              >
                <FolderIcon className="text-faint" />
                <span className="min-w-0 flex-1 truncate text-[13px]" title={project.path}>
                  {project.name}
                </span>
                {project.id === selected?.id ? <CheckIcon className="text-primary" /> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function Sidebar() {
  const { projects, threads, connected, draft } = useStore();
  const startDraft = useStore((state) => state.startDraft);
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const [worktreeProject, setWorktreeProject] = useState<Project | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [projectFilter, setProjectFilter] = usePersistedState<string>("sidebar.project", ALL_PROJECTS);

  const [foldedIds, setFoldedIds] = usePersistedState<string>("sidebar.collapsed", "");

  // a filter left pointing at a removed folder falls back to showing everything
  const selected = projects.find((project) => project.id === projectFilter) ?? null;

  const collapsed = useMemo(() => new Set(foldedIds.split(",").filter(Boolean)), [foldedIds]);

  const toggleCollapsed = (id: string) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setFoldedIds([...next].join(","));
  };

  // folders are derived from threads — a folder with no session isn't listed
  const grouped = useMemo(
    () =>
      projects
        .filter((project) => !selected || project.id === selected.id)
        .map((project) => ({
          project,
          threads: threads.filter((thread) => thread.projectId === project.id && !thread.archived),
        }))
        .filter((group) => group.threads.length > 0),
    [projects, threads, selected],
  );

  const archived = useMemo(
    () =>
      threads.filter(
        (thread) => thread.archived && (!selected || thread.projectId === selected.id),
      ),
    [threads, selected],
  );

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border/60 bg-card">
      <header className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <span className="font-mono text-[13px] font-semibold tracking-tight">sr03</span>
      </header>

      <div className="px-2 pb-1">
        <Button
          variant="secondary"
          onClick={() => startDraft()}
          className={cn("h-8 w-full justify-start gap-2 font-normal", draft && "bg-accent")}
        >
          <PlusIcon />
          New
        </Button>
      </div>

      <div className="flex items-center gap-0.5 px-2 pb-1">
        <div className="min-w-0 flex-1">
          <ProjectFilter projects={projects} selected={selected} onSelect={setProjectFilter} />
        </div>
        {selected?.isGit ? <WorktreeButton project={selected} onOpen={setWorktreeProject} /> : null}
        {selected ? <NewSessionButton project={selected} /> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {grouped.length === 0 && archived.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-faint">
            {selected ? "No sessions in this folder." : "No sessions yet. Start one with New."}
          </p>
        ) : null}

        {grouped.map(({ project, threads: projectThreads }, index) => {
          // the filter already names the folder when one is picked, so it has no header to collapse
          const folded = !selected && collapsed.has(project.id);
          return (
            <section key={project.id} className="mb-2">
              {index > 0 ? <Separator className="mb-2" /> : null}
              {selected ? null : (
                <div className="group flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    onClick={() => toggleCollapsed(project.id)}
                    title={project.path}
                    className="h-auto min-w-0 flex-1 justify-start gap-1 px-2 py-1 text-[12px] font-medium text-faint"
                  >
                    <span className="min-w-0 truncate text-left">{project.name}</span>
                    <ChevronIcon
                      className={cn(
                        "size-3 opacity-0 transition group-hover:opacity-100",
                        folded && "-rotate-90",
                      )}
                    />
                    {folded ? <span>({projectThreads.length})</span> : null}
                  </Button>
                  {project.isGit ? (
                    <WorktreeButton project={project} onOpen={setWorktreeProject} hover />
                  ) : null}
                  <NewSessionButton project={project} />
                </div>
              )}

              {folded ? null : (
                <ul className="mt-0.5">
                  {projectThreads.map((thread) => (
                    <ThreadRow key={thread.id} thread={thread} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}

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
        <div className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              className="size-6 text-faint"
            >
              <SettingsIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </footer>

      {worktreeProject ? (
        <WorktreePanel project={worktreeProject} onClose={() => setWorktreeProject(null)} />
      ) : null}
    </aside>
  );
}
