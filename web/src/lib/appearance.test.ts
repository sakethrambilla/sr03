// resolveDark is the one piece of mode logic with no DOM dependency, so it's the one piece
// tested directly — applyAppearance and the system-preference wiring are exercised by hand
// (see docs/plans/2026-09-06-light-dark-mode-themes/tasks/04-preview-panes-and-qa.md)
import assert from "node:assert/strict";
import test from "node:test";

import { resolveDark } from "./appearance.ts";

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
