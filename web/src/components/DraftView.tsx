import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { Branch, GitSnapshot } from "../lib/types.ts";
import { useStore } from "../store.ts";
import type { Draft } from "../store.ts";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BranchIcon,
  CheckIcon,
  Chip,
  FolderIcon,
  PlusIcon,
  SparkleIcon,
  StatusDot,
  WorktreeIcon,
  cn,
} from "./ui.tsx";
import { Composer } from "./Composer.tsx";
import { SidebarToggle } from "./Sidebar.tsx";
import { Separator } from "@/components/ui/separator";
import { FolderPicker } from "./FolderPicker.tsx";

function unusedBranch(base: string, branches: Branch[]): string {
  const taken = new Set(branches.map((branch) => branch.name));
  let name = `${base}-wt`;
  let counter = 2;
  while (taken.has(name)) name = `${base}-wt${counter++}`;
  return name;
}

function BranchMenu({
  branches,
  current,
  selected,
  linkedWorktree,
  onPick,
}: {
  branches: Branch[];
  current: string | null;
  selected: string | null;
  linkedWorktree: (branch: Branch) => string | null;
  onPick: (branch: Branch | { name: string; create: true }) => void;
}) {
  const [query, setQuery] = useState("");

  const needle = query.trim();
  const isNew = needle.length > 0 && !branches.some((branch) => branch.name === needle);

  return (
    // the search sits under the list, so its divider flips to the top edge
    <Command className="[&_[data-slot=command-input-wrapper]]:border-t [&_[data-slot=command-input-wrapper]]:border-b-0">
      <CommandList className="max-h-64 p-1">
        <CommandEmpty className="py-4 text-center text-[12px] text-faint">No branches</CommandEmpty>
        {isNew ? (
          <CommandItem value={needle} onSelect={() => onPick({ name: needle, create: true })}>
            <PlusIcon className="text-primary" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{needle}</span>
            <span className="text-[11px] text-faint">new branch · worktree</span>
          </CommandItem>
        ) : null}
        {branches.map((branch) => (
          <CommandItem key={branch.name} value={branch.name} onSelect={() => onPick(branch)}>
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{branch.name}</span>
            {branch.name === current ? (
              <span className="text-[11px] text-faint">checked out</span>
            ) : null}
            {linkedWorktree(branch) ? <WorktreeIcon className="size-3 text-primary" /> : null}
            {branch.name === selected ? <CheckIcon className="text-primary" /> : null}
          </CommandItem>
        ))}
      </CommandList>
      <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder="Search branches, or type a new name…"
      />
    </Command>
  );
}

