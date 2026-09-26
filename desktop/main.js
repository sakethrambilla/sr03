// A window over the ordinary sr03 server: the server runs as a child process under the
// machine's own Node, exactly as `pnpm start` would. Electron's bundled Node can't host it
// (type stripping, node:sqlite and node-pty's ABI all want the real thing).
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const { execFile, execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PAYLOAD = app.isPackaged
  ? path.join(process.resourcesPath, "payload")
  : path.join(__dirname, "payload");
const ENTRY = path.join(PAYLOAD, "server", "src", "index.ts");

let server = null;
let pendingFolder = folderArg(process.argv);
let appUrl = null;

const WINDOWS = process.platform === "win32";
const SHELL_BIN = process.env.SHELL || "/bin/zsh";
const PATH_ARGS = ["-ilc", "printf %s \"$PATH\""];

// on macOS a GUI launch inherits a bare /usr/bin:/bin PATH, so nvm/homebrew installs are
// invisible. the login shell is the only place the user's real PATH exists — the server needs it
// for node itself, and the Claude CLI it spawns needs it for git
function loginPath() {
  try {
    const found = execFileSync(SHELL_BIN, PATH_ARGS, { encoding: "utf8", timeout: 8000 }).trim();
    return found || process.env.PATH || "";
  } catch {
    return process.env.PATH || "";
  }
}

// an interactive shell takes up to a couple of seconds to start under a heavy rc file, so the
// answer is kept for the next launch and refreshed once the window is already up
const PATH_CACHE = path.join(app.getPath("userData"), "login-path");

function cachedLoginPath() {
  try {
    return fs.readFileSync(PATH_CACHE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function refreshLoginPath() {
  execFile(SHELL_BIN, PATH_ARGS, { encoding: "utf8", timeout: 8000 }, (error, stdout) => {
    const found = (stdout || "").trim();
    if (error || !found) return;
    try {
      fs.mkdirSync(path.dirname(PATH_CACHE), { recursive: true });
      fs.writeFileSync(PATH_CACHE, found);
    } catch {}
  });
}

// what the window shows for the second or two before the server answers
const SPLASH =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    '<!doctype html><html style="background:#1f1e1c"><body style="margin:0;height:100vh;display:grid;place-items:center;font:13px -apple-system,system-ui,sans-serif;color:#7d7b76">Starting sr03…</body></html>',
  );

function findNode(searchPath) {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, WINDOWS ? "node.exe" : "node");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// Windows resolves the user's PATH from the registry before the process starts, so a GUI launch
// already has the real one and there is no login shell to ask
function resolveSearchPath() {
  if (WINDOWS) return process.env.PATH || "";
  // a stale cache (node moved) falls back to asking the shell, which then rewrites it
  const cached = cachedLoginPath();
  const found = cached && findNode(cached) ? cached : loginPath();
  refreshLoginPath();
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForServer(port, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get({ host: "127.0.0.1", port, path: "/" }, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() > deadline) reject(new Error("server did not come up in time"));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function fail(message) {
  dialog.showErrorBox("sr03 could not start", message);
  app.exit(1);
}

// native traffic lights are a fixed 12px; the app header is h-13 (52px). x/y are DIP from the
// window's top-left so they sit on that header's centre line with the same inset the sidebar
// header uses, rather than hugging the corner the way the hidden-titlebar default does.
// AppKit on recent macOS relayouts the titlebar container after show/load/restore and forgets
// the constructor value, so placeTrafficLights re-asserts it.
const TRAFFIC_LIGHTS = { x: 20, y: 20 };

function placeTrafficLights(window) {
  if (WINDOWS || window.isDestroyed()) return;
  window.setWindowButtonPosition(TRAFFIC_LIGHTS);
}

function openWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#1f1e1c",
    // Windows keeps its native frame — its controls sit on the right, where panes have no
    // reserved room for them
    ...(WINDOWS ? {} : { titleBarStyle: "hidden", trafficLightPosition: TRAFFIC_LIGHTS }),
    title: "sr03",
  });
  if (!WINDOWS) {
    placeTrafficLights(window);
    window.on("ready-to-show", () => placeTrafficLights(window));
    window.on("restore", () => placeTrafficLights(window));
    window.on("leave-full-screen", () => placeTrafficLights(window));
    window.webContents.on("did-finish-load", () => {
      placeTrafficLights(window);
      setTimeout(() => placeTrafficLights(window), 50);
    });
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void window.loadURL(SPLASH);
  return window;
}

// argv carries Chromium switches and, unpackaged, the app dir — the folder is the last
// plain argument that is an existing directory
function folderArg(argv) {
  for (const value of argv.slice(1).reverse()) {
    if (value.startsWith("-") || !path.isAbsolute(value)) continue;
    try {
      if (fs.statSync(value).isDirectory()) return value;
    } catch {}
  }
  return null;
}

const CLI_MARKER = "# installed by sr03";
const CLI_DIRS = ["/usr/local/bin", path.join(os.homedir(), ".local", "bin")];

// exe is sr03.app/Contents/MacOS/sr03
function cliScript() {
  const bundle = path.resolve(app.getPath("exe"), "../../..");
  return [
    "#!/bin/sh",
    CLI_MARKER,
    `APP=${JSON.stringify(bundle)}`,
    'if [ $# -eq 0 ]; then exec open -a "$APP"; fi',
    'dir=$(cd "$1" 2>/dev/null && pwd -P) || { echo "sr03: $1: not a directory" >&2; exit 1; }',
    'exec open -n -a "$APP" --args "$dir"',
    "",
  ].join("\n");
}

function installCli() {
  let lastError = null;
  for (const dir of CLI_DIRS) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "sr03"), cliScript(), { mode: 0o755 });
      const onPath = loginPath().split(path.delimiter).includes(dir);
      dialog.showMessageBox({
        message: `Installed sr03 at ${path.join(dir, "sr03")}`,
        detail: onPath ? "Open a new terminal and run `sr03 .`" : `${dir} is not on your PATH — add it to your shell profile.`,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  dialog.showErrorBox("Could not install sr03", String(lastError?.message ?? lastError));
}

function uninstallCli() {
  const removed = [];
  for (const dir of CLI_DIRS) {
    const file = path.join(dir, "sr03");
    try {
      if (!fs.readFileSync(file, "utf8").includes(CLI_MARKER)) continue;
      fs.rmSync(file);
      removed.push(file);
    } catch {}
  }
  dialog.showMessageBox({ message: removed.length ? `Removed ${removed.join(", ")}` : "The sr03 command was not installed." });
}

function setMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Install 'sr03' command in PATH", click: installCli },
        { label: "Uninstall 'sr03' command", click: uninstallCli },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));
}

