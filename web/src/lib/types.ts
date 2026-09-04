// Mirror of server/src/types.ts, plus the shapes the REST endpoints answer with. Change both
// together — nothing checks that they agree.
export type ProviderId = "claude" | "cursor";
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "autoReview"
  | "plan"
  | "ask"
  | "bypassPermissions";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThreadStatus = "idle" | "running" | "error";
export type MessageRole = "user" | "assistant" | "tool" | "system" | "error";
export type ApprovalDecision = "allow" | "always" | "deny";

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
  providerId: ProviderId;
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

// what the CLI is busy with between visible output, for the turn's waiting label
export type ThreadPhase = { kind: "starting" } | { kind: "thinking" } | { kind: "tool"; name: string };

export interface PendingApproval {
  id: string;
  threadId: string;
  toolName: string;
  input: unknown;
  decisions: ApprovalDecision[];
}

export interface PendingQuestion {
  id: string;
  threadId: string;
  title: string | null;
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple: boolean;
  }>;
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

export interface ProviderCapabilities {
  effort: boolean;
  slashCommands: boolean;
  usage: boolean;
  tasks: boolean;
  fork: boolean;
  questions: boolean;
  liveModelSwitch: boolean;
  livePermissionModeSwitch: boolean;
}

export interface ProviderCatalog {
  id: ProviderId;
  label: string;
  models: ModelOption[];
  permissionModes: PermissionModeOption[];
  effortLevels: EffortOption[];
  defaults: { model: string; permissionMode: PermissionMode; effort: Effort };
  capabilities: ProviderCapabilities;
}

export interface AppState {
  projects: Project[];
  threads: Thread[];
  providers: ProviderCatalog[];
  defaultProviderId: ProviderId;
  apps: ExternalApp[];
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
  | { type: "thread.message.updated"; threadId: string; message: Message }
  | { type: "thread.phase"; threadId: string; phase: ThreadPhase | null }
  | { type: "thread.truncated"; threadId: string; seq: number }
  | { type: "thread.delta"; threadId: string; text: string }
  | { type: "thread.delta.end"; threadId: string }
  | { type: "thread.approval"; approval: PendingApproval }
  | { type: "thread.approval.resolved"; threadId: string; approvalId: string }
  | { type: "thread.approvals"; approvals: PendingApproval[] }
  | { type: "thread.question"; question: PendingQuestion }
  | { type: "thread.question.resolved"; threadId: string; questionId: string }
  | { type: "thread.questions"; questions: PendingQuestion[] }
  | { type: "thread.tasks"; threadId: string; tasks: ThreadTask[] }
  | { type: "thread.commands"; threadId: string; commands: SlashCommand[] }
  | { type: "usage"; threadId: string | null; usage: Usage }
  | { type: "resources"; resources: Resources }
  | { type: "thread.updated"; thread: Thread }
  | { type: "provider.changed"; provider: ProviderCatalog }
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

// a column keeps only the values ticked in its checklist
export interface TableFilter {
  column: number;
  values: string[];
}

export interface TableWindow {
  path: string;
  kind: "csv" | "xlsx";
  sheets: string[];
  sheet: number;
  head: string[] | null;
  rows: string[][];
  // the row index in the file for each row above, which a filtered window doesn't imply
  numbers: number[];
  offset: number;
  total: number;
  truncated: boolean;
  filtered: boolean;
  mtimeMs: number;
}

export interface TableValues {
  column: number;
  values: Array<{ value: string; count: number }>;
  truncated: boolean;
}

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

export interface ProviderStatus extends ProviderCatalog {
  state: "ready" | "signed-out" | "missing";
  detail: string;
  version: string | null;
  binary: string | null;
  account: ProviderAccount | null;
  settingSources: string[];
  signInHint: string;
  signInCommand: string;
  logoutCommand: string;
}
