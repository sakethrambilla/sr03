import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { PORT } from "./config.ts";
import { handleApiRequest } from "./api.ts";
import { subscribe } from "./bus.ts";

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
  response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer((request, response) => {
  void handleApiRequest(request, response).then((handled) => {
    if (!handled) serveStatic(request, response);
  });
});

const websockets = new WebSocketServer({ server, path: "/ws" });

websockets.on("connection", (socket) => {
  const unsubscribe = subscribe((event) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  });
  socket.on("close", unsubscribe);
  socket.on("error", unsubscribe);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`sr03 server listening on http://127.0.0.1:${PORT}`);
});
