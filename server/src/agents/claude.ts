// Claude Code provider adapter. Agent SDK frames are normalized into AgentEvent values; the
// provider-neutral runtime owns persistence, WebSocket projection, parking, and thread status.
import { randomUUID } from "node:crypto";
import {
  forkSession as forkClaudeSession,
  query,
  type CanUseTool,
  type PermissionUpdate,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKRateLimitInfo,
  type EffortLevel,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { usage as usageStore } from "../db.ts";
import type {
  ApprovalDecision,
  Effort,
  PendingApproval,
  Question,
  QuestionOption,
  SlashCommand,
  Thread,
  ThreadTask,
  Usage,
  UsageWindow,
} from "../types.ts";
import type {
  AgentEventSink,
  AgentProvider,
  AgentSession,
  AgentSettingsPatch,
} from "./types.ts";

// `Effort` spans every provider's ladder; the SDK accepts only Claude Code's five rungs
const CLAUDE_EFFORT_LEVELS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

function claudeEffort(effort: Effort): EffortLevel | null {
  return CLAUDE_EFFORT_LEVELS.has(effort) ? (effort as EffortLevel) : null;
}

interface InputQueue extends AsyncIterable<SDKUserMessage> {
  push(message: SDKUserMessage): void;
  end(): void;
}

type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

interface ClaudeSession {
  threadId: string;
  cwd: string;
  sessionId: string;
  input: InputQueue;
  query: Query;
  abort: AbortController;
  emit: AgentEventSink;
  approvals: Map<
    string,
    { approval: PendingApproval; resolve: (decision: ApprovalDecision) => void }
  >;
  alwaysAllow: Set<string>;
  interrupted: boolean;
  stopped: boolean;
  busy: boolean;
  subagentTasks: Map<string, string>;
}

function createInputQueue(): InputQueue {
  const buffer: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(message) {
      buffer.push(message);
      wake?.();
      wake = null;
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = buffer.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

const sessions = new Map<string, ClaudeSession>();

type SystemMessage = Extract<SDKMessage, { type: "system" }>;
const tasksByThread = new Map<string, Map<string, ThreadTask>>();
const TASK_STATUS: Record<string, ThreadTask["status"]> = {
  pending: "running",
  running: "running",
  paused: "running",
  completed: "done",
  failed: "failed",
  killed: "failed",
  stopped: "stopped",
};

function saveTask(session: ClaudeSession, task: ThreadTask): void {
  const tasks = tasksByThread.get(session.threadId) ?? new Map<string, ThreadTask>();
  tasks.set(task.id, task);
  tasksByThread.set(session.threadId, tasks);
  session.emit({ type: "tasks.changed", tasks: [...tasks.values()] });
}

function trackTask(session: ClaudeSession, message: SystemMessage): void {
  const known = (id: string) => tasksByThread.get(session.threadId)?.get(id) ?? null;
  switch (message.subtype) {
    case "task_started":
      if (message.ambient || (!message.subagent_type && message.task_type !== "local_agent")) return;
      if (typeof message.tool_use_id === "string") {
        session.subagentTasks.set(message.tool_use_id, message.task_id);
      }
      saveTask(session, {
        id: message.task_id,
        description: message.description,
        agentType: message.subagent_type ?? null,
        model: null,
        status: "running",
        tokens: 0,
        toolUses: 0,
        lastTool: null,
        error: null,
        depth: message.spawn_depth ?? 1,
        startedAt: Date.now(),
        endedAt: null,
      });
      return;
    case "task_progress": {
      const task = known(message.task_id);
      if (!task) return;
      saveTask(session, {
        ...task,
        description: message.description || task.description,
        agentType: message.subagent_type ?? task.agentType,
        model: null,
        tokens: message.usage.total_tokens,
        toolUses: message.usage.tool_uses,
        lastTool: message.last_tool_name ?? task.lastTool,
      });
      return;
    }
    case "task_updated": {
      const task = known(message.task_id);
      if (!task) return;
      const status = message.patch.status ? TASK_STATUS[message.patch.status] : task.status;
      saveTask(session, {
        ...task,
        status: status ?? task.status,
        description: message.patch.description ?? task.description,
        error: message.patch.error ?? task.error,
        endedAt: status === "running" ? null : (message.patch.end_time ?? task.endedAt ?? Date.now()),
      });
      return;
    }
    case "task_notification": {
      const task = known(message.task_id);
      if (task) {
        saveTask(session, {
          ...task,
          status: TASK_STATUS[message.status] ?? task.status,
          tokens: message.usage?.total_tokens ?? task.tokens,
          toolUses: message.usage?.tool_uses ?? task.toolUses,
          endedAt: task.endedAt ?? Date.now(),
        });
      }
      wakeIfIdle(session, message.ambient === true);
      return;
    }
    default:
      return;
  }
}

function taskOf(
  session: ClaudeSession,
  parentToolUseId: string | null | undefined,
): string | undefined {
  return parentToolUseId ? session.subagentTasks.get(parentToolUseId) : undefined;
}

// the CLI backgrounds a task and lets the turn end right away — its result lands as a
// task_notification with no turn open to hear it, so nothing would ever prompt the model to
// report back. This nudges it the same way typing "continue" does, just without the wait.
function wakeIfIdle(session: ClaudeSession, ambient: boolean): void {
  if (ambient || session.busy || session.stopped) return;
  session.busy = true;
  session.emit({ type: "notice", text: "Resumed automatically — a background task finished" });
  session.emit({ type: "turn.active" });
  session.input.push({
    type: "user",
    session_id: session.sessionId,
    parent_tool_use_id: null,
    isSynthetic: true,
    origin: { kind: "auto-continuation" },
    message: { role: "user", content: "A background task just finished. Continue." },
  } as SDKUserMessage);
}

function settleTasks(session: ClaudeSession): void {
  const tasks = tasksByThread.get(session.threadId);
  if (!tasks) return;
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    saveTask(session, {
      ...task,
      status: session.interrupted ? "failed" : "done",
      endedAt: Date.now(),
    });
  }
}

let limits: Pick<Usage, "plan" | "windows" | "credits"> | null = null;
let limitsAt: number | null = null;
const contextByThread = new Map<string, NonNullable<Usage["context"]>>();
const costByThread = new Map<string, number>();
const ACCOUNT_ROW = "account";

interface StoredThreadUsage {
  context: NonNullable<Usage["context"]> | null;
  cost: number | null;
}

for (const row of usageStore.all()) {
  try {
    if (row.id === ACCOUNT_ROW) {
      limits = JSON.parse(row.json) as NonNullable<typeof limits>;
      limitsAt = row.updatedAt;
      continue;
    }
    const stored = JSON.parse(row.json) as StoredThreadUsage;
    if (stored.context) contextByThread.set(row.id, stored.context);
    if (typeof stored.cost === "number") costByThread.set(row.id, stored.cost);
  } catch {
    // An unreadable row is a cold meter, not a reason to fail startup.
  }
}

function persistLimits(): void {
  if (!limits) return;
  limitsAt = Date.now();
  usageStore.set(ACCOUNT_ROW, JSON.stringify(limits));
}

function persistThread(threadId: string): void {
  const stored: StoredThreadUsage = {
    context: contextByThread.get(threadId) ?? null,
    cost: costByThread.get(threadId) ?? null,
  };
  if (!stored.context && stored.cost === null) return;
  usageStore.set(threadId, JSON.stringify(stored));
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly · all models",
  seven_day_oauth_apps: "Weekly · apps",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  seven_day_overage_included: "Weekly · extra usage",
  overage: "Extra usage",
};

const RESPONSE_WINDOWS = [
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
] as const;

function millis(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

function readLimits(response: SDKControlGetUsageResponse): Pick<Usage, "plan" | "windows" | "credits"> {
  const rates = response.rate_limits;
  const windows: UsageWindow[] = [];
  for (const id of RESPONSE_WINDOWS) {
    const window = rates?.[id];
    if (typeof window?.utilization !== "number") continue;
    windows.push({
      id,
      label: WINDOW_LABELS[id]!,
      utilization: window.utilization,
      resetsAt: millis(window.resets_at),
    });
  }
  for (const window of rates?.model_scoped ?? []) {
    if (typeof window.utilization !== "number") continue;
    windows.push({
      id: `model:${window.display_name}`,
      label: `Weekly · ${window.display_name}`,
      utilization: window.utilization,
      resetsAt: millis(window.resets_at),
    });
  }
  const extra = rates?.extra_usage;
  return {
    plan: response.subscription_type,
    windows,
    credits: extra?.is_enabled
      ? {
          spent: typeof extra.used_credits === "number" ? extra.used_credits / 100 : null,
          limit: typeof extra.monthly_limit === "number" ? extra.monthly_limit / 100 : null,
          currency: extra.currency ?? null,
        }
      : null,
  };
}

function usageSnapshot(threadId: string | null): Usage {
  return {
    context: (threadId ? contextByThread.get(threadId) : null) ?? null,
    sessionCostUsd: (threadId ? costByThread.get(threadId) : null) ?? null,
    plan: limits?.plan ?? null,
    windows: limits?.windows ?? [],
    credits: limits?.credits ?? null,
    windowsAt: limits ? limitsAt : null,
  };
}

async function readUsage(threadId: string | null): Promise<Usage> {
  const own = threadId ? (sessions.get(threadId) ?? null) : null;
  const any = own ?? [...sessions.values()][0] ?? null;
  if (own) {
    await own.query
      .getContextUsage({ detail: "summary" })
      .then((context) =>
        contextByThread.set(own.threadId, {
          used: context.totalTokens,
          max: context.rawMaxTokens,
          percentage: context.percentage,
        }),
      )
      .catch(() => undefined);
  }
  if (any) {
    await any.query
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
      .then((usage) => {
        limits = readLimits(usage);
        persistLimits();
        if (own) costByThread.set(own.threadId, usage.session.total_cost_usd);
      })
      .catch(() => undefined);
  }
  if (own) persistThread(own.threadId);
  return usageSnapshot(threadId);
}

function foldRateLimit(session: ClaudeSession, info: SDKRateLimitInfo): void {
  const id = info.rateLimitType;
  if (!id || typeof info.utilization !== "number") return;
  const resetsAt = info.resetsAt
    ? info.resetsAt < 1e12
      ? info.resetsAt * 1000
      : info.resetsAt
    : null;
  const window = {
    id,
    label: WINDOW_LABELS[id] ?? id,
    utilization: info.utilization,
    resetsAt,
  };
  const known = limits?.windows ?? [];
  limits = {
    plan: limits?.plan ?? null,
    credits: limits?.credits ?? null,
    windows: known.some((entry) => entry.id === id)
      ? known.map((entry) => (entry.id === id ? window : entry))
      : [...known, window],
  };
  persistLimits();
  session.emit({ type: "usage", usage: usageSnapshot(session.threadId) });
}

const terminalOnly = new Set<string>();
const commandsByCwd = new Map<string, Promise<SlashCommand[]>>();

function toCommands(commands: SlashCommand[]): SlashCommand[] {
  return commands
    .filter((command) => !terminalOnly.has(command.name))
    .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readCommands(cwd: string): Promise<SlashCommand[]> {
  const session = query({
    prompt: (async function* () {})(),
    options: {
      cwd,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
    },
  });
  try {
    return toCommands(await session.supportedCommands());
  } finally {
    session.close();
  }
}

function cachedCommands(cwd: string): Promise<SlashCommand[]> {
  const known = commandsByCwd.get(cwd);
  if (known) return known;
  const pending = readCommands(cwd).catch((error: Error) => {
    console.error(`[commands:claude] ${error.message}`);
    commandsByCwd.delete(cwd);
    return [];
  });
  commandsByCwd.set(cwd, pending);
  return pending;
}

function listCommands(cwd: string): Promise<SlashCommand[]> {
  const live = [...sessions.values()].find((session) => session.cwd === cwd);
  if (!live) return cachedCommands(cwd);
  return live.query.supportedCommands().then(toCommands).catch(() => cachedCommands(cwd));
}

// the CLI routes this one through canUseTool in every permission mode, unlike every other tool —
// so the question panel is reached even under acceptEdits and bypassPermissions
const ASK = "AskUserQuestion";

function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.flatMap((entry): Question[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const question = typeof value.question === "string" ? value.question : "";
    if (!question) return [];
    const options = (Array.isArray(value.options) ? value.options : []).flatMap(
      (option): QuestionOption[] => {
        if (!option || typeof option !== "object") return [];
        const label = (option as Record<string, unknown>).label;
        const description = (option as Record<string, unknown>).description;
        if (typeof label !== "string" || label.length === 0) return [];
        return [{ label, description: typeof description === "string" ? description : "" }];
      },
    );
    return [
      {
        question,
        header: typeof value.header === "string" ? value.header : "Question",
        options,
        multiSelect: value.multiSelect === true,
      },
    ];
  });
}

function makeCanUseTool(session: ClaudeSession): CanUseTool {
  return async (toolName, input, options) => {
    // a question is answered, never blanket-allowed, so alwaysAllow must not swallow it
    const questions = toolName === ASK ? parseQuestions(input) : [];
    const asking = questions.length > 0;
    if (!asking && session.alwaysAllow.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    const approval: PendingApproval = {
      id: randomUUID(),
      threadId: session.threadId,
      toolName,
      input,
      decisions: ["allow", "always", "deny"],
      ...(asking ? { questions } : {}),
    };
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      session.approvals.set(approval.id, { approval, resolve });
      session.emit({ type: "approval.requested", approval });
      options.signal.addEventListener("abort", () => {
        if (!session.approvals.delete(approval.id)) return;
        resolve("deny");
      });
    });
    if (typeof decision === "object") {
      return { behavior: "allow", updatedInput: { questions: input.questions, answers: decision.answers } };
    }
    if (decision === "deny") {
      return { behavior: "deny", message: asking ? "Question dismissed by user." : "Denied by user." };
    }
    if (decision === "always") {
      session.alwaysAllow.add(toolName);
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: (options.suggestions ?? []) as PermissionUpdate[],
      };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string"
        ? value.text
        : `[${String(value.type ?? "content")}]`;
    })
    .join("\n");
}

function handleMessage(session: ClaudeSession, message: SDKMessage): void {
  if (
    (message.type === "stream_event" || message.type === "assistant") &&
    !("parent_tool_use_id" in message && message.parent_tool_use_id)
  ) {
    session.emit({ type: "turn.active" });
  }
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        for (const name of message.terminal_slash_commands ?? []) terminalOnly.add(name);
        session.sessionId = message.session_id;
        session.emit({ type: "session.started", sessionId: message.session_id });
      } else if (message.subtype === "commands_changed") {
        session.emit({ type: "commands.changed", commands: toCommands(message.commands) });
      } else if (message.subtype === "local_command_output") {
        session.emit({ type: "assistant.complete", text: message.content });
      } else {
        trackTask(session, message);
      }
      return;
    case "stream_event": {
      const taskId = taskOf(session, message.parent_tool_use_id);
      const scoped = taskId ? { taskId } : {};
      const event = message.event;
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "thinking")
          session.emit({ type: "phase", phase: { kind: "thinking" }, ...scoped });
        else if (block.type === "tool_use")
          session.emit({ type: "phase", phase: { kind: "tool", name: block.name }, ...scoped });
        else if (block.type === "text") session.emit({ type: "phase", phase: null, ...scoped });
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        session.emit({ type: "assistant.delta", text: event.delta.text, ...scoped });
      }
      return;
    }
    case "assistant": {
      const taskId = taskOf(session, message.parent_tool_use_id);
      const scoped = taskId ? { taskId } : {};
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          session.emit({ type: "assistant.complete", text: block.text, ...scoped });
        } else if (block.type === "tool_use") {
          session.emit({
            type: "tool.started",
            callId: block.id,
            name: block.name,
            input: block.input,
            ...scoped,
          });
        }
      }
      return;
    }
    case "user": {
      if (typeof message.message.content === "string") return;
      const taskId = taskOf(session, message.parent_tool_use_id);
      const scoped = taskId ? { taskId } : {};
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        session.emit({
          type: "tool.completed",
          callId: block.tool_use_id,
          result: toolResultText(block.content),
          isError: block.is_error === true,
          ...scoped,
        });
      }
      return;
    }
    case "rate_limit_event":
      foldRateLimit(session, message.rate_limit_info);
      return;
    case "result":
      settleTasks(session);
      session.busy = false;
      session.emit({
        type: "turn.completed",
        ...(session.interrupted || message.subtype === "success"
          ? {}
          : { error: `Turn ended: ${message.subtype}`, errorCode: message.subtype }),
      });
      session.interrupted = false;
      return;
    default:
      return;
  }
}

