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
// a burst of output is sent as one frame per this many milliseconds instead of one per read
const FLUSH_MS = 8;

interface Session {
  threadId: string;
  term: IPty;
  // the tail of what the shell printed, kept as the chunks it arrived in so a busy shell
  // never copies the whole scrollback per read
  chunks: string[];
  size: number;
  pending: string;
  flush: NodeJS.Timeout | null;
}

function flush(terminalId: string, session: Session): void {
  session.flush = null;
  const data = session.pending;
  session.pending = "";
  if (data) publish({ type: "pty.data", threadId: session.threadId, terminalId, data });
}

// keyed by terminal id; a thread can hold several, and Map keeps them in creation order
const sessions = new Map<string, Session>();
let helperChecked = false;

export function listSessions(threadId: string): string[] {
  return [...sessions.entries()]
    .filter(([, session]) => session.threadId === threadId)
    .map(([id]) => id);
}

// the metrics sampler places a shell's cost on its thread; node-pty is the one child whose pid
// we are handed outright
export function sessionPids(): Array<{ pid: number; threadId: string }> {
  return [...sessions.values()].map((session) => ({ pid: session.term.pid, threadId: session.threadId }));
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
  const session: Session = { threadId, term, chunks: [], size: 0, pending: "", flush: null };
  sessions.set(terminalId, session);

  term.onData((data) => {
    session.chunks.push(data);
    session.size += data.length;
    while (session.size > SCROLLBACK_LIMIT && session.chunks.length > 1) {
      session.size -= session.chunks.shift()!.length;
    }
    session.pending += data;
    session.flush ??= setTimeout(() => flush(terminalId, session), FLUSH_MS);
  });
  term.onExit(({ exitCode }) => {
    if (session.flush) clearTimeout(session.flush);
    flush(terminalId, session);
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
  return { data: session.chunks.join("").slice(-SCROLLBACK_LIMIT) };
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
