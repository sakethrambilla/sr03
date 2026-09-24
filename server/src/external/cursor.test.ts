import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cursorReader } from "./cursor.ts";

const messages = [
  { role: "system", content: "sys" },
  { role: "user", content: "<user_info>\nWorkspace Path: /tmp/cur\n</user_info>" },
  { role: "user", content: [{ type: "text", text: "<user_query>\nadd a test\n</user_query>" }] },
  { role: "assistant", content: [
    { type: "text", text: "Adding." },
    { type: "tool-call", toolCallId: "u1", toolName: "Write", args: { path: "a.test.ts" } },
  ] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "u1", result: "written" }] },
];

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

async function writeChat(file: string, meta: Record<string, unknown>) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);");
  const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
  const refs: Buffer[] = [];
  for (const m of messages) {
    const data = Buffer.from(JSON.stringify(m));
    const id = sha(data);
    insert.run(id, data);
    refs.push(Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex"));
  }
  const root = Buffer.concat(refs);
  const rootId = sha(root);
  insert.run(rootId, root);
  const value = Buffer.from(JSON.stringify({ agentId: path.basename(path.dirname(file)), latestRootBlobId: rootId, createdAt: 1700000000000, ...meta })).toString("hex");
  db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(value);
  db.close();
}

async function fixture(name = "New Agent"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-"));
  await writeChat(path.join(root, "h1", "agent-1", "store.db"), { name });
  await writeChat(path.join(root, "h1", "agent-2", "store.db"), { name, subagentInfo: { parentAgentId: "agent-1" } });
  return root;
}

const sourceOf = (root: string) => path.join(root, "h1", "agent-1", "store.db");

test("scan lists the top-level chat with its workspace cwd", async () => {
  const root = await fixture();
  const source = sourceOf(root);
  const st = await fs.stat(source);
  assert.deepEqual(await cursorReader(root).scan(() => false), [{
    providerId: "cursor", sessionId: "agent-1", cwd: "/tmp/cur", title: "add a test",
    createdAt: 1700000000000, source, updatedAt: Math.floor(st.mtimeMs),
  }]);
});

test("scan prefers a real chat name", async () => {
  const root = await fixture("Tests");
  const [s] = await cursorReader(root).scan(() => false);
  assert.equal(s.title, "Tests");
});

test("scan skips known sessions", async () => {
  const root = await fixture();
  assert.deepEqual(await cursorReader(root).scan((id) => id === "agent-1"), []);
});

test("read maps user, assistant and tool rows", async () => {
  const root = await fixture();
  assert.deepEqual(await cursorReader(root).read(sourceOf(root)), [
    { role: "user", text: "add a test", meta: null },
    { role: "assistant", text: "Adding.", meta: null },
    { role: "tool", text: "", meta: { toolName: "Write", toolUseId: "u1", input: { path: "a.test.ts" }, result: "written", isError: false } },
  ]);
});

test("scan and read leave the store untouched", async () => {
  const root = await fixture();
  const source = sourceOf(root);
  const before = (await fs.stat(source)).mtimeMs;
  const r = cursorReader(root);
  await r.scan(() => false);
  await r.read(source);
  assert.equal((await fs.stat(source)).mtimeMs, before);
});
