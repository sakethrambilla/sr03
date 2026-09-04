// Every REST route, as one flat table of method + regex + handler. Commands come in here;
// results go back out over the socket through bus.ts. A handler returning a value means 200
// with that value as json, and a thrown HttpError means its status.
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import * as agents from "./agents/runtime.ts";
import * as git from "./git.ts";
import * as pty from "./pty.ts";
import { listProviders, logoutProvider } from "./providers.ts";
import {
  choosePath,
  createWorkspaceEntry,
  isDirectory,
  appIcon,
  listApps,
  listDirectory,
  listWorkspaceDir,
  openIn,
  readUpload,
  readWorkspaceFile,
  renameWorkspaceEntry,
  revealWorkspaceEntry,
  saveUpload,
  trashWorkspaceEntry,
  walkWorkspaceFiles,
  writeWorkspaceFile,
} from "./fsbrowse.ts";
import { readTable, readValues, tableKind, writeCell } from "./table.ts";
import type { TableFilter, TableQuery } from "./table.ts";
import { messages, projects, settings, threads } from "./db.ts";
import {
  currentProvider,
  currentProviders,
  defaultProviderId,
  isEffort,
  isModel,
  isPermissionMode,
  isProviderId,
} from "./models.ts";
import { publish } from "./bus.ts";

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function readRaw(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "File is larger than 25MB");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `\`${key}\` is required`);
  }
  return value.trim();
}

const threadOperationTails = new Map<string, Promise<void>>();

async function withThreadOperation<T>(threadId: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = threadOperationTails.get(threadId) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  threadOperationTails.set(threadId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (threadOperationTails.get(threadId) === tail) threadOperationTails.delete(threadId);
  }
}

function withThreadOperations<T>(
  threadIds: string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  const ids = [...new Set(threadIds)].sort();
  const acquire = (index: number): Promise<T> =>
    index === ids.length
      ? Promise.resolve(operation())
      : withThreadOperation(ids[index]!, () => acquire(index + 1));
  return acquire(0);
}

// the search and the per-column checklists travel as query params, so one parser reads both
function tableQuery(url: URL): TableQuery {
  const raw = url.searchParams.get("filters");
  let filters: TableFilter[] = [];
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "`filters` isn't valid JSON");
    }
    if (!Array.isArray(parsed)) throw new HttpError(400, "`filters` must be an array");
    filters = parsed.flatMap((entry): TableFilter[] => {
      const one = entry as { column?: unknown; values?: unknown };
      if (typeof one.column !== "number" || !Array.isArray(one.values)) return [];
      return [
        {
          column: one.column,
          values: one.values.filter((value): value is string => typeof value === "string"),
        },
      ];
    });
  }
  return {
    search: url.searchParams.get("q") ?? "",
    filters,
    header: url.searchParams.get("header") !== "0",
  };
}

function requireThread(id: string) {
  const thread = threads.byId(id);
  if (!thread) throw new HttpError(404, "Thread not found");
  return thread;
}

function requireProject(id: string) {
  const project = projects.byId(id);
  if (!project) throw new HttpError(404, "Project not found");
  return project;
}

