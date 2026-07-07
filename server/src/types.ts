export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export type ThreadStatus = "idle" | "running" | "error";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

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

export type MessageRole = "user" | "assistant" | "tool" | "system" | "error";

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

export type ServerEvent =
  | { type: "thread.status"; threadId: string; status: ThreadStatus; sessionId?: string | null }
  | { type: "thread.message"; threadId: string; message: Message }
  | { type: "thread.delta"; threadId: string; text: string }
  | { type: "thread.delta.end"; threadId: string }
  | { type: "thread.approval"; approval: PendingApproval }
  | { type: "thread.approval.resolved"; threadId: string; approvalId: string }
  | { type: "thread.updated"; thread: Thread }
  | { type: "pty.data"; threadId: string; data: string }
  | { type: "pty.snapshot"; threadId: string; data: string }
  | { type: "pty.exit"; threadId: string; code: number }
  | { type: "projects.changed" };

// the only traffic that flows client -> server over the socket; everything else is REST
export type ClientMessage =
  | { type: "pty.open"; threadId: string; cols: number; rows: number }
  | { type: "pty.input"; threadId: string; data: string }
  | { type: "pty.resize"; threadId: string; cols: number; rows: number }
  | { type: "pty.close"; threadId: string };
