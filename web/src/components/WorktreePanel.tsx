import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { GitSnapshot, Project } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button, Dialog, Pill } from "./ui.tsx";

export function WorktreePanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const newThread = useStore((state) => state.newThread);
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      await newThread({ projectId: project.id, cwd: worktree.path });
      onClose();
    });

  if (snapshot && !snapshot.isGit) {
    return (
      <Dialog title={`${project.name} · worktrees`} onClose={onClose}>
        <p className="text-sm text-muted">This folder is not a git repository, so worktrees are unavailable.</p>
      </Dialog>
    );
  }

  return (
    <Dialog title={`${project.name} · worktrees`} onClose={onClose} wide>
      {error ? <p className="mb-3 text-xs text-danger">{error}</p> : null}

      <section className="mb-5 rounded-lg border border-line bg-canvas p-3">
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">New worktree</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && branch.trim()) void create();
            }}
            placeholder="feat/my-branch"
            spellCheck={false}
            className="h-8 min-w-52 flex-1 rounded-md border border-line bg-panel px-2 font-mono text-xs outline-none focus:border-accent"
          />
          <span className="text-xs text-faint">from</span>
          <input
            value={base}
            onChange={(event) => setBase(event.target.value)}
            spellCheck={false}
            className="h-8 w-32 rounded-md border border-line bg-panel px-2 font-mono text-xs outline-none focus:border-accent"
          />
          <Button variant="primary" disabled={busy || !branch.trim()} onClick={() => void create()}>
            Create + open thread
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-faint">
          An existing branch is checked out as-is; a new name is branched off the base ref.
        </p>
      </section>

      <section className="mb-5">
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
          Worktrees ({snapshot?.worktrees.length ?? 0})
        </h3>
        <ul className="divide-y divide-line/60 overflow-hidden rounded-lg border border-line">
          {snapshot?.worktrees.map((worktree) => (
            <li key={worktree.path} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{worktree.branch ?? "detached"}</span>
                  {worktree.isMain ? <Pill>main</Pill> : null}
                </div>
                <p className="truncate font-mono text-[11px] text-faint">{worktree.path}</p>
              </div>
              <Button
                disabled={busy}
                onClick={() => void newThread({ projectId: project.id, cwd: worktree.path }).then(onClose)}
              >
                New thread
              </Button>
              {worktree.isMain ? null : (
                <Button
                  variant="danger"
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

      <section>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Branches</h3>
        <div className="flex flex-wrap gap-1.5">
          {snapshot?.branches.map((item) => (
            <button
              key={item.name}
              onClick={() => setBranch(item.name)}
              className="rounded-full border border-line bg-canvas px-2 py-0.5 font-mono text-[11px] text-muted hover:border-accent hover:text-ink"
            >
              {item.name}
              {item.isCurrent ? " ●" : ""}
              {item.worktreePath ? " ⧉" : ""}
            </button>
          ))}
        </div>
      </section>
    </Dialog>
  );
}
