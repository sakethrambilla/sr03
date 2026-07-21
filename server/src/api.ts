import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { forkSession } from "@anthropic-ai/claude-agent-sdk";

import * as claude from "./claude.ts";
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
  saveUpload,
  trashWorkspaceEntry,
  writeWorkspaceFile,
} from "./fsbrowse.ts";
import { messages, projects, threads } from "./db.ts";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  EFFORT_LEVELS,
  listModels,
  PERMISSION_MODES,
  isEffort,
  isPermissionMode,
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
      models: await listModels(),
      permissionModes: PERMISSION_MODES,
      effortLevels: EFFORT_LEVELS,
      apps: await listApps(),
      defaults: {
        model: DEFAULT_MODEL,
        permissionMode: DEFAULT_PERMISSION_MODE,
        effort: DEFAULT_EFFORT,
      },
    }),
  },
  {
    method: "POST",
    pattern: /^\/api\/providers\/([^/]+)\/logout$/,
    handler: ({ params }) => logoutProvider(params[0]!),
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
    handler: ({ params }) => {
      const project = requireProject(params[0]!);
      for (const thread of threads.list().filter((item) => item.projectId === project.id)) {
        claude.closeSession(thread.id);
      }
      projects.remove(project.id);
      publish({ type: "projects.changed" });
      return { ok: true };
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
      const target = requireString(body, "path");
      const info = await git.repoInfo(project.path);
      if (!info.isGit || !info.root) throw new HttpError(400, "Project is not a git repository");
      await git.removeWorktree({ root: info.root, path: target, force: body.force === true });
      await git.pruneWorktrees(info.root);
      publish({ type: "projects.changed" });
      return { ok: true };
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
      const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL;
      const permissionMode = isPermissionMode(body.permissionMode)
        ? body.permissionMode
        : DEFAULT_PERMISSION_MODE;
      const thread = threads.create({
        projectId: project.id,
        effort: isEffort(body.effort) ? body.effort : DEFAULT_EFFORT,
        title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : "New thread",
        cwd,
        branch: info.branch,
        isWorktree: path.resolve(cwd) !== path.resolve(project.path),
        model,
        permissionMode,
      });
      publish({ type: "thread.updated", thread });
      return thread;
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/threads\/([^/]+)$/,
    handler: async ({ params }) => {
      const thread = requireThread(params[0]!);
      const [info, diff] = await Promise.all([git.repoInfo(thread.cwd), git.diffStat(thread.cwd)]);
      return { thread, messages: messages.list(thread.id), git: { ...info, diff } };
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
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      const patch: {
        title?: string;
        model?: string;
        permissionMode?: typeof thread.permissionMode;
        effort?: typeof thread.effort;
        archived?: boolean;
      } = {};
      if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
      if (typeof body.model === "string") patch.model = body.model;
      if (isPermissionMode(body.permissionMode)) patch.permissionMode = body.permissionMode;
      if (isEffort(body.effort)) patch.effort = body.effort;
      if (typeof body.archived === "boolean") patch.archived = body.archived;
      const updated = threads.update(thread.id, patch);
      if (!updated) throw new HttpError(404, "Thread not found");
      await claude.applyThreadSettings(updated, patch);
      publish({ type: "thread.updated", thread: updated });
      return updated;
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/fork$/,
    handler: async ({ params }) => {
      const source = requireThread(params[0]!);
      // the fork gets a session file of its own, so both threads can run without interleaving
      const forked = source.sessionId
        ? await forkSession(source.sessionId, { dir: source.cwd }).catch((error: Error) => {
            throw new HttpError(500, `Could not fork session: ${error.message}`);
          })
        : null;
      const created = threads.create({
        projectId: source.projectId,
        title: `${source.title} (fork)`,
        cwd: source.cwd,
        branch: source.branch,
        isWorktree: source.isWorktree,
        model: source.model,
        permissionMode: source.permissionMode,
        effort: source.effort,
      });
      for (const message of messages.list(source.id)) {
        messages.append({
          threadId: created.id,
          role: message.role,
          text: message.text,
          meta: message.meta,
        });
      }
      const thread = threads.update(created.id, { sessionId: forked?.sessionId ?? null }) ?? created;
      publish({ type: "thread.updated", thread });
      return thread;
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/threads\/([^/]+)$/,
    handler: ({ params }) => {
      const thread = requireThread(params[0]!);
      claude.closeSession(thread.id);
      pty.closeThread(thread.id);
      threads.remove(thread.id);
      publish({ type: "projects.changed" });
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/turns$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      if (thread.status === "running") throw new HttpError(409, "Turn already running");
      const body = await readBody(request);
      const text = requireString(body, "text");
      if (thread.title === "New thread") {
        const title = text.split("\n")[0]!.slice(0, 60);
        const renamed = threads.update(thread.id, { title });
        if (renamed) publish({ type: "thread.updated", thread: renamed });
      }
      claude.sendTurn(requireThread(thread.id), text);
      return { ok: true };
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/threads\/([^/]+)\/interrupt$/,
    handler: async ({ params }) => {
      const thread = requireThread(params[0]!);
      await claude.interrupt(thread.id);
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
      const resolved = claude.resolveApproval(thread.id, params[1]!, decision);
      if (!resolved) throw new HttpError(410, "Approval is no longer pending");
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
