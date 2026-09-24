import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseLines, readHead, titleFrom, type ExternalReader, type ExternalSession, type ImportedMessage } from "./types.ts";

type Line = Record<string, unknown>;
type Part = Record<string, unknown>;

function isRealPrompt(text: string): boolean {
  const t = text.trim();
  return t !== "" && !t.startsWith("<") && !t.startsWith("# AGENTS.md");
}

function userText(payload: Line): string | null {
  if (payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return null;
  const parts = (payload.content as Part[])
    .filter((p) => typeof p?.text === "string" && isRealPrompt(p.text as string))
    .map((p) => (p.text as string).trim());
  return parts.length ? parts.join("\n") : null;
}

function assistantText(payload: Line): string {
  if (!Array.isArray(payload.content)) return "";
  return (payload.content as Part[]).filter((p) => p?.type === "output_text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

function outputText(output: unknown): string {
  if (typeof output !== "string") return "";
  try {
    const v = JSON.parse(output);
    if (Array.isArray(v) && v.length && v.every((p) => p && typeof p === "object" && typeof p.text === "string")) {
      return v.map((p) => p.text).join("\n");
    }
  } catch {}
  return output;
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

async function readIndex(file: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return names;
  }
  for (const l of parseLines(text)) {
    if (typeof l.id === "string" && typeof l.thread_name === "string" && l.thread_name) names.set(l.id, l.thread_name);
  }
  return names;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

async function rolloutFiles(sessions: string): Promise<string[]> {
  const files: string[] = [];
  for (const y of await listDir(sessions)) {
    for (const m of await listDir(y)) {
      for (const d of await listDir(m)) {
        let entries;
        try {
          entries = await fs.readdir(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) if (e.isFile() && e.name.endsWith(".jsonl")) files.push(path.join(d, e.name));
      }
    }
  }
  return files;
}

async function scanFile(file: string, names: Map<string, string>, isKnown: (id: string) => boolean): Promise<ExternalSession | null> {
  const lines = parseLines(await readHead(file, 65536));
  const first = lines[0];
  if (first?.type !== "session_meta") return null;
  const meta = first.payload as Line | undefined;
  if (!meta || typeof meta.id !== "string" || typeof meta.cwd !== "string") return null;
  if (meta.originator === "sr03" || isKnown(meta.id)) return null;
  let prompt: string | null = null;
  for (const l of lines) {
    if (l.type === "response_item" && (prompt = userText(l.payload as Line))) break;
  }
  if (!prompt) return null;
  const st = await fs.stat(file);
  return {
    providerId: "codex",
    sessionId: meta.id,
    cwd: meta.cwd,
    title: names.get(meta.id) || titleFrom(prompt),
    createdAt: Date.parse(meta.timestamp as string),
    updatedAt: Math.floor(st.mtimeMs),
    source: file,
  };
}

export function codexReader(root = path.join(os.homedir(), ".codex")): ExternalReader {
  return {
    providerId: "codex",

    async scan(isKnown) {
      const names = await readIndex(path.join(root, "session_index.jsonl"));
      const files = await rolloutFiles(path.join(root, "sessions"));
      const out: ExternalSession[] = [];
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const file = files[next++];
          try {
            const s = await scanFile(file, names, isKnown);
            if (s) out.push(s);
          } catch {}
        }
      };
      await Promise.all(Array.from({ length: 16 }, worker));
      return out;
    },

    async read(source) {
      const out: ImportedMessage[] = [];
      const tools = new Map<string, ImportedMessage>();
      for (const line of parseLines(await fs.readFile(source, "utf8"))) {
        if (line.type !== "response_item") continue;
        const p = line.payload as Line | undefined;
        if (!p) continue;
        if (p.type === "message") {
          if (p.role === "user") {
            const text = userText(p);
            if (text) out.push({ role: "user", text, meta: null });
          } else if (p.role === "assistant") {
            const text = assistantText(p);
            if (text.trim()) out.push({ role: "assistant", text, meta: null });
          }
        } else if (p.type === "function_call" || p.type === "custom_tool_call") {
          const input = p.type === "function_call" ? parseArgs(p.arguments) : p.input;
          const msg: ImportedMessage = { role: "tool", text: "", meta: { toolName: p.name, toolUseId: p.call_id, input } };
          tools.set(p.call_id as string, msg);
          out.push(msg);
        } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
          const tool = tools.get(p.call_id as string);
          if (!tool?.meta) continue;
          tool.meta.result = outputText(p.output);
          tool.meta.isError = false;
        }
      }
      return out;
    },
  };
}
