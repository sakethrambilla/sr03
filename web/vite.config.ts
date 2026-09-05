// The dev server on :5399, proxying /api and /ws through to the sr03 server, plus the `@/` alias
// the shadcn generator emits. `pnpm build` writes web/dist, which the server then serves itself.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SERVER = `http://127.0.0.1:${process.env.SR03_PORT ?? 3399}`;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// excalidraw's canvas fonts (Virgil, Excalifont, …) are loaded at runtime from
// window.EXCALIDRAW_ASSET_PATH, not bundled through an import — copied once from the installed
// package rather than committed, the same way node_modules itself is reconstructed, not tracked
const fontsSrc = path.join(ROOT, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const fontsDest = path.join(ROOT, "public/excalidraw-assets/fonts");
if (!fs.existsSync(fontsSrc)) {
  // a package upgrade that restructures dist/prod would land here silently otherwise —
  // the canvas would just fall back to unstyled default fonts with nothing to explain why
  console.warn(`[vite.config] excalidraw fonts not found at ${fontsSrc} — canvas text may look wrong`);
} else if (!fs.existsSync(fontsDest)) {
  fs.cpSync(fontsSrc, fontsDest, { recursive: true });
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.join(ROOT, "src") },
  },
  server: {
    port: 5399,
    proxy: {
      "/api": SERVER,
      "/ws": { target: SERVER.replace("http", "ws"), ws: true },
    },
  },
});
