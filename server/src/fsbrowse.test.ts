import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-fsbrowse-"));
process.env.SR03_DATA_DIR = dir;
const { linuxPickerCommands, windowsPickerCommand } = await import("./fsbrowse.ts");

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
