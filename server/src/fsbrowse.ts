import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
