// Filesystem work that isn't git: the folder picker's directory listing and the native OS
// dialog behind it, dropped-file uploads, the session folder's own tree — read, write, create,
// rename, trash, reveal — the "open in Cursor/VS Code/Zed/Finder" app list, and the file walk and
// text scan a folder falls back to when git can't index it. Every path that names something inside
// a session goes through safeJoin, which refuses to leave the folder.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { UPLOADS_DIR } from "./config.ts";
import { MATCH_TEXT_LIMIT } from "./git.ts";
import type { TextMatch } from "./git.ts";

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

export type PickerCommand = { cmd: string; args: string[]; cancelCode?: number };

export function linuxPickerCommands(kind: "folder" | "file", title: string): PickerCommand[] {
  const folder = kind === "folder";
  return [
    {
      cmd: "zenity",
      args: folder ? ["--file-selection", "--directory", `--title=${title}`] : ["--file-selection", `--title=${title}`],
      cancelCode: 1,
    },
    {
      cmd: "kdialog",
      args: ["--title", title, folder ? "--getexistingdirectory" : "--getopenfilename", os.homedir()],
      cancelCode: 1,
    },
  ];
}

// Windows PowerShell's FolderBrowserDialog is the old tree view; IFileOpenDialog is the Explorer one
const WINDOWS_PICKER = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class Sr03Picker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  // vtable order matters: unused slots are declared only to keep later ones at the right offset
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(); void SetFolder(); void GetFolder(); void GetCurrentSelection();
    void SetFileName(); void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel(); void SetFileNameLabel();
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  public static string Pick(string kind, string title) {
    var owner = new Form { TopMost = true, ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None,
      Opacity = 0, StartPosition = FormStartPosition.Manual, Location = new Point(-32000, -32000), Size = new Size(1, 1) };
    owner.Show();
    owner.Activate();
    try {
      if (kind == "file") {
        var files = new OpenFileDialog { Title = title };
        return files.ShowDialog(owner) == DialogResult.OK ? files.FileName : null;
      }
      var dialog = (IFileOpenDialog)new FileOpenDialog();
      // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
      dialog.SetOptions(0x20 | 0x40);
      dialog.SetTitle(title);
      if (dialog.Show(owner.Handle) != 0) return null;
      IShellItem item;
      dialog.GetResult(out item);
      string chosen;
      // SIGDN_FILESYSPATH
      item.GetDisplayName(0x80058000, out chosen);
      return chosen;
    } finally {
      owner.Close();
    }
  }
}
'@
`;

export function windowsPickerCommand(kind: "folder" | "file", title: string): PickerCommand {
  const quoted = `'${title.replaceAll("'", "''")}'`;
  const script = `${WINDOWS_PICKER}\n$chosen = [Sr03Picker]::Pick('${kind}', ${quoted})\nif ($chosen) { $chosen }\n`;
  return {
    cmd: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")],
  };
}

async function runPicker(commands: PickerCommand[]): Promise<string | null> {
  for (const { cmd, args, cancelCode } of commands) {
    try {
      const { stdout } = await exec(cmd, args);
      const chosen = stdout.trim();
      return chosen ? path.resolve(chosen) : null;
    } catch (error) {
      const { code, stderr = "" } = error as { code?: unknown; stderr?: string };
      if (code === "ENOENT") continue;
      if (code === cancelCode && !stderr.trim()) return null;
      throw new Error(stderr.trim() || "The native picker closed unexpectedly");
    }
  }
  throw new Error(`No native picker found (tried ${commands.map((c) => c.cmd).join(", ")})`);
}

async function chooseMac(kind: "folder" | "file", prompt: string): Promise<string | null> {
  try {
    // bare `activate` turns osascript itself into a GUI app, which costs ~2s before the dialog shows
    const { stdout } = await exec("osascript", [
      "-e",
      `tell application "System Events" to activate`,
      "-e",
      `tell application "System Events" to POSIX path of (choose ${kind} with prompt "${prompt}")`,
    ]);
    const chosen = stdout.trim();
    return chosen ? path.resolve(chosen) : null;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (stderr.includes("-128")) return null;
    throw new Error(stderr.trim() || "The native picker closed unexpectedly");
  }
}

