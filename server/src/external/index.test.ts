import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExternalReader, ExternalSession, ImportedMessage } from "./types.ts";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-ext-"));
process.env.SR03_DATA_DIR = dataDir;
const work = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-work-"));
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
