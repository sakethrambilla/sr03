import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("commandCache round-trips a value and reports a miss as null", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-db-"));
  const previous = process.env.SR03_DATA_DIR;
  process.env.SR03_DATA_DIR = directory;
  context.after(async () => {
    if (previous === undefined) delete process.env.SR03_DATA_DIR;
    else process.env.SR03_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { commandCache } = await import("./db.ts");
  assert.equal(commandCache.get("claude:/tmp/nope"), null);
  commandCache.set("claude:/tmp/proj", JSON.stringify([{ name: "foo" }]));
  const row = commandCache.get("claude:/tmp/proj");
  assert.ok(row);
  assert.deepEqual(JSON.parse(row.json), [{ name: "foo" }]);
});

test("external threads round-trip and every stored session id is remembered", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-db-"));
  const previous = process.env.SR03_DATA_DIR;
  process.env.SR03_DATA_DIR = directory;
  context.after(async () => {
    if (previous === undefined) delete process.env.SR03_DATA_DIR;
    else process.env.SR03_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { projects, threads, knownSessions } = await import("./db.ts");
  const project = projects.create({ path: directory, name: "p", isGit: false });
  const base = {
    projectId: project.id,
    providerId: "claude" as const,
    title: "t",
    model: "m",
    permissionMode: "default" as const,
    effort: "high" as const,
  };
  const thread = threads.createExternal({
    ...base,
    cwd: directory,
    sessionId: "s-ext",
    source: "/x/s-ext.jsonl",
    createdAt: 1000,
    updatedAt: 2000,
  });
  assert.equal(thread.external, true);
  assert.equal(thread.cwdMissing, false);
  assert.equal(thread.updatedAt, 2000);
  assert.equal(threads.externalSource(thread.id), "/x/s-ext.jsonl");
  assert.equal(knownSessions.has("claude", "s-ext"), true);

  threads.clearExternal(thread.id, 2000);
  const cleared = threads.byId(thread.id)!;
  assert.equal(cleared.external, false);
  assert.equal(cleared.updatedAt, 2000);

  const own = threads.create({ ...base, cwd: directory, branch: null, isWorktree: false, fast: false });
  threads.update(own.id, { sessionId: "s-own" });
  assert.equal(knownSessions.has("claude", "s-own"), true);
  threads.remove(own.id);
  assert.equal(knownSessions.has("claude", "s-own"), true);

  const gone = threads.createExternal({
    ...base,
    cwd: path.join(directory, "gone"),
    sessionId: "s-gone",
    source: "/x/s-gone.jsonl",
    createdAt: 1000,
    updatedAt: 1000,
  });
  assert.equal(gone.cwdMissing, true);
});

test("archiveIdle archives idle and errored threads, skipping running, archived and the excepted one", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-db-"));
  const previous = process.env.SR03_DATA_DIR;
  process.env.SR03_DATA_DIR = directory;
  context.after(async () => {
    if (previous === undefined) delete process.env.SR03_DATA_DIR;
    else process.env.SR03_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { projects, threads } = await import("./db.ts");
  const a = projects.create({ path: directory, name: "a", isGit: false });
  const b = projects.create({ path: path.join(directory, "b"), name: "b", isGit: false });

  const makeThread = (title: string, projectId: string) =>
    threads.create({
      projectId,
      providerId: "claude",
      title,
      cwd: directory,
      branch: null,
      isWorktree: false,
      model: "m",
      permissionMode: "default",
      effort: "high",
      fast: false,
    });

  const idle1 = makeThread("idle1", a.id);
  const idle2 = makeThread("idle2", a.id);
  const errored = makeThread("errored", a.id);
  const running = makeThread("running", a.id);
  const alreadyArchived = makeThread("alreadyArchived", a.id);
  const open = makeThread("open", a.id);
  const other = makeThread("other", b.id);

  threads.update(errored.id, { status: "error" });
  threads.update(running.id, { status: "running" });
  threads.update(alreadyArchived.id, { archived: true });

  const archived = threads.archiveIdle(a.id, open.id);
  assert.deepEqual(
    archived.map((t) => t.id).sort(),
    [idle1.id, idle2.id, errored.id].sort(),
  );
  assert.ok(archived.every((t) => t.archived === true));

  assert.equal(threads.byId(running.id)!.archived, false);
  assert.equal(threads.byId(open.id)!.archived, false);
  assert.equal(threads.byId(other.id)!.archived, false);

  const rest = threads.archiveIdle(a.id, null);
  assert.deepEqual(rest.map((t) => t.id), [open.id]);

  const none = threads.archiveIdle(a.id, null);
  assert.deepEqual(none, []);
});
