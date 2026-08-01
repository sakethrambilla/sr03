// A window over the ordinary sr03 server: the server runs as a child process under the
// machine's own Node, exactly as `pnpm start` would. Electron's bundled Node can't host it
// (type stripping, node:sqlite and node-pty's ABI all want the real thing).
const { app, BrowserWindow, dialog, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

const PAYLOAD = app.isPackaged
  ? path.join(process.resourcesPath, "payload")
  : path.join(__dirname, "payload");
const ENTRY = path.join(PAYLOAD, "server", "src", "index.ts");

let server = null;

// a GUI launch inherits a bare /usr/bin:/bin PATH, so nvm/homebrew installs are invisible.
// the login shell is the only place the user's real PATH exists — the server needs it for
// node itself, and the Claude CLI it spawns needs it for git
function loginPath() {
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const found = execFileSync(shellBin, ["-ilc", "printf %s \"$PATH\""], {
      encoding: "utf8",
      timeout: 8000,
    }).trim();
    return found || process.env.PATH || "";
  } catch {
    return process.env.PATH || "";
  }
}

function findNode(searchPath) {
  for (const dir of searchPath.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, "node");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
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

async function start() {
  const searchPath = loginPath();
  const nodeBin = findNode(searchPath);
  if (!nodeBin) {
    fail(`No node found on PATH.\n\nsr03 needs Node 22.16 or newer.\n\nSearched:\n${searchPath}`);
    return;
  }
  if (!fs.existsSync(ENTRY)) {
    fail(`Server payload missing at\n${ENTRY}\n\nRun \`pnpm dmg\` to rebuild it.`);
    return;
  }

  const port = await freePort();
  let log = "";

  server = spawn(nodeBin, ["--experimental-strip-types", ENTRY], {
    env: { ...process.env, PATH: searchPath, SR03_PORT: String(port) },
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

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#1f1e1c",
    titleBarStyle: "hiddenInset",
    title: "sr03",
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void window.loadURL(`http://127.0.0.1:${port}`);
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
