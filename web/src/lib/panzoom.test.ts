import test from "node:test";
import assert from "node:assert/strict";
import { clampScale, fitView, panBy, zoomAt } from "./panzoom.ts";

test("clampScale bounds the scale", () => {
  assert.equal(clampScale(0.01), 0.1);
  assert.equal(clampScale(100), 8);
});

test("fitView centres and scales content inside the padded viewport", () => {
  assert.deepEqual(fitView({ width: 200, height: 100 }, { width: 448, height: 448 }), {
    scale: 2,
    x: 24,
    y: 124,
  });
});

test("fitView on zero-size content returns the identity view", () => {
  assert.deepEqual(fitView({ width: 0, height: 100 }, { width: 448, height: 448 }), {
    x: 0,
    y: 0,
    scale: 1,
  });
});

test("zoomAt keeps the content point under the cursor fixed", () => {
  const v = zoomAt({ x: 10, y: 20, scale: 1 }, 2, { x: 110, y: 220 });
  assert.equal(v.scale, 2);
  assert.equal((110 - v.x) / v.scale, 100);
  assert.equal((220 - v.y) / v.scale, 200);
});

test("zoomAt at max scale leaves the view unchanged", () => {
  const view = { x: 5, y: 7, scale: 8 };
  assert.deepEqual(zoomAt(view, 2, { x: 50, y: 60 }), view);
});

test("panBy offsets without mutating the input", () => {
  const view = { x: 1, y: 2, scale: 3 };
  assert.deepEqual(panBy(view, 5, -2), { x: 6, y: 0, scale: 3 });
  assert.deepEqual(view, { x: 1, y: 2, scale: 3 });
});
