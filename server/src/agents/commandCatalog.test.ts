import assert from "node:assert/strict";
import { test } from "node:test";

import { createCommandCatalog } from "./commandCatalog.ts";
import type { SlashCommand } from "../types.ts";

const a: SlashCommand = { name: "a", description: "a", argumentHint: "" };
const b: SlashCommand = { name: "b", description: "b", argumentHint: "" };
const c: SlashCommand = { name: "c", description: "c", argumentHint: "" };
const gone: SlashCommand = { name: "gone", description: "gone", argumentHint: "" };
const x: SlashCommand = { name: "x", description: "x", argumentHint: "" };
const y: SlashCommand = { name: "y", description: "y", argumentHint: "" };

function fakeStore(seed: Record<string, SlashCommand[]> = {}) {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(seed)) map.set(key, JSON.stringify(value));
  return {
    get(id: string) {
      const json = map.get(id);
      return json ? { json } : null;
    },
    set(id: string, json: string) {
      map.set(id, json);
    },
    map,
  };
}

function fakePublish() {
  const events: unknown[] = [];
  return { events, publish: (event: unknown) => events.push(event) };
}

test("refresh replaces the cache with live ∪ scanned, sorted, and publishes once", async () => {
  const store = fakeStore({ "claude:/tmp/repo": [a, gone] });
  const { events, publish } = fakePublish();
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [c],
    probe: async () => [a, b],
    store,
    publish,
  });
  await catalog.refresh("/tmp/repo");
  assert.deepEqual(JSON.parse(store.map.get("claude:/tmp/repo")!), [a, b, c]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "commands.updated",
    providerId: "claude",
    cwd: "/tmp/repo",
    commands: [a, b, c],
  });
});

test("an empty probe result keeps the previous cache and publishes nothing", async () => {
  const store = fakeStore({ "claude:/tmp/repo": [a] });
  const { events, publish } = fakePublish();
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [b],
    probe: async () => [],
    store,
    publish,
  });
  await catalog.refresh("/tmp/repo");
  assert.deepEqual(JSON.parse(store.map.get("claude:/tmp/repo")!), [a]);
  assert.equal(events.length, 0);
});

test("a rejected probe leaves the cache untouched, publishes nothing, and refresh resolves", async () => {
  const store = fakeStore({ "claude:/tmp/repo": [a] });
  const { events, publish } = fakePublish();
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [b],
    probe: async () => {
      throw new Error("boom");
    },
    store,
    publish,
  });
  await assert.doesNotReject(catalog.refresh("/tmp/repo"));
  assert.deepEqual(JSON.parse(store.map.get("claude:/tmp/repo")!), [a]);
  assert.equal(events.length, 0);
});

test("an unchanged merged list publishes nothing", async () => {
  const store = fakeStore({ "claude:/tmp/repo": [a, b] });
  const { events, publish } = fakePublish();
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [b],
    probe: async () => [a],
    store,
    publish,
  });
  await catalog.refresh("/tmp/repo");
  assert.equal(events.length, 0);
});

test("refresh is single-flight per cwd", async () => {
  let calls = 0;
  let resolveProbe!: (value: SlashCommand[]) => void;
  const probePromise = new Promise<SlashCommand[]>((resolve) => {
    resolveProbe = resolve;
  });
  const store = fakeStore();
  const { publish } = fakePublish();
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [],
    probe: async () => {
      calls += 1;
      return probePromise;
    },
    store,
    publish,
  });
  const first = catalog.refresh("/tmp/repo");
  const second = catalog.refresh("/tmp/repo");
  resolveProbe([a]);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("list returns the cached value without waiting on the probe", async () => {
  const store = fakeStore({ "claude:/tmp/repo": [a] });
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [],
    probe: () => new Promise<SlashCommand[]>(() => {}),
    store,
    publish: () => {},
  });
  const result = await catalog.list("/tmp/repo");
  assert.deepEqual(result, [a]);
});

test("list with no cache and a non-empty scan writes and returns the scanned list", async () => {
  const store = fakeStore();
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [x],
    probe: async () => [],
    store,
    publish: () => {},
  });
  const result = await catalog.list("/tmp/repo");
  assert.deepEqual(result, [x]);
  assert.deepEqual(JSON.parse(store.map.get("claude:/tmp/repo")!), [x]);
});

test("list with no cache and an empty scan awaits the refresh", async () => {
  const store = fakeStore();
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [],
    probe: async () => [y],
    store,
    publish: () => {},
  });
  const result = await catalog.list("/tmp/repo");
  assert.deepEqual(result, [y]);
});

test("remember writes the store directly and never publishes", () => {
  const store = fakeStore();
  const { events, publish } = fakePublish();
  const catalog = createCommandCatalog({
    providerId: "claude",
    scan: async () => [],
    probe: async () => [],
    store,
    publish,
  });
  catalog.remember("/tmp/repo", [a]);
  assert.deepEqual(JSON.parse(store.map.get("claude:/tmp/repo")!), [a]);
  assert.equal(events.length, 0);
});
