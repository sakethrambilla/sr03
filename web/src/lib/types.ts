export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThreadStatus = "idle" | "running" | "error";
export type MessageRole = "user" | "assistant" | "tool" | "system" | "error";

export interface Project {
  id: string;
  path: string;
  name: string;
  isGit: boolean;
  createdAt: number;
}

export interface Thread {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  branch: string | null;
  isWorktree: boolean;
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
  sessionId: string | null;
  status: ThreadStatus;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  seq: number;
  role: MessageRole;
  text: string;
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export interface PendingApproval {
  id: string;
  threadId: string;
  toolName: string;
  input: unknown;
}

export interface ModelOption {
  slug: string;
  label: string;
  hint: string;
}

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

export interface EffortOption {
  value: Effort;
  label: string;
  hint: string;
}

export interface AppState {
  projects: Project[];
  threads: Thread[];
  models: ModelOption[];
  permissionModes: PermissionModeOption[];
  effortLevels: EffortOption[];
  defaults: { model: string; permissionMode: PermissionMode; effort: Effort };
}

export interface Branch {
  name: string;
  isCurrent: boolean;
  worktreePath: string | null;
}

export interface Worktree {
  path: string;
  branch: string | null;
  isMain: boolean;
}


export interface GitSnapshot {
  isGit: boolean;
  root?: string;
  branch?: string | null;
  dirty?: number;
  branches: Branch[];
  worktrees: Worktree[];
}

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

export type ServerEvent =
  | { type: "thread.status"; threadId: string; status: ThreadStatus; sessionId?: string | null }
  | { type: "thread.message"; threadId: string; message: Message }
  | { type: "thread.delta"; threadId: string; text: string }
  | { type: "thread.delta.end"; threadId: string }
  | { type: "thread.approval"; approval: PendingApproval }
  | { type: "thread.approval.resolved"; threadId: string; approvalId: string }
  | { type: "thread.updated"; thread: Thread }
  | { type: "projects.changed" };


