import fs from "node:fs/promises";
import path from "node:path";
import { publish } from "../bus.ts";
import { knownSessions, messages, projects, threads } from "../db.ts";
import { repoInfo } from "../git.ts";
import { currentProvider, defaultEffortFor } from "../models.ts";
import { truncate } from "../agents/runtime.ts";
import type { ProviderId, Thread } from "../types.ts";
import { claudeReader } from "./claude.ts";
import { codexReader } from "./codex.ts";
import { cursorReader } from "./cursor.ts";
import type { ExternalReader, ExternalSession } from "./types.ts";

const LABELS: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

function defaultReaders(): ExternalReader[] {
  return [claudeReader(), codexReader(), cursorReader()];
}

let running: Promise<number> | null = null;

export function discover(readers: ExternalReader[] = defaultReaders()): Promise<number> {
  if (running) return running;
  running = run(readers).finally(() => {
    running = null;
  });
  return running;
}

async function run(readers: ExternalReader[]): Promise<number> {
  let added = 0;
  for (const reader of readers) {
    let found: ExternalSession[] = [];
    try {
      found = await reader.scan((id) => knownSessions.has(reader.providerId, id));
    } catch (error) {
      console.error(`[external] ${reader.providerId} scan failed: ${(error as Error).message}`);
    }
    for (const s of found) {
      try {
        if (knownSessions.has(s.providerId, s.sessionId)) continue;
        const resolved = path.resolve(s.cwd);
        // on macOS /tmp is a symlink to /private/tmp, and providers record either spelling
        const dir = await fs.realpath(resolved).catch(() => resolved);
        let project = projects.byPath(dir) ?? projects.byPath(resolved);
        if (!project) {
          const { isGit } = await repoInfo(dir).catch(() => ({ isGit: false }));
          project = projects.create({ path: dir, name: path.basename(dir), isGit });
        }
        const defaults = currentProvider(s.providerId).defaults;
        const thread = threads.createExternal({
          projectId: project.id,
          providerId: s.providerId,
          title: s.title,
          cwd: dir,
          model: defaults.model,
          permissionMode: defaults.permissionMode,
          effort: defaultEffortFor(s.providerId, defaults.model),
          sessionId: s.sessionId,
          source: s.source,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        });
        publish({ type: "thread.updated", thread });
        added++;
      } catch (error) {
        console.error(`[external] ${s.providerId} session ${s.sessionId} skipped: ${(error as Error).message}`);
      }
    }
  }
  if (added > 0) publish({ type: "projects.changed" });
  return added;
}

const importing = new Map<string, Promise<void>>();

export function importExternal(thread: Thread, readers: ExternalReader[] = defaultReaders()): Promise<void> {
  if (!thread.external) return Promise.resolve();
  const pending = importing.get(thread.id);
  if (pending) return pending;
  const job = load(thread, readers).finally(() => importing.delete(thread.id));
  importing.set(thread.id, job);
  return job;
}

async function load(thread: Thread, readers: ExternalReader[]): Promise<void> {
  const label = LABELS[thread.providerId];
  const source = threads.externalSource(thread.id);
  const reader = readers.find((r) => r.providerId === thread.providerId);
  if (!source || !reader) throw new Error(`Could not read the ${label} transcript: no transcript source`);
  let list;
  try {
    list = await reader.read(source);
  } catch (error) {
    throw new Error(`Could not read the ${label} transcript: ${(error as Error).message}`);
  }
  for (const m of list) {
    let meta = m.meta;
    if (m.role === "tool" && meta && typeof meta.result === "string") {
      meta = { ...meta, result: truncate(meta.result) };
    }
    messages.append({ threadId: thread.id, role: m.role, text: m.text, meta });
  }
  threads.clearExternal(thread.id, thread.updatedAt);
  publish({ type: "thread.updated", thread: threads.byId(thread.id)! });
}
