import test from "node:test";
import assert from "node:assert/strict";
import { stepZoom, zoomPercent } from "./zoom.ts";

test("stepZoom moves one preset step or resets", () => {
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(1.1, 0), 1);
});

test("stepZoom clamps at the ends", () => {
  assert.equal(stepZoom(5, 1), 5);
  assert.equal(stepZoom(0.25, -1), 0.25);
});

test("stepZoom snaps an off-list factor to its neighbour", () => {
  assert.equal(stepZoom(1.05, 1), 1.1);
  assert.equal(stepZoom(1.05, -1), 1);
});

test("zoomPercent rounds to a whole percent", () => {
  assert.equal(zoomPercent(1.1), "110%");
  assert.equal(zoomPercent(0.67), "67%");
});
