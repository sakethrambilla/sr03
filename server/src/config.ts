import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const PORT = Number(process.env.SR03_PORT ?? 3399);
export const DATA_DIR = process.env.SR03_DATA_DIR ?? path.join(os.homedir(), ".sr03");
export const DB_PATH = path.join(DATA_DIR, "sr03.db");
export const WORKTREES_DIR = path.join(DATA_DIR, "worktrees");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
// how long an idle thread keeps its CLI process alive before it is parked and later resumed
export const IDLE_PARK_MS = Number(process.env.SR03_IDLE_PARK_MS ?? 10 * 60_000);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WORKTREES_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
