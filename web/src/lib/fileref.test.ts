import assert from "node:assert/strict";
import test from "node:test";

import { createFileIndex, splitRef } from "./fileref.ts";

test("splitRef decodes percent escapes", () => {
  assert.deepEqual(splitRef("src/a%20b.ts:42"), { path: "src/a b.ts", line: 42 });
});

test("splitRef strips file://", () => {
  assert.deepEqual(splitRef("file:///Users/x/repo/src/a.ts"), { path: "/Users/x/repo/src/a.ts" });
});

test("splitRef takes the first line of a range", () => {
  assert.deepEqual(splitRef("src/a.ts#L42-L50"), { path: "src/a.ts", line: 42 });
  assert.deepEqual(splitRef("src/a.ts:42-50"), { path: "src/a.ts", line: 42 });
  assert.deepEqual(splitRef("src/a.ts:42:7"), { path: "src/a.ts", line: 42 });
});

test("splitRef leaves a malformed escape as written", () => {
  assert.deepEqual(splitRef("src/100%.ts"), { path: "src/100%.ts" });
});

test("resolve maps an encoded path from another checkout onto the tree", () => {
  const index = createFileIndex(["src/a b.ts"]);
  assert.deepEqual(index.resolve("/elsewhere/checkout/src/a%20b.ts#L3"), { path: "src/a b.ts", line: 3 });
});
