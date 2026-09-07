# Task 6: web client methods + WorktreePanel UI enhancements

**Depends on:** Task 5
**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/components/ui.tsx`
- Modify: `web/src/components/WorktreePanel.tsx`

**Interfaces consumed:** the nine routes from Task 5, `Worktree` type
(Task 5, now carrying `locked`/`lockReason`/`favorite`).

## Steps

- [ ] 1. In `web/src/lib/api.ts`, add these methods next to
      `removeWorktree`:
      ```ts
      lockWorktree: (projectId: string, path: string, reason?: string) =>
        post<{ ok: true }>(`/api/projects/${projectId}/worktrees/lock`, { path, reason }),
      unlockWorktree: (projectId: string, path: string) =>
        post<{ ok: true }>(`/api/projects/${projectId}/worktrees/unlock`, { path }),
      moveWorktree: (projectId: string, path: string, to: string) =>
        post<{ ok: true; path: string }>(`/api/projects/${projectId}/worktrees/move`, { path, to }),
      fetchWorktree: (projectId: string, path: string) =>
        post<{ output: string }>(`/api/projects/${projectId}/worktrees/fetch`, { path }),
      pullWorktree: (projectId: string, path: string) =>
        post<{ output: string }>(`/api/projects/${projectId}/worktrees/pull`, { path }),
      pushWorktree: (projectId: string, path: string) =>
        post<{ output: string }>(`/api/projects/${projectId}/worktrees/push`, { path }),
      favoriteWorktree: (projectId: string, path: string, favorite: boolean) =>
        post<{ ok: true }>(`/api/projects/${projectId}/worktrees/favorite`, { path, favorite }),
      mergedCandidates: (projectId: string) =>
        call<{ candidates: Worktree[] }>(`/api/projects/${projectId}/worktrees/merged-candidates`),
      removeMergedWorktrees: (projectId: string, paths: string[]) =>
        post<{ removed: string[] }>(`/api/projects/${projectId}/worktrees/remove-merged`, { paths }),
      ```

- [ ] 2. In `web/src/components/ui.tsx`, add five icons to the
      `lucide-react` import list (alphabetical): `ArrowDownToLine`,
      `ArrowUpFromLine`, `Lock`, `LockOpen`, `Star`. Add them to `ICONS`:
      `LockIcon: Lock`, `UnlockIcon: LockOpen`, `FavoriteIcon: Star`,
      `PullIcon: ArrowDownToLine`, `PushIcon: ArrowUpFromLine`. Export
      each with `icon(...)`, following the existing pattern (e.g.
      `export const LockIcon = icon(ICONS.LockIcon);`).

- [ ] 3. Replace `web/src/components/WorktreePanel.tsx` in full with:
      ```tsx
      // A project's worktrees: which exist, adding one on a new or existing branch, and managing
      // their lifecycle — lock/unlock, move, fetch/pull/push, favorites, and bulk-removing every
      // worktree whose branch is already merged into the main worktree's branch. A worktree lives
      // under the data dir, not inside the repo.
      import { useEffect, useState } from "react";

      import { api } from "../lib/api.ts";
      import type { GitSnapshot, Project, Worktree } from "../lib/types.ts";
      import { useStore } from "../store.ts";
      import { Button } from "@/components/ui/button";
      import { Input } from "@/components/ui/input";
      import {
        CheckIcon,
        Dialog,
        FavoriteIcon,
        LockIcon,
        Pill,
        PullIcon,
        PushIcon,
        RefreshIcon,
        UnlockIcon,
        WorktreeIcon,
      } from "./ui.tsx";
      import { cn } from "@/lib/utils";

      export function WorktreePanel({ project, onClose }: { project: Project; onClose: () => void }) {
        const startDraft = useStore((state) => state.startDraft);
        const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
        const [branch, setBranch] = useState("");
        const [base, setBase] = useState("");
        const [error, setError] = useState<string | null>(null);
        const [busy, setBusy] = useState(false);
        const [moving, setMoving] = useState<string | null>(null);
        const [moveTarget, setMoveTarget] = useState("");
        const [candidates, setCandidates] = useState<Worktree[] | null>(null);

        const load = () => {
          api
            .git(project.id)
            .then((next) => {
              setSnapshot(next);
              setBase((current) => current || next.branch || "HEAD");
            })
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

        const create = () =>
          run(async () => {
            const existing = snapshot?.branches.find((item) => item.name === branch.trim());
            const worktree = await api.addWorktree(project.id, {
              branch: branch.trim(),
              createBranch: !existing,
              ...(existing ? {} : { base: base.trim() || "HEAD" }),
            });
            setBranch("");
            startDraft({
              projectId: project.id,
              ...(worktree.branch ? { branch: worktree.branch } : {}),
              worktreePath: worktree.path,
            });
            onClose();
          });

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

            <section className="mb-5 rounded-lg border border-border bg-background p-3">
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">New worktree</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && branch.trim()) void create();
                  }}
                  placeholder="feat/my-branch"
                  spellCheck={false}
                  className="h-8 min-w-52 flex-1 font-mono text-xs"
                />
                <span className="text-xs text-faint">from</span>
                <Input
                  value={base}
                  onChange={(event) => setBase(event.target.value)}
                  spellCheck={false}
                  className="h-8 w-32 font-mono text-xs"
                />
                <Button variant="default" disabled={busy || !branch.trim()} onClick={() => void create()}>
                  Create + start session
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-faint">
                An existing branch is checked out as-is; a new name is branched off the base ref.
              </p>
            </section>

            <section className="mb-5">
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
                        <p className="truncate font-mono text-[11px] text-faint">{worktree.path}</p>
                      </div>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          startDraft({
                            projectId: project.id,
                            ...(worktree.branch ? { branch: worktree.branch } : {}),
                            ...(worktree.isMain ? {} : { worktreePath: worktree.path }),
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

            <section>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Branches</h3>
              <div className="flex flex-wrap gap-1.5">
                {snapshot?.branches.map((item) => (
                  <Button
                    key={item.name}
                    variant="outline"
                    onClick={() => setBranch(item.name)}
                    className="h-auto gap-1.5 bg-background px-2 py-0.5 font-mono text-[11px] font-normal text-muted-foreground"
                  >
                    {item.name}
                    {item.isCurrent ? <CheckIcon className="size-3 text-primary" /> : null}
                    {item.worktreePath ? <WorktreeIcon className="size-3" /> : null}
                  </Button>
                ))}
              </div>
            </section>
          </Dialog>
        );
      }
      ```
- [ ] 4. Run `pnpm -C web typecheck`. Expect: no errors.

- [ ] 5. Manual verification against a scratch repo with a merged
      branch (per the repo's Testing section):
      ```bash
      mkdir -p /tmp/sr03-merged && cd /tmp/sr03-merged && git init -q -b main \
        && echo one > a.txt && git add . && git commit -qm init \
        && git checkout -q -b done-feature \
        && echo two >> a.txt && git add . && git commit -qm "feature work" \
        && git checkout -q main && git merge -q done-feature
      ```
      Run `pnpm dev`, add the project, create a worktree on
      `done-feature` through the panel (it's an existing, already-merged
      branch). Open the worktree panel again and click "Remove
      merged…" — expect the `done-feature` worktree listed as a
      candidate; confirm and expect it removed. Separately, star a
      worktree, restart the server, and confirm it still shows starred
      and sorts to the top of the list.

- [ ] 6. `git add web/src/lib/api.ts web/src/components/ui.tsx web/src/components/WorktreePanel.tsx`
      `git commit -m "feat(web): add worktree lock, move, sync, and favorites UI"`

## Done when

`pnpm -C web typecheck` is clean, and the manual scenario in step 5
removes exactly the merged worktree (not the main one) and shows the
favorited worktree surviving a restart, sorted first in the list.
