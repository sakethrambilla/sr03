// Lane assignment is a single pass whose output the git graph panel renders verbatim, so the
// expected lanes here are literal arrays generated from the shipped algorithm — they pin its
// behaviour commit-for-commit rather than restate it.
import assert from "node:assert/strict";
import test from "node:test";

import type { Commit } from "./types.ts";
import { UNCOMMITTED, laneColor, layoutGraph, matchesFilter, withUncommitted } from "./gitgraph.ts";

const commit = (hash: string, ...parents: string[]): Commit => ({
  hash,
  parents,
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.com",
  authorDate: 1_700_000_000,
  message: `work on ${hash}`,
});

const lanes = (commits: Commit[]) => layoutGraph(commits).rows.map((row) => row.lane);

test("a linear chain stays in lane 0", () => {
  const history = [commit("c4", "c3"), commit("c3", "c2"), commit("c2", "c1"), commit("c1")];
  const { rows, laneCount } = layoutGraph(history);
  assert.deepEqual(
    rows.map((row) => row.lane),
    [0, 0, 0, 0],
  );
  assert.equal(laneCount, 1);
  assert.deepEqual(
    rows.map((row) => row.commit.hash),
    ["c4", "c3", "c2", "c1"],
  );
});

test("a history that diverges and re-merges pins every lane", () => {
  const history = [
    commit("h1", "m"),
    commit("m", "a2", "b2"),
    commit("a2", "a1"),
    commit("b2", "b1"),
    commit("a1", "base"),
    commit("b1", "base"),
    commit("base"),
  ];
  const { rows, laneCount } = layoutGraph(history);
  assert.deepEqual(
    rows.map((row) => row.lane),
    [0, 0, 0, 1, 0, 1, 0],
  );
  assert.equal(laneCount, 2);
});

test("a merge's second parent gets its own lane, freed once it is placed", () => {
  const history = [commit("m", "p1", "p2"), commit("p1", "root"), commit("p2", "root"), commit("root")];
  const { rows, laneCount } = layoutGraph(history);
  assert.deepEqual(
    rows.map((row) => row.lane),
    [0, 0, 1, 0],
  );
  assert.equal(laneCount, 2);
});

test("a commit whose parent is beyond the loaded page still gets a lane", () => {
  const history = [commit("x", "missing1"), commit("y", "missing2")];
  const { rows, laneCount } = layoutGraph(history);
  assert.deepEqual(
    rows.map((row) => row.lane),
    [0, 1],
  );
  assert.equal(laneCount, 2);
});

test("a clean tree gets no synthetic row", () => {
  const history = [commit("head"), commit("older")];
  assert.equal(withUncommitted(history, "head", false).length, 2);
});

test("a dirty tree prepends a synthetic row parented on head", () => {
  const history = [commit("head"), commit("older")];
  const result = withUncommitted(history, "head", true);
  assert.equal(result.length, 3);
  assert.equal(result[0]!.hash, UNCOMMITTED);
  assert.deepEqual(result[0]!.parents, ["head"]);
  assert.deepEqual(lanes(result), [0, 0, 0]);
});

test("a dirty tree with no head gets no synthetic row", () => {
  const history = [commit("head"), commit("older")];
  assert.equal(withUncommitted(history, null, true).length, 2);
});

test("lane colours repeat every eight lanes", () => {
  assert.equal(laneColor(0), "var(--graph-lane-1)");
  assert.equal(laneColor(8), "var(--graph-lane-1)");
});

test("the filter matches message, author and hash prefix but not a hash infix", () => {
  const target = { ...commit("abcdef123456", "older"), message: "fix the parser" };
  assert.equal(matchesFilter(target, "the parser"), true);
  assert.equal(matchesFilter(target, "lovelace"), true);
  assert.equal(matchesFilter(target, "abcdef"), true);
  assert.equal(matchesFilter(target, "cdef12"), false);
});
