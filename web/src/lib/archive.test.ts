import assert from "node:assert/strict";
import test from "node:test";

import { exitDelays, exitTotalMs } from "./archive.ts";

test("delays stagger by 30ms from zero", () => {
  assert.deepEqual(exitDelays(0), []);
  assert.deepEqual(exitDelays(1), [0]);
  assert.deepEqual(exitDelays(3), [0, 30, 60]);
});

test("a large batch compresses its stagger to a 500ms span", () => {
  const delays = exitDelays(21);
  assert.equal(delays.at(-1), 500);
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] - delays[i - 1] <= 30);
});

test("total time is the last delay plus the exit duration", () => {
  assert.equal(exitTotalMs(0), 0);
  assert.equal(exitTotalMs(1), 200);
  assert.equal(exitTotalMs(3), 260);
  assert.equal(exitTotalMs(100), 700);
});
