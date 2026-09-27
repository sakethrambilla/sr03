// Everything sr03 asks git: repo and branch info, worktree add/remove/list, the changed-file list
// behind a session's file tree, per-file diffs, which paths are ignored, and the text search behind
// the quick-open palette. Every call shells out to the git binary — there is no cache and no
// library.
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
  locked: boolean;
  lockReason: string | null;
}

export async function listWorktrees(root: string): Promise<Worktree[]> {
  const output = await git(root, ["worktree", "list", "--porcelain"]);
  const worktrees: Worktree[] = [];
  let current: {
    path?: string;
    branch?: string | null;
    locked?: boolean;
    lockReason?: string | null;
  } = {};
  const flush = () => {
    if (current.path) {
      worktrees.push({
        path: path.resolve(current.path),
        branch: current.branch ?? null,
        isMain: worktrees.length === 0,
        locked: current.locked ?? false,
        lockReason: current.lockReason ?? null,
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
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = line === "locked" ? null : line.slice("locked ".length).trim();
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

export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number; // unix seconds
  message: string;    // subject line only
}

export interface Ref {
  name: string;               // short name, e.g. "main", "origin/main", "v1.0.0"
  kind: "head" | "tag" | "remote";
  commit: string;              // hash it resolves to (tags: the tag's target, peeled)
}

export async function commitLog(
  root: string,
  input: { maxCount: number; skip: number; ref?: string },
): Promise<{ commits: Commit[]; hasMore: boolean }> {
  const FIELD = "\x1f";
  const RECORD = "\x1e";
  const format = `%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s${RECORD}`;
  const fetchCount = input.maxCount + 1;
  // a caller-supplied ref narrows history to one branch/tag instead of every ref; validated
  // by the API route before it ever reaches here, but re-checked since this is exported
  if (input.ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(input.ref)) {
    throw new GitError(`Invalid ref: ${input.ref}`);
  }
  try {
    const output = await git(root, [
      "log",
      "--date-order",
      ...(input.ref ? [input.ref] : ["--all"]),
      `--max-count=${fetchCount}`,
      `--skip=${input.skip}`,
      `--format=${format}`,
    ]);
    const records = output
      .split(RECORD)
      .map((record) => record.trim())
      .filter((record) => record.length > 0);
    const commits = records.slice(0, input.maxCount).map((record) => {
      const [hash, parents, authorName, authorEmail, authorDate, message] = record.split(FIELD);
      return {
        hash: hash ?? "",
        parents: (parents ?? "").split(" ").filter(Boolean),
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        authorDate: Number(authorDate) || 0,
        message: message ?? "",
      };
    });
    return { commits, hasMore: records.length > input.maxCount };
  } catch {
    // an empty repo ("does not have any commits yet") is an empty page, not a failure
    return { commits: [], hasMore: false };
  }
}

export async function listRefs(root: string): Promise<Ref[]> {
  const output = await git(root, [
    "for-each-ref",
    "--format=%(refname)\x1f%(objectname)\x1f%(*objectname)",
    "refs/heads",
    "refs/tags",
    "refs/remotes",
  ]);
  const refs: Ref[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [refname, objectname, peeled] = line.split("\x1f");
    if (!refname || !objectname) continue;
    if (refname.startsWith("refs/heads/")) {
      refs.push({ name: refname.slice("refs/heads/".length), kind: "head", commit: objectname });
    } else if (refname.startsWith("refs/tags/")) {
      const target = peeled && peeled.length > 0 ? peeled : objectname;
      refs.push({ name: refname.slice("refs/tags/".length), kind: "tag", commit: target });
    } else if (refname.startsWith("refs/remotes/")) {
      refs.push({ name: refname.slice("refs/remotes/".length), kind: "remote", commit: objectname });
    }
  }
  return refs;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";
}

// sanitizeSegment is lossy — feat/a and feat-a both become feat-a — and a removed worktree can
// leave its directory behind, so the first free name wins rather than the bare one
async function freeWorktreePath(dir: string, name: string): Promise<string> {
  for (let counter = 1; ; counter += 1) {
    const target = path.join(dir, counter === 1 ? name : `${name}-${counter}`);
    if (!(await fs.stat(target).then(() => true, () => false))) return target;
  }
}

// Claude Code's .worktreeinclude: one path per line, relative to the repo root, naming gitignored
// paths (.env, node_modules) that a fresh worktree still needs. Plain paths, not gitignore patterns
// or pathspecs — git resolves a malformed pathspec to "match everything", which would copy the
// whole ignored tree. check-ignore is what keeps this to ignored paths only.
// Best-effort: the worktree already exists by the time this runs, so a missing or unreadable entry
// is logged and the worktree still ships without it.
async function copyIncludedPaths(root: string, target: string): Promise<void> {
  const manifest = await fs
    .readFile(path.join(root, ".worktreeinclude"), "utf8")
    .catch(() => null);
  if (manifest === null) return;

  for (const line of manifest.split("\n")) {
    const entry = line.trim();
    if (entry.length === 0 || entry.startsWith("#")) continue;
    const from = path.resolve(root, entry);
    if (!from.startsWith(root + path.sep)) {
      console.error("[git] .worktreeinclude skipping path outside the repo:", entry);
      continue;
    }
    const ignored = await git(root, ["check-ignore", "-q", "--", entry]).then(
      () => true,
      () => false,
    );
    if (!ignored) {
      console.error("[git] .worktreeinclude skipping path git does not ignore:", entry);
      continue;
    }
    if (!(await fs.stat(from).then(() => true, () => false))) continue;
    const to = path.join(target, path.relative(root, from));
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(from, to, { recursive: true, force: true, errorOnExist: false });
  }
}

export async function addWorktree(input: {
  root: string;
  branch: string;
  createBranch: boolean;
  base?: string;
}): Promise<Worktree> {
  const repoName = sanitizeSegment(path.basename(input.root));
  const parent = path.join(WORKTREES_DIR, repoName);
  await fs.mkdir(parent, { recursive: true });
  const target = await freeWorktreePath(parent, sanitizeSegment(input.branch));
  const args = input.createBranch
    ? ["worktree", "add", "-b", input.branch, target, input.base ?? "HEAD"]
    : ["worktree", "add", target, input.branch];
  await git(input.root, args);
  await copyIncludedPaths(input.root, target).catch((error: Error) =>
    console.error("[git] .worktreeinclude", error.message),
  );
  return { path: target, branch: input.branch, isMain: false, locked: false, lockReason: null };
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

export async function lockWorktree(input: { root: string; path: string; reason?: string }): Promise<void> {
  const args = ["worktree", "lock", input.path];
  if (input.reason?.trim()) args.push("--reason", input.reason.trim());
  await git(input.root, args);
}

export async function unlockWorktree(input: { root: string; path: string }): Promise<void> {
  await git(input.root, ["worktree", "unlock", input.path]);
}

export async function moveWorktree(input: { root: string; path: string; to: string }): Promise<void> {
  await git(input.root, ["worktree", "move", input.path, input.to]);
}

export async function fetchWorktree(cwd: string): Promise<string> {
  return git(cwd, ["fetch"]);
}

export async function pullWorktree(cwd: string): Promise<string> {
  return git(cwd, ["pull"]);
}

export async function pushWorktree(cwd: string): Promise<string> {
  return git(cwd, ["push"]);
}

export async function mergedBranches(root: string, target: string): Promise<Set<string>> {
  const output = await git(root, ["branch", "--merged", target, "--format=%(refname:short)"]);
  return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
}

export async function switchBranch(input: {
  cwd: string;
  branch: string;
  createBranch: boolean;
  base?: string;
}): Promise<void> {
  const args = input.createBranch
    ? ["switch", "-c", input.branch, input.base ?? "HEAD"]
    : ["switch", input.branch];
  await git(input.cwd, args);
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

export interface CommitFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  binary: boolean;
}

// the canonical empty tree — diffing a root commit against it is how you list "everything
// this commit added" without diff-tree's separate --root flag and its different output shape
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function firstParentOrEmptyTree(cwd: string, hash: string): Promise<string> {
  try {
    return (await git(cwd, ["rev-parse", `${hash}^`])).trim();
  } catch {
    return EMPTY_TREE; // root commit has no parent
  }
}

function classifyCommitStatus(code: string): CommitFile["status"] {
  const letter = code[0] ?? "M";
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R" || letter === "C") return "renamed";
  return "modified";
}

// Two diffs of the same base..hash pair, walked in lockstep: --name-status for the status
// letter, --numstat for line counts. Git walks the tree in the same order for both formats
// given identical base/hash/pathspec, so the Nth record of one is the Nth of the other. A
// rename/copy's record in both formats is [old path, new path] — the new path is what the
// user acts on, so that one is kept.
export async function commitFiles(cwd: string, hash: string): Promise<CommitFile[]> {
  const base = await firstParentOrEmptyTree(cwd, hash);
  const [statusRaw, numstatRaw] = await Promise.all([
    git(cwd, ["-c", "core.quotepath=false", "diff", "--name-status", "-z", base, hash]),
    git(cwd, ["-c", "core.quotepath=false", "diff", "--numstat", "-z", base, hash]),
  ]);
  const statusParts = statusRaw.split("\0").filter((part) => part.length > 0);
  const statuses: Array<{ code: string; path: string }> = [];
  for (let index = 0; index < statusParts.length; index += 1) {
    const code = statusParts[index]!;
    const isRenameOrCopy = code[0] === "R" || code[0] === "C";
    const oldPath = statusParts[index + 1];
    if (oldPath === undefined) break;
    if (isRenameOrCopy) {
      const newPath = statusParts[index + 2];
      statuses.push({ code, path: newPath ?? oldPath });
      index += 2;
    } else {
      statuses.push({ code, path: oldPath });
      index += 1;
    }
  }
  const numstatParts = numstatRaw.split("\0").filter((part) => part.length > 0);
  const counts: Array<{ insertions: number; deletions: number; binary: boolean }> = [];
  for (let index = 0; index < numstatParts.length; index += 1) {
    const record = numstatParts[index]!;
    const [insertions, deletions, name] = record.split("\t");
    if (insertions === undefined || deletions === undefined) continue;
    if (!name) index += 2; // rename/copy: name is empty, old and new paths follow as separate records
    counts.push({
      insertions: Number(insertions) || 0,
      deletions: Number(deletions) || 0,
      binary: insertions === "-",
    });
  }
  return statuses.map((entry, index) => ({
    path: entry.path,
    status: classifyCommitStatus(entry.code),
    insertions: counts[index]?.insertions ?? 0,
    deletions: counts[index]?.deletions ?? 0,
    binary: counts[index]?.binary ?? false,
  }));
}

export async function commitFileDiff(cwd: string, hash: string, file: string): Promise<string> {
  const base = await firstParentOrEmptyTree(cwd, hash);
  return diffText(cwd, ["-c", "core.quotepath=false", "diff", base, hash, "--", file]);
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
// past this many untracked files the counts stop mattering and the reads start to
const UNTRACKED_COUNT_LIMIT = 200;
const READ_CONCURRENCY = 8;

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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

  const counted = await mapLimit(untracked.slice(0, UNTRACKED_COUNT_LIMIT), READ_CONCURRENCY, (file) =>
    countLines(path.join(cwd, file)),
  );
  untracked.forEach((file, index) => {
    files.push({
      path: file,
      status: "untracked",
      staged: false,
      ...(counted[index] ?? { insertions: 0, deletions: 0, binary: false }),
    });
  });

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

export interface TextMatch {
  path: string;
  line: number;
  text: string;
}

// a match on a minified line is worth having; the other 200 KB of that line is not
export const MATCH_TEXT_LIMIT = 400;
const RECORD_LIMIT = 1024 * 1024;

// `-z -n` writes one record per hit as path\0line\0text, so a path containing a colon can't be
// mistaken for a field separator. There is no --column here on purpose: git counts that in bytes,
// which would land in the wrong place on any line holding multibyte text.
function parseMatch(record: string): TextMatch | null {
  const first = record.indexOf("\0");
  const second = record.indexOf("\0", first + 1);
  if (first === -1 || second === -1) return null;
  const line = Number(record.slice(first + 1, second));
  if (!Number.isInteger(line)) return null;
  return {
    path: record.slice(0, first),
    line,
    text: record.slice(second + 1, second + 1 + MATCH_TEXT_LIMIT),
  };
}

// Every text match in the folder, or null when it isn't a repo and the caller has to scan
// itself. `--untracked` covers the same files listedFiles does — tracked plus untracked, minus
// ignored — and `-I` leaves binaries alone. grep has no global cap of its own, only a per-file
// one, so this reads records until `limit` and then kills the child.
export function searchText(cwd: string, query: string, limit: number): Promise<TextMatch[] | null> {
  // smart case, the way ripgrep and VS Code do it: an all-lowercase query ignores case
  const smartCase = query === query.toLowerCase() ? ["-i"] : [];
  const args = [
    "-c",
    "core.quotepath=false",
    "grep",
    "--no-color",
    "-n",
    "-I",
    "-z",
    "--untracked",
    ...smartCase,
    "-F",
    "-e",
    query,
    "--",
    ".",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    const matches: TextMatch[] = [];
    let buffer = "";
    let skipping = false;
    let err = "";
    let settled = false;

    const done = (value: TextMatch[] | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const record = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (skipping) {
          skipping = false;
          continue;
        }
        const match = parseMatch(record);
        if (match) matches.push(match);
        if (matches.length >= limit) {
          child.kill();
          done(matches);
          return;
        }
      }
      // a minified file is one enormous line, and buffering it whole costs more than its match
      if (buffer.length > RECORD_LIMIT) {
        buffer = "";
        skipping = true;
      }
    });
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      // 1 is "nothing matched", which is an answer; outside a repo grep can't run at all
      if (code === 0 || code === 1) return done(matches);
      if (/not a git repository/i.test(err)) return done(null);
      if (settled) return;
      settled = true;
      reject(new GitError(err.trim() || `git exited ${code}`));
    });
  });
}
