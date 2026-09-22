// resolveDark is the one piece of mode logic with no DOM dependency, so it's the one piece
// tested directly — applyAppearance and the system-preference wiring are exercised by hand
// (see docs/plans/2026-09-06-light-dark-mode-themes/tasks/04-preview-panes-and-qa.md)
import assert from "node:assert/strict";
import test from "node:test";

import { groupFonts, resolveDark } from "./appearance.ts";

test("resolveDark: explicit light and dark ignore the OS preference", () => {
  assert.strictEqual(resolveDark("light", true), false);
  assert.strictEqual(resolveDark("light", false), false);
  assert.strictEqual(resolveDark("dark", true), true);
  assert.strictEqual(resolveDark("dark", false), true);
});

test("resolveDark: system follows the OS preference", () => {
  assert.strictEqual(resolveDark("system", true), true);
  assert.strictEqual(resolveDark("system", false), false);
});

test("groupFonts: a family the bundle already covers is dropped from the probed list", () => {
  const groups = groupFonts(["Inter Variable", "Iosevka"], ["Inter", "Iosevka", "Menlo"]);
  assert.deepStrictEqual(groups.bundled, ["Inter Variable", "Iosevka"]);
  assert.deepStrictEqual(groups.installed, ["Menlo"]);
});

test("groupFonts: bundled families are listed whatever the probe returned", () => {
  const groups = groupFonts(["Sora Variable"], []);
  assert.deepStrictEqual(groups.bundled, ["Sora Variable"]);
  assert.deepStrictEqual(groups.installed, []);
});
