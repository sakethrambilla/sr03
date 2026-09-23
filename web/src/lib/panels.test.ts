import assert from "node:assert/strict";
import test from "node:test";

import { MAX_PANEL_PX, MIN_PANEL_PX, PANEL_DEFAULTS, clampPanelWidth, resizedWidth } from "./panels.ts";

test("defaults match the widths the panels had when they were fixed", () => {
  assert.deepEqual(PANEL_DEFAULTS, { sidebar: 288, files: 300, agents: 260 });
});

test("a right-edge handle grows with the pointer, a left-edge handle against it", () => {
  assert.equal(resizedWidth(288, 100, "right"), 388);
  assert.equal(resizedWidth(300, -80, "left"), 380);
  assert.equal(resizedWidth(300, 50, "left"), 250);
});

test("clamps to the panel bounds", () => {
  assert.equal(clampPanelWidth(120, Infinity), MIN_PANEL_PX);
  assert.equal(clampPanelWidth(900, Infinity), MAX_PANEL_PX);
  assert.equal(clampPanelWidth(333.6, Infinity), 334);
});

test("never takes more than the chat can spare, but never goes below the minimum", () => {
  assert.equal(clampPanelWidth(500, 420), 420);
  assert.equal(clampPanelWidth(500, 150), MIN_PANEL_PX);
});
