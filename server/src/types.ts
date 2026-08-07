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

// a subagent the turn spawned, folded from the SDK's task_started/progress/updated stream
export interface ThreadTask {
  id: string;
  description: string;
  agentType: string | null;
  status: "running" | "done" | "failed";
  tokens: number;
  toolUses: number;
  lastTool: string | null;
  error: string | null;
  depth: number;
  startedAt: number;
  endedAt: number | null;
}

// one row of the CLI's slash-command list: built-ins, skills, and the folder's own commands
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

// one plan rate-limit window, as the /usage control request reports it
export interface UsageWindow {
  id: string;
  label: string;
  utilization: number;
  resetsAt: number | null;
}

export interface Usage {
  context: { used: number; max: number; percentage: number } | null;
  sessionCostUsd: number | null;
  plan: string | null;
  windows: UsageWindow[];
  credits: { spent: number | null; limit: number | null; currency: string | null } | null;
  updatedAt: number;
}

export type ServerEvent =
  | { type: "thread.status"; threadId: string; status: ThreadStatus; sessionId?: string | null }
  | { type: "thread.message"; threadId: string; message: Message }
  | { type: "thread.delta"; threadId: string; text: string }
  | { type: "thread.delta.end"; threadId: string }
  | { type: "thread.approval"; approval: PendingApproval }
  | { type: "thread.approval.resolved"; threadId: string; approvalId: string }
  | { type: "thread.approvals"; approvals: PendingApproval[] }
  | { type: "thread.tasks"; threadId: string; tasks: ThreadTask[] }
  | { type: "thread.commands"; threadId: string; commands: SlashCommand[] }
  | { type: "usage"; threadId: string | null; usage: Usage }
  | { type: "thread.updated"; thread: Thread }
  | { type: "pty.data"; threadId: string; terminalId: string; data: string }
  | { type: "pty.snapshot"; threadId: string; terminalId: string; data: string }
  | { type: "pty.terminals"; threadId: string; ids: string[] }
  | { type: "pty.created"; threadId: string; terminalId: string }
  | { type: "pty.exit"; threadId: string; terminalId: string; code: number }
  | { type: "projects.changed" };

// the only traffic that flows client -> server over the socket; everything else is REST
export type ClientMessage =
  | { type: "pty.list"; threadId: string }
  | { type: "pty.create"; threadId: string; cols: number; rows: number }
  | { type: "pty.open"; threadId: string; terminalId: string; cols: number; rows: number }
  | { type: "pty.input"; threadId: string; terminalId: string; data: string }
  | { type: "pty.resize"; threadId: string; terminalId: string; cols: number; rows: number }
  | { type: "pty.close"; threadId: string; terminalId: string };
