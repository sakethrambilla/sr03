// The tree model is what the file panel's correctness rests on — ordering, projection, the
// change-set policy and the stale-load guard are all pure, so they are all tested here rather
// than through the component that draws them.
import assert from "node:assert/strict";
import test from "node:test";

import type { TreeEntry } from "./types.ts";
import {
  AUTO_EXPAND_MAX_CHANGES,
  ancestors,
  autoExpandFor,
  compareEntries,
  createDirLoadTracker,
  dirtyAncestors,
  forEachWithConcurrency,
  insertEntry,
  parentOf,
  projectRows,
  removeEntry,
  replaceEntry,
  toggleSubtree,
} from "./filetree.ts";

const dir = (path: string): TreeEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: true,
  ignored: false,
});
const file = (path: string): TreeEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: false,
  ignored: false,
});

test.describe("path helpers and ordering", () => {
  test("parentOf returns the containing directory, or the root", () => {
    assert.equal(parentOf("a/b/c.ts"), "a/b");
    assert.equal(parentOf("README.md"), "");
  });

  test("ancestors lists every directory above a path", () => {
    assert.deepEqual(ancestors("a/b/c.ts"), ["a", "a/b"]);
    assert.deepEqual(ancestors("README.md"), []);
  });

  test("compareEntries puts directories first, then names", () => {
    assert.ok(compareEntries(dir("src"), file("README.md")) < 0);
    assert.ok(compareEntries(file("README.md"), dir("src")) > 0);
    assert.ok(compareEntries(file("a.ts"), file("b.ts")) < 0);
  });
});

test.describe("projection", () => {
  const dirs = {
    "": [dir("src"), file("README.md")],
    src: [dir("src/lib"), file("src/main.ts")],
    "src/lib": [file("src/lib/util.ts")],
  };

  test("only the root expanded yields root entries at depth 0", () => {
    const rows = projectRows(dirs, new Set([""]));
    assert.deepEqual(
      rows.map((row) => [row.entry.path, row.depth]),
      [
        ["src", 0],
        ["README.md", 0],
      ],
    );
  });

  test("an expanded nested dir puts its children right after it", () => {
    const rows = projectRows(dirs, new Set(["", "src"]));
    assert.deepEqual(
      rows.map((row) => [row.entry.path, row.depth]),
      [
        ["src", 0],
        ["src/lib", 1],
        ["src/main.ts", 1],
        ["README.md", 0],
      ],
    );
  });

  test("an expanded dir with no listing yields its own row and no children", () => {
    const rows = projectRows({ "": [dir("src")] }, new Set(["", "src"]));
    assert.deepEqual(
      rows.map((row) => [row.entry.path, row.depth]),
      [["src", 0]],
    );
  });
});

test.describe("change-set policy", () => {
  test("dirtyAncestors collects every ancestor of every changed path", () => {
    assert.deepEqual(dirtyAncestors(["a/b/c.ts", "d.ts"]), new Set(["a", "a/b"]));
  });

  test("autoExpandFor gives up above the change cap", () => {
    const many = new Set(
      Array.from({ length: AUTO_EXPAND_MAX_CHANGES + 1 }, (_, i) => `a/f${i}.ts`),
    );
    assert.equal(autoExpandFor(many), null);
    assert.deepEqual(autoExpandFor(new Set(["a/b/c.ts", "a/d.ts", "e.ts"])), new Set(["a", "a/b"]));
  });

  test("toggleSubtree collapsing drops descendants without mutating the input", () => {
    const expanded = new Set(["", "src", "src/lib"]);
    const next = toggleSubtree(expanded, { "": [] }, "src");
    assert.deepEqual(next, new Set([""]));
    assert.deepEqual(expanded, new Set(["", "src", "src/lib"]));
  });
});

test.describe("load tracker", () => {
  test("a fresh token is current", () => {
    const tracker = createDirLoadTracker();
    assert.equal(tracker.isCurrent(tracker.begin("src")), true);
  });

  test("a second begin on the same dir makes the first token stale", () => {
    const tracker = createDirLoadTracker();
    const first = tracker.begin("src");
    tracker.begin("src");
    assert.equal(tracker.isCurrent(first), false);
  });

  test("a begin on another dir leaves the first token current", () => {
    const tracker = createDirLoadTracker();
    const first = tracker.begin("src");
    tracker.begin("web");
    assert.equal(tracker.isCurrent(first), true);
  });
});

test.describe("concurrency and entry edits", () => {
  test("forEachWithConcurrency caps in-flight work and swallows failures", async () => {
    let inFlight = 0;
    let peak = 0;
    const visited: number[] = [];
    await forEachWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      visited.push(item);
      await Promise.resolve();
      inFlight -= 1;
      if (item === 2) throw new Error("bad directory");
    });
    assert.equal(peak <= 2, true);
    assert.deepEqual(visited.slice().sort(), [0, 1, 2, 3, 4]);
  });

  test("insertEntry sorts, and replaces an existing path", () => {
    const entries = [dir("src"), file("a.ts"), file("c.ts")];
    assert.deepEqual(
      insertEntry(entries, file("b.ts")).map((entry) => entry.path),
      ["src", "a.ts", "b.ts", "c.ts"],
    );
    const replaced = insertEntry(entries, { ...file("c.ts"), ignored: true });
    assert.equal(replaced.length, 3);
    assert.equal(replaced[2]!.ignored, true);
  });

  test("replaceEntry re-sorts when the new name moves it", () => {
    const entries = [file("a.ts"), file("b.ts"), file("c.ts")];
    assert.deepEqual(
      replaceEntry(entries, "a.ts", file("z.ts")).map((entry) => entry.path),
      ["b.ts", "c.ts", "z.ts"],
    );
  });

  test("toggleSubtree expanding restores already-loaded descendants", () => {
    const dirs = { "": [], src: [], "src/lib": [], web: [] };
    assert.deepEqual(toggleSubtree(new Set([""]), dirs, "src"), new Set(["", "src", "src/lib"]));
  });

  test("removeEntry and replaceEntry leave the input alone", () => {
    const entries = [file("a.ts"), file("b.ts")];
    assert.deepEqual(
      removeEntry(entries, "a.ts").map((entry) => entry.path),
      ["b.ts"],
    );
    replaceEntry(entries, "a.ts", file("z.ts"));
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["a.ts", "b.ts"],
    );
  });
});
