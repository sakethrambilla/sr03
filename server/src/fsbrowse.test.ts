import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-fsbrowse-"));
process.env.SR03_DATA_DIR = dir;
const { linuxPickerCommands, locateEntry, statWorkspacePdf, statWorkspaceVideo, videoRange, windowsPickerCommand } = await import("./fsbrowse.ts");

after(() => fs.rm(dir, { recursive: true, force: true }));

test("linux picker tries zenity then kdialog", () => {
  assert.deepEqual(linuxPickerCommands("folder", "T"), [
    { cmd: "zenity", args: ["--file-selection", "--directory", "--title=T"], cancelCode: 1 },
    { cmd: "kdialog", args: ["--title", "T", "--getexistingdirectory", os.homedir()], cancelCode: 1 },
  ]);
  assert.deepEqual(linuxPickerCommands("file", "T"), [
    { cmd: "zenity", args: ["--file-selection", "--title=T"], cancelCode: 1 },
    { cmd: "kdialog", args: ["--title", "T", "--getopenfilename", os.homedir()], cancelCode: 1 },
  ]);
});

test("windows picker is an encoded powershell script", () => {
  const { cmd, args, cancelCode } = windowsPickerCommand("folder", "Pick 'it'");
  assert.equal(cmd, "powershell.exe");
  assert.equal(cancelCode, undefined);
  assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
  const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
  assert.match(script, /Pick\('folder', 'Pick ''it'''\)/);
  assert.match(script, /IFileOpenDialog/);
  assert.match(script, /OutputEncoding/);
});

test("video range parses single byte ranges", () => {
  assert.equal(videoRange(1000, undefined), null);
  assert.deepEqual(videoRange(1000, "bytes=0-"), { start: 0, end: 999 });
  assert.deepEqual(videoRange(1000, "bytes=100-199"), { start: 100, end: 199 });
  assert.deepEqual(videoRange(1000, "bytes=900-5000"), { start: 900, end: 999 });
  assert.deepEqual(videoRange(1000, "bytes=-100"), { start: 900, end: 999 });
  assert.equal(videoRange(1000, "bytes=1000-"), "unsatisfiable");
  assert.equal(videoRange(1000, "bytes=0-1,5-9"), null);
  assert.equal(videoRange(1000, "items=0-1"), null);
});

test("workspace video stat checks type and containment", async () => {
  const root = await fs.mkdtemp(path.join(dir, "video-"));
  await fs.writeFile(path.join(root, "a.mp4"), Buffer.alloc(10));
  await fs.writeFile(path.join(root, "notes.txt"), "hi");
  const video = await statWorkspaceVideo(root, "a.mp4");
  assert.equal(video.size, 10);
  assert.equal(video.type, "video/mp4");
  await assert.rejects(statWorkspaceVideo(root, "notes.txt"), /not a video/);
  await assert.rejects(statWorkspaceVideo(root, "../x.mp4"), /outside the session folder/);
});

test("locate maps a checkout path into the worktree and names a missing path", async () => {
  const root = await fs.mkdtemp(path.join(dir, "locate-"));
  const main = path.join(root, "main");
  const wt = path.join(root, "wt");
  await fs.mkdir(path.join(wt, "nested"), { recursive: true });
  await fs.mkdir(main);
  await fs.writeFile(path.join(wt, "ignored.txt"), "x");
  await fs.writeFile(path.join(wt, "nested", "x.txt"), "x");
  assert.deepEqual(await locateEntry(wt, path.join(main, "ignored.txt"), main), { path: "ignored.txt" });
  assert.deepEqual(await locateEntry(wt, "nested/x.txt", main), { path: "nested/x.txt" });
  await assert.rejects(locateEntry(wt, "nope.txt", main), { code: "ENOENT", path: path.join(wt, "nope.txt") });
});

test("workspace pdf stat checks type and containment", async () => {
  const root = await fs.mkdtemp(path.join(dir, "pdf-"));
  await fs.writeFile(path.join(root, "a.pdf"), Buffer.alloc(10));
  await fs.writeFile(path.join(root, "notes.txt"), "hi");
  const pdf = await statWorkspacePdf(root, "a.pdf");
  assert.equal(pdf.size, 10);
  assert.equal(pdf.type, "application/pdf");
  assert.match(pdf.etag, /^"10-[\d.]+"$/);
  await assert.rejects(statWorkspacePdf(root, "notes.txt"), /not a pdf/);
  await assert.rejects(statWorkspacePdf(root, "../x.pdf"), /outside the session folder/);
});
