// A window over the ordinary sr03 server: the server runs as a child process under the
// machine's own Node, exactly as `pnpm start` would. Electron's bundled Node can't host it
// (type stripping, node:sqlite and node-pty's ABI all want the real thing).
const { app, BrowserWindow, dialog, shell } = require("electron");
const { execFile, execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const PAYLOAD = app.isPackaged
  ? path.join(process.resourcesPath, "payload")
  : path.join(__dirname, "payload");
const ENTRY = path.join(PAYLOAD, "server", "src", "index.ts");

let server = null;

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

function openWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#1f1e1c",
    // on macOS the app's own 60px header stands in for the title bar, so the traffic lights are
    // placed on its centre line rather than left at the inset default, which sits ~10px higher.
    // Windows keeps its native frame — its controls sit on the right, where panes have no
    // reserved room for them
    ...(WINDOWS ? {} : { titleBarStyle: "hidden", trafficLightPosition: { x: 20, y: 22 } }),
    title: "sr03",
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void window.loadURL(SPLASH);
  return window;
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

  if (!window.isDestroyed()) void window.loadURL(`http://127.0.0.1:${port}`);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) window.focus();
  });
  app.whenReady().then(start);
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    app.isQuitting = true;
    server?.kill();
  });
}
