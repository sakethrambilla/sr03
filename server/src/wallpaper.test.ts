import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-wallpaper-"));
process.env.SR03_DATA_DIR = dir;
const { sniffImage, saveWallpaper, readWallpaper, removeWallpaper } = await import("./wallpaper.ts");

after(() => fs.rm(dir, { recursive: true, force: true }));

const padding = Buffer.alloc(16);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), padding]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);

test("sniffImage recognizes png, jpeg and webp by their bytes", () => {
  assert.equal(sniffImage(png), "png");
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), padding])), "jpg");
  assert.equal(sniffImage(webp), "webp");
});

test("sniffImage rejects other bytes and an empty buffer", () => {
  assert.equal(sniffImage(Buffer.from("%PDF-1.7")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("saveWallpaper returns a versioned url and readWallpaper returns the bytes", async () => {
  const { url } = await saveWallpaper(png, "png");
  assert.match(url, /^\/api\/wallpaper\?v=[0-9a-z]+$/);
  const file = await readWallpaper();
  assert.ok(file);
  assert.deepEqual(file.bytes, png);
  assert.equal(file.type, "image/png");
});

test("saving a new wallpaper replaces the previous one", async () => {
  await saveWallpaper(png, "png");
  await saveWallpaper(webp, "webp");
  const entries = (await fs.readdir(dir)).filter((name) => name.startsWith("wallpaper."));
  assert.deepEqual(entries, ["wallpaper.webp"]);
  assert.equal((await readWallpaper())?.type, "image/webp");
});

test("removeWallpaper clears the wallpaper and is safe to repeat", async () => {
  await saveWallpaper(png, "png");
  await removeWallpaper();
  assert.equal(await readWallpaper(), null);
  await removeWallpaper();
});
