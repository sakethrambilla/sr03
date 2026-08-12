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

export interface ModelOption {
  slug: string;
  label: string;
  hint: string;
  resolved?: string;
}

export interface PermissionModeOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

export interface ExternalApp {
  id: string;
  label: string;
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
  apps: ExternalApp[];
  defaults: { model: string; permissionMode: PermissionMode; effort: Effort };
}

// one row of the CLI's slash-command list: built-ins, skills, and the folder's own commands
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
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

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  staged: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
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
  windowsAt: number | null;
}

// one attributable slice of the process tree: a thread's agent, a thread's terminals, or the
// leftovers the server spawned for itself
export interface ResourceGroup {
  id: string;
  title: string;
  kind: "agent" | "terminal" | "other";
  rss: number;
  cpu: number;
  processes: number;
}

export interface Resources {
  at: number;
  total: { rss: number; cpu: number; processes: number };
  server: { rss: number; cpu: number; heapUsed: number; external: number };
  shell: { rss: number; cpu: number; processes: number } | null;
  groups: ResourceGroup[];
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
  | { type: "resources"; resources: Resources }
  | { type: "thread.updated"; thread: Thread }
  | { type: "pty.data"; threadId: string; terminalId: string; data: string }
  | { type: "pty.snapshot"; threadId: string; terminalId: string; data: string }
  | { type: "pty.terminals"; threadId: string; ids: string[] }
  | { type: "pty.created"; threadId: string; terminalId: string }
  | { type: "pty.exit"; threadId: string; terminalId: string; code: number }
  | { type: "projects.changed" };

export type ClientMessage =
  | { type: "resources.watch"; on: boolean }
  | { type: "pty.list"; threadId: string }
  | { type: "pty.create"; threadId: string; cols: number; rows: number }
  | { type: "pty.open"; threadId: string; terminalId: string; cols: number; rows: number }
  | { type: "pty.input"; threadId: string; terminalId: string; data: string }
  | { type: "pty.resize"; threadId: string; terminalId: string; cols: number; rows: number }
  | { type: "pty.close"; threadId: string; terminalId: string };

export interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  ignored: boolean;
}

export interface ProviderAccount {
  email: string | null;
  organization: string | null;
  plan: string | null;
}

export interface ProviderStatus {
  id: string;
  label: string;
  state: "ready" | "signed-out" | "missing";
  detail: string;
  version: string | null;
  binary: string | null;
  account: ProviderAccount | null;
  settingSources: string[];
  models: ModelOption[];
  defaults: { model: string; permissionMode: string; effort: string };
  signInHint: string;
}
