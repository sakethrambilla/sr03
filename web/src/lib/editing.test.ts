// The editor's text behaviours are pure string math, so every case is checked here rather than
// through the textarea.
import assert from "node:assert/strict";
import test from "node:test";

import { comment, indent, indentUnit, newline, outdent } from "./editing.ts";

const apply = (value: string, edit: { from: number; to: number; text: string }) =>
  value.slice(0, edit.from) + edit.text + value.slice(edit.to);

test("indent unit follows the file, then the language", () => {
  assert.equal(indentUnit("def f():\n    pass\n", "a.py"), "    ");
  assert.equal(indentUnit("const a = {\n  b: 1,\n}\n", "a.ts"), "  ");
  assert.equal(indentUnit("x = 1\n", "a.py"), "    ");
  assert.equal(indentUnit("x\n", "a.ts"), "  ");
  assert.equal(indentUnit("if x:\n\tpass\n", "a.py"), "\t");
});

test("tab indents to the next stop, and shifts whole selected lines", () => {
  const one = "ab\n";
  assert.equal(apply(one, indent(one, { start: 1, end: 1 }, "  ")), "a b\n");
  const many = "a\nb\n";
  const edit = indent(many, { start: 0, end: 3 }, "  ");
  assert.equal(apply(many, edit), "  a\n  b\n");
});

test("shift-tab removes one level, and never eats code", () => {
  const value = "    a\n  b\nc\n";
  assert.equal(apply(value, outdent(value, { start: 0, end: 11 }, "  ")), "  a\nb\nc\n");
});

test("enter keeps the indent and opens a block", () => {
  const py = "def f():";
  assert.equal(apply(py, newline(py, { start: 8, end: 8 }, "    ", "a.py")), "def f():\n    ");
  const ts = "  const a = {";
  assert.equal(apply(ts, newline(ts, { start: 13, end: 13 }, "  ", "a.ts")), "  const a = {\n    ");
  const plain = "    x = 1";
  assert.equal(apply(plain, newline(plain, { start: 9, end: 9 }, "    ", "a.py")), "    x = 1\n    ");
  // a colon only opens a block in python
  const ts2 = "type A = {a: 1}:";
  assert.equal(apply(ts2, newline(ts2, { start: 16, end: 16 }, "  ", "a.ts")), "type A = {a: 1}:\n");
});

test("comment toggles at the shallowest indent and restores it", () => {
  const value = "  a\n\n    b\n";
  const on = comment(value, { start: 0, end: 10 }, "a.py")!;
  assert.equal(apply(value, on), "  # a\n\n  #   b\n");
  const back = comment(apply(value, on), { start: 0, end: 14 }, "a.py")!;
  assert.equal(apply(apply(value, on), back), value);
});

test("comment is skipped where the grammar has none", () => {
  assert.equal(comment("{}\n", { start: 0, end: 2 }, "a.json"), null);
  assert.equal(comment("\n\n", { start: 0, end: 2 }, "a.py"), null);
});
