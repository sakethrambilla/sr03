import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { UPLOADS_DIR } from "./config.ts";

const exec = promisify(execFile);

const UPLOAD_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export async function listDirectory(target?: string): Promise<DirListing> {
  const resolved = path.resolve(target?.trim() ? target.replace(/^~/, os.homedir()) : os.homedir());
  const dirents = await fs.readdir(resolved, { withFileTypes: true });
  const dirs = dirents
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  const entries = await Promise.all(
    dirs.map(async (entry) => {
      const entryPath = path.join(resolved, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        isGit: await fs
          .stat(path.join(entryPath, ".git"))
          .then(() => true)
          .catch(() => false),
      };
    }),
  );
  const parent = path.dirname(resolved);
  return { path: resolved, parent: parent === resolved ? null : parent, entries };
}

export async function isDirectory(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

// the browser can't hand us a real path, but the server shares the machine, so ask macOS itself
export async function choosePath(kind: "folder" | "file"): Promise<string | null> {
  if (process.platform !== "darwin") throw new Error("The native picker needs macOS");
  const prompt = kind === "folder" ? "sr03 — choose a project folder" : "sr03 — choose a file";
  try {
    const { stdout } = await exec("osascript", [
      "-e",
      "activate",
      "-e",
      `POSIX path of (choose ${kind} with prompt "${prompt}")`,
    ]);
    const chosen = stdout.trim();
    return chosen ? path.resolve(chosen) : null;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (stderr.includes("-128")) return null;
    throw new Error(stderr.trim() || "The native picker closed unexpectedly");
  }
}

// dropped and pasted files have no path of their own, so they get one under the data dir
export async function saveUpload(
  name: string,
  bytes: Buffer,
): Promise<{ path: string; name: string; url: string }> {
  const clean =
    path
      .basename(name)
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "attachment";
  const stored = `${Date.now().toString(36)}-${clean}`;
  const target = path.join(UPLOADS_DIR, stored);
  await fs.writeFile(target, bytes);
  return { path: target, name: clean, url: `/api/uploads/${encodeURIComponent(stored)}` };
}

export async function readUpload(name: string): Promise<{ bytes: Buffer; type: string } | null> {
  const target = path.join(UPLOADS_DIR, path.basename(name));
  const bytes = await fs.readFile(target).catch(() => null);
  if (!bytes) return null;
  return { bytes, type: UPLOAD_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream" };
}
