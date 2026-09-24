import fs from "node:fs/promises";
import type { ProviderId } from "../types.ts";

export interface ExternalSession {
  providerId: ProviderId;
  sessionId: string;
  cwd: string;
  title: string;
  /** epoch ms */
  createdAt: number;
  /** epoch ms, the source file's mtime */
  updatedAt: number;
  /** absolute path read again by read() */
  source: string;
}

export interface ImportedMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  meta: Record<string, unknown> | null;
}

export interface ExternalReader {
  providerId: ProviderId;
  scan(isKnown: (sessionId: string) => boolean): Promise<ExternalSession[]>;
  read(source: string): Promise<ImportedMessage[]>;
}

export function titleFrom(prompt: string): string {
  const line = prompt.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

async function readAt(file: string, position: number, bytes: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, position);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function readHead(file: string, bytes: number): Promise<string> {
  return readAt(file, 0, bytes);
}

export async function readTail(file: string, bytes: number): Promise<string> {
  const { size } = await fs.stat(file);
  return readAt(file, Math.max(0, size - bytes), bytes);
}

export function parseLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch {}
  }
  return out;
}
