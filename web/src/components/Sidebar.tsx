import { useMemo, useState } from "react";

import type { Project } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { Button, StatusDot, cn } from "./ui.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
import { WorktreePanel } from "./WorktreePanel.tsx";

export function Sidebar() {
  const { projects, threads, activeThreadId, connected } = useStore();
  const openThread = useStore((state) => state.openThread);
  const newThread = useStore((state) => state.newThread);
  const removeThread = useStore((state) => state.removeThread);
  const refreshState = useStore((state) => state.refreshState);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [worktreeProject, setWorktreeProject] = useState<Project | null>(null);

  const grouped = useMemo(
    () =>
      projects.map((project) => ({
        project,
        threads: threads.filter((thread) => thread.projectId === project.id),
      })),
    [projects, threads],
  );

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="font-mono text-sm font-semibold tracking-tight">sr03</span>
        <span
          className={cn("size-1.5 rounded-full", connected ? "bg-emerald-500" : "bg-danger")}
          title={connected ? "Connected" : "Disconnected"}
        />
        <div className="flex-1" />
        <Button variant="ghost" onClick={() => setPickerOpen(true)} title="Add project folder">
          + Folder
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {grouped.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-faint">
            No projects yet. Add a folder to start.
          </p>
        ) : null}

        {grouped.map(({ project, threads: projectThreads }) => (
          <section key={project.id} className="mb-3">
            <div className="group flex items-center gap-1 px-3 py-1">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-muted uppercase">
                {project.name}
              </span>
              {project.isGit ? (
                <button
                  onClick={() => setWorktreeProject(project)}
                  className="rounded px-1 text-xs text-faint opacity-0 transition group-hover:opacity-100 hover:text-ink"
                  title="Worktrees"
                >
                  ⧉
                </button>
              ) : null}
              <button
                onClick={() => void newThread({ projectId: project.id })}
                className="rounded px-1 text-sm text-faint opacity-0 transition group-hover:opacity-100 hover:text-ink"
                title="New thread"
              >
                +
              </button>
              <button
                onClick={() => void api.removeProject(project.id).then(refreshState)}
                className="rounded px-1 text-xs text-faint opacity-0 transition group-hover:opacity-100 hover:text-danger"
                title="Remove project"
              >
                ✕
              </button>
            </div>

            <ul>
              {projectThreads.length === 0 ? (
                <li className="px-3 py-1 text-[11px] text-faint">No threads</li>
              ) : null}
              {projectThreads.map((thread) => (
                <li key={thread.id} className="group px-1.5">
                  <div
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                      thread.id === activeThreadId ? "bg-raised" : "hover:bg-raised/60",
                    )}
                    onClick={() => void openThread(thread.id)}
                  >
                    <StatusDot status={thread.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink">{thread.title}</p>
                      {thread.isWorktree && thread.branch ? (
                        <p className="truncate font-mono text-[10px] text-faint">⧉ {thread.branch}</p>
                      ) : null}
                    </div>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        void removeThread(thread.id);
                      }}
                      className="text-xs text-faint opacity-0 transition group-hover:opacity-100 hover:text-danger"
                      title="Delete thread"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {pickerOpen ? (
        <FolderPicker
          onClose={() => setPickerOpen(false)}
          onPick={async (path) => {
            await api.addProject(path);
            await refreshState();
          }}
        />
      ) : null}
      {worktreeProject ? (
        <WorktreePanel project={worktreeProject} onClose={() => setWorktreeProject(null)} />
      ) : null}
    </aside>
  );
}
