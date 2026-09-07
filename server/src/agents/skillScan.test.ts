import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dedupeByName, parseFrontmatter, scanCommandFiles, scanSkillDirectories } from "./skillScan.ts";

test("parseFrontmatter reads top-level fields between fences", () => {
  const fields = parseFrontmatter('---\ndescription: Do the thing\nargument-hint: "<name>"\n---\nbody');
  assert.deepEqual(fields, { description: "Do the thing", "argument-hint": "<name>" });
});

test("parseFrontmatter returns {} when there is no frontmatter", () => {
  assert.deepEqual(parseFrontmatter("just a body"), {});
});

test("scanCommandFiles reads one command per markdown file", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-scan-cmd-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "deploy.md"),
    "---\ndescription: Ship it\nargument-hint: <env>\n---\nbody",
  );
  await fs.writeFile(path.join(directory, "notes.txt"), "ignored, not markdown");
  const commands = await scanCommandFiles(directory);
  assert.deepEqual(commands, [
    { name: "deploy", description: "Ship it", argumentHint: "<env>" },
  ]);
});

test("scanCommandFiles returns [] for a missing directory", async () => {
  assert.deepEqual(await scanCommandFiles("/does/not/exist"), []);
});

test("scanSkillDirectories reads one skill per SKILL.md folder", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-scan-skill-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "review"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "review", "SKILL.md"),
    "---\ndescription: Review a diff\n---\nbody",
  );
  const commands = await scanSkillDirectories(directory);
  assert.deepEqual(commands, [{ name: "review", description: "Review a diff", argumentHint: "" }]);
});

test("dedupeByName keeps the first list's entry on a name collision", () => {
  const merged = dedupeByName([
    [{ name: "review", description: "project", argumentHint: "" }],
    [{ name: "review", description: "user", argumentHint: "" }],
    [{ name: "deploy", description: "user", argumentHint: "" }],
  ]);
  assert.deepEqual(merged, [
    { name: "deploy", description: "user", argumentHint: "" },
    { name: "review", description: "project", argumentHint: "" },
  ]);
});
