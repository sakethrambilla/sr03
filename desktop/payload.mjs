// Collects everything the packaged app runs: the built UI plus a symlink-free copy of the
// server and its dependencies. Layout mirrors the repo, since the server resolves
// web/dist relative to its own source directory.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const payload = path.join(here, "payload");

const run = (command, args) =>
  execFileSync(command, args, { cwd: repo, stdio: "inherit" });

run("pnpm", ["-C", repo, "build"]);

fs.rmSync(payload, { recursive: true, force: true });

// --legacy + hoisted gives real directories instead of the usual .pnpm symlink farm,
// which would dangle once electron-builder copies it into the app bundle
run("pnpm", [
  "--filter",
  "@sr03/server",
  "deploy",
  "--prod",
  "--legacy",
  "--config.node-linker=hoisted",
  path.join(payload, "server"),
]);

// the filtered --prod deploy above records itself as the workspace's install state, which leaves
// every later `pnpm <script>` wanting a production install; a plain install puts it back
run("pnpm", ["-C", repo, "install"]);

fs.cpSync(path.join(repo, "web", "dist"), path.join(payload, "web", "dist"), { recursive: true });

// node-pty ships prebuilds for every platform triple; 58M of those are Windows
const prebuilds = path.join(payload, "server", "node_modules", "node-pty", "prebuilds");
for (const entry of fs.readdirSync(prebuilds)) {
  if (entry !== "darwin-arm64") fs.rmSync(path.join(prebuilds, entry), { recursive: true, force: true });
}

console.log(`payload ready at ${payload}`);