async function start() {
  const searchPath = resolveSearchPath();
  const nodeBin = findNode(searchPath);
  if (!nodeBin) {
    fail(`No node found on PATH.\n\nsr03 needs Node 22.16 or newer.\n\nSearched:\n${searchPath}`);
    return;
  }
  if (!fs.existsSync(ENTRY)) {
    fail(`Server payload missing at\n${ENTRY}\n\nRun \`pnpm dmg\` to rebuild it.`);
    return;
  }

  // the window goes up before the server does, so the click has something to show for itself
  const window = openWindow();
  const port = await freePort();
  let log = "";

  server = spawn(nodeBin, ["--experimental-strip-types", ENTRY], {
    // the server measures the whole app, and the shell's own processes are only reachable
    // from the pid that owns them
    env: { ...process.env, PATH: searchPath, SR03_PORT: String(port), SR03_SHELL_PID: String(process.pid) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = (chunk) => {
    log = (log + chunk.toString()).slice(-4000);
    process.stdout.write(chunk);
  };
  server.stdout.on("data", record);
  server.stderr.on("data", record);
  server.on("exit", (code) => {
    server = null;
    if (!app.isQuitting) fail(`The server exited (code ${code}).\n\n${log}`);
  });

  try {
    await waitForServer(port, Date.now() + 30000);
  } catch (error) {
    fail(`${error.message}\n\n${log}`);
    return;
  }

  appUrl = `http://127.0.0.1:${port}`;
  const query = pendingFolder ? `/?open=${encodeURIComponent(pendingFolder)}` : "";
  pendingFolder = null;
  if (!window.isDestroyed()) void window.loadURL(appUrl + query);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", (_event, argv) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    // the launching process already exited, so macOS won't hand focus back on its own
    app.focus({ steal: true });
    window.focus();
    const folder = folderArg(argv);
    if (!folder) return;
    // still on the splash: the first loadURL will carry it
    if (!appUrl) {
      pendingFolder = folder;
      return;
    }
    const detail = JSON.stringify(folder);
    void window.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent("sr03:open", { detail: ${detail} }))`,
    );
  });
  app.whenReady().then(() => {
    if (!WINDOWS && app.isPackaged) setMenu();
    return start();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    app.isQuitting = true;
    server?.kill();
  });
}
