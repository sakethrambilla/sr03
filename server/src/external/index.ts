import fs from "node:fs/promises";
import path from "node:path";
import { publish } from "../bus.ts";
import { knownSessions, messages, projects, threads } from "../db.ts";
import { mainRepoRoot } from "../git.ts";
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

const TEMP_ROOTS = ["/tmp", "/private/tmp"];

function isTemp(dir: string): boolean {
  return TEMP_ROOTS.some((root) => dir === root || dir.startsWith(root + path.sep));
}

async function exists(dir: string): Promise<boolean> {
  return fs.stat(dir).then((s) => s.isDirectory(), () => false);
}

// where a session's folder belongs: the main checkout for a worktree (even a deleted one, via its
// nearest surviving ancestor), the folder itself outside git, or null for temp and vanished folders
async function placement(cwd: string): Promise<{ dir: string; root: string } | null> {
  const resolved = path.resolve(cwd);
  // on macOS /tmp is a symlink to /private/tmp, and providers record either spelling
  const dir = await fs.realpath(resolved).catch(() => resolved);
  if (isTemp(dir) || isTemp(resolved)) return null;
  if (await exists(dir)) return { dir, root: (await mainRepoRoot(dir)) ?? dir };
  let ancestor = path.dirname(dir);
  while (ancestor !== path.dirname(ancestor) && !(await exists(ancestor))) ancestor = path.dirname(ancestor);
  const root = await mainRepoRoot(ancestor);
  return root ? { dir, root } : null;
}

async function projectFor(root: string) {
  const existing = projects.byPath(root);
  if (existing) return existing;
  const isGit = (await mainRepoRoot(root)) === root;
  return projects.create({ path: root, name: path.basename(root), isGit });
}

// folds projects an earlier discovery made per worktree or temp folder into their main repo;
// projects holding any thread sr03 started itself are left alone
async function consolidate(): Promise<boolean> {
  let changed = false;
  const all = threads.list();
  for (const project of projects.list()) {
    const own = all.filter((t) => t.projectId === project.id);
    if (own.length === 0 || own.some((t) => !t.external)) continue;
    const place = await placement(project.path);
    if (place && place.root === project.path) continue;
    if (place) {
      const target = await projectFor(place.root);
      for (const t of own) threads.move(t.id, target.id, t.cwd !== place.root);
    }
    projects.remove(project.id);
    changed = true;
  }
  return changed;
}

async function run(readers: ExternalReader[]): Promise<number> {
  let added = 0;
  const consolidated = await consolidate().catch((error) => {
    console.error(`[external] consolidate failed: ${(error as Error).message}`);
    return false;
  });
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
        const place = await placement(s.cwd);
        if (!place) continue;
        const project = await projectFor(place.root);
        const defaults = currentProvider(s.providerId).defaults;
        const thread = threads.createExternal({
          projectId: project.id,
          providerId: s.providerId,
          title: s.title,
          cwd: place.dir,
          isWorktree: place.dir !== place.root,
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
  if (added > 0 || consolidated) publish({ type: "projects.changed" });
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
