// The wire contract: the rows db.ts stores, and every event that crosses the socket in either
// direction. Mirrored in web/src/lib/types.ts — change both together.
export type ProviderId = "claude" | "cursor";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "autoReview"
  | "plan"
  | "ask"
  | "bypassPermissions";

export type ThreadStatus = "idle" | "running" | "error";

// Ordered faint-to-deep; a provider exposes whichever subset its selected model supports.
export type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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

export type EditorTab = { kind: "chat" } | { kind: "file"; path: string };

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

// what the CLI is busy with between visible output, for the turn's waiting label
export type ThreadPhase = { kind: "starting" } | { kind: "thinking" } | { kind: "tool"; name: string };

export interface QuestionOption {
  label: string;
  description: string;
}

// one AskUserQuestion question; `question` is also the key the SDK looks its answer up by
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

// a subagent the turn spawned, folded from the SDK's task_started/progress/updated stream
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
}

// one row of the CLI's slash-command list: built-ins, skills, and the folder's own commands
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
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
  | { type: "defaults.changed"; defaults: { model: string; permissionMode: PermissionMode; effort: Effort } }
  | { type: "pty.data"; threadId: string; terminalId: string; data: string }
  | { type: "pty.snapshot"; threadId: string; terminalId: string; data: string }
  | { type: "pty.terminals"; threadId: string; ids: string[] }
  | { type: "pty.created"; threadId: string; terminalId: string }
  | { type: "pty.exit"; threadId: string; terminalId: string; code: number }
  | { type: "projects.changed" };

// the only traffic that flows client -> server over the socket; everything else is REST
export type ClientMessage =
  | { type: "resources.watch"; on: boolean }
  | { type: "pty.list"; threadId: string }
  | { type: "pty.create"; threadId: string; cols: number; rows: number }
  | { type: "pty.open"; threadId: string; terminalId: string; cols: number; rows: number }
  | { type: "pty.input"; threadId: string; terminalId: string; data: string }
  | { type: "pty.resize"; threadId: string; terminalId: string; cols: number; rows: number }
  | { type: "pty.close"; threadId: string; terminalId: string };
