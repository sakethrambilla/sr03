import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { titleFrom, type ExternalReader, type ExternalSession, type ImportedMessage } from "./types.ts";

type Meta = { agentId: string; latestRootBlobId: string; name?: string; createdAt: number; subagentInfo?: unknown };
type Message = { role: string; content: unknown };
type Part = Record<string, unknown>;

// even a readOnly open writes the store's -shm, so the store and its WAL are read from a copy
async function openChat<T>(file: string, fn: (db: DatabaseSync, meta: Meta) => T): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-"));
  try {
    const copy = path.join(dir, "store.db");
    await fs.copyFile(file, copy);
    await fs.copyFile(file + "-wal", copy + "-wal").catch(() => {});
    const db = new DatabaseSync(copy);
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as { value: string } | undefined;
      if (!row) throw new Error("no meta");
      return fn(db, JSON.parse(Buffer.from(row.value, "hex").toString("utf8")));
    } finally {
      db.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function varint(buf: Uint8Array, at: number): [number, number] {
  let value = 0;
  let scale = 1;
  while (at < buf.length) {
    const b = buf[at++];
    value += (b & 0x7f) * scale;
    if (!(b & 0x80)) return [value, at];
    scale *= 128;
  }
  throw new Error("truncated varint");
}

function rootIds(buf: Uint8Array): string[] {
  const ids: string[] = [];
  let at = 0;
  while (at < buf.length) {
    const [key, next] = varint(buf, at);
    at = next;
    const wire = key & 7;
    if (wire === 0) at = varint(buf, at)[1];
    else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else if (wire === 2) {
      const [len, start] = varint(buf, at);
      at = start + len;
      if (key >>> 3 === 1 && len === 32) ids.push(Buffer.from(buf.subarray(start, at)).toString("hex"));
    } else throw new Error(`wire type ${wire}`);
  }
  return ids;
}

function loadMessages(db: DatabaseSync, meta: Meta): Message[] {
  const get = db.prepare("SELECT data FROM blobs WHERE id = ?");
  const root = get.get(meta.latestRootBlobId) as { data: Uint8Array } | undefined;
  if (!root) return [];
  const out: Message[] = [];
  for (const id of rootIds(root.data)) {
    const row = get.get(id) as { data: Uint8Array } | undefined;
    if (!row) continue;
    try {
      const m = JSON.parse(Buffer.from(row.data).toString("utf8"));
      if (m && typeof m.role === "string") out.push(m);
    } catch {}
  }
  return out;
}

function rawText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Part[]).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

function userText(content: unknown): string {
  const raw = rawText(content);
  const query = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (query) return query[1].trim();
  return raw.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/g, "").trim();
}

async function storeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  let hashes;
  try {
    hashes = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const h of hashes) {
    if (!h.isDirectory()) continue;
    let agents;
    try {
      agents = await fs.readdir(path.join(root, h.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const a of agents) if (a.isDirectory()) files.push(path.join(root, h.name, a.name, "store.db"));
  }
  return files;
}

async function mtime(file: string): Promise<number> {
  try {
    return Math.floor((await fs.stat(file + "-wal")).mtimeMs);
  } catch {
    return Math.floor((await fs.stat(file)).mtimeMs);
  }
}

async function scanFile(file: string, isKnown: (id: string) => boolean): Promise<ExternalSession | null> {
  await fs.access(file);
  const found = await openChat(file, (db, meta) => {
    if (meta.subagentInfo || isKnown(meta.agentId)) return null;
    let cwd: string | null = null;
    let prompt: string | null = null;
    for (const m of loadMessages(db, meta)) {
      if (m.role !== "user") continue;
      cwd ??= rawText(m.content).match(/^Workspace Path: (.+)$/m)?.[1] ?? null;
      prompt ||= userText(m.content) || null;
      if (cwd && prompt) break;
    }
    return cwd && prompt ? { meta, cwd, prompt } : null;
  });
  if (!found) return null;
  const { meta, cwd, prompt } = found;
  return {
    providerId: "cursor",
    sessionId: meta.agentId,
    cwd,
    title: meta.name && meta.name !== "New Agent" ? meta.name : titleFrom(prompt),
    createdAt: meta.createdAt,
    source: file,
    updatedAt: await mtime(file),
  };
}

export function cursorReader(root = path.join(os.homedir(), ".cursor", "chats")): ExternalReader {
  return {
    providerId: "cursor",

    async scan(isKnown) {
      const files = await storeFiles(root);
      const out: ExternalSession[] = [];
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const file = files[next++];
          try {
            const s = await scanFile(file, isKnown);
            if (s) out.push(s);
          } catch {}
        }
      };
      await Promise.all(Array.from({ length: 16 }, worker));
      return out;
    },

    async read(source) {
      await fs.access(source);
      return openChat(source, (db, meta) => {
        const out: ImportedMessage[] = [];
        const tools = new Map<string, ImportedMessage>();
        for (const m of loadMessages(db, meta)) {
          if (m.role === "user") {
            const text = userText(m.content);
            if (text) out.push({ role: "user", text, meta: null });
          } else if (m.role === "assistant") {
            if (typeof m.content === "string") {
              if (m.content.trim()) out.push({ role: "assistant", text: m.content, meta: null });
              continue;
            }
            if (!Array.isArray(m.content)) continue;
            for (const p of m.content as Part[]) {
              if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
                out.push({ role: "assistant", text: p.text, meta: null });
              } else if (p?.type === "tool-call") {
                const msg: ImportedMessage = { role: "tool", text: "", meta: { toolName: p.toolName, toolUseId: p.toolCallId, input: p.args } };
                tools.set(p.toolCallId as string, msg);
                out.push(msg);
              }
            }
          } else if (m.role === "tool" && Array.isArray(m.content)) {
            for (const p of m.content as Part[]) {
              if (p?.type !== "tool-result") continue;
              const tool = tools.get(p.toolCallId as string);
              if (!tool?.meta) continue;
              tool.meta.result = typeof p.result === "string" ? p.result : JSON.stringify(p.result);
              tool.meta.isError = Boolean(p.isError);
            }
          }
        }
        return out;
      });
    },
  };
}