// the browser can't hand us a real path, but the server shares the machine, so ask the OS itself
export async function choosePath(kind: "folder" | "file"): Promise<string | null> {
  const prompt = kind === "folder" ? "sr03 — choose a project folder" : "sr03 — choose a file";
  if (process.platform === "darwin") return chooseMac(kind, prompt);
  if (process.platform === "linux") return runPicker(linuxPickerCommands(kind, prompt));
  if (process.platform === "win32") return runPicker([windowsPickerCommand(kind, prompt)]);
  throw new Error("No native picker on this platform");
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

const IMAGE_TYPES: Record<string, string> = {
  ...UPLOAD_TYPES,
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

export async function readWorkspaceImage(
  root: string,
  rel: string,
): Promise<{ bytes: Buffer; type: string }> {
  const target = safeJoin(root, rel);
  const type = IMAGE_TYPES[path.extname(target).toLowerCase()];
  if (!type?.startsWith("image/")) throw new Error("That path is not an image");
  return { bytes: await fs.readFile(target), type };
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

const iconCache = new Map<string, Buffer | null>();

// Resources holds a document icon per file type too, so only CFBundleIconFile names the app's own
async function bundleIcon(bundle: string): Promise<string | null> {
  const { stdout } = await exec("plutil", [
    "-extract",
    "CFBundleIconFile",
    "raw",
    "-o",
    "-",
    path.join(bundle, "Contents/Info.plist"),
  ]).catch(() => ({ stdout: "" }));
  const name = stdout.trim();
  if (!name) return null;
  const icns = path.join(bundle, "Contents/Resources", name.endsWith(".icns") ? name : `${name}.icns`);
  return fs.stat(icns).then(() => icns).catch(() => null);
}

export async function appIcon(id: string): Promise<Buffer | null> {
  const cached = iconCache.get(id);
  if (cached !== undefined) return cached;
  const entry = (await installedApps()).find((candidate) => candidate.app.id === id);
  const icns = entry ? await bundleIcon(entry.bundle) : null;
  let png: Buffer | null = null;
  if (icns) {
    const out = path.join(os.tmpdir(), `sr03-icon-${id}-${process.pid}.png`);
    png = await exec("sips", ["-s", "format", "png", "--resampleHeightWidth", "64", "64", icns, "--out", out])
      .then(() => fs.readFile(out))
      .catch(() => null);
    await fs.rm(out, { force: true });
  }
  iconCache.set(id, png);
  return png;
}

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
}

const TREE_SKIP = new Set([".git"]);
const FILE_LIMIT = 1024 * 1024;

export function safeJoin(root: string, rel: string): string {
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
      ignored: false,
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

export async function createWorkspaceEntry(
  root: string,
  rel: string,
  kind: "file" | "dir",
): Promise<TreeEntry> {
  const target = safeJoin(root, rel);
  if (target === path.resolve(root)) throw new Error("Give the new entry a name");
  if (await fs.stat(target).then(() => true).catch(() => false)) {
    throw new Error(`${path.basename(target)} already exists`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (kind === "dir") await fs.mkdir(target);
  else await fs.writeFile(target, "", { flag: "wx" });
  return { name: path.basename(target), path: rel, isDir: kind === "dir", ignored: false };
}

export async function renameWorkspaceEntry(
  root: string,
  rel: string,
  name: string,
): Promise<TreeEntry> {
  if (name.includes("/")) throw new Error("A name can't contain a slash");
  const target = safeJoin(root, rel);
  if (target === path.resolve(root)) throw new Error("The session folder itself can't be renamed");
  const nextRel = path.join(path.dirname(rel), name);
  const next = safeJoin(root, nextRel);
  if (next !== target) {
    if (await fs.stat(next).then(() => true).catch(() => false)) {
      throw new Error(`${name} already exists`);
    }
    await fs.rename(target, next);
  }
  const stats = await fs.stat(next);
  return { name, path: nextRel, isDir: stats.isDirectory(), ignored: false };
}

async function freeTrashPath(base: string): Promise<string> {
  const trash = path.join(os.homedir(), ".Trash");
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = path.join(trash, attempt === 0 ? base : `${stem} ${attempt}${ext}`);
    if (!(await fs.stat(candidate).then(() => true).catch(() => false))) return candidate;
  }
  throw new Error("The Trash already holds 200 entries by that name");
}

// deleting someone's source file should stay undoable, so this moves it to the Trash
// and only removes it outright when that isn't possible (another volume, no Trash)
export async function trashWorkspaceEntry(
  root: string,
  rel: string,
): Promise<{ path: string; trashed: boolean }> {
  const target = safeJoin(root, rel);
  if (target === path.resolve(root)) throw new Error("The session folder itself can't be deleted");
  await fs.lstat(target);
  try {
    await fs.rename(target, await freeTrashPath(path.basename(target)));
    return { path: rel, trashed: true };
  } catch {
    await fs.rm(target, { recursive: true, force: true });
    return { path: rel, trashed: false };
  }
}

export async function revealWorkspaceEntry(root: string, rel: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Finder is only available on macOS");
  const target = safeJoin(root, rel);
  await fs.lstat(target);
  await exec("open", ["-R", target]);
}

export async function openWorkspaceFile(root: string, rel: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Opening in the browser is only available on macOS");
  const target = safeJoin(root, rel);
  if (!(await fs.stat(target)).isFile()) throw new Error("That path is not a file");
  await exec("open", [target]);
}

// for a path a reply names that the file index skips (gitignored, or in another checkout):
// inside the root it comes back relative so a tab can open it, outside it Finder shows it
export async function locateEntry(root: string, ref: string): Promise<{ path: string | null }> {
  const base = path.resolve(root);
  const target = path.resolve(base, ref.replace(/^~(?=\/|$)/, os.homedir()));
  const stats = await fs.stat(target);
  if (target.startsWith(base + path.sep) && stats.isFile()) {
    return { path: path.relative(base, target).split(path.sep).join("/") };
  }
  if (process.platform !== "darwin") throw new Error("Finder is only available on macOS");
  await exec("open", ["-R", target]);
  return { path: null };
}

export async function writeWorkspaceFile(
  root: string,
  rel: string,
  text: string,
): Promise<{ path: string; bytes: number }> {
  const target = safeJoin(root, rel);
  const stats = await fs.stat(target);
  if (!stats.isFile()) throw new Error("That path is not a file");
  // the editor was handed a truncated read, so writing it back would drop the rest
  if (stats.size > FILE_LIMIT) {
    throw new Error("Too large to edit here — only the first 1 MB of this file was loaded");
  }
  await fs.writeFile(target, text, "utf8");
  return { path: rel, bytes: Buffer.byteLength(text) };
}

const WALK_SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
]);
const WALK_LIMIT = 20000;

// the fallback for a folder git knows nothing about, so it has to guess what to skip
export async function walkWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [""];

  while (queue.length > 0 && files.length < WALK_LIMIT) {
    const rel = queue.shift()!;
    const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const entry of dirents) {
      if (WALK_SKIP.has(entry.name)) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(next);
      else if (entry.isFile()) files.push(next);
    }
  }
  return files;
}

// the other half of the fallback: a folder git can't grep gets scanned here instead, over the
// same list walkWorkspaceFiles produced
export async function scanWorkspaceText(
  root: string,
  query: string,
  limit: number,
): Promise<TextMatch[]> {
  // smart case, matching searchText: an all-lowercase query lowercases the line too
  const insensitive = query === query.toLowerCase();
  const matches: TextMatch[] = [];

  for (const rel of await walkWorkspaceFiles(root)) {
    if (matches.length >= limit) break;
    const target = path.join(root, rel);
    const stats = await fs.stat(target).catch(() => null);
    if (!stats?.isFile() || stats.size > FILE_LIMIT) continue;
    const bytes = await fs.readFile(target).catch(() => null);
    if (!bytes || bytes.includes(0)) continue;

    const lines = bytes.toString("utf8").split("\n");
    for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
      const text = lines[index]!;
      if (!(insensitive ? text.toLowerCase() : text).includes(query)) continue;
      matches.push({ path: rel, line: index + 1, text: text.slice(0, MATCH_TEXT_LIMIT) });
    }
  }
  return matches;
}
