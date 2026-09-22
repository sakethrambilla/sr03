// Timing tests for the filesystem watcher. The coalescer's window is what fixes the stale tree,
// so it is driven by an injected clock and scheduler rather than by sleeping.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { subscribe } from "./bus.ts";
import type { ServerEvent } from "./types.ts";
import {
  createCoalescer,
  releaseAllUnder,
  shouldIgnoreWatchPath,
  watchThread,
  WATCH_MAX_WAIT_MS,
  WATCH_TRAILING_MS,
  type WatchFactory,
  type WatchHandle,
} from "./watch.ts";

// a scheduler whose time only moves when a test moves it
function fakeClock() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number): unknown => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (timer: unknown): void => {
      pending.delete(timer as number);
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let due: { id: number; at: number; fn: () => void } | null = null;
        for (const [id, entry] of pending) {
          if (entry.at <= target && (!due || entry.at < due.at)) due = { id, ...entry };
        }
        if (!due) break;
        pending.delete(due.id);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

test("a lone signal emits once at the trailing window and not before", () => {
  const clock = fakeClock();
  let emits = 0;
  const coalescer = createCoalescer(() => emits++, { ...clock });

  coalescer.signal();
  clock.advance(WATCH_TRAILING_MS - 1);
  assert.equal(emits, 0);
  clock.advance(1);
  assert.equal(emits, 1);
  clock.advance(10_000);
  assert.equal(emits, 1);
});

test("after an emit the window resets for the next lone signal", () => {
  const clock = fakeClock();
  let emits = 0;
  const coalescer = createCoalescer(() => emits++, { ...clock });

  coalescer.signal();
  clock.advance(WATCH_TRAILING_MS);
  assert.equal(emits, 1);

  coalescer.signal();
  clock.advance(WATCH_TRAILING_MS - 1);
  assert.equal(emits, 1);
  clock.advance(1);
  assert.equal(emits, 2);
});

test("a later signal re-arms the trailing window", () => {
  const clock = fakeClock();
  let emits = 0;
  const coalescer = createCoalescer(() => emits++, { ...clock });

  coalescer.signal();
  clock.advance(100);
  coalescer.signal();
  clock.advance(100);
  assert.equal(emits, 0);
  clock.advance(50);
  assert.equal(emits, 1);
});

test("a continuous stream emits at the max-wait ceiling and never more often", () => {
  const clock = fakeClock();
  const emittedAt: number[] = [];
  const coalescer = createCoalescer(() => emittedAt.push(clock.now()), { ...clock });

  for (let i = 0; i < 20; i++) {
    coalescer.signal();
    clock.advance(100);
  }
  clock.advance(WATCH_TRAILING_MS);

  assert.ok(emittedAt.length >= 3, `expected repeated emits, got ${emittedAt.length}`);
  for (let i = 1; i < emittedAt.length; i++) {
    const gap = emittedAt[i]! - emittedAt[i - 1]!;
    assert.ok(gap >= WATCH_TRAILING_MS, `gap ${gap} below the trailing window`);
    assert.ok(gap <= WATCH_MAX_WAIT_MS, `gap ${gap} above the max-wait ceiling`);
  }
});

test("dispose drops a pending signal without emitting, and is safe twice", () => {
  const clock = fakeClock();
  let emits = 0;
  const coalescer = createCoalescer(() => emits++, { ...clock });

  coalescer.signal();
  clock.advance(WATCH_TRAILING_MS - 1);
  coalescer.dispose();
  coalescer.dispose();
  clock.advance(10_000);
  assert.equal(emits, 0);
});

test("only a leading .git segment is ignored", () => {
  assert.equal(shouldIgnoreWatchPath(".git/HEAD"), true);
  assert.equal(shouldIgnoreWatchPath(".git"), true);
  assert.equal(shouldIgnoreWatchPath("src/index.ts"), false);
  assert.equal(shouldIgnoreWatchPath("src/.gitignore"), false);
  // node_modules is deliberately NOT filtered: the file tree renders it
  assert.equal(shouldIgnoreWatchPath("node_modules/x/y.js"), false);
  assert.equal(shouldIgnoreWatchPath("a/node_modules_old/x"), false);
  assert.equal(shouldIgnoreWatchPath("a/.git/HEAD"), false);
});

function collect(threadId: string): { events: number; stop: () => void } {
  const state = { events: 0, stop: () => {} };
  state.stop = subscribe((event: ServerEvent) => {
    if (event.type === "fs.changed" && event.threadId === threadId) state.events++;
  });
  return state;
}

test("a factory that throws yields a release that does not throw", () => {
  const seen = collect("t-throw");
  const factory: WatchFactory = () => {
    throw new Error("EPERM");
  };
  const release = watchThread("t-throw", "/nowhere/throw", factory);
  release();
  release();
  assert.equal(seen.events, 0);
  seen.stop();
});

test("an error on the handle publishes one fs.changed and closes the watch", () => {
  const seen = collect("t-error");
  let closed = 0;
  const hook: { fail: ((error: Error) => void) | null } = { fail: null };
  const factory: WatchFactory = (): WatchHandle => ({
    close: () => closed++,
    on: (_event, listener) => {
      hook.fail = listener;
    },
  });

  const release = watchThread("t-error", "/nowhere/error", factory);
  assert.ok(hook.fail, "the watcher subscribed to error");
  hook.fail(new Error("boom"));
  assert.equal(seen.events, 1);
  assert.equal(closed, 1);
  release();
  seen.stop();
});

test("a null filename still signals", () => {
  const clock = fakeClock();
  const seen = collect("t-null");
  let onChange: ((eventType: string, filename: string | null) => void) | null = null;
  const factory: WatchFactory = (_dir, handler): WatchHandle => {
    onChange = handler;
    return { close: () => {}, on: () => {} };
  };

  const release = watchThread("t-null", "/nowhere/null", factory, { ...clock });
  onChange!("rename", null);
  clock.advance(WATCH_TRAILING_MS);
  assert.equal(seen.events, 1);
  release();
  seen.stop();
});

test("an ignored path does not signal", () => {
  const clock = fakeClock();
  const seen = collect("t-ignored");
  let onChange: ((eventType: string, filename: string | null) => void) | null = null;
  const factory: WatchFactory = (_dir, handler): WatchHandle => {
    onChange = handler;
    return { close: () => {}, on: () => {} };
  };

  const release = watchThread("t-ignored", "/nowhere/ignored", factory, { ...clock });
  onChange!("change", path.join(".git", "HEAD"));
  clock.advance(10_000);
  assert.equal(seen.events, 0);
  release();
  seen.stop();
});

test("the watch is refcounted and its release is idempotent", () => {
  let created = 0;
  let closed = 0;
  const factory: WatchFactory = (): WatchHandle => {
    created++;
    return { close: () => closed++, on: () => {} };
  };

  const first = watchThread("t-ref", "/nowhere/ref", factory);
  const second = watchThread("t-ref", "/nowhere/ref", factory);
  assert.equal(created, 1);

  first();
  first();
  assert.equal(closed, 0);
  second();
  assert.equal(closed, 1);
});

test("releaseAllUnder closes every watch at or under a directory", () => {
  let closed = 0;
  const factory: WatchFactory = (): WatchHandle => ({ close: () => closed++, on: () => {} });
  const root = path.join(os.tmpdir(), "sr03-under");

  const inside = watchThread("t-under-a", path.join(root, "wt-a"), factory);
  const at = watchThread("t-under-b", root, factory);
  const outside = watchThread("t-under-c", path.join(os.tmpdir(), "sr03-elsewhere"), factory);

  releaseAllUnder(root);
  assert.equal(closed, 2);

  // the stale releases must be harmless after a force-close
  inside();
  at();
  assert.equal(closed, 2);
  outside();
  assert.equal(closed, 3);
});

// The only test here that depends on the platform's recursive fs.watch support.
test("a real write reaches the bus", async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sr03-watch-"));
  const arrived = new Promise<void>((resolve) => {
    const stop = subscribe((event: ServerEvent) => {
      if (event.type === "fs.changed" && event.threadId === "t-real") {
        stop();
        resolve();
      }
    });
  });

  const release = watchThread("t-real", dir);
  // FSEvents arms the recursive watch asynchronously, so a single write can land before it is
  // live. Keep writing until the event arrives rather than racing the platform once.
  let writing = true;
  const writes = (async () => {
    for (let attempt = 0; writing && attempt < 40; attempt++) {
      await fs.promises.writeFile(path.join(dir, `created-${attempt}.txt`), "hello");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  try {
    await Promise.race([
      arrived,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("no fs.changed within 5s")), 5000),
      ),
    ]);
  } finally {
    writing = false;
    await writes;
    release();
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