function DraftChips({ draft }: { draft: Draft }) {
  const project = useStore((state) => state.projects.find((item) => item.id === draft.projectId));
  const patchDraft = useStore((state) => state.patchDraft);
  const refreshState = useStore((state) => state.refreshState);
  const setError = useStore((state) => state.setError);
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setSnapshot(null);
    if (!draft.projectId) return;
    let cancelled = false;
    api
      .git(draft.projectId)
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [draft.projectId]);

  const useFolder = async (path: string) => {
    const project = await api.addProject(path);
    patchDraft({
      projectId: project.id,
      branch: null,
      createBranch: false,
      worktree: false,
      worktreePath: null,
    });
    await refreshState();
  };

  const chooseFolder = async () => {
    setChoosing(true);
    try {
      const chosen = await api.choosePath("folder");
      if (chosen.path) await useFolder(chosen.path);
    } catch (error) {
      setError((error as Error).message);
      setPickerOpen(true);
    } finally {
      setChoosing(false);
    }
  };

  const branches = snapshot?.branches ?? [];
  const current = snapshot?.branch ?? null;
  const selected = draft.branch ?? current;
  const lockedWorktree = Boolean(draft.worktreePath);
  const mainPath = snapshot?.worktrees.find((worktree) => worktree.isMain)?.path ?? null;
  // the main checkout is a worktree too, but running there is not "a worktree session"
  const linkedWorktree = (branch: Branch) =>
    branch.worktreePath && branch.worktreePath !== mainPath ? branch.worktreePath : null;

  const toggleWorktree = () => {
    if (lockedWorktree) return;
    if (draft.worktree) {
      patchDraft({ worktree: false, branch: null, createBranch: false, worktreePath: null });
      return;
    }
    const entry = branches.find((branch) => branch.name === selected);
    if (entry && !entry.isCurrent && !linkedWorktree(entry)) {
      patchDraft({ worktree: true, branch: entry.name, createBranch: false });
      return;
    }
    // the selected branch is checked out already, so a worktree needs a branch of its own
    patchDraft({
      worktree: true,
      branch: unusedBranch(selected ?? "session", branches),
      createBranch: true,
    });
  };

  const pickBranch = (branch: Branch | { name: string; create: true }) => {
    setMenuOpen(false);
    if ("create" in branch) {
      patchDraft({ branch: branch.name, createBranch: true, worktreePath: null, worktree: true });
      return;
    }
    const existing = linkedWorktree(branch);
    if (existing) {
      patchDraft({ branch: branch.name, createBranch: false, worktreePath: existing, worktree: true });
      return;
    }
    patchDraft({
      branch: branch.name,
      createBranch: false,
      worktreePath: null,
      worktree: !branch.isCurrent,
    });
  };

  return (
    <>
      <Chip
        icon={<FolderIcon />}
        onClick={() => void chooseFolder()}
        title="Choose the folder this session runs in"
        className={project ? undefined : "border-primary/60 text-primary"}
      >
        {choosing ? "Choosing…" : (project?.name ?? "Choose folder")}
      </Chip>

      {snapshot?.isGit ? (
        <div className="inline-flex">
          <div className="inline-flex h-7 items-center overflow-hidden rounded-md border border-border/70 bg-accent/40 text-[12px] text-muted-foreground">
            <Popover open={menuOpen} onOpenChange={setMenuOpen}>
              <PopoverTrigger
                title="Branch"
                className="flex h-full items-center gap-1.5 px-2 transition outline-none hover:text-foreground"
              >
                <BranchIcon />
                <span className="max-w-40 truncate font-mono">{selected ?? "detached"}</span>
                {draft.createBranch ? <span className="text-[11px] text-primary">new</span> : null}
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-80 p-0">
                <BranchMenu
                  branches={branches}
                  current={current}
                  selected={selected}
                  linkedWorktree={linkedWorktree}
                  onPick={pickBranch}
                />
              </PopoverContent>
            </Popover>
            <Separator orientation="vertical" className="h-4" />
            <Tooltip>
              <TooltipTrigger asChild>
                <label
                  className={cn(
                    "flex h-full items-center gap-1.5 px-2 transition hover:text-foreground",
                    lockedWorktree ? "cursor-default" : "cursor-pointer",
                  )}
                >
                  <Checkbox
                    checked={draft.worktree}
                    disabled={lockedWorktree}
                    onCheckedChange={toggleWorktree}
                    className="size-3"
                  />
                  worktree
                </label>
              </TooltipTrigger>
              <TooltipContent>
                {lockedWorktree
                  ? "This branch already has a worktree, so the session runs there"
                  : "Run this session in its own git worktree"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      ) : null}

      {pickerOpen ? (
        <FolderPicker onClose={() => setPickerOpen(false)} onPick={useFolder} />
      ) : null}
    </>
  );
}

export function DraftView({ draft }: { draft: Draft }) {
  const project = useStore((state) => state.projects.find((item) => item.id === draft.projectId));
  const patchDraft = useStore((state) => state.patchDraft);
  const startFromDraft = useStore((state) => state.startFromDraft);
  const setError = useStore((state) => state.setError);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <header data-titlebar className="flex h-15 shrink-0 items-center gap-2.5 border-b border-border/60 px-5">
        <SidebarToggle />
        <StatusDot status="idle" />
        <h1 className="min-w-0 truncate text-[13.5px] font-medium">New session</h1>
        <div className="flex-1" />
        {project ? (
          <span className="truncate font-mono text-[11px] text-faint" title={project.path}>
            {project.path.replace(/^\/Users\/[^/]+/, "~")}
          </span>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center px-5">
        <div className="text-center">
          <h2 className="flex items-center justify-center gap-1.5 text-[17px] font-medium">
            <SparkleIcon className="size-4 text-primary" />
            Start a session
          </h2>
          <p className="mt-1.5 text-[13px] text-faint">
            Pick a folder and branch below, then describe the task.
          </p>
          <p className="mt-1 text-[12px] text-faint">
            Once the first message is sent they stay fixed for the session.
          </p>
        </div>
      </div>

      <Composer
        chips={<DraftChips draft={draft} />}
        cwd={draft.worktreePath ?? project?.path}
        model={draft.model}
        permissionMode={draft.permissionMode}
        effort={draft.effort}
        onModel={(model) => patchDraft({ model })}
        onPermissionMode={(permissionMode) => patchDraft({ permissionMode })}
        onEffort={(effort) => patchDraft({ effort })}
        placeholder={draft.projectId ? "Describe a task or ask a question" : "Choose a folder to start…"}
        blocked={!draft.projectId}
        onSubmit={async (text) => {
          try {
            await startFromDraft(text);
          } catch (error) {
            setError((error as Error).message);
            throw error;
          }
        }}
      />
    </main>
  );
}
