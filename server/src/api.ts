import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import * as claude from "./claude.ts";
import * as git from "./git.ts";
import { listDirectory, isDirectory } from "./fsbrowse.ts";
import { messages, projects, threads } from "./db.ts";
import {
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  MODELS,
  PERMISSION_MODES,
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
    handler: () => ({
      projects: projects.list(),
      threads: threads.list(),
      models: MODELS,
      permissionModes: PERMISSION_MODES,
      defaults: { model: DEFAULT_MODEL, permissionMode: DEFAULT_PERMISSION_MODE },
    }),
  },
  {
    method: "GET",
    pattern: /^\/api\/fs$/,
    handler: ({ url }) => listDirectory(url.searchParams.get("path") ?? undefined),
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
    method: "PATCH",
    pattern: /^\/api\/threads\/([^/]+)$/,
    handler: async ({ params, request }) => {
      const thread = requireThread(params[0]!);
      const body = await readBody(request);
      const patch: { title?: string; model?: string; permissionMode?: typeof thread.permissionMode } = {};
      if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
      if (typeof body.model === "string") patch.model = body.model;
      if (isPermissionMode(body.permissionMode)) patch.permissionMode = body.permissionMode;
      const updated = threads.update(thread.id, patch);
      if (!updated) throw new HttpError(404, "Thread not found");
      await claude.applyThreadSettings(updated, patch);
      publish({ type: "thread.updated", thread: updated });
      return updated;
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/threads\/([^/]+)$/,
    handler: ({ params }) => {
      const thread = requireThread(params[0]!);
      claude.closeSession(thread.id);
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
    json(response, 200, result ?? { ok: true });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error("[api]", error);
    json(response, status, { error: (error as Error).message });
  }
  return true;
}
