import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SERVER = `http://127.0.0.1:${process.env.SR03_PORT ?? 3399}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5399,
    proxy: {
      "/api": SERVER,
      "/ws": { target: SERVER.replace("http", "ws"), ws: true },
    },
  },
});
