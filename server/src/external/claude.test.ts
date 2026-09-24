import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeReader } from "./claude.ts";

const s1Lines = [
  { type: "permission-mode", permissionMode: "default" },
  { type: "user", isMeta: true, cwd: "/tmp/a", sessionId: "s1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "<local-command-caveat>caveat</local-command-caveat>" } },
  { type: "user", cwd: "/tmp/a", sessionId: "s1", isSidechain: false, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "fix the build\nplease" } },
  { type: "assistant", cwd: "/tmp/a", sessionId: "s1", isSidechain: false, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
  { type: "user", cwd: "/tmp/a", sessionId: "s1", isSidechain: false, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }], is_error: false }] } },
  { type: "assistant", cwd: "/tmp/a", sessionId: "s1", isSidechain: false, timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
  { type: "ai-title", aiTitle: "Build fix" },
];

function s1Text(withTitle = true): string {
  const lines = withTitle ? s1Lines : s1Lines.filter((l) => l.type !== "ai-title");
  return lines.map((l) => JSON.stringify(l)).join("\n") + '\n{"type":"user",';
}

async function fixture(withTitle = true): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-claude-"));
  await fs.mkdir(path.join(root, "-tmp-a", "s1", "subagents"), { recursive: true });
  await fs.writeFile(path.join(root, "-tmp-a", "s1.jsonl"), s1Text(withTitle));
  await fs.writeFile(path.join(root, "-tmp-a", "s2.jsonl"), JSON.stringify({ type: "permission-mode", permissionMode: "default" }) + "\n");
  await fs.writeFile(path.join(root, "-tmp-a", "s1", "subagents", "x.jsonl"), JSON.stringify(s1Lines[2]) + "\n");
  return root;
}

test("scan lists the one real session", async () => {
  const root = await fixture();
  const source = path.join(root, "-tmp-a", "s1.jsonl");
  const sessions = await claudeReader(root).scan(() => false);
  const st = await fs.stat(source);
  assert.deepEqual(sessions, [{
    providerId: "claude", sessionId: "s1", cwd: "/tmp/a", title: "Build fix",
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"), updatedAt: Math.floor(st.mtimeMs), source,
  }]);
});

test("scan skips known sessions", async () => {
  const root = await fixture();
  assert.deepEqual(await claudeReader(root).scan((id) => id === "s1"), []);
});

test("read projects user, assistant and tool rows", async () => {
  const root = await fixture();
  const rows = await claudeReader(root).read(path.join(root, "-tmp-a", "s1.jsonl"));
  assert.deepEqual(rows, [
    { role: "user", text: "fix the build\nplease", meta: null },
    { role: "assistant", text: "Looking.", meta: null },
    { role: "tool", text: "", meta: { toolName: "Bash", toolUseId: "t1", input: { command: "ls" }, result: "a.txt", isError: false } },
    { role: "assistant", text: "Done.", meta: null },
  ]);
});

test("title falls back to the first prompt line", async () => {
  const root = await fixture(false);
  const [s] = await claudeReader(root).scan(() => false);
  assert.equal(s.title, "fix the build");
});

test("read rejects a missing file with ENOENT", async () => {
  const root = await fixture();
  await assert.rejects(claudeReader(root).read(path.join(root, "nope.jsonl")), { code: "ENOENT" });
});

test("scan handles 1,000 sessions in under 3 s", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-claude-"));
  const text = s1Text();
  for (let d = 0; d < 20; d++) await fs.mkdir(path.join(root, `-tmp-p${d}`));
  await Promise.all(Array.from({ length: 1000 }, (_, i) => fs.writeFile(path.join(root, `-tmp-p${i % 20}`, `p${i}.jsonl`), text)));
  const start = performance.now();
  const sessions = await claudeReader(root).scan(() => false);
  const ms = performance.now() - start;
  console.log(`scanned ${sessions.length} sessions in ${ms.toFixed(0)} ms`);
  assert.equal(sessions.length, 1000);
  assert.ok(ms < 3000, `took ${ms} ms`);
});
