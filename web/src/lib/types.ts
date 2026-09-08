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
// Ordered faint-to-deep; a provider exposes whichever subset its selected model supports.
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThreadStatus = "idle" | "running" | "error";
export type MessageRole = "user" | "assistant" | "tool" | "system" | "error";

export interface Project {
  id: string;
  path: string;
  name: string;
  isGit: boolean;
  createdAt: number;
}

// The editor area as a flat row or column of one to three groups. A tab is tagged rather than a
// bare string so the transcript can never collide with a file that happens to be named "chat".
// `active` indexes into the group's own `tabs`; `sizes` is one fraction per group, parallel to
// `groups`.
export type LayoutAxis = "horizontal" | "vertical";

// the subagent variant is client-only and deliberately absent from server/src/types.ts —
// the server's layout guard should keep rejecting it
export type EditorTab =
  | { kind: "chat" }
  | { kind: "file"; path: string }
  | { kind: "subagent"; taskId: string };

export interface EditorGroup {
  id: string;
  tabs: EditorTab[];
  active: number;
}

export interface EditorLayout {
  axis: LayoutAxis;
  groups: EditorGroup[];
  sizes: number[];
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
  fast: boolean;
  sessionId: string | null;
  status: ThreadStatus;
  archived: boolean;
  layout: EditorLayout | null;
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

export interface QuestionOption {
  label: string;
  description: string;
}

// one AskUserQuestion question; `question` is also the key its answer is sent back under
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface PendingApproval {
  id: string;
  threadId: string;
  toolName: string;
  input: unknown;
  decisions: Array<"allow" | "always" | "deny">;
  // set only for AskUserQuestion, which is answered rather than allowed or denied
  questions?: Question[];
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

// answers are keyed by question text, which is what the CLI looks them up by
export type ApprovalDecision = "allow" | "always" | "deny" | { answers: Record<string, string> };

export interface ThreadTask {
  id: string;
  description: string;
  agentType: string | null;
  model: string | null;
  status: "running" | "done" | "failed" | "stopped";
  tokens: number;
  toolUses: number;
  lastTool: string | null;
  error: string | null;
  depth: number;
  startedAt: number;
  endedAt: number | null;
  // Agent/Task tool_use_id that spawned this row; Claude's id is the SDK task_id, which differs
  toolUseId: string | null;
}

export interface ModelOption {
  slug: string;
  label: string;
  hint: string;
  resolved?: string;
  // set only where a provider scopes these to the model — Cursor does, Claude Code does not
  effortLevels?: EffortOption[];
  defaultEffort?: Effort;
  fast?: FastOption;
}

export interface FastOption {
  hint: string;
  default: boolean;
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
  // the provider-native pair this rung maps to, where the wire value isn't the native one
  native?: { configId: string; value: string };
}

export interface ProviderCapabilities {
  effort: boolean;
  fast: boolean;
  slashCommands: boolean;
  usage: boolean;
  tasks: boolean;
  subagentTranscripts: boolean;
  stopSubagents: boolean;
  fork: boolean;
  questions: boolean;
  liveModelSwitch: boolean;
  livePermissionModeSwitch: boolean;
  liveEffortSwitch: boolean;
  liveFastSwitch: boolean;
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
  defaults: { model: string; permissionMode: PermissionMode; effort: Effort };
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
  locked: boolean;
  lockReason: string | null;
  favorite: boolean;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  staged: boolean;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number;
  message: string;
}

export interface Ref {
  name: string;
  kind: "head" | "tag" | "remote";
  commit: string;
}

export interface CommitFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
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
  | { type: "thread.task.delta"; threadId: string; taskId: string; text: string }
  | { type: "thread.task.delta.end"; threadId: string; taskId: string }
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
  | { type: "provider.status"; status: ProviderStatus }
  | { type: "defaults.changed"; defaults: { model: string; permissionMode: PermissionMode; effort: Effort } }
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

export interface TextMatch {
  path: string;
  line: number;
  text: string;
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
