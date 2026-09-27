import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-fsbrowse-"));
process.env.SR03_DATA_DIR = dir;
const { linuxPickerCommands } = await import("./fsbrowse.ts");

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