type Handler = (context: {
  request: IncomingMessage;
  response: ServerResponse;
  params: string[];
  url: URL;
}) => Promise<unknown> | unknown;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [
  {
    method: "GET",
    pattern: /^\/api\/state$/,
    handler: async () => ({
      projects: projects.list(),
      threads: threads.list(),
      providers: currentProviders(),
      defaultProviderId: defaultProviderId(),
      apps: await listApps(),
    }),
  },
  {
    method: "POST",
    pattern: /^\/api\/providers\/([^/]+)\/logout$/,
    handler: ({ params }) => {
      const providerId = params[0]!;
      if (!isProviderId(providerId)) throw new HttpError(404, "Provider not found");
      return logoutProvider(providerId);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/providers$/,
    handler: () => listProviders().then((providers) => ({ providers })),
  },
  {
    method: "GET",
    pattern: /^\/api\/apps\/([^/]+)\/icon$/,
    handler: async ({ params, response }) => {
      const png = await appIcon(params[0]!);
      if (!png) throw new HttpError(404, "No icon for that app");
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "max-age=3600",
      });
      response.end(png);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/fs$/,
    handler: ({ url }) => listDirectory(url.searchParams.get("path") ?? undefined),
  },
  {
    method: "POST",
    pattern: /^\/api\/fs\/choose$/,
    handler: async ({ request }) => {
      const body = await readBody(request);
      return { path: await choosePath(body.kind === "file" ? "file" : "folder") };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/uploads$/,
    handler: async ({ request }) => {
      const bytes = await readRaw(request, 25 * 1024 * 1024);
      if (bytes.length === 0) throw new HttpError(400, "Nothing to upload");
      const header = request.headers["x-filename"];
      return saveUpload(typeof header === "string" ? decodeURIComponent(header) : "attachment", bytes);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/uploads\/([^/]+)$/,
    handler: async ({ params, response }) => {
      const file = await readUpload(decodeURIComponent(params[0]!));
      if (!file) throw new HttpError(404, "Upload not found");
      response.writeHead(200, {
        "content-type": file.type,
        "content-length": file.bytes.length,
        "cache-control": "no-store",
      });
      response.end(file.bytes);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/projects$/,
    handler: async ({ request }) => {
      const body = await readBody(request);
      const target = path.resolve(requireString(body, "path"));
      if (!(await isDirectory(target))) throw new HttpError(400, "Not a directory");
      const existing = projects.byPath(target);
      if (existing) return existing;
      const info = await git.repoInfo(target);
      const project = projects.create({
        path: target,
        name: path.basename(target),
        isGit: info.isGit,
      });
      publish({ type: "projects.changed" });
      return project;
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/projects\/([^/]+)$/,
    handler: async ({ params }) => {
      const project = requireProject(params[0]!);
      const ids = threads
        .list()
        .filter((thread) => thread.projectId === project.id)
        .map((thread) => thread.id);
      return withThreadOperations(ids, () => {
        const affected = threads.list().filter((thread) => thread.projectId === project.id);
        if (affected.some((thread) => !agents.canOperate(thread.id))) {
          throw new HttpError(409, "A project session is active in another sr03 instance");
        }
        const reserved: Array<{ id: string; status: (typeof affected)[number]["status"] }> = [];
        try {
          for (const thread of affected) {
            if (!agents.reserveThread(thread.id)) throw new HttpError(409, "A project session is busy");
            reserved.push({ id: thread.id, status: thread.status });
          }
          for (const thread of affected) agents.closeSession(thread.id);
          projects.remove(project.id);
          publish({ type: "projects.changed" });
          return { ok: true };
        } finally {
          for (const thread of reserved) {
            agents.releaseThreadReservation(thread.id, thread.status);
          }
        }
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/projects\/([^/]+)\/git$/,
    handler: async ({ params }) => {
      const project = requireProject(params[0]!);
      const info = await git.repoInfo(project.path);
      if (!info.isGit || !info.root) return { isGit: false, branches: [], worktrees: [] };
      const [branches, worktrees] = await Promise.all([
        git.listBranches(info.root),
        git.listWorktrees(info.root),
      ]);
      return { isGit: true, root: info.root, branch: info.branch, dirty: info.dirty, branches, worktrees };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/projects\/([^/]+)\/worktrees$/,
    handler: async ({ params, request }) => {
      const project = requireProject(params[0]!);
      const body = await readBody(request);
      const branch = requireString(body, "branch");
      const info = await git.repoInfo(project.path);
      if (!info.isGit || !info.root) throw new HttpError(400, "Project is not a git repository");
      const worktree = await git.addWorktree({
        root: info.root,
        branch,
        createBranch: body.createBranch !== false,
        ...(typeof body.base === "string" && body.base.trim() ? { base: body.base.trim() } : {}),
      });
      publish({ type: "projects.changed" });
      return worktree;
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/projects\/([^/]+)\/worktrees$/,
    handler: async ({ params, request }) => {
      const project = requireProject(params[0]!);
      const body = await readBody(request);
      const target = path.resolve(requireString(body, "path"));
      const usesTarget = (cwd: string) =>
        path.resolve(cwd) === target || path.resolve(cwd).startsWith(`${target}${path.sep}`);
      const ids = threads
        .list()
        .filter((thread) => thread.projectId === project.id && usesTarget(thread.cwd))
        .map((thread) => thread.id);
      return withThreadOperations(ids, async () => {
        const affected = threads
          .list()
          .filter((thread) => thread.projectId === project.id && usesTarget(thread.cwd));
        if (
          affected.some(
            (thread) => thread.status === "running" || !agents.canOperate(thread.id),
          )
        ) {
          throw new HttpError(409, "The worktree is in use by an active session");
        }
        const reserved: Array<{ id: string; status: (typeof affected)[number]["status"] }> = [];
        try {
          for (const thread of affected) {
            if (!agents.reserveThread(thread.id)) throw new HttpError(409, "A worktree session is busy");
            reserved.push({ id: thread.id, status: thread.status });
            agents.closeSession(thread.id);
          }
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) {
            throw new HttpError(400, "Project is not a git repository");
          }
          await git.removeWorktree({ root: info.root, path: target, force: body.force === true });
          await git.pruneWorktrees(info.root);
          publish({ type: "projects.changed" });
          return { ok: true };
        } finally {
          for (const thread of reserved) {
            agents.releaseThreadReservation(thread.id, thread.status);
          }
        }
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads$/,
    handler: async ({ request }) => {
      const body = await readBody(request);
      const project = requireProject(requireString(body, "projectId"));
      const cwd = typeof body.cwd === "string" && body.cwd.trim() ? path.resolve(body.cwd) : project.path;
      if (!(await isDirectory(cwd))) throw new HttpError(400, "Working directory does not exist");
      const info = await git.repoInfo(cwd);
      if (body.providerId !== undefined && !isProviderId(body.providerId)) {
        throw new HttpError(400, "Unknown provider");
      }
      const providerId = body.providerId ?? defaultProviderId();
      const provider = currentProvider(providerId);
      if (body.model !== undefined && !isModel(providerId, body.model)) {
        throw new HttpError(400, "Unknown model");
      }
      if (
        body.permissionMode !== undefined &&
        !isPermissionMode(providerId, body.permissionMode)
      ) {
        throw new HttpError(400, "Unknown permission mode");
      }
      if (body.effort !== undefined && !isEffort(providerId, body.effort)) {
        throw new HttpError(400, "Unknown effort level");
      }
      const thread = threads.create({
        projectId: project.id,
        providerId,
        effort: body.effort ?? provider.defaults.effort,
        title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : "New thread",
        cwd,
        branch: info.branch,
        isWorktree: path.resolve(cwd) !== path.resolve(project.path),
        model: body.model ?? provider.defaults.model,
        permissionMode: body.permissionMode ?? provider.defaults.permissionMode,
      });
      publish({ type: "thread.updated", thread });
      return thread;
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)$/,
    handler: ({ params }) => {
      const thread = requireThread(params[0]!);
      return { thread, messages: messages.list(thread.id), tasks: agents.threadTasks(thread.id) };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/commands$/,
    handler: ({ url }) => {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) throw new HttpError(400, "A cwd is required");
      const rawProvider = url.searchParams.get("provider");
      if (rawProvider !== null && !isProviderId(rawProvider)) {
        throw new HttpError(400, "Unknown provider");
      }
      const providerId = rawProvider ?? defaultProviderId();
      return agents.listCommands(providerId, cwd).then((commands) => ({ commands }));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/usage$/,
    handler: ({ url }) => {
      const threadId = url.searchParams.get("thread");
      return agents.readUsage(threadId && threads.byId(threadId) ? threadId : null);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)\/git$/,
    handler: async ({ params }) => {
      const thread = requireThread(params[0]!);
      const [info, diff] = await Promise.all([git.repoInfo(thread.cwd), git.diffStat(thread.cwd)]);
      return { branch: info.branch, dirty: info.dirty, diff };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)\/tree$/,
    handler: async ({ params, url }) => {
      const thread = requireThread(params[0]!);
      const rel = url.searchParams.get("path") ?? "";
      const entries = await listWorkspaceDir(thread.cwd, rel);
      const ignored = await git.ignoredPaths(
        thread.cwd,
        entries.map((entry) => entry.path),
      );
      return {
        path: rel,
        entries: entries.map((entry) => ({ ...entry, ignored: ignored.has(entry.path) })),
      };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/fs$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      return createWorkspaceEntry(
        thread.cwd,
        requireString(body, "path"),
        body.kind === "dir" ? "dir" : "file",
      );
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/threads\/([^/]+)\/file$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      if (typeof body.text !== "string") throw new HttpError(400, "`text` is required");
      return writeWorkspaceFile(thread.cwd, requireString(body, "path"), body.text);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/reveal$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      await revealWorkspaceEntry(thread.cwd, requireString(body, "path"));
      return { ok: true };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/threads\/([^/]+)\/fs$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      return renameWorkspaceEntry(
        thread.cwd,
        requireString(body, "path"),
        requireString(body, "name"),
      );
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/threads\/([^/]+)\/fs$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      return trashWorkspaceEntry(thread.cwd, requireString(body, "path"));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)\/file$/,
    handler: async ({ params, url }) => {
      const thread = requireThread(params[0]!);
      const rel = url.searchParams.get("path")?.trim() ?? "";
      if (!rel) throw new HttpError(400, "`path` is required");
      const [file, state] = await Promise.all([
        readWorkspaceFile(thread.cwd, rel),
        git.fileState(thread.cwd, rel),
      ]);
      return { path: rel, ...file, ...state };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)\/table$/,
    handler: async ({ params, url }) => {
      const thread = requireThread(params[0]!);
      const rel = url.searchParams.get("path")?.trim() ?? "";
      if (!rel) throw new HttpError(400, "`path` is required");
      if (!tableKind(rel)) throw new HttpError(400, "That file isn't a table");
      const number = (key: string, fallback: number) => {
        const raw = Number(url.searchParams.get(key));
        return Number.isFinite(raw) ? raw : fallback;
      };
      return readTable(thread.cwd, rel, {
        sheet: number("sheet", 0),
        offset: number("offset", 0),
        limit: number("limit", 500),
        query: tableQuery(url),
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)\/table\/values$/,
    handler: async ({ params, url }) => {
      const thread = requireThread(params[0]!);
      const rel = url.searchParams.get("path")?.trim() ?? "";
      if (!rel) throw new HttpError(400, "`path` is required");
      if (!tableKind(rel)) throw new HttpError(400, "That file isn't a table");
      const column = Number(url.searchParams.get("column"));
      if (!Number.isInteger(column) || column < 0) throw new HttpError(400, "`column` is required");
      return readValues(thread.cwd, rel, {
        sheet: Number(url.searchParams.get("sheet")) || 0,
        column,
        query: tableQuery(url),
      });
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/threads\/([^/]+)\/table$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      if (typeof body.value !== "string") throw new HttpError(400, "`value` is required");
      if (!Number.isInteger(body.row) || !Number.isInteger(body.column)) {
        throw new HttpError(400, "`row` and `column` are required");
      }
      return writeCell(thread.cwd, requireString(body, "path"), {
        row: body.row as number,
        column: body.column as number,
        value: body.value,
        mtimeMs: typeof body.mtimeMs === "number" ? body.mtimeMs : 0,
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/settings$/,
    handler: async () => ({ settings: settings.all() }),
  },
  {
    method: "PUT",
    pattern: /^\/api\/settings$/,
    handler: async ({ request }) => {
      const body = await readBody(request);
      if (typeof body.value !== "string") throw new HttpError(400, "`value` is required");
      settings.set(requireString(body, "key"), body.value);
      return { ok: true };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)\/files$/,
    handler: async ({ params }) => {
      const thread = requireThread(params[0]!);
      const files = (await git.listedFiles(thread.cwd)) ?? (await walkWorkspaceFiles(thread.cwd));
      return { files };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)\/changes$/,
    handler: async ({ params }) => {
      const thread = requireThread(params[0]!);
      const [info, files] = await Promise.all([git.repoInfo(thread.cwd), git.changedFiles(thread.cwd)]);
      return { isGit: info.isGit, branch: info.branch, files };
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)\/diff$/,
    handler: async ({ params, url }) => {
      const thread = requireThread(params[0]!);
      const file = url.searchParams.get("file")?.trim() ?? "";
      if (!file || file.startsWith("-") || file.split("/").includes("..")) {
        throw new HttpError(400, "`file` is required");
      }
      const untracked = url.searchParams.get("untracked") === "1";
      return { file, diff: await git.fileDiff(thread.cwd, file, untracked) };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/open$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      await openIn(requireString(body, "app"), thread.cwd);
      return { ok: true };
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/threads\/([^/]+)$/,
    handler: async ({ params, request }) => {
      const body = await readBody(request);
      return withThreadOperation(params[0]!, async () => {
        const thread = requireThread(params[0]!);
        const patch: {
          title?: string;
          model?: string;
          permissionMode?: typeof thread.permissionMode;
          effort?: typeof thread.effort;
          archived?: boolean;
        } = {};
        if (body.title !== undefined) {
          if (typeof body.title !== "string" || !body.title.trim()) {
            throw new HttpError(400, "`title` must be a non-empty string");
          }
          patch.title = body.title.trim();
        }
        if (body.model !== undefined) {
          if (!isModel(thread.providerId, body.model)) throw new HttpError(400, "Unknown model");
          patch.model = body.model;
        }
        if (body.permissionMode !== undefined) {
          if (!isPermissionMode(thread.providerId, body.permissionMode)) {
            throw new HttpError(400, "Unknown permission mode");
          }
          patch.permissionMode = body.permissionMode;
        }
        if (body.effort !== undefined) {
          if (!isEffort(thread.providerId, body.effort)) {
            throw new HttpError(400, "Unknown effort level");
          }
          patch.effort = body.effort;
        }
        if (body.archived !== undefined) {
          if (typeof body.archived !== "boolean") {
            throw new HttpError(400, "`archived` must be a boolean");
          }
          patch.archived = body.archived;
        }
        const capabilities = currentProvider(thread.providerId).capabilities;
        if (
          thread.status === "running" &&
          ((patch.model !== undefined &&
            patch.model !== thread.model &&
            !capabilities.liveModelSwitch) ||
            (patch.permissionMode !== undefined &&
              patch.permissionMode !== thread.permissionMode &&
              !capabilities.livePermissionModeSwitch))
        ) {
          throw new HttpError(409, "That setting can only change after the current turn finishes");
        }
        const changesAgentSettings =
          patch.model !== undefined ||
          patch.permissionMode !== undefined ||
          patch.effort !== undefined;
        if (changesAgentSettings && !agents.canOperate(thread.id)) {
          throw new HttpError(409, "This thread is active in another sr03 instance");
        }
        const reserved = changesAgentSettings && thread.status !== "running";
        if (reserved && !agents.reserveThread(thread.id)) throw new HttpError(409, "Thread is busy");
        try {
          await agents.applyThreadSettings(thread, patch);
          const updated = threads.update(thread.id, patch);
          if (!updated) throw new HttpError(404, "Thread not found");
          publish({ type: "thread.updated", thread: updated });
          return updated;
        } finally {
          if (reserved) agents.releaseThreadReservation(thread.id, thread.status);
        }
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/fork$/,
    handler: async ({ params }) => {
      return withThreadOperation(params[0]!, async () => {
        const source = requireThread(params[0]!);
        if (source.status === "running") throw new HttpError(409, "Turn already running");
        if (!currentProvider(source.providerId).capabilities.fork) {
          throw new HttpError(
            400,
            `${currentProvider(source.providerId).label} cannot fork sessions`,
          );
        }
        if (!agents.reserveThread(source.id)) throw new HttpError(409, "Thread is busy");
        try {
          const transcript = messages.list(source.id);
          // the fork gets a session file of its own, so both threads can run without interleaving
          const forked = source.sessionId
            ? await agents.forkSession(source).catch((error: Error) => {
                throw new HttpError(500, `Could not fork session: ${error.message}`);
              })
            : null;
          const created = threads.create({
            projectId: source.projectId,
            providerId: source.providerId,
            title: `${source.title} (fork)`,
            cwd: source.cwd,
            branch: source.branch,
            isWorktree: source.isWorktree,
            model: source.model,
            permissionMode: source.permissionMode,
            effort: source.effort,
          });
          for (const message of transcript) {
            messages.append({
              threadId: created.id,
              role: message.role,
              text: message.text,
              meta: message.meta,
            });
          }
          const thread = threads.update(created.id, { sessionId: forked }) ?? created;
          publish({ type: "thread.updated", thread });
          return thread;
        } finally {
          agents.releaseThreadReservation(source.id, source.status);
        }
      });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/threads\/([^/]+)$/,
    handler: ({ params }) =>
      withThreadOperation(params[0]!, () => {
        const thread = requireThread(params[0]!);
        if (!agents.canOperate(thread.id)) {
          throw new HttpError(409, "This thread is active in another sr03 instance");
        }
        if (thread.status === "running" && !agents.hasSession(thread.id)) {
          throw new HttpError(409, "This server does not own the running session");
        }
        if (!agents.reserveThread(thread.id)) throw new HttpError(409, "Thread is busy");
        try {
          agents.closeSession(thread.id);
          pty.closeThread(thread.id);
          threads.remove(thread.id);
          publish({ type: "projects.changed" });
          return { ok: true };
        } finally {
          agents.releaseThreadReservation(thread.id, thread.status);
        }
      }),
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/turns$/,
    handler: async ({ params, request }) => {
      const body = await readBody(request);
      const text = requireString(body, "text");
      return withThreadOperation(params[0]!, () => {
        const thread = requireThread(params[0]!);
        if (thread.status === "running") throw new HttpError(409, "Turn already running");
        if (!agents.sendTurn(thread, text)) {
          throw new HttpError(
            409,
            agents.canOperate(thread.id)
              ? "Turn already running"
              : "This thread is active in another sr03 instance",
          );
        }
        // /clear leaves no turn behind, so it would only name the thread after itself
        if (thread.title === "New thread" && !agents.isClear(text)) {
          const title = text.split("\n")[0]!.slice(0, 60);
          const renamed = threads.update(thread.id, { title });
          if (renamed) publish({ type: "thread.updated", thread: renamed });
        }
        return { ok: true };
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/rewind$/,
    handler: async ({ params, request }) => {
      const body = await readBody(request);
      const messageId = requireString(body, "messageId");
      return withThreadOperation(params[0]!, () => {
        const thread = requireThread(params[0]!);
        if (thread.status === "running") throw new HttpError(409, "Turn already running");
        const message = messages.byId(messageId);
        if (!message || message.threadId !== thread.id) throw new HttpError(404, "No such message");
        if (!agents.truncateThread(thread, message.seq)) throw new HttpError(409, "Thread is busy");
        // the caller puts this back in the composer, which is the whole point of rewinding to it
        return { text: message.text };
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/interrupt$/,
    handler: async ({ params }) => {
      const thread = requireThread(params[0]!);
      if (!(await agents.interrupt(thread.id))) {
        throw new HttpError(409, "This server does not own the running session");
      }
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/approvals\/([^/]+)$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      const decision = requireString(body, "decision");
      if (decision !== "allow" && decision !== "always" && decision !== "deny") {
        throw new HttpError(400, "Unknown decision");
      }
      const resolved = await agents.resolveApproval(thread.id, params[1]!, decision);
      if (!resolved) throw new HttpError(410, "Approval is no longer pending");
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/questions\/([^/]+)$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) {
        throw new HttpError(400, "`answers` is required");
      }
      const entries = Object.entries(body.answers as Record<string, unknown>);
      if (
        entries.some(
          ([, value]) =>
            !Array.isArray(value) || !value.every((item) => typeof item === "string"),
        )
      ) {
        throw new HttpError(400, "Every answer must be an array of strings");
      }
      const answers = Object.fromEntries(entries) as Record<string, string[]>;
      const pending = agents.pendingQuestion(thread.id, params[1]!);
      if (!pending) throw new HttpError(410, "Question is no longer pending");
      const expectedIds = new Set(pending.questions.map((question) => question.id));
      if (entries.length !== expectedIds.size || entries.some(([id]) => !expectedIds.has(id))) {
        throw new HttpError(400, "Answers must cover exactly the pending questions");
      }
      for (const question of pending.questions) {
        const selected = answers[question.id] ?? [];
        const offered = new Set(question.options.map((option) => option.id));
        if (
          selected.length === 0 ||
          (!question.allowMultiple && selected.length !== 1) ||
          new Set(selected).size !== selected.length ||
          selected.some((optionId) => !offered.has(optionId))
        ) {
          throw new HttpError(400, `Invalid answer for question "${question.id}"`);
        }
      }
      const resolved = await agents.resolveQuestion(thread.id, params[1]!, answers);
      if (!resolved) throw new HttpError(410, "Question is no longer pending");
      return { ok: true };
    },
  },
];

export async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  const route = routes.find(
    (candidate) => candidate.method === request.method && candidate.pattern.test(url.pathname),
  );
  if (!route) {
    json(response, 404, { error: "Unknown endpoint" });
    return true;
  }

  const match = route.pattern.exec(url.pathname)!;
  try {
    const result = await route.handler({
      request,
      response,
      params: match.slice(1),
      url,
    });
    if (!response.headersSent) json(response, 200, result ?? { ok: true });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error("[api]", error);
    json(response, status, { error: (error as Error).message });
  }
  return true;
}
