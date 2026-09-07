// A project's worktrees: which exist, and removing one. Creating one happens from the composer's
// own worktree checkbox + branch picker, which already covers picking a base and naming a branch.
import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { GitSnapshot, Project } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { Dialog, Pill } from "./ui.tsx";

export function WorktreePanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const startDraft = useStore((state) => state.startDraft);
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .git(project.id)
      .then(setSnapshot)
      .catch((cause: Error) => setError(cause.message));
  };

  useEffect(load, [project.id]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (snapshot && !snapshot.isGit) {
    return (
      <Dialog title={`${project.name} · worktrees`} onClose={onClose}>
        <p className="text-sm text-muted-foreground">This folder is not a git repository, so worktrees are unavailable.</p>
      </Dialog>
    );
  }

  return (
    <Dialog title={`${project.name} · worktrees`} onClose={onClose} wide>
      {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}

      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Worktrees ({snapshot?.worktrees.length ?? 0})
        </h3>
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
          {snapshot?.worktrees.map((worktree) => (
            <li key={worktree.path} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{worktree.branch ?? "detached"}</span>
                  {worktree.isMain ? <Pill>main</Pill> : null}
                </div>
                <p className="font-mono text-[11px] break-all text-faint">{worktree.path}</p>
              </div>
              <Button
                disabled={busy}
                onClick={() => {
                  startDraft({
                    projectId: project.id,
                    ...(worktree.branch ? { branch: worktree.branch } : {}),
                    ...(worktree.isMain ? {} : { worktreePath: worktree.path }),
                    locked: true,
                  });
                  onClose();
                }}
              >
                New session
              </Button>
              {worktree.isMain ? null : (
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void run(() => api.removeWorktree(project.id, worktree.path, true))}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </Dialog>
  );
}
