import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexReader } from "./codex.ts";

const T = "2026-01-02T00:00:00.000Z";
const item = (payload: unknown) => ({ timestamp: T, type: "response_item", payload });

const aLines = [
  { timestamp: T, type: "session_meta", payload: { id: "c1", cwd: "/tmp/c", originator: "codex_cli_rs", timestamp: T } },
  item({ type: "message", role: "developer", content: [{ type: "input_text", text: "be helpful" }] }),
  item({ type: "message", role: "user", content: [
    { type: "input_text", text: "<environment_context>cwd</environment_context>" },
    { type: "input_text", text: "# AGENTS.md instructions for /tmp/c" },
    { type: "input_text", text: "rename the file" },
  ] }),
  item({ type: "function_call", name: "shell", arguments: '{"cmd":"ls"}', call_id: "k1" }),
  item({ type: "function_call_output", call_id: "k1", output: '[{"type":"input_text","text":"a.txt"}]' }),
  item({ type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch", call_id: "k2" }),
  item({ type: "custom_tool_call_output", call_id: "k2", output: "ok" }),
  item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Renamed." }] }),
];

const bLines = [
  { timestamp: T, type: "session_meta", payload: { id: "c2", cwd: "/tmp/c", originator: "sr03", timestamp: T } },
  item({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }),
];

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n");

async function fixture(withIndex = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-codex-"));
  const day = path.join(root, "sessions", "2026", "01", "02");
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, "rollout-a.jsonl"), jsonl(aLines) + '\n{"timestamp":"' + T + '","type":');
  await fs.writeFile(path.join(day, "rollout-b.jsonl"), jsonl(bLines) + "\n");
  if (withIndex) {
    await fs.writeFile(path.join(root, "session_index.jsonl"), jsonl([
      { id: "c1", thread_name: "Old", updated_at: T },
      { id: "c1", thread_name: "Rename file", updated_at: T },
    ]) + "\n");
  }
  return root;
}

const sourceOf = (root: string) => path.join(root, "sessions", "2026", "01", "02", "rollout-a.jsonl");

test("scan lists the non-sr03 session with its index title", async () => {
  const root = await fixture();
  const source = sourceOf(root);
  const st = await fs.stat(source);
  assert.deepEqual(await codexReader(root).scan(() => false), [{
    providerId: "codex", sessionId: "c1", cwd: "/tmp/c", title: "Rename file",
    createdAt: Date.parse(T), updatedAt: Math.floor(st.mtimeMs), source,
  }]);
});

test("scan falls back to the prompt without an index", async () => {
  const root = await fixture(false);
  const sessions = await codexReader(root).scan(() => false);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "rename the file");
});

test("scan skips known sessions", async () => {
  const root = await fixture();
  assert.deepEqual(await codexReader(root).scan((id) => id === "c1"), []);
});

test("read yields user, tool and assistant rows in order", async () => {
  const root = await fixture();
  assert.deepEqual(await codexReader(root).read(sourceOf(root)), [
    { role: "user", text: "rename the file", meta: null },
    { role: "tool", text: "", meta: { toolName: "shell", toolUseId: "k1", input: { cmd: "ls" }, result: "a.txt", isError: false } },
    { role: "tool", text: "", meta: { toolName: "apply_patch", toolUseId: "k2", input: "*** Begin Patch", result: "ok", isError: false } },
    { role: "assistant", text: "Renamed.", meta: null },
  ]);
});

test("scan of a missing root is empty", async () => {
  assert.deepEqual(await codexReader(path.join(os.tmpdir(), "sr03-codex-missing-" + Date.now())).scan(() => false), []);
});

test("scan finds a prompt that sits past the first 64K", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-codex-"));
  const day = path.join(root, "sessions", "2026", "01", "02");
  await fs.mkdir(day, { recursive: true });
  const padding = item({ type: "message", role: "user", content: [{ type: "input_text", text: `<recommended_plugins>${"x".repeat(100_000)}</recommended_plugins>` }] });
  await fs.writeFile(path.join(day, "rollout-a.jsonl"), jsonl([aLines[0], padding, ...aLines.slice(1)]) + "\n");
  const sessions = await codexReader(root).scan(() => false);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "rename the file");
});
