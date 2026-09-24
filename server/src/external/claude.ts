import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseLines, readHead, readTail, titleFrom, type ExternalReader, type ExternalSession, type ImportedMessage } from "./types.ts";

type Line = Record<string, unknown>;
type Part = Record<string, unknown>;

function content(line: Line): unknown {
  return (line.message as { content?: unknown } | undefined)?.content;
}

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((p: Part) => p?.type === "text" && typeof p.text === "string").map((p: Part) => p.text).join("\n");
}

function isRealText(text: string): boolean {
  const t = text.trim();
  return t !== "" && !t.startsWith("<");
}

function skipped(line: Line): boolean {
  return line.isMeta === true || line.isSidechain === true;
}

function promptOf(line: Line): string | null {
  if (line.type !== "user" || skipped(line)) return null;
  const text = textOf(content(line));
  return isRealText(text) ? text : null;
}

async function scanFile(file: string, sessionId: string): Promise<ExternalSession | null> {
  const st = await fs.stat(file);
  const lines = parseLines(await readHead(file, 65536));
  const cwd = lines.find((l) => typeof l.cwd === "string")?.cwd as string | undefined;
  let prompt: string | null = null;
  for (const l of lines) if ((prompt = promptOf(l))) break;
  if (!cwd || !prompt) return null;
  const stamped = lines.find((l) => typeof l.timestamp === "string")?.timestamp as string | undefined;
  const parsed = stamped ? Date.parse(stamped) : NaN;
  let title = "";
  for (const l of parseLines(await readTail(file, 65536))) if (typeof l.aiTitle === "string" && l.aiTitle) title = l.aiTitle;
  return {
    providerId: "claude",
    sessionId,
    cwd,
    title: title || titleFrom(prompt),
    createdAt: Number.isNaN(parsed) ? Math.floor(st.birthtimeMs) : parsed,
    updatedAt: Math.floor(st.mtimeMs),
    source: file,
  };
}

export function claudeReader(root = path.join(os.homedir(), ".claude", "projects")): ExternalReader {
  return {
    providerId: "claude",

    async scan(isKnown) {
      let dirs;
      try {
        dirs = await fs.readdir(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const files: Array<{ file: string; sessionId: string }> = [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const dir = path.join(root, d.name);
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
          const sessionId = e.name.slice(0, -".jsonl".length);
          if (!isKnown(sessionId)) files.push({ file: path.join(dir, e.name), sessionId });
        }
      }
      const out: ExternalSession[] = [];
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          const { file, sessionId } = files[next++];
          try {
            const s = await scanFile(file, sessionId);
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
        if (skipped(line)) continue;
        const c = content(line);
        if (line.type === "user") {
          const text = textOf(c);
          if (isRealText(text)) out.push({ role: "user", text, meta: null });
          if (!Array.isArray(c)) continue;
          for (const p of c as Part[]) {
            if (p?.type !== "tool_result") continue;
            const tool = tools.get(p.tool_use_id as string);
            if (!tool?.meta) continue;
            tool.meta.result = textOf(p.content);
            tool.meta.isError = Boolean(p.is_error);
          }
        } else if (line.type === "assistant") {
          if (typeof c === "string") {
            if (c.trim()) out.push({ role: "assistant", text: c, meta: null });
            continue;
          }
          if (!Array.isArray(c)) continue;
          for (const p of c as Part[]) {
            if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
              out.push({ role: "assistant", text: p.text, meta: null });
            } else if (p?.type === "tool_use") {
              const msg: ImportedMessage = { role: "tool", text: "", meta: { toolName: p.name, toolUseId: p.id, input: p.input } };
              tools.set(p.id as string, msg);
              out.push(msg);
            }
          }
        }
      }
      return out;
    },
  };
}
