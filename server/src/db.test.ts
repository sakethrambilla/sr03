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
