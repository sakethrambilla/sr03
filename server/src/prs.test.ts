import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// config.ts reads SR03_DATA_DIR once per process, so the whole file shares one data dir.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr03-prs-"));
const previous = process.env.SR03_DATA_DIR;
process.env.SR03_DATA_DIR = dataDir;
after(() => {
  if (previous === undefined) delete process.env.SR03_DATA_DIR;
  else process.env.SR03_DATA_DIR = previous;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const { parsePrList, pollPrs, prStateFor } = await import("./prs.ts");
const { projects, threads } = await import("./db.ts");
const git = await import("./git.ts");

type Lister = NonNullable<Parameters<typeof pollPrs>[0]>;

test("prStateFor picks the newest same-owner PR opened since the thread and drops closed ones", () => {
  const since = Date.parse("2026-01-01T00:00:00Z");
  const pr = (headRefName: string, state: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
    headRefName,
    headRepositoryOwner: { login: "me" },
    state,
    isDraft: false,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt,
    ...extra,
  });
  const prs = parsePrList(
    JSON.stringify([
      pr("open", "OPEN", "2026-03-01T00:00:00Z"),
      pr("draft", "OPEN", "2026-03-01T00:00:00Z", { isDraft: true }),
      pr("merged", "MERGED", "2026-03-01T00:00:00Z"),
      pr("closed", "CLOSED", "2026-03-01T00:00:00Z"),
      pr("reopened", "CLOSED", "2026-03-01T00:00:00Z"),
      pr("reopened", "OPEN", "2026-03-02T00:00:00Z"),
      pr("reclosed", "MERGED", "2026-03-01T00:00:00Z"),
      pr("reclosed", "CLOSED", "2026-03-02T00:00:00Z"),
      pr("fork", "OPEN", "2026-03-01T00:00:00Z", { headRepositoryOwner: { login: "someone" } }),
      pr("old", "MERGED", "2026-03-01T00:00:00Z", { createdAt: "2025-06-01T00:00:00Z" }),
    ]),
    "me",
  );
  const branches = ["open", "draft", "merged", "closed", "reopened", "reclosed", "fork", "old", "missing"];
  assert.deepEqual(Object.fromEntries(branches.map((branch) => [branch, prStateFor(prs, branch, since)])), {
    open: "open",
    draft: "draft",
    merged: "merged",
    closed: "none",
    reopened: "open",
    reclosed: "none",
    fork: "none",
    old: "none",
    missing: "none",
  });
});

let counter = 0;
async function setup(options: { worktree?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(dataDir, `repo-${counter++}-`));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  run("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  run("add", ".");
  run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const project = projects.create({ path: root, name: path.basename(root), isGit: true });
  const branch = `feat-${counter}`;
  const worktree = options.worktree === false ? null : await git.addWorktree({ root, branch, createBranch: true });
  const thread = threads.create({
    projectId: project.id,
    providerId: "claude",
    title: "t",
    cwd: worktree?.path ?? root,
    branch: worktree ? branch : null,
    isWorktree: worktree !== null,
    model: "m",
    permissionMode: "default",
    effort: "high",
    fast: false,
  });
  const branchListed = () => run("branch", "--list", branch).trim() !== "";
  return { root, branch, worktreePath: worktree?.path ?? root, thread, branchListed };
}

const STATES = { open: ["OPEN", false], draft: ["OPEN", true], merged: ["MERGED", false] } as const;

const lister = (entries: Record<string, keyof typeof STATES>, createdAt = new Date().toISOString()): Lister =>
  async () =>
    Object.entries(entries).map(([headRefName, key]) => ({
      headRefName,
      headRepositoryOwner: { login: "me" },
      state: STATES[key][0],
      isDraft: STATES[key][1],
      createdAt,
      updatedAt: createdAt,
    }));

function archiveOthers(keep: string) {
  for (const thread of threads.list()) if (thread.id !== keep) threads.update(thread.id, { archived: true });
}

test("an open PR is recorded and the thread stays", async () => {
  const s = await setup();
  archiveOthers(s.thread.id);
  await pollPrs(lister({ [s.branch]: "open" }));
  const thread = threads.byId(s.thread.id)!;
  assert.equal(thread.pr, "open");
  assert.equal(thread.archived, false);
});

test("a merged PR archives the thread and removes its worktree and branch", async () => {
  const s = await setup();
  archiveOthers(s.thread.id);
  await pollPrs(lister({ [s.branch]: "merged" }));
  const thread = threads.byId(s.thread.id)!;
  assert.equal(thread.pr, "merged");
  assert.equal(thread.archived, true);
  assert.equal(fs.existsSync(s.worktreePath), false);
  assert.equal(s.branchListed(), false);
});

test("a merged PR with a dirty worktree archives but keeps the worktree", async () => {
  const s = await setup();
  archiveOthers(s.thread.id);
  fs.writeFileSync(path.join(s.worktreePath, "scratch.txt"), "x\n");
  await pollPrs(lister({ [s.branch]: "merged" }));
  assert.equal(threads.byId(s.thread.id)!.archived, true);
  assert.equal(fs.existsSync(s.worktreePath), true);
});

test("a merge during a running turn archives once the thread goes idle", async () => {
  const s = await setup();
  archiveOthers(s.thread.id);
  threads.update(s.thread.id, { status: "running" });
  await pollPrs(lister({ [s.branch]: "merged" }));
  let thread = threads.byId(s.thread.id)!;
  assert.equal(thread.pr, "merged");
  assert.equal(thread.archived, false);
  threads.update(s.thread.id, { status: "idle" });
  await pollPrs(lister({ [s.branch]: "merged" }));
  thread = threads.byId(s.thread.id)!;
  assert.equal(thread.archived, true);
});

test("an unarchived merged thread is not archived again", async () => {
  const s = await setup();
  archiveOthers(s.thread.id);
  fs.writeFileSync(path.join(s.worktreePath, "scratch.txt"), "x\n");
  await pollPrs(lister({ [s.branch]: "merged" }));
  assert.equal(threads.byId(s.thread.id)!.archived, true);
  threads.update(s.thread.id, { archived: false });
  await pollPrs(lister({ [s.branch]: "merged" }));
  assert.equal(threads.byId(s.thread.id)!.archived, false);
});

test("an unknown PR list changes nothing", async () => {
  const s = await setup();
  archiveOthers(s.thread.id);
  await pollPrs(async () => null);
  const thread = threads.byId(s.thread.id)!;
  assert.equal(thread.pr, "none");
  assert.equal(thread.archived, false);
});

test("a PR that disappears from the list goes back to none", async () => {
  const s = await setup();
  archiveOthers(s.thread.id);
  await pollPrs(lister({ [s.branch]: "open" }));
  assert.equal(threads.byId(s.thread.id)!.pr, "open");
  await pollPrs(lister({}));
  const thread = threads.byId(s.thread.id)!;
  assert.equal(thread.pr, "none");
  assert.equal(thread.archived, false);
});

test("non-worktree threads never reach the lister", async () => {
  const s = await setup({ worktree: false });
  archiveOthers(s.thread.id);
  let calls = 0;
  await pollPrs(async () => {
    calls++;
    return [];
  });
  assert.equal(calls, 0);
});

test("a merged PR from before the thread existed is ignored, even beside an older thread", async () => {
  const older = await setup();
  const s = await setup();
  archiveOthers(s.thread.id);
  threads.update(older.thread.id, { archived: false });
  const between = new Date((older.thread.createdAt + s.thread.createdAt) / 2 - 1).toISOString();
  await pollPrs(lister({ [s.branch]: "merged" }, between));
  const thread = threads.byId(s.thread.id)!;
  assert.equal(thread.pr, "none");
  assert.equal(thread.archived, false);
  assert.ok(fs.existsSync(s.worktreePath));
});
