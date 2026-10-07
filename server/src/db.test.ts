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

test("a thread whose folder is gone reports cwdMissing", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-db-"));
  const previous = process.env.SR03_DATA_DIR;
  process.env.SR03_DATA_DIR = directory;
  context.after(async () => {
    if (previous === undefined) delete process.env.SR03_DATA_DIR;
    else process.env.SR03_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { projects, threads } = await import("./db.ts");
  const project = projects.create({ path: directory, name: "p", isGit: false });
  const base = {
    projectId: project.id,
    providerId: "claude" as const,
    title: "t",
    branch: null,
    isWorktree: false,
    model: "m",
    permissionMode: "default" as const,
    effort: "high" as const,
    fast: false,
  };
  const here = threads.create({ ...base, cwd: directory });
  assert.equal(threads.byId(here.id)!.cwdMissing, false);
  const gone = threads.create({ ...base, cwd: path.join(directory, "gone") });
  assert.equal(threads.byId(gone.id)!.cwdMissing, true);
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

test("archiveStale archives threads whose last activity is before the cutoff", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-db-"));
  const previous = process.env.SR03_DATA_DIR;
  process.env.SR03_DATA_DIR = directory;
  context.after(async () => {
    if (previous === undefined) delete process.env.SR03_DATA_DIR;
    else process.env.SR03_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { projects, threads, messages } = await import("./db.ts");
  const project = projects.create({ path: directory, name: "stale", isGit: false });
  const base = {
    projectId: project.id,
    providerId: "claude" as const,
    title: "t",
    cwd: directory,
    branch: null,
    isWorktree: false,
    model: "m",
    permissionMode: "default" as const,
    effort: "high" as const,
    fast: false,
  };
  const withMessage = threads.create(base);
  const empty = threads.create(base);
  const running = threads.create(base);
  const excepted = threads.create(base);
  const alreadyArchived = threads.create(base);
  messages.append({ threadId: withMessage.id, role: "user", text: "hi" });
  threads.update(running.id, { status: "running" });
  threads.update(alreadyArchived.id, { archived: true });
  const mine = new Set([withMessage.id, empty.id, running.id, excepted.id, alreadyArchived.id]);

  assert.deepEqual(threads.archiveStale(0, []), []);

  // the module's db is shared with earlier tests, so only this test's threads are compared
  const archived = threads.archiveStale(Date.now() + 60_000, [excepted.id]).filter((t) => mine.has(t.id));
  assert.deepEqual(archived.map((t) => t.id).sort(), [withMessage.id, empty.id].sort());
  assert.ok(archived.every((t) => t.archived === true));
  assert.equal(threads.byId(running.id)!.archived, false);
  assert.equal(threads.byId(excepted.id)!.archived, false);
});
