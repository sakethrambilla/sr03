// The last thing electron-builder prints is the block map, which buries the artifact it just
// made. This says where it landed, so it is the last line the build leaves on screen.
//
// Usage: node report.mjs <dmg|exe>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LABELS = { dmg: "DMG", exe: "EXE" };

const kind = process.argv[2];
if (!LABELS[kind]) {
  console.error(`usage: node report.mjs <${Object.keys(LABELS).join("|")}>`);
  process.exit(1);
}

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const [newest] = fs
  .readdirSync(dist)
  .filter((entry) => entry.endsWith(`.${kind}`))
  .map((entry) => path.join(dist, entry))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

if (!newest) {
  console.error(`no .${kind} found in ${dist}`);
  process.exit(1);
}

const mb = Math.round(fs.statSync(newest).size / 1024 / 1024);
console.log(`\n✔ ${LABELS[kind]} built successfully — saved at ${newest} (${mb} MB)\n`);
