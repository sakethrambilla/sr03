// The file panel's whole model: row projection from loaded listings plus the expansion set, the
// server's entry order, the change-set policy behind dirty marks and auto-expand, and the guards
// a refresh needs — a per-directory staleness token and a bounded fan-out. Pure — no React, no
// DOM — so the panel's components only draw what this decides.
import type { TreeEntry } from "./types.ts";

export interface TreeRow {
  entry: TreeEntry;
  depth: number;
}

export const INDENT = 12;
export const ROW_HEIGHT = 22;
export const OVERSCAN = 20;
export const REFRESH_CONCURRENCY = 16;
export const AUTO_EXPAND_MAX_CHANGES = 200;

export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export function ancestors(path: string): string[] {
  const out: string[] = [];
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

// the server's own order — mirrors listWorkspaceDir's sort in server/src/fsbrowse.ts
export function compareEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function projectRows(
  dirs: Readonly<Record<string, readonly TreeEntry[]>>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of dirs[dir] ?? []) {
      rows.push({ entry, depth });
      if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

export function dirtyAncestors(changedPaths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const path of changedPaths) for (const dir of ancestors(path)) out.add(dir);
  return out;
}

// null means "too many changes to be worth expanding", which an empty set does not
export function autoExpandFor(changedPaths: ReadonlySet<string>): Set<string> | null {
  if (changedPaths.size > AUTO_EXPAND_MAX_CHANGES) return null;
  return dirtyAncestors(changedPaths);
}

export function toggleSubtree(
  expanded: ReadonlySet<string>,
  dirs: Readonly<Record<string, readonly TreeEntry[]>>,
  dir: string,
): Set<string> {
  const next = new Set(expanded);
  const prefix = `${dir}/`;
  if (next.has(dir)) {
    next.delete(dir);
    for (const path of expanded) if (path.startsWith(prefix)) next.delete(path);
    return next;
  }
  next.add(dir);
  for (const path of Object.keys(dirs)) if (path.startsWith(prefix)) next.add(path);
  return next;
}

export interface DirLoadToken {
  dir: string;
  revision: number;
}

export interface DirLoadTracker {
  begin(dir: string): DirLoadToken;
  isCurrent(token: DirLoadToken): boolean;
}

export function createDirLoadTracker(): DirLoadTracker {
  const revisions = new Map<string, number>();
  return {
    begin(dir) {
      const revision = (revisions.get(dir) ?? 0) + 1;
      revisions.set(dir, revision);
      return { dir, revision };
    },
    isCurrent(token) {
      return revisions.get(token.dir) === token.revision;
    },
  };
}

// never rejects: one unreadable directory must not abort the rest of a refresh
export function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.min(Math.max(limit, 1), items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await task(item);
      } catch {
        // swallowed by contract
      }
    }
  };
  return Promise.all(Array.from({ length: width }, worker)).then(() => undefined);
}

export function insertEntry(entries: readonly TreeEntry[], entry: TreeEntry): TreeEntry[] {
  const out = entries.filter((existing) => existing.path !== entry.path);
  out.push(entry);
  return out.sort(compareEntries);
}

export function removeEntry(entries: readonly TreeEntry[], path: string): TreeEntry[] {
  return entries.filter((entry) => entry.path !== path);
}

export function replaceEntry(
  entries: readonly TreeEntry[],
  fromPath: string,
  next: TreeEntry,
): TreeEntry[] {
  return insertEntry(removeEntry(entries, fromPath), next);
}
