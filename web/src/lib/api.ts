import type {
  AppState,
  ChangedFile,
  DirListing,
  Effort,
  GitSnapshot,
  Message,
  PermissionMode,
  Project,
  ProviderStatus,
  SlashCommand,
  TableWindow,
  Thread,
  ThreadTask,
  TreeEntry,
  Usage,
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
  providers: () => call<{ providers: ProviderStatus[] }>("/api/providers"),
  logoutProvider: (id: string) =>
    post<{ ok: boolean; output: string }>(`/api/providers/${id}/logout`),
  browse: (path?: string) =>
    call<DirListing>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  choosePath: (kind: "folder" | "file") => post<{ path: string | null }>("/api/fs/choose", { kind }),
  upload: async (file: File) => {
    const response = await fetch("/api/uploads", {
      method: "POST",
      headers: { "x-filename": encodeURIComponent(file.name || "attachment") },
      body: file,
    });
    const body = (await response.json()) as { path: string; name: string; url: string; error?: string };
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    return body;
  },
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
    effort?: Effort;
    title?: string;
  }) => post<Thread>("/api/threads", input),
  thread: (id: string) =>
    call<{ thread: Thread; messages: Message[]; tasks: ThreadTask[]; git: GitSnapshot & { diff: { files: number; insertions: number; deletions: number } } }>(
      `/api/threads/${id}`,
    ),
  commands: (cwd: string) =>
    call<{ commands: SlashCommand[] }>(`/api/commands?cwd=${encodeURIComponent(cwd)}`),
  usage: (threadId?: string | null) =>
    call<Usage>(`/api/usage${threadId ? `?thread=${encodeURIComponent(threadId)}` : ""}`),
  threadGit: (id: string) =>
    call<{ branch: string | null; dirty: number; diff: { files: number; insertions: number; deletions: number } }>(
      `/api/threads/${id}/git`,
    ),
  patchThread: (
    id: string,
    patch: {
      title?: string;
      model?: string;
      permissionMode?: PermissionMode;
      effort?: Effort;
      archived?: boolean;
    },
  ) =>
    call<Thread>(`/api/threads/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  changes: (id: string) =>
    call<{ isGit: boolean; branch: string | null; files: ChangedFile[] }>(`/api/threads/${id}/changes`),
  fileDiff: (id: string, file: string, untracked: boolean) =>
    call<{ file: string; diff: string }>(
      `/api/threads/${id}/diff?file=${encodeURIComponent(file)}${untracked ? "&untracked=1" : ""}`,
    ),
  settings: () => call<{ settings: Record<string, string> }>("/api/settings"),
  saveSetting: (key: string, value: string) =>
    call<{ ok: true }>("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    }),
  files: (id: string) => call<{ files: string[] }>(`/api/threads/${id}/files`),
  tree: (id: string, path: string) =>
    call<{ path: string; entries: TreeEntry[] }>(
      `/api/threads/${id}/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  file: (id: string, path: string) =>
    call<{
      path: string;
      text: string;
      binary: boolean;
      truncated: boolean;
      status: ChangedFile["status"] | null;
      diff: string;
    }>(`/api/threads/${id}/file?path=${encodeURIComponent(path)}`),
  table: (id: string, path: string, sheet: number, offset: number, limit: number) =>
    call<TableWindow>(
      `/api/threads/${id}/table?path=${encodeURIComponent(path)}&sheet=${sheet}&offset=${offset}&limit=${limit}`,
    ),
  saveFile: (id: string, path: string, text: string) =>
    call<{ path: string; bytes: number }>(`/api/threads/${id}/file`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, text }),
    }),
  createEntry: (id: string, path: string, kind: "file" | "dir") =>
    post<TreeEntry>(`/api/threads/${id}/fs`, { path, kind }),
  renameEntry: (id: string, path: string, name: string) =>
    call<TreeEntry>(`/api/threads/${id}/fs`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, name }),
    }),
  trashEntry: (id: string, path: string) =>
    call<{ path: string; trashed: boolean }>(`/api/threads/${id}/fs`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    }),
  revealEntry: (id: string, path: string) => post<{ ok: true }>(`/api/threads/${id}/reveal`, { path }),
  openIn: (id: string, app: string) => post<{ ok: true }>(`/api/threads/${id}/open`, { app }),
  forkThread: (id: string) => post<Thread>(`/api/threads/${id}/fork`),
  removeThread: (id: string) => call<{ ok: true }>(`/api/threads/${id}`, { method: "DELETE" }),
  sendTurn: (id: string, text: string) => post<{ ok: true }>(`/api/threads/${id}/turns`, { text }),
  interrupt: (id: string) => post<{ ok: true }>(`/api/threads/${id}/interrupt`),
  respondToApproval: (threadId: string, approvalId: string, decision: "allow" | "always" | "deny") =>
    post<{ ok: true }>(`/api/threads/${threadId}/approvals/${approvalId}`, { decision }),
};
  rewind: (id: string, messageId: string) =>
    post<{ text: string }>(`/api/threads/${id}/rewind`, { messageId }),
