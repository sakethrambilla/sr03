import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  commitFileDiff,
  commitFiles,
  commitLog,
  fetchWorktree,
  listRefs,
  listWorktrees,
  lockWorktree,
  mergedBranches,
  removeWorktree,
  unlockWorktree,
} from "./git.ts";

function sh(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr03-git-test-"));
  sh(dir, ["init", "-q", "-b", "main"]);
  sh(dir, ["config", "user.email", "test@example.com"]);
  sh(dir, ["config", "user.name", "Test"]);
  return dir;
}

test("commitLog returns commits newest-first with parent hashes", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "first"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "second"]);
  return commitLog(dir, { maxCount: 10, skip: 0 }).then((result) => {
    assert.equal(result.commits.length, 2);
    assert.equal(result.hasMore, false);
    assert.equal(result.commits[0]!.message, "second");
    assert.deepEqual(result.commits[0]!.parents, [result.commits[1]!.hash]);
    assert.deepEqual(result.commits[1]!.parents, []);
  });
});

test("commitLog paginates with hasMore", () => {
  const dir = makeRepo();
  for (let i = 0; i < 3; i += 1) {
    fs.writeFileSync(path.join(dir, "a.txt"), String(i));
    sh(dir, ["add", "."]);
    sh(dir, ["commit", "-q", "-m", `commit ${i}`]);
  }
  return commitLog(dir, { maxCount: 2, skip: 0 }).then((result) => {
    assert.equal(result.commits.length, 2);
    assert.equal(result.hasMore, true);
  });
});

test("commitLog on a repo with no commits returns an empty page", () => {
  const dir = makeRepo();
  return commitLog(dir, { maxCount: 10, skip: 0 }).then((result) => {
    assert.deepEqual(result, { commits: [], hasMore: false });
  });
});

test("commitLog scoped to a ref excludes commits only reachable from other branches", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "on main"]);
  sh(dir, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "on feature"]);
  return commitLog(dir, { maxCount: 10, skip: 0, ref: "main" }).then((result) => {
    assert.deepEqual(
      result.commits.map((commit) => commit.message),
      ["on main"],
    );
  });
});

test("commitLog rejects a ref that isn't a plausible ref name", () => {
  const dir = makeRepo();
  return assert.rejects(() => commitLog(dir, { maxCount: 10, skip: 0, ref: "--upload-pack=x" }));
});

test("listRefs classifies heads and tags", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "first"]);
  sh(dir, ["tag", "v1"]);
  sh(dir, ["branch", "feature"]);
  return listRefs(dir).then((refs) => {
    const kinds = refs.map((ref) => `${ref.kind}:${ref.name}`).sort();
    assert.deepEqual(kinds, ["head:feature", "head:main", "tag:v1"]);
  });
});

test("commitFiles reports an added file for the root commit", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "first"]);
  const hash = sh(dir, ["rev-parse", "HEAD"]).trim();
  return commitFiles(dir, hash).then((files) => {
    assert.deepEqual(files, [
      { path: "a.txt", status: "added", insertions: 1, deletions: 0, binary: false },
    ]);
  });
});

test("commitFiles reports nothing for an empty commit", () => {
  const dir = makeRepo();
  sh(dir, ["commit", "-q", "--allow-empty", "-m", "empty"]);
  const hash = sh(dir, ["rev-parse", "HEAD"]).trim();
  return commitFiles(dir, hash).then((files) => {
    assert.deepEqual(files, []);
  });
});

test("commitFileDiff shows the added line for the root commit", () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  sh(dir, ["add", "."]);
  sh(dir, ["commit", "-q", "-m", "first"]);
  const hash = sh(dir, ["rev-parse", "HEAD"]).trim();
  return commitFileDiff(dir, hash, "a.txt").then((diff) => {
    assert.match(diff, /\+one/);
  });
});
