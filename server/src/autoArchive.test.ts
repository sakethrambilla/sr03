import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveDays } from "./autoArchive.ts";

test("archiveDays accepts 1/2/7/14 and falls back to 7", () => {
  assert.equal(archiveDays("1"), 1);
  assert.equal(archiveDays("14"), 14);
  assert.equal(archiveDays(undefined), 7);
  assert.equal(archiveDays("3"), 7);
  assert.equal(archiveDays("abc"), 7);
});
