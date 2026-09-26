import assert from "node:assert/strict";
import test from "node:test";

import { contextBand } from "./context.ts";

test("below 50 is ok", () => {
  assert.deepEqual(contextBand(0), { width: 0, band: "ok" });
  assert.deepEqual(contextBand(30), { width: 30, band: "ok" });
  assert.equal(contextBand(49.9).band, "ok");
});

test("50 up to 80 is warn", () => {
  assert.deepEqual(contextBand(50), { width: 50, band: "warn" });
  assert.equal(contextBand(79).band, "warn");
});

test("80 and above is hot, width clamped to 100", () => {
  assert.deepEqual(contextBand(80), { width: 80, band: "hot" });
  assert.deepEqual(contextBand(130), { width: 100, band: "hot" });
});

test("negative and NaN clamp to zero", () => {
  assert.deepEqual(contextBand(-5), { width: 0, band: "ok" });
  assert.deepEqual(contextBand(NaN), { width: 0, band: "ok" });
});
