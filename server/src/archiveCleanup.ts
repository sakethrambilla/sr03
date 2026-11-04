import path from "node:path";
import * as agents from "./agents/runtime.ts";
import { publish } from "./bus.ts";
import { WORKTREES_DIR } from "./config.ts";
import { projects, threads } from "./db.ts";
import * as git from "./git.ts";
import type { Thread } from "./types.ts";
import { releaseAllUnder } from "./watch.ts";

export interface ArchiveTarget {
  root: string;
  path: string;
  branch: string | null;
  files: string[];
  commits: number;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

export async function archiveTarget(thread: Thread): Promise<ArchiveTarget | null> {
  if (!thread.isWorktree) return null;
  const project = projects.byId(thread.projectId);
  if (!project) return null;
  const info = await git.repoInfo(project.path);
  if (!info.isGit || !info.root) return null;
  const cwd = path.resolve(thread.cwd);
  const worktrees = await git.listWorktrees(info.root);
  const worktree = worktrees.find((w) => within(cwd, path.resolve(w.path)));
  if (!worktree || worktree.isMain || worktree.locked) return null;
  const worktreePath = path.resolve(worktree.path);
  if (!within(worktreePath, path.resolve(WORKTREES_DIR))) return null;
  const shared = threads
    .list()
    .some((other) => other.id !== thread.id && !other.archived && within(path.resolve(other.cwd), worktreePath));
  if (shared) return null;
  const base = worktrees.find((w) => w.isMain)?.branch;
  if (!base) return null;
  const { files, commits } = await git.unsavedWork(worktreePath, base);
  return { root: info.root, path: worktreePath, branch: worktree.branch, files, commits };
}

export async function cleanupWorktree(thread: Thread, force: boolean): Promise<void> {
  try {
    const target = await archiveTarget(thread);
    if (!target) return;
    if (!force && (target.files.length || target.commits)) return;
    agents.closeSession(thread.id);
    releaseAllUnder(target.path);
    await git.removeWorktree({ root: target.root, path: target.path, force: true });
    await git.pruneWorktrees(target.root);
    if (target.branch) await git.deleteBranch(target.root, target.branch);
    publish({ type: "projects.changed" });
  } catch (error) {
    console.error("[archive] cleanup", thread.id, (error as Error).message);
  }
}
