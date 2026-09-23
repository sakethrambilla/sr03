// The one app-wide wallpaper, stored as DATA_DIR/wallpaper.<ext>. There is never more than one.
import fs from "node:fs/promises";
import path from "node:path";

import { DATA_DIR } from "./config.ts";

export const WALLPAPER_LIMIT = 20 * 1024 * 1024;

const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
export type WallpaperExt = keyof typeof TYPES;
const EXTS = Object.keys(TYPES) as WallpaperExt[];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// the bytes decide, not the filename or the client's content-type
export function sniffImage(bytes: Buffer): WallpaperExt | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

const fileFor = (ext: WallpaperExt) => path.join(DATA_DIR, `wallpaper.${ext}`);

export async function removeWallpaper(): Promise<void> {
  await Promise.all(EXTS.map((ext) => fs.rm(fileFor(ext), { force: true })));
}

// the version in the url is what makes the browser drop the previous image
export async function saveWallpaper(bytes: Buffer, ext: WallpaperExt): Promise<{ url: string }> {
  await removeWallpaper();
  await fs.writeFile(fileFor(ext), bytes);
  return { url: `/api/wallpaper?v=${Date.now().toString(36)}` };
}

export async function readWallpaper(): Promise<{ bytes: Buffer; type: string } | null> {
  for (const ext of EXTS) {
    const bytes = await fs.readFile(fileFor(ext)).catch(() => null);
    if (bytes) return { bytes, type: TYPES[ext] };
  }
  return null;
}
