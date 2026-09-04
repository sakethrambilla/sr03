// The process entry point. One http server serves the REST API (api.ts) and the built UI out of
// web/dist, and a WebSocket at /ws fans every server event out to every open client. The socket
// also carries the only traffic that flows the other way: terminal keystrokes and the resource
// meter's on/off switch.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { PORT } from "./config.ts";
import { handleApiRequest } from "./api.ts";
import { pendingApprovals } from "./claude.ts";
import { subscribe } from "./bus.ts";
import { threads } from "./db.ts";
import * as metrics from "./metrics.ts";
import { listModels } from "./models.ts";
import * as pty from "./pty.ts";
import type { ClientMessage, ServerEvent } from "./types.ts";

const WEB_DIST = path.resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function serveStatic(request: http.IncomingMessage, response: http.ServerResponse): void {
  if (!fs.existsSync(WEB_DIST)) {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Run `pnpm dev` (Vite serves the UI) or `pnpm build` first.");
    return;
  }
  const requested = new URL(request.url ?? "/", "http://localhost").pathname;
  const candidate = path.join(WEB_DIST, requested);
  const file =
    requested !== "/" && candidate.startsWith(WEB_DIST) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(WEB_DIST, "index.html");
  // vite names every asset by its content hash, so those never go stale; the document does
  const hashed = requested.startsWith("/assets/") && file === candidate;
  response.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer((request, response) => {
  void handleApiRequest(request, response).then((handled) => {
    if (!handled) serveStatic(request, response);
  });
});

const websockets = new WebSocketServer({ server, path: "/ws" });

interface Connection {
  send: (data: string) => void;
  watchResources: (() => void) | null;
}

function handleClientMessage(socket: Connection, raw: string): void {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  if (message.type === "resources.watch") {
    if (!message.on) {
      socket.watchResources?.();
      socket.watchResources = null;
      return;
    }
    socket.watchResources ??= metrics.watch();
    // a reopened meter would otherwise sit blank until the next tick
    const known = metrics.snapshot();
    if (known) socket.send(JSON.stringify({ type: "resources", resources: known }));
    return;
  }

  const thread = threads.byId(message.threadId);
  if (!thread) return;

  switch (message.type) {
    case "pty.list":
      socket.send(
        JSON.stringify({ type: "pty.terminals", threadId: thread.id, ids: pty.listSessions(thread.id) }),
      );
      return;
    case "pty.create": {
      const terminalId = pty.createSession(thread.id, thread.cwd, message.cols, message.rows);
      socket.send(JSON.stringify({ type: "pty.created", threadId: thread.id, terminalId }));
      return;
    }
    case "pty.open": {
      // the snapshot goes only to the socket that asked, so other clients keep their own scroll
      const attached = pty.attach(message.terminalId, message.cols, message.rows);
      if (attached) {
        socket.send(
          JSON.stringify({
            type: "pty.snapshot",
            threadId: thread.id,
            terminalId: message.terminalId,
            data: attached.data,
          }),
        );
      }
      return;
    }
    case "pty.input":
      pty.write(message.terminalId, message.data);
      return;
    case "pty.resize":
      pty.resize(message.terminalId, message.cols, message.rows);
      return;
    case "pty.close":
      pty.closeSession(message.terminalId);
      return;
  }
}

websockets.on("connection", (socket) => {
  const connection: Connection = { send: (data) => socket.send(data), watchResources: null };
  const unsubscribe = subscribe((_event, json) => {
    if (socket.readyState === socket.OPEN) socket.send(json);
  });
  // a reload or a dropped socket misses whatever was published while it was gone; an approval
  // nobody can answer leaves its turn parked forever, so every new socket is told what is open
  const snapshot: ServerEvent = { type: "thread.approvals", approvals: pendingApprovals() };
  socket.send(JSON.stringify(snapshot));
  socket.on("message", (raw) => {
    try {
      handleClientMessage(connection, raw.toString());
    } catch (error) {
      console.error("[ws]", error);
    }
  });
  const teardown = () => {
    unsubscribe();
    connection.watchResources?.();
    connection.watchResources = null;
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`sr03 server listening on http://127.0.0.1:${PORT}`);
  // asking the CLI for its model list costs seconds, so pay it before the first page load
  void listModels();
});
