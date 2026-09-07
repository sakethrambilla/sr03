// The whole persistence layer, on node:sqlite: the schema, the additive migrations and boot-time
// cleanup that run as this module loads, and one accessor object per table — settings, usage,
// projects, threads, messages. Nothing else in the server touches sql.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { DB_PATH } from "./config.ts";
import { parseLayout } from "./layout.ts";
import type {
  EditorLayout,
  Effort,
  Message,
  MessageRole,
  PermissionMode,
  Project,
  ProviderId,
  Thread,
  ThreadStatus,
} from "./types.ts";

function isBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "errcode" in error &&
    (error as Error & { errcode?: number }).errcode === 5
  );
}

function retryBusy(action: () => void): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      action();
      return;
    } catch (error) {
      if (!isBusy(error) || attempt === 199) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");
retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_git INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL DEFAULT 'claude',
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    branch TEXT,
    is_worktree INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    effort TEXT NOT NULL DEFAULT 'high',
    fast INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    owner_id TEXT,
    layout TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    meta TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_thread_seq ON messages(thread_id, seq);
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS server_instances (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worktree_favorites (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, path)
  );
`);

// sqlite has no ADD COLUMN IF NOT EXISTS. The write lock makes the check-and-alter sequence safe
// when the desktop app and a development server start against the same data directory.
db.exec("BEGIN IMMEDIATE");
try {
  const threadColumns = db
    .prepare("SELECT name FROM pragma_table_info('threads')")
    .all()
    .map((row) => (row as Record<string, unknown>).name as string);
  if (!threadColumns.includes("effort")) {
    db.exec("ALTER TABLE threads ADD COLUMN effort TEXT NOT NULL DEFAULT 'high'");
  }
  if (!threadColumns.includes("fast")) {
    db.exec("ALTER TABLE threads ADD COLUMN fast INTEGER NOT NULL DEFAULT 0");
  }
  if (!threadColumns.includes("archived")) {
    db.exec("ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
  }
  if (!threadColumns.includes("provider_id")) {
    db.exec("ALTER TABLE threads ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!threadColumns.includes("owner_id")) {
    db.exec("ALTER TABLE threads ADD COLUMN owner_id TEXT");
  }
  if (!threadColumns.includes("layout")) {
    db.exec("ALTER TABLE threads ADD COLUMN layout TEXT");
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const INSTANCE_ID = randomUUID();
const INSTANCE_LEASE_MS = 30_000;
const instanceUpsert = db.prepare(
  `INSERT INTO server_instances (id, pid, heartbeat_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`,
);
const ownerlessThreadRelease = db.prepare(
  `UPDATE threads SET status = 'idle', updated_at = ?
   WHERE status = 'running' AND owner_id IS NULL`,
);
const ownedThreadRelease = db.prepare(
  `UPDATE threads
   SET status = CASE WHEN status = 'running' THEN 'idle' ELSE status END,
       owner_id = NULL,
       updated_at = ?
   WHERE owner_id = ?`,
);
const staleInstances = db.prepare(
  "SELECT id, pid FROM server_instances WHERE id <> ? AND heartbeat_at < ?",
);
const instanceDelete = db.prepare("DELETE FROM server_instances WHERE id = ?");

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function refreshInstanceLease(): void {
  const now = Date.now();
  let began = false;
  retryBusy(() => {
    try {
      db.exec("BEGIN IMMEDIATE");
      began = true;
      instanceUpsert.run(INSTANCE_ID, process.pid, now);
      ownerlessThreadRelease.run(now);
      const stale = staleInstances.all(INSTANCE_ID, now - INSTANCE_LEASE_MS) as Array<{
        id: string;
        pid: number;
      }>;
      for (const instance of stale) {
        if (processIsAlive(instance.pid)) continue;
        ownedThreadRelease.run(now, instance.id);
        instanceDelete.run(instance.id);
      }
      db.exec("COMMIT");
      began = false;
    } catch (error) {
      if (began) db.exec("ROLLBACK");
      began = false;
      throw error;
    }
  });
}

refreshInstanceLease();
const instanceHeartbeat = setInterval(() => {
  try {
    refreshInstanceLease();
  } catch (error) {
    console.error(`[db] Could not refresh server lease: ${(error as Error).message}`);
  }
}, 5_000);
instanceHeartbeat.unref();

function releaseInstanceLease(): void {
  clearInterval(instanceHeartbeat);
  try {
    db.prepare(
      "UPDATE threads SET status = 'idle', owner_id = NULL, updated_at = ? WHERE owner_id = ?",
    ).run(Date.now(), INSTANCE_ID);
    db.prepare("DELETE FROM server_instances WHERE id = ?").run(INSTANCE_ID);
  } catch {}
}

process.once("exit", releaseInstanceLease);
process.once("SIGINT", () => {
  releaseInstanceLease();
  process.exit(130);
});
process.once("SIGTERM", () => {
  releaseInstanceLease();
  process.exit(143);
});

// folders are derived from threads, so a project without any is stale state
db.exec("DELETE FROM projects WHERE id NOT IN (SELECT project_id FROM threads)");
db.exec("DELETE FROM usage WHERE id <> 'account' AND id NOT IN (SELECT id FROM threads)");

type Row = Record<string, unknown>;

function toProject(row: Row): Project {
  return {
    id: row.id as string,
    path: row.path as string,
    name: row.name as string,
    isGit: Boolean(row.is_git),
    createdAt: row.created_at as number,
  };
}

function toThread(row: Row): Thread {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    providerId: row.provider_id === "cursor" ? "cursor" : "claude",
    title: row.title as string,
    cwd: row.cwd as string,
    branch: (row.branch as string | null) ?? null,
    isWorktree: Boolean(row.is_worktree),
    model: row.model as string,
    permissionMode: row.permission_mode as PermissionMode,
    effort: row.effort as Effort,
    fast: Boolean(row.fast),
    sessionId: (row.session_id as string | null) ?? null,
    status: row.status as ThreadStatus,
    archived: Boolean(row.archived),
    layout: parseLayout(row.layout),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toMessage(row: Row): Message {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    seq: row.seq as number,
    role: row.role as MessageRole,
    text: row.text as string,
    meta: row.meta ? (JSON.parse(row.meta as string) as Record<string, unknown>) : null,
    createdAt: row.created_at as number,
  };
}

// every statement is prepared once; some of these run per streamed token
const sql = {
  settingsAll: db.prepare("SELECT key, value FROM settings"),
  settingsSet: db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ),
  usageAll: db.prepare("SELECT id, json, updated_at FROM usage"),
  usageSet: db.prepare(
    "INSERT INTO usage (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
  ),
  usageRemove: db.prepare("DELETE FROM usage WHERE id = ?"),
  projectsList: db.prepare("SELECT * FROM projects ORDER BY created_at ASC"),
  projectById: db.prepare("SELECT * FROM projects WHERE id = ?"),
  projectByPath: db.prepare("SELECT * FROM projects WHERE path = ?"),
  projectInsert: db.prepare(
    "INSERT INTO projects (id, path, name, is_git, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
  projectRemove: db.prepare("DELETE FROM projects WHERE id = ?"),
  threadsList: db.prepare("SELECT * FROM threads ORDER BY updated_at DESC"),
  threadById: db.prepare("SELECT * FROM threads WHERE id = ?"),
  threadSetLayout: db.prepare("UPDATE threads SET layout = ? WHERE id = ?"),
  threadInsert: db.prepare(
    `INSERT INTO threads (id, project_id, provider_id, title, cwd, branch, is_worktree, model, permission_mode, effort, fast, session_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ),
  threadClaim: db.prepare(
    `UPDATE threads SET status = 'running', owner_id = ?, updated_at = ?
     WHERE id = ?
       AND status <> 'running'
       AND (owner_id IS NULL OR owner_id = ?)`,
  ),
  threadOwned: db.prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ?"),
  threadOwner: db.prepare("SELECT owner_id FROM threads WHERE id = ?"),
  threadOwnedRunning: db.prepare(
    `UPDATE threads SET status = 'running', updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ),
  threadOwnedRunningSession: db.prepare(
    `UPDATE threads SET status = 'running', session_id = ?, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ),
  threadOwnedRelease: db.prepare(
    `UPDATE threads SET status = ?, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  ),
  threadRelease: db.prepare(
    "UPDATE threads SET owner_id = NULL, updated_at = ? WHERE id = ? AND owner_id = ?",
  ),
  threadTouch: db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?"),
  threadRemove: db.prepare("DELETE FROM threads WHERE id = ?"),
  messagesList: db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq ASC"),
  messageById: db.prepare("SELECT * FROM messages WHERE id = ?"),
  // the next seq is worked out inside the insert, so appending is one statement
  messageInsert: db.prepare(
    `INSERT INTO messages (id, thread_id, seq, role, text, meta, created_at)
     VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE thread_id = ?), ?, ?, ?, ?)
     RETURNING seq`,
  ),
  messageSetMeta: db.prepare("UPDATE messages SET meta = ? WHERE id = ?"),
  messagesTruncate: db.prepare("DELETE FROM messages WHERE thread_id = ? AND seq >= ?"),
  worktreeFavoritesList: db.prepare(
    "SELECT path FROM worktree_favorites WHERE project_id = ? ORDER BY created_at ASC",
  ),
  worktreeFavoriteAdd: db.prepare(
    "INSERT INTO worktree_favorites (project_id, path, created_at) VALUES (?, ?, ?) ON CONFLICT(project_id, path) DO NOTHING",
  ),
  worktreeFavoriteRemove: db.prepare(
    "DELETE FROM worktree_favorites WHERE project_id = ? AND path = ?",
  ),
  threadSetCwd: db.prepare("UPDATE threads SET cwd = ?, updated_at = ? WHERE id = ?"),
};

// the desktop shell loads a new port every launch, so the browser's own storage starts empty
// each time — anything meant to outlive a restart has to live here
export const settings = {
  all(): Record<string, string> {
    const rows = sql.settingsAll.all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  },

  set(key: string, value: string): void {
    sql.settingsSet.run(key, value);
  },
};

// the numbers behind the usage meter only come off a live session, so the last read is kept to
// carry a restart: one row per thread for its context and cost, plus 'account' for the plan
export const usage = {
  all(): Array<{ id: string; json: string; updatedAt: number }> {
    const rows = sql.usageAll.all() as Array<{ id: string; json: string; updated_at: number }>;
    return rows.map((row) => ({ id: row.id, json: row.json, updatedAt: row.updated_at }));
  },

  set(id: string, json: string): void {
    sql.usageSet.run(id, json, Date.now());
  },

  remove(id: string): void {
    sql.usageRemove.run(id);
  },
};

export const projects = {
  list(): Project[] {
    return sql.projectsList.all().map(toProject);
  },
  byId(id: string): Project | null {
    const row = sql.projectById.get(id);
    return row ? toProject(row) : null;
  },
  byPath(path: string): Project | null {
    const row = sql.projectByPath.get(path);
    return row ? toProject(row) : null;
  },
  create(input: { path: string; name: string; isGit: boolean }): Project {
    const project: Project = { id: randomUUID(), createdAt: Date.now(), ...input };
    sql.projectInsert.run(project.id, project.path, project.name, project.isGit ? 1 : 0, project.createdAt);
    return project;
  },
  remove(id: string): void {
    sql.projectRemove.run(id);
  },
};

export const worktreeFavorites = {
  list(projectId: string): string[] {
    return (sql.worktreeFavoritesList.all(projectId) as Array<{ path: string }>).map((row) => row.path);
  },
  add(projectId: string, path: string): void {
    sql.worktreeFavoriteAdd.run(projectId, path, Date.now());
  },
  remove(projectId: string, path: string): void {
    sql.worktreeFavoriteRemove.run(projectId, path);
  },
};

const THREAD_COLUMNS: Record<string, string> = {
  title: "title",
  model: "model",
  permissionMode: "permission_mode",
  effort: "effort",
  fast: "fast",
  sessionId: "session_id",
  status: "status",
  archived: "archived",
};

// one prepared UPDATE per distinct set of columns, since patches come in a handful of shapes
const threadUpdates = new Map<string, ReturnType<typeof db.prepare>>();

export const threads = {
  list(): Thread[] {
    return sql.threadsList.all().map(toThread);
  },
  byId(id: string): Thread | null {
    const row = sql.threadById.get(id);
    return row ? toThread(row) : null;
  },
  create(input: {
    projectId: string;
    providerId: ProviderId;
    title: string;
    cwd: string;
    branch: string | null;
    isWorktree: boolean;
    model: string;
    permissionMode: PermissionMode;
    effort: Effort;
    fast: boolean;
  }): Thread {
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(),
      sessionId: null,
      status: "idle",
      archived: false,
      layout: null,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    sql.threadInsert.run(
      thread.id,
      thread.projectId,
      thread.providerId,
      thread.title,
      thread.cwd,
      thread.branch,
      thread.isWorktree ? 1 : 0,
      thread.model,
      thread.permissionMode,
      thread.effort,
      thread.fast ? 1 : 0,
      null,
      thread.status,
      thread.createdAt,
      thread.updatedAt,
    );
    return thread;
  },
  claim(id: string): boolean {
    return sql.threadClaim.run(INSTANCE_ID, Date.now(), id, INSTANCE_ID).changes === 1;
  },
  owns(id: string): boolean {
    return Boolean(sql.threadOwned.get(id, INSTANCE_ID));
  },
  canOperate(id: string): boolean {
    const row = sql.threadOwner.get(id) as { owner_id: string | null } | undefined;
    return Boolean(row && (row.owner_id === null || row.owner_id === INSTANCE_ID));
  },
  setOwnedStatus(id: string, status: ThreadStatus, sessionId?: string | null): boolean {
    const now = Date.now();
    if (status === "running") {
      const result =
        sessionId === undefined
          ? sql.threadOwnedRunning.run(now, id, INSTANCE_ID)
          : sql.threadOwnedRunningSession.run(sessionId, now, id, INSTANCE_ID);
      return result.changes === 1;
    }
    return sql.threadOwnedRelease.run(status, now, id, INSTANCE_ID).changes === 1;
  },
  release(id: string): void {
    sql.threadRelease.run(Date.now(), id, INSTANCE_ID);
  },
  // deliberately not update(): that writes updated_at, and threadsList is ordered by it, so a
  // dragged tab would jump the session to the top of the sidebar
  setLayout(id: string, layout: EditorLayout | null): Thread | null {
    sql.threadSetLayout.run(layout ? JSON.stringify(layout) : null, id);
    return threads.byId(id);
  },

  update(
    id: string,
    patch: Partial<
      Pick<
        Thread,
        "title" | "model" | "permissionMode" | "effort" | "fast" | "sessionId" | "status" | "archived"
      >
    >,
  ): Thread | null {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(THREAD_COLUMNS)) {
      const value = patch[key as keyof typeof patch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === "boolean" ? Number(value) : value);
    }
    if (sets.length === 0) return threads.byId(id);
    const shape = sets.join(", ");
    let statement = threadUpdates.get(shape);
    if (!statement) {
      statement = db.prepare(`UPDATE threads SET ${shape}, updated_at = ? WHERE id = ?`);
      threadUpdates.set(shape, statement);
    }
    statement.run(...values, Date.now(), id);
    return threads.byId(id);
  },
  touch(id: string): void {
    sql.threadTouch.run(Date.now(), id);
  },
  setCwd(id: string, cwd: string): void {
    sql.threadSetCwd.run(cwd, Date.now(), id);
  },
  remove(id: string): void {
    sql.threadRemove.run(id);
  },
};

export const messages = {
  list(threadId: string): Message[] {
    return sql.messagesList.all(threadId).map(toMessage);
  },
  append(input: {
    threadId: string;
    role: MessageRole;
    text: string;
    meta?: Record<string, unknown> | null;
  }): Message {
    const id = randomUUID();
    const createdAt = Date.now();
    const meta = input.meta ?? null;
    const row = sql.messageInsert.get(
      id,
      input.threadId,
      input.threadId,
      input.role,
      input.text,
      meta ? JSON.stringify(meta) : null,
      createdAt,
    ) as { seq: number };
    threads.touch(input.threadId);
    return { id, threadId: input.threadId, seq: row.seq, role: input.role, text: input.text, meta, createdAt };
  },
  byId(id: string): Message | null {
    const row = sql.messageById.get(id);
    return row ? toMessage(row) : null;
  },
  setMeta(id: string, meta: Record<string, unknown> | null): void {
    sql.messageSetMeta.run(meta ? JSON.stringify(meta) : null, id);
  },
  // seq starts at 1, so 0 drops the whole thread
  truncate(threadId: string, seq: number): void {
    sql.messagesTruncate.run(threadId, seq);
    threads.touch(threadId);
  },
};
