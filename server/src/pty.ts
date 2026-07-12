import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  threadId: string;
  term: IPty;
  buffer: string;
}

// keyed by terminal id; a thread can hold several, and Map keeps them in creation order
const sessions = new Map<string, Session>();
let helperChecked = false;

export function listSessions(threadId: string): string[] {
  return [...sessions.entries()]
    .filter(([, session]) => session.threadId === threadId)
    .map(([id]) => id);
}

export function createSession(threadId: string, cwd: string, cols: number, rows: number): string {
  if (!helperChecked) {
    ensureSpawnHelper();
    helperChecked = true;
  }

  const terminalId = randomUUID();
  const shell = process.env.SHELL ?? "/bin/sh";
  const term = spawn(shell, ["-l"], {
    cwd,
    cols: Math.max(cols, 2),
    rows: Math.max(rows, 1),
    name: "xterm-256color",
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  const session: Session = { threadId, term, buffer: "" };
  sessions.set(terminalId, session);

  term.onData((data) => {
    session.buffer = (session.buffer + data).slice(-SCROLLBACK_LIMIT);
    publish({ type: "pty.data", threadId, terminalId, data });
  });
  term.onExit(({ exitCode }) => {
    sessions.delete(terminalId);
    publish({ type: "pty.exit", threadId, terminalId, code: exitCode });
  });

  return terminalId;
}

// a reattaching client needs what already scrolled past, so every session keeps a tail of its output
export function attach(terminalId: string, cols: number, rows: number): { data: string } | null {
  const session = sessions.get(terminalId);
  if (!session) return null;
  resize(terminalId, cols, rows);
  return { data: session.buffer };
}

export function write(terminalId: string, data: string): void {
  sessions.get(terminalId)?.term.write(data);
}

export function resize(terminalId: string, cols: number, rows: number): void {
  const session = sessions.get(terminalId);
  if (!session) return;
  try {
    session.term.resize(Math.max(cols, 2), Math.max(rows, 1));
  } catch {
    // the shell exited between the client's measurement and this call
  }
}

export function closeSession(terminalId: string): void {
  const session = sessions.get(terminalId);
  if (!session) return;
  sessions.delete(terminalId);
  try {
    session.term.kill();
  } catch {
    // already gone
  }
}

export function closeThread(threadId: string): void {
  for (const terminalId of listSessions(threadId)) closeSession(terminalId);
}