async function pump(session: ClaudeSession): Promise<void> {
  try {
    for await (const message of session.query) handleMessage(session, message);
  } catch (error) {
    if (!session.stopped && session.interrupted) {
      settleTasks(session);
      session.busy = false;
      session.emit({ type: "turn.completed" });
      session.interrupted = false;
    } else if (!session.stopped) {
      session.emit({
        type: "session.error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);
  }
}

function closeNativeSession(session: ClaudeSession): void {
  if (session.stopped) return;
  session.stopped = true;
  for (const pending of session.approvals.values()) pending.resolve("deny");
  session.approvals.clear();
  session.input.end();
  session.query.close();
  session.abort.abort();
  if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);
}

async function open(
  thread: Thread,
  emit: AgentEventSink,
  signal: AbortSignal,
): Promise<AgentSession> {
  const abort = new AbortController();
  const input = createInputQueue();
  const session: ClaudeSession = {
    threadId: thread.id,
    cwd: thread.cwd,
    sessionId: thread.sessionId ?? "",
    input,
    abort,
    emit,
    approvals: new Map(),
    alwaysAllow: new Set(),
    interrupted: false,
    stopped: false,
    busy: false,
    subagentTasks: new Map(),
    query: undefined as unknown as Query,
  };
  const effort = claudeEffort(thread.effort);
  session.query = query({
    prompt: input,
    options: {
      cwd: thread.cwd,
      model: thread.model,
      permissionMode: thread.permissionMode as ClaudePermissionMode,
      ...(effort ? { effort } : {}),
      includePartialMessages: true,
      forwardSubagentText: true,
      abortController: abort,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      canUseTool: makeCanUseTool(session),
      ...(thread.sessionId ? { resume: thread.sessionId } : {}),
      stderr: (data) => {
        if (data.trim()) console.error(`[claude:${thread.id}] ${data.trim()}`);
      },
    },
  });
  if (signal.aborted) {
    closeNativeSession(session);
    throw new Error("Claude session opening was cancelled");
  }
  signal.addEventListener("abort", () => closeNativeSession(session), { once: true });
  sessions.set(thread.id, session);
  void pump(session);

  return {
    async send(text) {
      session.busy = true;
      session.input.push({
        type: "user",
        session_id: session.sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: text },
      } as SDKUserMessage);
    },
    async interrupt() {
      session.interrupted = true;
      for (const pending of session.approvals.values()) pending.resolve("deny");
      session.approvals.clear();
      try {
        await session.query.interrupt();
      } catch {
        session.abort.abort();
      }
    },
    async respondToApproval(id, decision) {
      const pending = session.approvals.get(id);
      if (!pending) return false;
      session.approvals.delete(id);
      pending.resolve(decision);
      return true;
    },
    async respondToQuestion() {
      return false;
    },
    async applySettings(patch: AgentSettingsPatch) {
      if (patch.model) await session.query.setModel(patch.model);
      if (patch.permissionMode) {
        await session.query.setPermissionMode(patch.permissionMode as ClaudePermissionMode);
      }
      const effort = patch.effort ? claudeEffort(patch.effort) : null;
      if (effort) await session.query.applyFlagSettings({ effortLevel: effort });
      return "applied";
    },
    close() {
      closeNativeSession(session);
    },
  };
}

export const claudeProvider: AgentProvider = {
  id: "claude",
  open,
  listCommands,
  readUsage,
  async forkSession(sessionId, cwd) {
    const forked = await forkClaudeSession(sessionId, { dir: cwd });
    return forked.sessionId;
  },
  forgetThread(threadId) {
    tasksByThread.delete(threadId);
    contextByThread.delete(threadId);
    costByThread.delete(threadId);
  },
};
