import type {
  AppState,
  DirListing,
  GitSnapshot,
  Message,
  PermissionMode,
  Project,
  Thread,
  Worktree,
} from "./types.ts";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? response.statusText);
  return body;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });

export const api = {
  state: () => call<AppState>("/api/state"),
  browse: (path?: string) =>
    call<DirListing>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  addProject: (path: string) => post<Project>("/api/projects", { path }),
  removeProject: (id: string) => call<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),
  git: (projectId: string) => call<GitSnapshot>(`/api/projects/${projectId}/git`),
  addWorktree: (projectId: string, input: { branch: string; createBranch: boolean; base?: string }) =>
    post<Worktree>(`/api/projects/${projectId}/worktrees`, input),
  removeWorktree: (projectId: string, path: string, force = false) =>
    call<{ ok: true }>(`/api/projects/${projectId}/worktrees`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, force }),
    }),
  createThread: (input: {
    projectId: string;
    cwd?: string;
    model?: string;
    permissionMode?: PermissionMode;
    title?: string;
  }) => post<Thread>("/api/threads", input),
  thread: (id: string) =>
    call<{ thread: Thread; messages: Message[]; git: GitSnapshot & { diff: { files: number; insertions: number; deletions: number } } }>(
      `/api/threads/${id}`,
    ),
  threadGit: (id: string) =>
    call<{ branch: string | null; dirty: number; diff: { files: number; insertions: number; deletions: number } }>(
      `/api/threads/${id}/git`,
    ),
  patchThread: (id: string, patch: { title?: string; model?: string; permissionMode?: PermissionMode }) =>
    call<Thread>(`/api/threads/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  removeThread: (id: string) => call<{ ok: true }>(`/api/threads/${id}`, { method: "DELETE" }),
  sendTurn: (id: string, text: string) => post<{ ok: true }>(`/api/threads/${id}/turns`, { text }),
  interrupt: (id: string) => post<{ ok: true }>(`/api/threads/${id}/interrupt`),
  respondToApproval: (threadId: string, approvalId: string, decision: "allow" | "always" | "deny") =>
    post<{ ok: true }>(`/api/threads/${threadId}/approvals/${approvalId}`, { decision }),
};
