// Collects everything the packaged app runs: the built UI plus a symlink-free copy of the
// server and its dependencies. Layout mirrors the repo, since the server resolves
// web/dist relative to its own source directory.
//
// Usage: node payload.mjs [<node-pty prebuild triple>], default the host's.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const payload = path.join(here, "payload");

const TRIPLES = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
if (!TRIPLES.includes(target)) {
  console.error(`unknown target "${target}" — expected one of ${TRIPLES.join(", ")}`);
  process.exit(1);
}

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
// every later `pnpm <script>` wanting a production install; a plain install puts it back.
// confirmModulesPurge=false because the restore can need a full reinstall, and its prompt would
// otherwise stall the build on a pipe with the workspace left needing a production install
run("pnpm", ["-C", repo, "install", "--config.confirmModulesPurge=false"]);

fs.cpSync(path.join(repo, "web", "dist"), path.join(payload, "web", "dist"), { recursive: true });

// node-pty ships prebuilds for every platform triple, and the app only ever runs on one
const prebuilds = path.join(payload, "server", "node_modules", "node-pty", "prebuilds");
for (const entry of fs.readdirSync(prebuilds)) {
  if (entry !== target) fs.rmSync(path.join(prebuilds, entry), { recursive: true, force: true });
}

// the win32 prebuilds carry 28M of MSVC debug symbols, which only a debugger ever opens
for (const entry of fs.readdirSync(path.join(prebuilds, target))) {
  if (entry.endsWith(".pdb")) fs.rmSync(path.join(prebuilds, target, entry));
}

// the Agent SDK's CLI is an optional dependency per platform, and the deploy above resolves the
// host's — so a cross-built payload arrives with the wrong 200M binary and the SDK, which looks
// for `claude-agent-sdk-<platform>-<arch>/claude[.exe]`, finds nothing and every turn fails.
// the triple doubles as the package suffix, so fetch the target's and drop whatever else is here
const scope = path.join(payload, "server", "node_modules", "@anthropic-ai");
const wanted = `claude-agent-sdk-${target}`;
if (!fs.existsSync(path.join(scope, wanted))) {
  const { version } = JSON.parse(
    fs.readFileSync(path.join(scope, "claude-agent-sdk", "package.json"), "utf8"),
  );
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "sr03-cli-"));
  run("npm", ["pack", `@anthropic-ai/${wanted}@${version}`, "--pack-destination", staging]);
  const [tarball] = fs.readdirSync(staging).filter((entry) => entry.endsWith(".tgz"));
  if (!tarball) throw new Error(`npm pack produced no tarball for ${wanted}@${version}`);
  const into = path.join(scope, wanted);
  fs.mkdirSync(into, { recursive: true });
  run("tar", ["-xzf", path.join(staging, tarball), "-C", into, "--strip-components=1"]);
  fs.rmSync(staging, { recursive: true, force: true });

  for (const entry of fs.readdirSync(scope)) {
    if (entry.startsWith("claude-agent-sdk-") && entry !== wanted) {
      fs.rmSync(path.join(scope, entry), { recursive: true, force: true });
    }
  }
}

console.log(`payload ready at ${payload} (${target})`);
