import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExternalReader, ExternalSession, ImportedMessage } from "./types.ts";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-ext-"));
process.env.SR03_DATA_DIR = dataDir;
// os.tmpdir() sits under the /var -> /private/var symlink, and discovery stores real paths
const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sr03-work-")));
after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

const { discover, importExternal } = await import("./index.ts");
const { projects, threads, messages } = await import("../db.ts");

const fake = (sessions: ExternalSession[], transcript: ImportedMessage[] | Error): ExternalReader => ({
  providerId: "claude",
  scan: async (isKnown) => sessions.filter((s) => !isKnown(s.sessionId)),
  read: async () => {
    if (transcript instanceof Error) throw transcript;
    return transcript;
  },
});

const session = (sessionId: string): ExternalSession => ({
  providerId: "claude",
  sessionId,
  cwd: work,
  title: `title ${sessionId}`,
  createdAt: 1_000,
  updatedAt: 2_000,
  source: path.join(work, `${sessionId}.jsonl`),
});

const msgs: ImportedMessage[] = [
  { role: "user", text: "hi", meta: null },
  { role: "assistant", text: "hello", meta: null },
  { role: "tool", text: "Bash", meta: { result: "x".repeat(5000) } },
];

const s = session("s1");
const externalBy = (id: string) => threads.list().filter((t) => t.external && t.sessionId === id);

test("(a) discover adds a thread and its project", async () => {
  assert.equal(await discover([fake([s], msgs)]), 1);
  assert.ok(projects.byPath(work));
  const [t] = externalBy("s1");
  assert.ok(t);
  assert.equal(t.title, s.title);
  assert.equal(t.updatedAt, s.updatedAt);
});

test("(b) a second discover adds nothing", async () => {
  const before = [threads.list().length, projects.list().length];
  assert.equal(await discover([fake([s], msgs)]), 0);
  assert.deepEqual([threads.list().length, projects.list().length], before);
});

test("(c) sessions sr03 created itself are skipped", async () => {
  const project = projects.byPath(work)!;
  const own = threads.create({
    projectId: project.id, providerId: "claude", title: "own", cwd: work, branch: null,
    isWorktree: false, model: "m", permissionMode: "default", effort: "medium", fast: false,
  });
  threads.update(own.id, { sessionId: "own" });
  assert.equal(await discover([fake([session("own")], msgs)]), 0);
});

test("(e) a failed read writes nothing", async () => {
  await discover([fake([session("bad")], msgs)]);
  const [t] = externalBy("bad");
  const gone = Object.assign(new Error("gone"), { code: "ENOENT" });
  await assert.rejects(importExternal(t!, [fake([], gone)]), /Could not read the Claude transcript/);
  assert.equal(messages.list(t!.id).length, 0);
  assert.equal(threads.byId(t!.id)!.external, true);
});

test("(d) importExternal stores the transcript once", async () => {
  const [t] = externalBy("s1");
  await importExternal(t!, [fake([], msgs)]);
  const list = messages.list(t!.id);
  assert.deepEqual(list.map((m) => [m.role, m.text]), msgs.map((m) => [m.role, m.text]));
  const after = threads.byId(t!.id)!;
  assert.equal(after.external, false);
  assert.equal(after.updatedAt, t!.updatedAt);
  const result = list[2]!.meta!.result as string;
  assert.ok(result.length < 5000);
  assert.ok(result.includes("more chars)"));
});

test("(f) one failing provider does not stop the others", async () => {
  const broken: ExternalReader = { providerId: "codex", scan: async () => { throw new Error("boom"); }, read: async () => [] };
  assert.equal(await discover([broken, fake([session("s2")], msgs)]), 1);
});

test("(g) concurrent discovers share one run", async () => {
  const reader = fake([session("s3")], msgs);
  assert.deepEqual(await Promise.all([discover([reader]), discover([reader])]), [1, 1]);
  assert.equal(threads.list().filter((t) => t.sessionId === "s3").length, 1);
});

test("a cwd reached through a symlink joins the real path's project", async () => {
  const link = path.join(dataDir, "work-link");
  await fs.symlink(work, link);
  const before = projects.list().length;
  assert.equal(await discover([fake([{ ...session("s-link"), cwd: link }], msgs)]), 1);
  assert.equal(projects.list().length, before);
  assert.equal(externalBy("s-link")[0]?.projectId, projects.byPath(work)!.id);
});

const repo = path.join(work, "repo");
const wt = path.join(work, "repo-wt");
const sh = (cwd: string, cmd: string) => execSync(cmd, { cwd, stdio: "ignore" });

test("a worktree session joins its main repo's project", async () => {
  await fs.mkdir(repo);
  sh(repo, "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init");
  sh(repo, `git worktree add -q ${wt}`);
  assert.equal(await discover([fake([{ ...session("s-wt"), cwd: wt }], msgs)]), 1);
  const [t] = externalBy("s-wt");
  assert.equal(t!.projectId, projects.byPath(repo)!.id);
  assert.equal(t!.cwd, wt);
  assert.equal(t!.isWorktree, true);
  assert.equal(projects.byPath(wt), null);
});

test("a session in a deleted worktree still joins its repo", async () => {
  const gone = path.join(repo, ".claude", "worktrees", "gone");
  assert.equal(await discover([fake([{ ...session("s-gone"), cwd: gone }], msgs)]), 1);
  assert.equal(externalBy("s-gone")[0]!.projectId, projects.byPath(repo)!.id);
});

test("sessions in temp or vanished folders are skipped", async () => {
  const before = projects.list().length;
  const sessions = [{ ...session("s-tmp"), cwd: "/tmp/sr03-x" }, { ...session("s-void"), cwd: path.join(dataDir, "nope") }];
  assert.equal(await discover([fake(sessions, msgs)]), 0);
  assert.equal(projects.list().length, before);
});

test("an earlier per-worktree project is folded into the repo", async () => {
  const stray = projects.create({ path: wt, name: "repo-wt", isGit: true });
  const t = threads.createExternal({
    projectId: stray.id, providerId: "claude", title: "old", cwd: wt, isWorktree: false, model: "m",
    permissionMode: "default", effort: "medium", sessionId: "s-old", source: "x", createdAt: 1, updatedAt: 1,
  });
  await discover([fake([], msgs)]);
  assert.equal(projects.byId(stray.id), null);
  assert.equal(threads.byId(t.id)!.projectId, projects.byPath(repo)!.id);
  assert.equal(threads.byId(t.id)!.isWorktree, true);
});
