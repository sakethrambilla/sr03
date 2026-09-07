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
