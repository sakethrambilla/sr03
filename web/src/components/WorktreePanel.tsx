// A project's worktrees: which exist, and managing their lifecycle — lock/unlock, move,
// fetch/pull/push, favorites, and bulk-removing every worktree whose branch is already merged
// into the main worktree's branch. Creating one happens from the composer's own worktree
// checkbox + branch picker, which already covers picking a base and naming a branch.
import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { GitSnapshot, Project, Worktree } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  FavoriteIcon,
  LockIcon,
  Pill,
  PullIcon,
  PushIcon,
  RefreshIcon,
  UnlockIcon,
} from "./ui.tsx";
import { cn } from "@/lib/utils";

export function WorktreePanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const startDraft = useStore((state) => state.startDraft);
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [candidates, setCandidates] = useState<Worktree[] | null>(null);

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

  const loadCandidates = () =>
    run(async () => {
      const result = await api.mergedCandidates(project.id);
      setCandidates(result.candidates);
    });

  const confirmRemoveMerged = () =>
    run(async () => {
      if (!candidates || candidates.length === 0) return;
      await api.removeMergedWorktrees(
        project.id,
        candidates.map((worktree) => worktree.path),
      );
      setCandidates(null);
    });

  if (snapshot && !snapshot.isGit) {
    return (
      <Dialog title={`${project.name} · worktrees`} onClose={onClose}>
        <p className="text-sm text-muted-foreground">This folder is not a git repository, so worktrees are unavailable.</p>
      </Dialog>
    );
  }

  const worktrees = [...(snapshot?.worktrees ?? [])].sort(
    (a, b) => Number(b.favorite) - Number(a.favorite),
  );

  return (
    <Dialog title={`${project.name} · worktrees`} onClose={onClose} wide>
      {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Worktrees ({worktrees.length})
          </h3>
          <Button variant="outline" disabled={busy} onClick={() => void loadCandidates()} className="h-7 text-xs">
            Remove merged…
          </Button>
        </div>

        {candidates ? (
          <div className="mb-2 rounded-lg border border-border bg-background p-2">
            {candidates.length === 0 ? (
              <p className="text-xs text-faint">No worktrees are merged into the main branch.</p>
            ) : (
              <>
                <p className="mb-1.5 text-xs text-muted-foreground">
                  Merged into the main worktree's branch — remove these?
                </p>
                <ul className="mb-2 space-y-0.5">
                  {candidates.map((worktree) => (
                    <li key={worktree.path} className="truncate font-mono text-[11px] text-faint">
                      {worktree.branch} — {worktree.path}
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => void confirmRemoveMerged()}
                  >
                    Remove {candidates.length}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setCandidates(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}

        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
          {worktrees.map((worktree) => (
            <li key={worktree.path} className="flex flex-col gap-1.5 px-3 py-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.favoriteWorktree(project.id, worktree.path, !worktree.favorite))
                  }
                  aria-label={worktree.favorite ? "Unfavorite" : "Favorite"}
                  className="shrink-0 text-faint hover:text-foreground"
                >
                  <FavoriteIcon className={cn("size-3.5", worktree.favorite && "fill-primary text-primary")} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{worktree.branch ?? "detached"}</span>
                    {worktree.isMain ? <Pill>main</Pill> : null}
                    {worktree.locked ? (
                      <span title={worktree.lockReason ?? undefined}>
                        <Pill>locked</Pill>
                      </span>
                    ) : null}
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
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      title="Fetch"
                      onClick={() => void run(() => api.fetchWorktree(project.id, worktree.path))}
                    >
                      <RefreshIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      title="Pull"
                      onClick={() => void run(() => api.pullWorktree(project.id, worktree.path))}
                    >
                      <PullIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      title="Push"
                      onClick={() => void run(() => api.pushWorktree(project.id, worktree.path))}
                    >
                      <PushIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy}
                      title={worktree.locked ? "Unlock" : "Lock"}
                      onClick={() =>
                        void run(() =>
                          worktree.locked
                            ? api.unlockWorktree(project.id, worktree.path)
                            : api.lockWorktree(project.id, worktree.path),
                        )
                      }
                    >
                      {worktree.locked ? <UnlockIcon className="size-3.5" /> : <LockIcon className="size-3.5" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setMoving(worktree.path);
                        setMoveTarget(worktree.path);
                      }}
                    >
                      Move
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={busy || worktree.locked}
                      title={worktree.locked ? worktree.lockReason ?? "Locked" : undefined}
                      onClick={() => void run(() => api.removeWorktree(project.id, worktree.path, true))}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </div>
              {moving === worktree.path ? (
                <div className="flex items-center gap-2 pl-6">
                  <Input
                    value={moveTarget}
                    onChange={(event) => setMoveTarget(event.target.value)}
                    spellCheck={false}
                    className="h-7 flex-1 font-mono text-[11px]"
                  />
                  <Button
                    size="sm"
                    disabled={busy || !moveTarget.trim() || moveTarget.trim() === worktree.path}
                    onClick={() =>
                      void run(async () => {
                        await api.moveWorktree(project.id, worktree.path, moveTarget.trim());
                        setMoving(null);
                      })
                    }
                  >
                    Confirm move
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMoving(null)}>
                    Cancel
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </Dialog>
  );
}
