import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { spawn } from "node-pty";
import type { IPty } from "node-pty";

import { publish } from "./bus.ts";

const require = createRequire(import.meta.url);

// node-pty's spawn-helper arrives without its exec bit through some package managers,
// and posix_spawnp then fails for every session — fix it in place rather than at install time
function ensureSpawnHelper(): void {
  const root = path.resolve(path.dirname(require.resolve("node-pty")), "..");
  const prebuilds = path.join(root, "prebuilds");
  const candidates = [path.join(root, "build", "Release", "spawn-helper")];
  try {
    for (const entry of fs.readdirSync(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(prebuilds, entry.name, "spawn-helper"));
    }
  } catch {
    // no prebuilds directory in a source build
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      try {
        fs.chmodSync(candidate, 0o755);
      } catch {
        // missing for this platform, or not ours to change
      }
    }
  }
}

const SCROLLBACK_LIMIT = 128 * 1024;

interface Session {
  term: IPty;
  cwd: string;
  buffer: string;
}

const sessions = new Map<string, Session>();
let helperChecked = false;

// a reattaching client needs what already scrolled past, so every session keeps a tail of its output
export function openSession(
  threadId: string,
  cwd: string,
  cols: number,
  rows: number,
): { data: string } {
  const existing = sessions.get(threadId);
  if (existing && existing.cwd === cwd) {
    existing.term.resize(cols, rows);
    return { data: existing.buffer };
  }
  if (existing) closeSession(threadId);

  if (!helperChecked) {
    ensureSpawnHelper();
    helperChecked = true;
  }

  const shell = process.env.SHELL ?? "/bin/sh";
  const term = spawn(shell, ["-l"], {
    cwd,
    cols,
    rows,
    name: "xterm-256color",
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  const session: Session = { term, cwd, buffer: "" };
  sessions.set(threadId, session);

  term.onData((data) => {
    session.buffer = (session.buffer + data).slice(-SCROLLBACK_LIMIT);
    publish({ type: "pty.data", threadId, data });
  });
  term.onExit(({ exitCode }) => {
    sessions.delete(threadId);
    publish({ type: "pty.exit", threadId, code: exitCode });
  });

  return { data: "" };
}

export function write(threadId: string, data: string): void {
  sessions.get(threadId)?.term.write(data);
}

export function resize(threadId: string, cols: number, rows: number): void {
  const session = sessions.get(threadId);
  if (!session) return;
  try {
    session.term.resize(Math.max(cols, 2), Math.max(rows, 1));
  } catch {
    // the shell exited between the client's measurement and this call
  }
}

export function closeSession(threadId: string): void {
  const session = sessions.get(threadId);
  if (!session) return;
  sessions.delete(threadId);
  try {
    session.term.kill();
  } catch {
    // already gone
  }
}
