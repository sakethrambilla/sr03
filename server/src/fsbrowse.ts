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

const APP_DIRS = [
  "/Applications",
  path.join(os.homedir(), "Applications"),
  "/System/Applications",
  "/System/Applications/Utilities",
  "/System/Library/CoreServices",
];

const OPEN_TARGETS = [
  { id: "cursor", label: "Cursor", names: ["Cursor"] },
  { id: "vscode", label: "VS Code", names: ["Visual Studio Code", "VSCodium"] },
  { id: "zed", label: "Zed", names: ["Zed"] },
  { id: "finder", label: "Finder", names: ["Finder"] },
] as const;

export interface ExternalApp {
  id: string;
  label: string;
}

async function findBundle(names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    for (const dir of APP_DIRS) {
      const candidate = path.join(dir, `${name}.app`);
      if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate;
    }
  }
  return null;
}

async function installedApps(): Promise<Array<{ app: ExternalApp; bundle: string }>> {
  if (process.platform !== "darwin") return [];
  const found = await Promise.all(
    OPEN_TARGETS.map(async (target): Promise<{ app: ExternalApp; bundle: string } | null> => {
      const bundle = await findBundle(target.names);
      return bundle
        ? { app: { id: target.id, label: target.label }, bundle }
        : null;
    }),
  );
  return found.filter((entry): entry is { app: ExternalApp; bundle: string } => entry !== null);
}

export async function listApps(): Promise<ExternalApp[]> {
  return (await installedApps()).map((entry) => entry.app);
}

export async function openIn(id: string, target: string): Promise<void> {
  const entry = (await installedApps()).find((candidate) => candidate.app.id === id);
  if (!entry) throw new Error(`${id} is not installed on this machine`);
  await exec("open", ["-a", entry.bundle, target]);
}

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
}

const TREE_SKIP = new Set([".git"]);
const FILE_LIMIT = 1024 * 1024;

function safeJoin(root: string, rel: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("That path is outside the session folder");
  }
  return target;
}

export async function listWorkspaceDir(root: string, rel: string): Promise<TreeEntry[]> {
  const dirents = await fs.readdir(safeJoin(root, rel), { withFileTypes: true });
  return dirents
    .filter((entry) => !TREE_SKIP.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: rel ? `${rel}/${entry.name}` : entry.name,
      isDir: entry.isDirectory(),
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

export async function readWorkspaceFile(
  root: string,
  rel: string,
): Promise<{ text: string; binary: boolean; truncated: boolean }> {
  const target = safeJoin(root, rel);
  const stats = await fs.stat(target);
  if (!stats.isFile()) throw new Error("That path is not a file");
  const handle = await fs.open(target, "r");
  try {
    const size = Math.min(stats.size, FILE_LIMIT);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    if (buffer.includes(0)) return { text: "", binary: true, truncated: false };
    return { text: buffer.toString("utf8"), binary: false, truncated: stats.size > FILE_LIMIT };
  } finally {
    await handle.close();
  }
}
