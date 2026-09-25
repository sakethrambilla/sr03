import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMANDS,
  findConflicts,
  formatBinding,
  parseOverrides,
  resolveBindings,
  step,
  strokeFromEvent,
} from "./shortcuts.ts";

const ev = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const defaults = resolveBindings({});
const all = () => true;

test("strokeFromEvent: meta or ctrl both map to mod", () => {
  assert.strictEqual(strokeFromEvent(ev("K", { metaKey: true, shiftKey: true })), "mod+shift+k");
  assert.strictEqual(strokeFromEvent(ev("K", { ctrlKey: true, shiftKey: true })), "mod+shift+k");
});

test("strokeFromEvent: a modifier-only key is no stroke", () => {
  assert.strictEqual(strokeFromEvent(ev("Shift", { shiftKey: true })), null);
});

test("formatBinding: chords join with then", () => {
  assert.strictEqual(formatBinding(["mod+k", "w"], true), "⌘K then W");
  assert.strictEqual(formatBinding(["mod+k", "w"], false), "Ctrl+K then W");
});

test("resolveBindings: valid overrides apply, bad entries fall back, unknown ids drop", () => {
  const b = resolveBindings({ quickOpen: ["mod+shift+o"], toggleTerminal: null, bogus: 1, save: 5 });
  assert.deepStrictEqual(b.quickOpen, ["mod+shift+o"]);
  assert.strictEqual(b.toggleTerminal, null);
  assert.deepStrictEqual(b.save, ["mod+s"]);
  assert.ok(!("bogus" in b));
  assert.strictEqual(Object.keys(b).length, COMMANDS.length);
});

test("parseOverrides: invalid or missing input is empty", () => {
  assert.deepStrictEqual(parseOverrides("{"), {});
  assert.deepStrictEqual(parseOverrides(undefined), {});
});

test("findConflicts: a shared binding flags both ids", () => {
  assert.deepStrictEqual(findConflicts(resolveBindings({ quickOpen: ["mod+b"] })), new Set(["quickOpen", "toggleFileTree"]));
  assert.deepStrictEqual(findConflicts(defaults), new Set());
});

test("step: a chord prefix pends, then runs or clears", () => {
  assert.deepStrictEqual(step(null, "mod+k", defaults, all), { run: null, pending: "mod+k" });
  assert.deepStrictEqual(step("mod+k", "w", defaults, all), { run: "closeAllFiles", pending: null });
  assert.deepStrictEqual(step("mod+k", "x", defaults, all), { run: null, pending: null });
});

test("step: bare keys and unavailable commands never run", () => {
  assert.deepStrictEqual(step(null, "w", defaults, all), { run: null, pending: null });
  assert.strictEqual(step(null, "mod+p", defaults, (id) => id !== "quickOpen").run, null);
});
