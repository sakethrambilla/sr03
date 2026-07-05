import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

import { WORKTREES_DIR } from "./config.ts";

const exec = promisify(execFile);

export class GitError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new GitError(stderr || (error as Error).message);
  }
}

export interface RepoInfo {
  isGit: boolean;
  root: string | null;
  branch: string | null;
  dirty: number;
}

export async function repoInfo(dir: string): Promise<RepoInfo> {
  try {
    const root = (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    const [branch, status] = await Promise.all([
      git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((value) => value.trim()),
      git(dir, ["status", "--porcelain"]),
    ]);
    const dirty = status.split("\n").filter((line) => line.trim().length > 0).length;
    return { isGit: true, root, branch: branch === "HEAD" ? null : branch, dirty };
  } catch {
    return { isGit: false, root: null, branch: null, dirty: 0 };
  }
}

export interface Worktree {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export async function listWorktrees(root: string): Promise<Worktree[]> {
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  const worktrees: Worktree[] = [];
  let current: { path?: string; branch?: string | null } = {};
  const flush = () => {
    if (current.path) {
      worktrees.push({
        path: path.resolve(current.path),
        branch: current.branch ?? null,
        isMain: worktrees.length === 0,
      });
    }
    current = {};
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length).trim();
    } else if (line.trim() === "detached") {
      current.branch = null;
    }
  }
  flush();
  return worktrees;
}

export interface Branch {
  name: string;
  isCurrent: boolean;
  worktreePath: string | null;
}

export async function listBranches(root: string): Promise<Branch[]> {
  const [output, worktrees] = await Promise.all([
    git(root, ["for-each-ref", "--format=%(refname:short)%09%(HEAD)", "refs/heads"]),
    listWorktrees(root),
  ]);
  const byBranch = new Map(
    worktrees.filter((worktree) => worktree.branch).map((worktree) => [worktree.branch!, worktree.path]),
  );
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name, head] = line.split("\t");
      return {
        name: name!.trim(),
        isCurrent: head?.trim() === "*",
        worktreePath: byBranch.get(name!.trim()) ?? null,
      };
    });
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

export async function addWorktree(input: {
  root: string;
  branch: string;
  createBranch: boolean;
  base?: string;
}): Promise<Worktree> {
  const repoName = sanitizeSegment(path.basename(input.root));
  const target = path.join(WORKTREES_DIR, repoName, sanitizeSegment(input.branch));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const args = input.createBranch
    ? ["worktree", "add", "-b", input.branch, target, input.base ?? "HEAD"]
    : ["worktree", "add", target, input.branch];
  await git(input.root, args);
  return { path: target, branch: input.branch, isMain: false };
}

export async function removeWorktree(input: {
  root: string;
  path: string;
  force: boolean;
}): Promise<void> {
  const args = ["worktree", "remove", input.path];
  if (input.force) args.push("--force");
  await git(input.root, args);
}

export async function pruneWorktrees(root: string): Promise<void> {
  await git(root, ["worktree", "prune"]);
}

export async function diffStat(cwd: string): Promise<{ files: number; insertions: number; deletions: number }> {
  try {
    const output = await git(cwd, ["diff", "--numstat", "HEAD"]);
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of output.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      files += 1;
      insertions += Number(parts[0]) || 0;
      deletions += Number(parts[1]) || 0;
    }
    return { files, insertions, deletions };
  } catch {
    return { files: 0, insertions: 0, deletions: 0 };
  }
}
