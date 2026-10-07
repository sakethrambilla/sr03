// A recursive filesystem watch per thread, plus a narrow one on git's metadata so commits and
// checkouts refresh status, coalesced into one fs.changed on the bus. Refcounted like metrics.ts's
// meter: it runs only while a client is looking.
import fs from "node:fs";
import path from "node:path";

import { publish } from "./bus.ts";
import { gitDirs } from "./git.ts";

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

const GIT_META = /^(HEAD|index|packed-refs|ORIG_HEAD|MERGE_HEAD)(\.lock)?$/;

/** Whether an event from a git-dir watch ("git") or a refs watch ("refs") should refresh status. */
export function isGitMetaChange(dirKind: "git" | "refs", filename: string | null): boolean {
  if (dirKind === "refs" || filename === null) return true;
  return GIT_META.test(filename);
}

export interface WatchHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export type WatchFactory = (
  dir: string,
  onChange: (eventType: string, filename: string | null) => void,
  recursive?: boolean,
) => WatchHandle;

export type GitDirsResolver = (cwd: string) => Promise<{ gitDir: string; commonDir: string } | null>;

const defaultFactory: WatchFactory = (dir, onChange, recursive = true) =>
  fs.watch(dir, { recursive, persistent: false }, onChange);

interface Entry {
  cwd: string;
  refs: number;
  handle: WatchHandle | null;
  gitHandles: WatchHandle[];
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
  for (const handle of [entry.handle, ...entry.gitHandles]) {
    try {
      handle?.close();
    } catch (error) {
      console.error("[watch] close failed", (error as Error).message);
    }
  }
}

function logOnce(threadId: string, message: string): void {
  if (logged.has(threadId)) return;
  logged.add(threadId);
  console.error(message);
}

function watchGitDirs(
  threadId: string,
  entry: Entry,
  factory: WatchFactory,
  dirs: { gitDir: string; commonDir: string },
): void {
  const targets: Array<[string, "git" | "refs", boolean]> = [[dirs.gitDir, "git", false]];
  if (dirs.commonDir !== dirs.gitDir) targets.push([dirs.commonDir, "git", false]);
  targets.push([path.join(dirs.commonDir, "refs"), "refs", true]);
  for (const [dir, kind, recursive] of targets) {
    try {
      const handle = factory(
        dir,
        (_eventType, filename) => {
          if (isGitMetaChange(kind, filename)) entry.coalescer?.signal();
        },
        recursive,
      );
      handle.on("error", (error: Error) => logOnce(threadId, `[watch] git watch error ${dir} ${error.message}`));
      entry.gitHandles.push(handle);
    } catch (error) {
      logOnce(threadId, `[watch] cannot watch ${dir} ${(error as Error).message}`);
    }
  }
}

/**
 * Idempotent release bound to the Entry it was issued for. The identity check matters after
 * releaseAllUnder: it force-deletes an entry while refs are still held, and a later release
 * must not decrement a watch that was recreated for the same thread in the meantime.
 */
function releaseFor(threadId: string, owner: Entry): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (entries.get(threadId) !== owner) return;
    owner.refs -= 1;
    if (owner.refs <= 0) teardown(threadId);
  };
}

/** Refcounted recursive watch on one thread's cwd. Returns an idempotent release. */
export function watchThread(
  threadId: string,
  cwd: string,
  factory?: WatchFactory,
  options?: CoalescerOptions,
  resolveGitDirs?: GitDirsResolver,
): () => void {
  const existing = entries.get(threadId);
  if (existing) {
    existing.refs += 1;
    return releaseFor(threadId, existing);
  }

  const entry: Entry = {
    cwd: path.resolve(cwd),
    refs: 1,
    handle: null,
    gitHandles: [],
    coalescer: null,
  };
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
  void (resolveGitDirs ?? gitDirs)(cwd)
    .then((dirs) => {
      if (!dirs || entries.get(threadId) !== entry) return;
      watchGitDirs(threadId, entry, factory ?? defaultFactory, dirs);
    })
    .catch((error: Error) => logOnce(threadId, `[watch] cannot resolve git dirs ${cwd} ${error.message}`));
  return releaseFor(threadId, entry);
}

/** Force-close every watch at or under `cwd`, ignoring refcounts. For worktree removal. */
export function releaseAllUnder(cwd: string): void {
  const base = path.resolve(cwd);
  for (const [threadId, entry] of [...entries]) {
    if (entry.cwd === base || entry.cwd.startsWith(base + path.sep)) teardown(threadId);
  }
}
