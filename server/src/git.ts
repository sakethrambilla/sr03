import { execFile, spawn } from "node:child_process";
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

// `git diff --no-index` exits 1 when the files differ, which is a result here rather than a failure
async function diffText(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    if (failure.stdout) return failure.stdout;
    throw new GitError(failure.stderr?.trim() || (error as Error).message);
  }
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  staged: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
}

function classify(code: string | undefined): ChangedFile["status"] {
  if (code === "??") return "untracked";
  const letters = (code ?? "M").replace(/[ ?]/g, "");
  if (letters.includes("R")) return "renamed";
  if (letters.includes("D")) return "deleted";
  if (letters.includes("A")) return "added";
  return "modified";
}

async function statusCodes(cwd: string, pathspec?: string): Promise<Map<string, string>> {
  const raw = await git(cwd, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    ...(pathspec ? ["--", pathspec] : []),
  ]);
  const codes = new Map<string, string>();
  const parts = raw.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    codes.set(entry.slice(3), code);
    // a rename or copy is followed by its source path; git reports that side as a deletion
    // whenever the content changed too much for the pair to survive rename detection
    if (code.includes("R") || code.includes("C")) {
      index += 1;
      const source = parts[index];
      if (source && !codes.has(source)) codes.set(source, "D ");
    }
  }
  return codes;
}

// -z numstat writes renames as `ins\tdel\t` followed by the old and new paths as separate records
async function numstat(cwd: string, ref: string) {
  const raw = await diffText(cwd, ["-c", "core.quotepath=false", "diff", "--numstat", "-z", ref]);
  const parts = raw.split("\0");
  const entries: Array<{ path: string; insertions: number; deletions: number; binary: boolean }> = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) continue;
    const [insertions, deletions, name] = record.split("\t");
    if (insertions === undefined || deletions === undefined) continue;
    let file = name ?? "";
    if (!file) {
      index += 2;
      file = parts[index] ?? "";
    }
    if (!file) continue;
    entries.push({
      path: file,
      insertions: Number(insertions) || 0,
      deletions: Number(deletions) || 0,
      binary: insertions === "-",
    });
  }
  return entries;
}

const UNTRACKED_SCAN_LIMIT = 2 * 1024 * 1024;

async function countLines(target: string) {
  const stats = await fs.stat(target).catch(() => null);
  if (!stats || !stats.isFile() || stats.size > UNTRACKED_SCAN_LIMIT) {
    return { insertions: 0, deletions: 0, binary: false };
  }
  const bytes = await fs.readFile(target).catch(() => null);
  if (!bytes) return { insertions: 0, deletions: 0, binary: false };
  if (bytes.includes(0)) return { insertions: 0, deletions: 0, binary: true };
  const text = bytes.toString("utf8");
  const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  return { insertions: lines, deletions: 0, binary: false };
}

export async function changedFiles(cwd: string): Promise<ChangedFile[]> {
  const [codes, tracked, untracked] = await Promise.all([
    statusCodes(cwd).catch(() => new Map<string, string>()),
    numstat(cwd, "HEAD").catch(() => []),
    git(cwd, ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"])
      .then((raw) => raw.split("\0").filter((entry) => entry.length > 0))
      .catch(() => [] as string[]),
  ]);

  const files: ChangedFile[] = tracked.map((entry) => {
    const code = codes.get(entry.path);
    return {
      path: entry.path,
      status: classify(code),
      staged: code !== undefined && code[0] !== " " && code[0] !== "?",
      insertions: entry.insertions,
      deletions: entry.deletions,
      binary: entry.binary,
    };
  });

  for (const file of untracked) {
    files.push({
      path: file,
      status: "untracked",
      staged: false,
      ...(await countLines(path.join(cwd, file))),
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function fileDiff(cwd: string, file: string, untracked: boolean): Promise<string> {
  const args = untracked
    ? ["diff", "--no-index", "--", "/dev/null", file]
    : ["diff", "HEAD", "--", file];
  return diffText(cwd, ["-c", "core.quotepath=false", ...args]);
}

export async function fileState(
  cwd: string,
  file: string,
): Promise<{ status: ChangedFile["status"] | null; diff: string }> {
  const codes = await statusCodes(cwd, file).catch(() => new Map<string, string>());
  const code = codes.get(file);
  if (!code) return { status: null, diff: "" };
  const status = classify(code);
  return { status, diff: await fileDiff(cwd, file, status === "untracked").catch(() => "") };
}

// check-ignore wants its paths on stdin (a big directory would blow the argument limit)
// and exits 1 when nothing matched, which is an answer rather than a failure
function gitStdin(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 || code === 1 ? resolve(out) : reject(new GitError(err.trim() || `git exited ${code}`)),
    );
    child.stdin.end(input);
  });
}

export async function ignoredPaths(cwd: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const out = await gitStdin(
    cwd,
    ["-c", "core.quotepath=false", "check-ignore", "-z", "--stdin"],
    `${paths.join("\0")}\0`,
  ).catch(() => "");
  return new Set(out.split("\0").filter((entry) => entry.length > 0));
}

// every file git would show — tracked plus untracked, minus whatever is ignored
export async function listedFiles(cwd: string): Promise<string[] | null> {
  try {
    const out = await git(cwd, [
      "-c",
      "core.quotepath=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}
