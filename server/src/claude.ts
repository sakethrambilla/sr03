// One long-lived Agent SDK session per thread, and everything folded out of its message stream:
// the transcript rows, the streamed text, tool-approval prompts (canUseTool), subagent progress,
// slash-command lists, and the usage numbers behind the meter. Also owns a session's lifecycle —
// interrupt, idle parking, and the truncation that /clear and rewind do.
import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type PermissionUpdate,
  type Query,
  type SDKControlGetUsageResponse,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { publish } from "./bus.ts";
import { IDLE_PARK_MS } from "./config.ts";
import { messages as messageStore, threads as threadStore, usage as usageStore } from "./db.ts";
import type {
  Effort,
  Message,
  PendingApproval,
  PermissionMode,
  SlashCommand,
  Thread,
  ThreadPhase,
  ThreadTask,
  Usage,
  UsageWindow,
} from "./types.ts";

interface InputQueue extends AsyncIterable<SDKUserMessage> {
  push(message: SDKUserMessage): void;
  end(): void;
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

type ApprovalDecision = "allow" | "always" | "deny";

interface Session {
  threadId: string;
  input: InputQueue;
  query: Query;
  abort: AbortController;
  approvals: Map<string, { approval: PendingApproval; resolve: (decision: ApprovalDecision) => void }>;
  alwaysAllow: Set<string>;
  interrupted: boolean;
  // set when sr03 itself stopped the CLI, so its pump winding down isn't read as a failure
  stopped: boolean;
  // text streamed since the last assistant message landed, so a stopped turn keeps what it said
  partial: string;
  // tool_use id -> transcript message id, so the result can be attached when it arrives
  toolMessages: Map<string, string>;
}

const sessions = new Map<string, Session>();

// what the CLI is doing right now, so a thread's status never waits on a sqlite read
const running = new Set<string>();

function truncate(value: string, limit = 4000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} more chars)` : value;
}

function appendMessage(
  threadId: string,
  role: "user" | "assistant" | "tool" | "system" | "error",
  text: string,
  meta?: Record<string, unknown>,
): Message {
  const message = messageStore.append({ threadId, role, text, meta });
  publish({ type: "thread.message", threadId, message });
  return message;
}

function setPhase(threadId: string, phase: ThreadPhase | null): void {
  publish({ type: "thread.phase", threadId, phase });
}

// the tool row was published when the call started; its output lands on the same row
function attachResult(threadId: string, messageId: string, result: string, isError: boolean): void {
  const current = messageStore.byId(messageId);
  if (!current) return;
  const meta = { ...(current.meta ?? {}), result, isError };
  messageStore.setMeta(messageId, meta);
  publish({ type: "thread.message.updated", threadId, message: { ...current, meta } });
}

// whatever the model had said before a turn was cut short is worth keeping
function keepPartial(session: Session): void {
  const partial = session.partial.trim();
  session.partial = "";
  if (partial) appendMessage(session.threadId, "assistant", partial, { partial: true });
}

function setStatus(threadId: string, status: Thread["status"], sessionId?: string | null): void {
  if (status === "running") running.add(threadId);
  else running.delete(threadId);
  threadStore.update(threadId, { status, ...(sessionId !== undefined ? { sessionId } : {}) });
  publish({ type: "thread.status", threadId, status, sessionId });
  if (status === "idle") schedulePark(threadId);
  else cancelPark(threadId);
}

// a CLI that has answered its turn keeps a quarter of a gigabyte resident for as long as the
// server runs, so an idle one is stopped after a while and the next turn resumes it cold
const parkTimers = new Map<string, NodeJS.Timeout>();

function cancelPark(threadId: string): void {
  const timer = parkTimers.get(threadId);
  if (timer) clearTimeout(timer);
  parkTimers.delete(threadId);
}

function schedulePark(threadId: string): void {
  cancelPark(threadId);
  if (!sessions.has(threadId)) return;
  const timer = setTimeout(() => {
    parkTimers.delete(threadId);
    const session = sessions.get(threadId);
    if (!session || session.approvals.size > 0 || running.has(threadId)) return;
    stopSession(threadId);
  }, IDLE_PARK_MS);
  timer.unref();
  parkTimers.set(threadId, timer);
}

// the SDK ends a turn on a recoverable API error and then carries on streaming the same one, so
// model output for an idle thread is proof the turn is still alive
function ensureRunning(threadId: string): void {
  if (running.has(threadId)) return;
  setStatus(threadId, "running");
}

type SystemMessage = Extract<SDKMessage, { type: "system" }>;

// subagents live only as long as the server does, so they stay in memory rather than in sqlite
const tasksByThread = new Map<string, Map<string, ThreadTask>>();

const TASK_STATUS: Record<string, ThreadTask["status"]> = {
  pending: "running",
  running: "running",
  paused: "running",
  completed: "done",
  failed: "failed",
  killed: "failed",
  stopped: "failed",
};

// only a thread with a live session owns a CLI process, which is what lets the metrics sampler
// tell an agent apart from anything else the server spawned
export function liveThreads(): string[] {
  return [...sessions.keys()];
}

export function threadTasks(threadId: string): ThreadTask[] {
  return [...(tasksByThread.get(threadId)?.values() ?? [])];
}

function saveTask(threadId: string, task: ThreadTask): void {
  const tasks = tasksByThread.get(threadId) ?? new Map<string, ThreadTask>();
  tasks.set(task.id, task);
  tasksByThread.set(threadId, tasks);
  publish({ type: "thread.tasks", threadId, tasks: [...tasks.values()] });
}

// the CLI reports shell and housekeeping tasks on the same stream; only Task-tool agents belong here
function trackTask(threadId: string, message: SystemMessage): void {
  const known = (id: string) => tasksByThread.get(threadId)?.get(id) ?? null;

  switch (message.subtype) {
    case "task_started": {
      if (message.ambient || (!message.subagent_type && message.task_type !== "local_agent")) return;
      saveTask(threadId, {
        id: message.task_id,
        description: message.description,
        agentType: message.subagent_type ?? null,
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
    }
    case "task_progress": {
      const task = known(message.task_id);
      if (!task) return;
      saveTask(threadId, {
        ...task,
        description: message.description || task.description,
        agentType: message.subagent_type ?? task.agentType,
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
      saveTask(threadId, {
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
      if (!task) return;
      saveTask(threadId, {
        ...task,
        status: TASK_STATUS[message.status] ?? task.status,
        tokens: message.usage?.total_tokens ?? task.tokens,
        toolUses: message.usage?.tool_uses ?? task.toolUses,
        endedAt: task.endedAt ?? Date.now(),
      });
      return;
    }
    default:
      return;
  }
}

// a subagent outlives its turn only when backgrounded, which sr03 never does — so anything
// still marked running once the turn ends never had its closing event delivered
function settleTasks(threadId: string, interrupted: boolean): void {
  const tasks = tasksByThread.get(threadId);
  if (!tasks) return;
  for (const task of tasks.values()) {
    if (task.status !== "running") continue;
    saveTask(threadId, {
      ...task,
      status: interrupted ? "failed" : "done",
      endedAt: Date.now(),
    });
  }
}

// plan limits belong to the account, not the thread, so the newest read is shared by every thread
let limits: Pick<Usage, "plan" | "windows" | "credits"> | null = null;
let limitsAt: number | null = null;
const contextByThread = new Map<string, NonNullable<Usage["context"]>>();
const costByThread = new Map<string, number>();

interface StoredThreadUsage {
  context: NonNullable<Usage["context"]> | null;
  cost: number | null;
}

const ACCOUNT_ROW = "account";

// a restart leaves no session behind to ask, so the last read is what the meter opens with
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
    // an unreadable row is a cold meter, not a reason to fail the boot
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
    // the endpoint counts credits in minor units — 6162 is $61.62
    credits: extra?.is_enabled
      ? {
          spent: typeof extra.used_credits === "number" ? extra.used_credits / 100 : null,
          limit: typeof extra.monthly_limit === "number" ? extra.monthly_limit / 100 : null,
          currency: extra.currency ?? null,
        }
      : null,
  };
}

function snapshot(threadId: string | null): Usage {
  return {
    context: (threadId ? contextByThread.get(threadId) : null) ?? null,
    sessionCostUsd: (threadId ? costByThread.get(threadId) : null) ?? null,
    plan: limits?.plan ?? null,
    windows: limits?.windows ?? [],
    credits: limits?.credits ?? null,
    // the windows decay while a thread sits idle, so the meter says how old the read is
    windowsAt: limits ? limitsAt : null,
  };
}

// the CLI answers both questions over the control channel, so a live session is the only way to
// ask — a thread without one shows whatever the last read left behind
export async function readUsage(threadId: string | null): Promise<Usage> {
  const own = threadId ? (sessions.get(threadId) ?? null) : null;
  const any = own ?? [...sessions.values()][0] ?? null;

  if (own) {
    // 'summary' answers from the last response instead of re-counting every category
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

  const usage = snapshot(threadId);
  publish({ type: "usage", threadId, usage });
  return usage;
}

// the stream reports a window the moment the API pushes back on it, which is fresher than the
// read at the end of the turn
function foldRateLimit(threadId: string, info: SDKRateLimitInfo): void {
  const id = info.rateLimitType;
  const utilization = info.utilization;
  if (!id || typeof utilization !== "number") return;
  // the field has arrived as both seconds and milliseconds; anything this small is seconds
  const resetsAt = info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : null;
  const known = limits?.windows ?? [];
  const window = { id, label: WINDOW_LABELS[id] ?? id, utilization, resetsAt };
  limits = {
    plan: limits?.plan ?? null,
    credits: limits?.credits ?? null,
    windows: known.some((entry) => entry.id === id)
      ? known.map((entry) => (entry.id === id ? window : entry))
      : [...known, window],
  };
  persistLimits();
  publish({ type: "usage", threadId, usage: snapshot(threadId) });
}

// a few of the CLI's commands only mean anything inside a terminal (/exit, /statusline). the
// init message names them, and it is the only place they are named — so the set fills in as
// sessions run, and a list read before any of them has run may still carry one
const terminalOnly = new Set<string>();

// commands come from the folder as much as from the CLI — skills and the project's own commands
// live in it — so a cold read is cached per cwd for the life of the server
const commandsByCwd = new Map<string, Promise<SlashCommand[]>>();

function toCommands(commands: SlashCommand[]): SlashCommand[] {
  return commands
    .filter((command) => !terminalOnly.has(command.name))
    .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

// a throwaway session, the way the model catalog is read — the CLI only answers this over the
// control channel, so asking is the only way to know
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
  let pending = commandsByCwd.get(cwd);
  if (pending) return pending;
  pending = readCommands(cwd).catch((error: Error) => {
    console.error("[commands] could not read the CLI list:", error.message);
    commandsByCwd.delete(cwd);
    return [];
  });
  commandsByCwd.set(cwd, pending);
  return pending;
}

// a live session in that folder answers instead of a second CLI: it is already warm, and it knows
// about anything discovered mid-turn
export function listCommands(cwd: string): Promise<SlashCommand[]> {
  const live = [...sessions.values()].find(
    (session) => threadStore.byId(session.threadId)?.cwd === cwd,
  );
  if (!live) return cachedCommands(cwd);
  return live.query
    .supportedCommands()
    .then(toCommands)
    .catch(() => cachedCommands(cwd));
}

function makeCanUseTool(session: Session): CanUseTool {
  return async (toolName, input, options) => {
    if (session.alwaysAllow.has(toolName)) return { behavior: "allow", updatedInput: input };

    const approval: PendingApproval = {
      id: randomUUID(),
      threadId: session.threadId,
      toolName,
      input,
    };
    publish({ type: "thread.approval", approval });

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      session.approvals.set(approval.id, { approval, resolve });
      options.signal.addEventListener("abort", () => {
        if (!session.approvals.delete(approval.id)) return;
        publish({
          type: "thread.approval.resolved",
          threadId: session.threadId,
          approvalId: approval.id,
        });
        resolve("deny");
      });
    });

    if (decision === "deny") return { behavior: "deny", message: "Denied by user." };
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

function handleMessage(session: Session, message: SDKMessage): void {
  const { threadId } = session;
  if (message.type === "stream_event" || message.type === "assistant") ensureRunning(threadId);
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        for (const name of message.terminal_slash_commands ?? []) terminalOnly.add(name);
        setStatus(threadId, "running", message.session_id);
        setPhase(threadId, null);
        return;
      }
      if (message.subtype === "commands_changed") {
        publish({ type: "thread.commands", threadId, commands: toCommands(message.commands) });
        return;
      }
      // a local command (/usage, /cost) never reaches the model, so its output is the whole turn
      if (message.subtype === "local_command_output") {
        appendMessage(threadId, "assistant", message.content);
        return;
      }
      trackTask(threadId, message);
      return;
    }
    case "stream_event": {
      const event = message.event;
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "thinking") setPhase(threadId, { kind: "thinking" });
        else if (block.type === "tool_use") setPhase(threadId, { kind: "tool", name: block.name });
        else if (block.type === "text") setPhase(threadId, null);
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        session.partial += event.delta.text;
        publish({ type: "thread.delta", threadId, text: event.delta.text });
      }
      return;
    }
    case "assistant": {
      publish({ type: "thread.delta.end", threadId });
      session.partial = "";
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          appendMessage(threadId, "assistant", block.text);
        } else if (block.type === "tool_use") {
          const saved = appendMessage(threadId, "tool", "", {
            toolName: block.name,
            toolUseId: block.id,
            input: block.input,
          });
          session.toolMessages.set(block.id, saved.id);
        }
      }
      return;
    }
    case "user": {
      const content = message.message.content;
      if (typeof content === "string") return;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const messageId = session.toolMessages.get(block.tool_use_id);
        if (!messageId) continue;
        session.toolMessages.delete(block.tool_use_id);
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? [])
                .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
                .join("\n");
        attachResult(threadId, messageId, truncate(text), block.is_error === true);
      }
      return;
    }
    case "rate_limit_event": {
      foldRateLimit(threadId, message.rate_limit_info);
      return;
    }
    case "result": {
      settleTasks(threadId, session.interrupted);
      void readUsage(threadId);
      if (session.interrupted) {
        session.interrupted = false;
        keepPartial(session);
        appendMessage(threadId, "system", "Stopped by user");
      } else if (message.subtype !== "success") {
        keepPartial(session);
        appendMessage(threadId, "error", `Turn ended: ${message.subtype}`, {
          error: message.subtype,
        });
      }
      session.partial = "";
      publish({ type: "thread.delta.end", threadId });
      setPhase(threadId, null);
      setStatus(threadId, "idle");
      return;
    }
    default:
      return;
  }
}

async function pump(session: Session): Promise<void> {
  try {
    for await (const message of session.query) {
      handleMessage(session, message);
    }
  } catch (error) {
    if (session.stopped) {
      // parked or closed on purpose; the thread may already be running a fresh session
    } else if (!session.abort.signal.aborted) {
      keepPartial(session);
      appendMessage(session.threadId, "error", (error as Error).message);
      setPhase(session.threadId, null);
      setStatus(session.threadId, "error");
    } else {
      keepPartial(session);
      setPhase(session.threadId, null);
      setStatus(session.threadId, "idle");
    }
  } finally {
    // a parked session's pump winds down after its replacement may already be running
    if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);
  }
}

function startSession(thread: Thread): Session {
  const abort = new AbortController();
  const input = createInputQueue();
  const session: Session = {
    threadId: thread.id,
    input,
    abort,
    approvals: new Map(),
    alwaysAllow: new Set(),
    interrupted: false,
    stopped: false,
    partial: "",
    toolMessages: new Map(),
    query: undefined as unknown as Query,
  };
  session.query = query({
    prompt: input,
    options: {
      cwd: thread.cwd,
      model: thread.model,
      permissionMode: thread.permissionMode,
      effort: thread.effort,
      includePartialMessages: true,
      abortController: abort,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      canUseTool: makeCanUseTool(session),
      ...(thread.sessionId ? { resume: thread.sessionId } : {}),
      stderr: (data) => {
        if (data.trim().length > 0) console.error(`[claude:${thread.id}] ${data.trim()}`);
      },
    },
  });
  sessions.set(thread.id, session);
  void pump(session);
  return session;
}

// sr03 keeps the transcript, the CLI keeps its own, and nothing can trim the CLI's — so
// dropping messages drops the session with them, and the next turn starts the model cold
export function truncateThread(thread: Thread, seq: number): void {
  closeSession(thread.id);
  running.delete(thread.id);
  messageStore.truncate(thread.id, seq);
  usageStore.remove(thread.id);
  const next = threadStore.update(thread.id, { sessionId: null, status: "idle" });
  publish({ type: "thread.truncated", threadId: thread.id, seq });
  setPhase(thread.id, null);
  if (next) publish({ type: "thread.updated", thread: next });
  publish({ type: "usage", threadId: thread.id, usage: snapshot(thread.id) });
}

// the CLI takes an optional session name after /clear, which sr03 has nowhere to put
const CLEAR = /^\/clear\b/;

export function isClear(text: string): boolean {
  return CLEAR.test(text.trim());
}

export function sendTurn(thread: Thread, text: string): void {
  if (isClear(text)) {
    truncateThread(thread, 0);
    return;
  }
  const cold = !sessions.has(thread.id);
  const session = sessions.get(thread.id) ?? startSession(thread);
  appendMessage(thread.id, "user", text);
  setStatus(thread.id, "running");
  // the CLI takes seconds to come up, which reads as a stall unless it is named
  if (cold) setPhase(thread.id, { kind: "starting" });
  session.input.push({
    type: "user",
    session_id: thread.sessionId ?? "",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  } as SDKUserMessage);
}

// a turn parks inside canUseTool until someone answers, and the prompt only ever reached the
// client as an event — so a socket that reconnects has to be told what is still outstanding
export function pendingApprovals(): PendingApproval[] {
  return [...sessions.values()].flatMap((session) =>
    [...session.approvals.values()].map((pending) => pending.approval),
  );
}

export async function interrupt(threadId: string): Promise<void> {
  const session = sessions.get(threadId);
  if (!session) {
    setStatus(threadId, "idle");
    return;
  }
  session.interrupted = true;
  for (const [approvalId, pending] of session.approvals) {
    session.approvals.delete(approvalId);
    publish({ type: "thread.approval.resolved", threadId, approvalId });
    pending.resolve("deny");
  }
  try {
    await session.query.interrupt();
  } catch {
    session.abort.abort();
  }
  setPhase(threadId, null);
  setStatus(threadId, "idle");
}

export function resolveApproval(
  threadId: string,
  approvalId: string,
  decision: ApprovalDecision,
): boolean {
  const session = sessions.get(threadId);
  const pending = session?.approvals.get(approvalId);
  if (!session || !pending) return false;
  session.approvals.delete(approvalId);
  publish({ type: "thread.approval.resolved", threadId, approvalId });
  pending.resolve(decision);
  return true;
}

export async function applyThreadSettings(
  thread: Thread,
  patch: { model?: string; permissionMode?: PermissionMode; effort?: Effort },
): Promise<void> {
  const session = sessions.get(thread.id);
  if (!session) return;
  if (patch.model) await session.query.setModel(patch.model).catch(() => undefined);
  if (patch.permissionMode)
    await session.query.setPermissionMode(patch.permissionMode).catch(() => undefined);
  if (patch.effort)
    await session.query.applyFlagSettings({ effortLevel: patch.effort }).catch(() => undefined);
}

// stops the CLI but keeps what the panels show — the thread's session id still resumes it
function stopSession(threadId: string): void {
  cancelPark(threadId);
  const session = sessions.get(threadId);
  if (!session) return;
  session.stopped = true;
  session.input.end();
  session.query.close();
  session.abort.abort();
  sessions.delete(threadId);
}

export function closeSession(threadId: string): void {
  stopSession(threadId);
  tasksByThread.delete(threadId);
  contextByThread.delete(threadId);
  costByThread.delete(threadId);
}
