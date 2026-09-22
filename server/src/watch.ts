// A recursive filesystem watch per thread, coalesced into one fs.changed on the bus. Refcounted
// like metrics.ts's meter: it runs only while a client is looking.
import fs from "node:fs";
import path from "node:path";

import { publish } from "./bus.ts";

export const WATCH_TRAILING_MS = 150;
export const WATCH_MAX_WAIT_MS = 500;

export interface Coalescer {
  signal(): void;
  dispose(): void;
}

export interface CoalescerOptions {
  trailingMs?: number;
  maxWaitMs?: number;
  // an opaque handle, not NodeJS.Timeout — a fake scheduler returns its own
  schedule?: (fn: () => void, ms: number) => unknown;
  clear?: (timer: unknown) => void;
  now?: () => number;
}

// A trailing window that re-arms on every signal but never fires later than
// firstSignalAt + maxWaitMs, so a continuous stream still emits at the ceiling.
export function createCoalescer(emit: () => void, options?: CoalescerOptions): Coalescer {
  const trailingMs = options?.trailingMs ?? WATCH_TRAILING_MS;
  const maxWaitMs = options?.maxWaitMs ?? WATCH_MAX_WAIT_MS;
  const schedule = options?.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = options?.clear ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const now = options?.now ?? (() => Date.now());

  let timer: unknown = null;
  let firstSignalAt = 0;

  const fire = (): void => {
    timer = null;
    firstSignalAt = 0;
    emit();
  };

  const arm = (): void => {
    const elapsed = now() - firstSignalAt;
    const delay = Math.max(Math.min(trailingMs, maxWaitMs - elapsed), 0);
    timer = schedule(fire, delay);
  };

  return {
    signal(): void {
      if (timer === null) {
        firstSignalAt = now();
      } else {
        clear(timer);
      }
      arm();
    },
    dispose(): void {
      if (timer !== null) clear(timer);
      timer = null;
      firstSignalAt = 0;
    },
  };
}

// mirrors fsbrowse.ts's TREE_SKIP, which is not exported; node_modules is absent there on purpose,
// since the tree renders it and dropping its events would under-signal a visible directory
const WATCH_SKIP = new Set([".git"]);

/** True for paths no consumer wants to hear about. `rel` is relative to the session root. */
export function shouldIgnoreWatchPath(rel: string): boolean {
  const first = rel.split(/[\\/]/, 1)[0];
  return first !== undefined && WATCH_SKIP.has(first);
}

export interface WatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export type WatchFactory = (
  dir: string,
  onChange: (eventType: string, filename: string | null) => void,
) => WatchHandle;

const defaultFactory: WatchFactory = (dir, onChange) =>
  fs.watch(dir, { recursive: true, persistent: false }, onChange);

interface Entry {
  cwd: string;
  refs: number;
  handle: WatchHandle | null;
  coalescer: Coalescer | null;
}

const entries = new Map<string, Entry>();
// one log per thread, not per failed attempt — a broken watch must not spam or retry
const logged = new Set<string>();
const noop = (): void => {};

function teardown(threadId: string): void {
  const entry = entries.get(threadId);
  if (!entry) return;
  entries.delete(threadId);
  entry.coalescer?.dispose();
  try {
    entry.handle?.close();
  } catch (error) {
    console.error("[watch] close failed", (error as Error).message);
  }
}

/** Refcounted recursive watch on one thread's cwd. Returns an idempotent release. */
export function watchThread(
  threadId: string,
  cwd: string,
  factory?: WatchFactory,
  options?: CoalescerOptions,
): () => void {
  const existing = entries.get(threadId);
  if (existing) {
    existing.refs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = entries.get(threadId);
      if (!entry) return;
      entry.refs -= 1;
      if (entry.refs <= 0) teardown(threadId);
    };
  }

  const entry: Entry = { cwd: path.resolve(cwd), refs: 1, handle: null, coalescer: null };
  entry.coalescer = createCoalescer(() => publish({ type: "fs.changed", threadId }), options);

  try {
    entry.handle = (factory ?? defaultFactory)(cwd, (_eventType, filename) => {
      // a null filename means "something changed, path unknown" — signal rather than under-signal
      if (filename !== null && shouldIgnoreWatchPath(filename)) return;
      entries.get(threadId)?.coalescer?.signal();
    });
  } catch (error) {
    entry.coalescer.dispose();
    if (!logged.has(threadId)) {
      logged.add(threadId);
      console.error("[watch] cannot watch", cwd, (error as Error).message);
    }
    return noop;
  }

  entry.handle.on("error", (error: Error) => {
    console.error("[watch] error", cwd, error.message);
    teardown(threadId);
    // one spurious refresh is cheap; a missed one is not, so this bypasses the coalescer
    publish({ type: "fs.changed", threadId });
  });

  entries.set(threadId, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = entries.get(threadId);
    if (!current) return;
    current.refs -= 1;
    if (current.refs <= 0) teardown(threadId);
  };
}

/** Force-close every watch at or under `cwd`, ignoring refcounts. For worktree removal. */
export function releaseAllUnder(cwd: string): void {
  const base = path.resolve(cwd);
  for (const [threadId, entry] of [...entries]) {
    if (entry.cwd === base || entry.cwd.startsWith(base + path.sep)) teardown(threadId);
  }
}
