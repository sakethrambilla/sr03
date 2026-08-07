import { useMemo, useRef, useState } from "react";

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
  FilterIcon,
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

function SidebarButton() {
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const toggleSidebar = useStore((state) => state.toggleSidebar);
  const label = sidebarOpen ? "Hide sidebar" : "Show sidebar";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          aria-label={label}
          className="-ml-1.5 text-faint"
        >
          <SidebarIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <span className="text-faint">⌘⇧B</span>
      </TooltipContent>
    </Tooltip>
  );
}

// there is only ever one toggle, and it keeps the same spot at the window's left edge: the
// sidebar's own header carries it while the sidebar is up, the main header takes over once it isn't
export function SidebarToggle() {
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  return sidebarOpen ? null : <SidebarButton />;
}

function ThreadRow({ thread }: { thread: Thread }) {
  const activeThreadId = useStore((state) => state.activeThreadId);
  const openThread = useStore((state) => state.openThread);
  const renameThread = useStore((state) => state.renameThread);
  const forkThread = useStore((state) => state.forkThread);
  const setArchived = useStore((state) => state.setArchived);
  const done = useStore((state) => Boolean(state.finished[thread.id]));
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

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
        <StatusDot status={thread.status} done={done} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <Input
              ref={renameRef}
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
            // the menu's focus trap outlives its own close animation, so it takes focus off the
            // freshly mounted rename input. taking it back here is what lets a click on another
            // session blur the input, and so put the rename away
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              renameRef.current?.focus();
            }}
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
    <Button
      variant="ghost"
      size="icon"
      onClick={() => onOpen(project)}
      aria-label="Worktrees"
      className={cn("size-6 shrink-0 text-faint", hover && "opacity-0 group-hover:opacity-100")}
    >
      <WorktreeIcon className="size-3.5" />
    </Button>
  );
}

function NewSessionButton({ project, hover }: { project: Project; hover?: boolean }) {
  const startDraft = useStore((state) => state.startDraft);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => startDraft({ projectId: project.id })}
      aria-label="New session in this folder"
      className={cn("size-6 shrink-0 text-faint", hover && "opacity-0 group-hover:opacity-100")}
    >
      <PlusIcon className="size-3.5" />
    </Button>
  );
}

const ALL_PROJECTS = "all";

type StatusFilter = "all" | "active" | "archived";

const STATUS_FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
];

function StatusFilterMenu({
  value,
  onSelect,
}: {
  value: StatusFilter;
  onSelect: (value: StatusFilter) => void;
}) {
  const current = STATUS_FILTERS.find((item) => item.id === value) ?? STATUS_FILTERS[0];

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Filter sessions"
              className={cn("size-6 shrink-0", value === "all" ? "text-faint" : "text-primary")}
            >
              <FilterIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{`Filter: ${current.label}`}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-36">
        {STATUS_FILTERS.map((item) => (
          <DropdownMenuItem key={item.id} onSelect={() => onSelect(item.id)} className="gap-3">
            <span className="min-w-0 flex-1 text-[13px]">{item.label}</span>
            {item.id === value ? <CheckIcon className="text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const [statusFilter, setStatusFilter] = usePersistedState<StatusFilter>("sidebar.status", "all");

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
          threads: threads.filter(
            (thread) =>
              thread.projectId === project.id &&
              (statusFilter === "archived" ? thread.archived : !thread.archived),
          ),
        }))
        .filter((group) => group.threads.length > 0),
    [projects, threads, selected, statusFilter],
  );

  // under "all" the archived ones keep their own collapsed section below the active folders
  const archived = useMemo(
    () =>
      statusFilter === "all"
        ? threads.filter(
            (thread) => thread.archived && (!selected || thread.projectId === selected.id),
          )
        : [],
    [threads, selected, statusFilter],
  );

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-border/60 bg-card">
      <header data-titlebar className="flex h-15 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <SidebarButton />
      </header>

      <div className="px-2 pt-2 pb-1">
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
        <StatusFilterMenu value={statusFilter} onSelect={setStatusFilter} />
        {selected?.isGit ? <WorktreeButton project={selected} onOpen={setWorktreeProject} /> : null}
        {selected ? <NewSessionButton project={selected} /> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {grouped.length === 0 && archived.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-faint">
            {statusFilter === "archived"
              ? "No archived sessions."
              : selected
                ? "No sessions in this folder."
                : "No sessions yet. Start one with New."}
          </p>
        ) : null}

        {grouped.map(({ project, threads: projectThreads }, index) => {
          // the filter already names the folder when one is picked, so it has no header to collapse
          const folded = !selected && collapsed.has(project.id);
          return (
            <section key={project.id} className="mb-2">
              {index > 0 ? <Separator className="mb-2 bg-border/50" /> : null}
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
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          className="size-6 text-faint"
        >
          <SettingsIcon className="size-3.5" />
        </Button>
      </footer>

      {worktreeProject ? (
        <WorktreePanel project={worktreeProject} onClose={() => setWorktreeProject(null)} />
      ) : null}
    </aside>
  );
}
