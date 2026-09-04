// Cursor CLI provider adapter. One `cursor-agent acp` process owns each warm thread; standard and
// Cursor-extension messages are normalized into the provider-neutral runtime contract.
import { randomUUID } from "node:crypto";

import { currentProvider } from "../models.ts";
import { findCursor } from "../providers.ts";
import type {
  ApprovalDecision,
  ModelOption,
  PendingApproval,
  PendingQuestion,
  PermissionMode,
  Thread,
  Usage,
} from "../types.ts";
import {
  AcpRpcError,
  AcpTransportError,
  spawnAcp,
  type AcpConnection,
} from "./acp.ts";
import type {
  AgentEventSink,
  AgentProvider,
  AgentSession,
  AgentSettingsPatch,
} from "./types.ts";

type PermissionResponse = {
  outcome:
    | { outcome: "cancelled" }
    | { outcome: "selected"; optionId: string };
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  settled: boolean;
}

interface NativeApproval {
  approval: PendingApproval;
  choices: Map<ApprovalDecision, string>;
  toolCallId: string | null;
  resolve(response: PermissionResponse): void;
  settled: boolean;
}

type QuestionResponse = {
  outcome:
    | {
        outcome: "answered";
        answers: Array<{ questionId: string; selectedOptionIds: string[] }>;
      }
    | { outcome: "cancelled" };
};

interface NativeQuestion {
  question: PendingQuestion;
  resolve(response: QuestionResponse): void;
  settled: boolean;
}

interface ActiveTurn {
  text: string;
  finished: boolean;
  interrupted: boolean;
  messageId: string | null;
  plans: Set<string>;
  done: Deferred<void>;
}

interface CursorTool {
  callId: string;
  name: string;
  input: unknown;
  mutatesFiles: boolean;
  data: Record<string, unknown>;
}

interface ReplayGate {
  activity: number;
  lastActivityAt: number;
}

interface CursorNativeSession {
  threadId: string;
  emit: AgentEventSink;
  connection: AcpConnection;
  sessionId: string | null;
  model: string;
  models: Map<string, string>;
  permissionMode: PermissionMode;
  started: boolean;
  disposed: boolean;
  intentionalClose: boolean;
  interrupting: boolean;
  activeTurn: ActiveTurn | null;
  promptTail: Promise<void>;
  approvals: Map<string, NativeApproval>;
  questions: Map<string, NativeQuestion>;
  tools: Map<string, CursorTool>;
  completedTools: Set<string>;
  replayGate: ReplayGate | null;
  closeTimer: NodeJS.Timeout | null;
}

const STARTUP_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 90_000;
const SETTINGS_TIMEOUT_MS = 15_000;
const CANCEL_WRITE_TIMEOUT_MS = 2_000;
const CANCEL_FINISH_TIMEOUT_MS = 8_000;
const LOAD_REPLAY_IDLE_MS = 175;
const LOAD_REPLAY_DRAIN_MAX_MS = 1_500;
const NATIVE_RESPONSE_GRACE_MS = 50;
const TOOL_OUTPUT_MAX_CHARS = 12_000;
const COMPLETED_TOOL_LIMIT = 256;

const sessions = new Map<string, CursorNativeSession>();

function createDeferred<T>(): Deferred<T> {
  let resolver: ((value: T) => void) | null = null;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve) => {
      resolver = resolve;
    }),
    resolve(value) {
      if (deferred.settled) return;
      deferred.settled = true;
      resolver?.(value);
    },
    settled: false,
  };
  return deferred;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value, null, 2);
    return typeof encoded === "string" ? encoded : String(value);
  } catch {
    return String(value);
  }
}

function boundToolOutput(value: string): string {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value;
  return `[Earlier output truncated]\n${value.slice(-TOOL_OUTPUT_MAX_CHARS)}`;
}

function contentText(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => contentText(entry, depth + 1))
      .filter((entry) => entry.trim())
      .join("\n");
  }
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (value.type === "content") return contentText(value.content, depth + 1);
  if (value.type === "diff") {
    const path = stringValue(value.path);
    const text = typeof value.newText === "string" ? value.newText : "";
    return [path ? `Updated ${path}` : "", text].filter(Boolean).join("\n");
  }
  if (value.type === "terminal") {
    const terminalId = stringValue(value.terminalId);
    return terminalId ? `Terminal ${terminalId}` : "";
  }

  const parts: string[] = [];
  for (const key of ["stdout", "stderr", "output", "result", "message", "content"]) {
    const text = contentText(value[key], depth + 1);
    if (text.trim() && !parts.includes(text)) parts.push(text);
  }
  return parts.join("\n");
}

function assistantChunk(update: Record<string, unknown>): string {
  if (typeof update.text === "string") return update.text;
  return contentText(update.content);
}

function formatPlan(value: unknown): string {
  if (!isRecord(value)) return "";
  const plan = stringValue(value.plan);
  if (plan) return plan;

  const entries = Array.isArray(value.entries)
    ? value.entries
    : Array.isArray(value.todos)
      ? value.todos
      : [];
  const lines = entries.flatMap((entry): string[] => {
    if (!isRecord(entry)) return [];
    const content = stringValue(entry.content) ?? stringValue(entry.title);
    if (!content) return [];
    const checked = entry.status === "completed" ? "x" : " ";
    return [`- [${checked}] ${content}`];
  });
  if (lines.length > 0) return lines.join("\n");

  const overview = stringValue(value.overview);
  return overview ?? "";
}

function appendAssistant(session: CursorNativeSession, text: string): void {
  if (!text) return;
  const turn = session.activeTurn;
  if (!turn || turn.finished) return;
  turn.text += text;
  session.emit({ type: "phase", phase: null });
  session.emit({ type: "assistant.delta", text });
}

function flushAssistant(session: CursorNativeSession): void {
  const turn = session.activeTurn;
  if (!turn || turn.finished || !turn.text) return;
  const text = turn.text;
  turn.text = "";
  turn.messageId = null;
  session.emit({ type: "phase", phase: null });
  session.emit({ type: "assistant.complete", text });
}

function appendMessageChunk(
  session: CursorNativeSession,
  update: Record<string, unknown>,
  text: string,
): void {
  const turn = session.activeTurn;
  if (!turn || turn.finished) return;
  const messageId = stringValue(update.messageId);
  if (turn.text && messageId !== null && turn.messageId !== null && messageId !== turn.messageId) {
    flushAssistant(session);
  }
  if (messageId) turn.messageId = messageId;
  appendAssistant(session, text);
}

function appendPlan(session: CursorNativeSession, plan: string, force: boolean): void {
  const normalized = plan.trim();
  if (!normalized) return;
  const turn = session.activeTurn;
  if (!turn || turn.finished || turn.plans.has(normalized)) return;
  if (!force && turn.text.trim()) return;
  turn.plans.add(normalized);
  const prefix = turn.text && !turn.text.endsWith("\n") ? "\n\n" : "";
  appendAssistant(session, `${prefix}${normalized}`);
}

function finishAssistant(session: CursorNativeSession, turn: ActiveTurn, flush: boolean): void {
  if (turn.finished) return;
  if (flush) flushAssistant(session);
  turn.finished = true;
  session.emit({ type: "phase", phase: null });
}

function replayFlag(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const meta = value._meta;
  return isRecord(meta) && (meta.isReplay === true || meta.replay === true);
}

function toolCallId(update: Record<string, unknown>): string | null {
  return stringValue(update.toolCallId) ?? stringValue(update.callId) ?? stringValue(update.id);
}

function toolName(update: Record<string, unknown>): string {
  const input = isRecord(update.rawInput)
    ? update.rawInput
    : isRecord(update.input)
      ? update.input
      : null;
  return (
    stringValue(input?.toolName) ??
    stringValue(input?.tool) ??
    stringValue(input?.name) ??
    stringValue(update.title) ??
    stringValue(update.kind) ??
    "Cursor tool"
  );
}

function toolInput(update: Record<string, unknown>): unknown {
  if (update.rawInput !== undefined) return update.rawInput;
  if (update.input !== undefined) return update.input;
  const input: Record<string, unknown> = {};
  for (const key of ["kind", "title", "locations"]) {
    if (update[key] !== undefined) input[key] = update[key];
  }
  return input;
}

function toolMutatesFiles(update: Record<string, unknown>): boolean {
  const kind = stringValue(update.kind)?.toLowerCase();
  return kind === "edit" || kind === "delete" || kind === "move" || kind === "execute";
}

function mergeTool(
  previous: CursorTool | undefined,
  update: Record<string, unknown>,
  callId: string,
): CursorTool {
  return {
    callId,
    name: previous?.name ?? toolName(update),
    input: previous?.input ?? toolInput(update),
    mutatesFiles: previous?.mutatesFiles === true || toolMutatesFiles(update),
    data: { ...previous?.data, ...update },
  };
}

function terminalToolStatus(status: unknown): "completed" | "failed" | "cancelled" | null {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

function toolResult(tool: CursorTool, status: "completed" | "failed" | "cancelled"): string {
  for (const value of [
    tool.data.rawOutput,
    tool.data.output,
    tool.data.result,
    tool.data.content,
  ]) {
    const text = contentText(value).trim();
    if (text) return boundToolOutput(text);
    if (value !== undefined && value !== null && !Array.isArray(value) && isRecord(value)) {
      const encoded = safeJson(value);
      if (encoded !== "{}") return boundToolOutput(encoded);
    }
  }
  return status === "completed" ? "Tool completed." : "Tool did not complete successfully.";
}

function rememberCompletedTool(session: CursorNativeSession, callId: string): void {
  session.completedTools.add(callId);
  if (session.completedTools.size <= COMPLETED_TOOL_LIMIT) return;
  const oldest = session.completedTools.values().next().value;
  if (typeof oldest === "string") session.completedTools.delete(oldest);
}

function denyTool(session: CursorNativeSession, callId: string | null): void {
  if (!callId) return;
  const tool = session.tools.get(callId);
  if (!tool) return;
  session.tools.delete(callId);
  rememberCompletedTool(session, callId);
  session.emit({
    type: "tool.completed",
    callId,
    result: "Tool denied by user.",
    isError: true,
  });
  session.emit({ type: "phase", phase: null });
}

function startTool(session: CursorNativeSession, update: Record<string, unknown>): void {
  const callId = toolCallId(update);
  if (!callId || session.completedTools.has(callId)) return;
  const existing = session.tools.get(callId);
  const tool = mergeTool(existing, update, callId);
  session.tools.set(callId, tool);
  if (existing) return;
  flushAssistant(session);
  session.emit({ type: "phase", phase: { kind: "tool", name: tool.name } });
  session.emit({
    type: "tool.started",
    callId,
    name: tool.name,
    input: tool.input,
    mutatesFiles: tool.mutatesFiles,
  });
}

function updateTool(session: CursorNativeSession, update: Record<string, unknown>): void {
  const callId = toolCallId(update);
  if (!callId || session.completedTools.has(callId)) return;
  const previous = session.tools.get(callId);
  const tool = mergeTool(previous, update, callId);
  session.tools.set(callId, tool);
  if (!previous) {
    flushAssistant(session);
    session.emit({ type: "phase", phase: { kind: "tool", name: tool.name } });
    session.emit({
      type: "tool.started",
      callId,
      name: tool.name,
      input: tool.input,
      mutatesFiles: tool.mutatesFiles,
    });
  }

  const status = terminalToolStatus(update.status ?? tool.data.status);
  if (!status) return;
  session.tools.delete(callId);
  rememberCompletedTool(session, callId);
  session.emit({
    type: "tool.completed",
    callId,
    result: toolResult(tool, status),
    isError: status !== "completed",
  });
  session.emit({ type: "phase", phase: null });
}

function handleSessionUpdate(session: CursorNativeSession, params: unknown): void {
  if (!isRecord(params)) return;
  const incomingSessionId = stringValue(params.sessionId);
  if (incomingSessionId && session.sessionId && incomingSessionId !== session.sessionId) return;
  const update = isRecord(params.update) ? params.update : params;

  if (session.replayGate) {
    session.replayGate.activity += 1;
    session.replayGate.lastActivityAt = Date.now();
    return;
  }
  if (replayFlag(params) || replayFlag(update) || !session.started) return;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = assistantChunk(update);
      if (text) appendMessageChunk(session, update, text);
      return;
    }
    case "agent_thought_chunk":
      session.emit({ type: "phase", phase: { kind: "thinking" } });
      return;
    case "tool_call":
      startTool(session, update);
      return;
    case "tool_call_update":
      updateTool(session, update);
      return;
    case "plan": {
      const plan = formatPlan(update);
      if (plan) appendPlan(session, plan, false);
      return;
    }
    default:
      return;
  }
}

type OfferedPermission = "allow" | "always" | "deny_once" | "deny_always" | null;

function normalizedOptionText(option: Record<string, unknown>): string {
  return [option.optionId, option.id, option.name, option.label]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z]+/g, "");
}

function optionId(option: unknown): string | null {
  return isRecord(option) ? stringValue(option.optionId) ?? stringValue(option.id) : null;
}

function offeredPermission(option: Record<string, unknown>): OfferedPermission {
  switch (option.kind) {
    case "allow_once":
      return "allow";
    case "allow_always":
      return "always";
    case "reject_once":
      return "deny_once";
    case "reject_always":
      return "deny_always";
    default:
      break;
  }
  const normalized = normalizedOptionText(option);
  if (normalized.includes("allowalways")) return "always";
  if (/(?:reject|deny)always/.test(normalized)) return "deny_always";
  if (normalized.includes("allowonce")) return "allow";
  if (/(?:reject|deny)/.test(normalized)) return "deny_once";
  return null;
}

function permissionChoices(params: Record<string, unknown>): Map<ApprovalDecision, string> {
  const options = Array.isArray(params.options)
    ? params.options.filter(isRecord)
    : [];
  const choices = new Map<ApprovalDecision, string>();
  const allow = options.find((option) => offeredPermission(option) === "allow");
  const always = options.find((option) => offeredPermission(option) === "always");
  const rejectOnce = options.find((option) => offeredPermission(option) === "deny_once");
  const rejectAlways = options.find((option) => offeredPermission(option) === "deny_always");
  const allowId = optionId(allow);
  const alwaysId = optionId(always);
  const rejectId = optionId(rejectOnce) ?? optionId(rejectAlways);
  if (allowId) choices.set("allow", allowId);
  if (alwaysId) choices.set("always", alwaysId);
  if (rejectId) choices.set("deny", rejectId);
  return choices;
}

function approvalTool(session: CursorNativeSession, params: Record<string, unknown>): {
  callId: string | null;
  name: string;
  input: unknown;
} {
  const tool = isRecord(params.toolCall) ? params.toolCall : params;
  const trackedId = toolCallId(tool);
  const tracked = trackedId ? session.tools.get(trackedId) : undefined;
  return {
    callId: trackedId,
    name: tracked?.name ?? toolName(tool),
    input:
      tool.rawInput !== undefined || tool.input !== undefined
        ? toolInput(tool)
        : (tracked?.input ?? toolInput(tool)),
  };
}

function handlePermissionRequest(
  session: CursorNativeSession,
  value: unknown,
): Promise<PermissionResponse> {
  if (!isRecord(value) || session.disposed) {
    return Promise.resolve({ outcome: { outcome: "cancelled" } });
  }
  const choices = permissionChoices(value);
  if (choices.size === 0) {
    return Promise.resolve({ outcome: { outcome: "cancelled" } });
  }
  const tool = approvalTool(session, value);
  const approval: PendingApproval = {
    id: randomUUID(),
    threadId: session.threadId,
    toolName: tool.name,
    input: tool.input,
    decisions: (["allow", "always", "deny"] as ApprovalDecision[]).filter((decision) =>
      choices.has(decision),
    ),
  };
  return new Promise<PermissionResponse>((resolve) => {
    const pending: NativeApproval = {
      approval,
      choices,
      toolCallId: tool.callId,
      resolve,
      settled: false,
    };
    session.approvals.set(approval.id, pending);
    session.emit({ type: "approval.requested", approval });
  });
}

function parseQuestion(value: unknown, index: number): PendingQuestion["questions"][number] | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id) ?? `question-${index + 1}`;
  const prompt = stringValue(value.prompt) ?? stringValue(value.question);
  if (!prompt) return null;
  const options = Array.isArray(value.options)
    ? value.options.flatMap((entry, optionIndex) => {
        if (!isRecord(entry)) return [];
        const label = stringValue(entry.label) ?? stringValue(entry.name);
        if (!label) return [];
        return [{ id: stringValue(entry.id) ?? `option-${optionIndex + 1}`, label }];
      })
    : [];
  return {
    id,
    prompt,
    options: options.length > 0 ? options : [{ id: "ok", label: "OK" }],
    allowMultiple: value.allowMultiple === true || value.multiSelect === true,
  };
}

function handleAskQuestion(
  session: CursorNativeSession,
  value: unknown,
): Promise<QuestionResponse> {
  if (!isRecord(value) || session.disposed) {
    return Promise.resolve({ outcome: { outcome: "cancelled" } });
  }
  const questions = Array.isArray(value.questions)
    ? value.questions.flatMap((question, index) => {
        const parsed = parseQuestion(question, index);
        return parsed ? [parsed] : [];
      })
    : [];
  if (questions.length === 0) {
    return Promise.resolve({ outcome: { outcome: "cancelled" } });
  }
  const question: PendingQuestion = {
    id: randomUUID(),
    threadId: session.threadId,
    title: stringValue(value.title),
    questions,
  };
  return new Promise<QuestionResponse>((resolve) => {
    session.questions.set(question.id, {
      question,
      resolve,
      settled: false,
    });
    session.emit({ type: "question.requested", question });
  });
}

function handleCreatePlan(
  session: CursorNativeSession,
  value: unknown,
): { accepted: true } {
  const plan = formatPlan(value);
  if (plan) {
    if (session.activeTurn) appendPlan(session, plan, true);
    else session.emit({ type: "assistant.complete", text: plan });
  }
  return { accepted: true };
}

function settleApproval(pending: NativeApproval, response: PermissionResponse): void {
  if (pending.settled) return;
  pending.settled = true;
  pending.resolve(response);
}

function settleQuestion(
  pending: NativeQuestion,
  response: QuestionResponse,
): void {
  if (pending.settled) return;
  pending.settled = true;
  pending.resolve(response);
}

function settleNativeRequests(session: CursorNativeSession): number {
  const count = session.approvals.size + session.questions.size;
  for (const pending of session.approvals.values()) {
    settleApproval(pending, { outcome: { outcome: "cancelled" } });
  }
  for (const pending of session.questions.values()) {
    settleQuestion(pending, { outcome: { outcome: "cancelled" } });
  }
  session.approvals.clear();
  session.questions.clear();
  return count;
}

function handleConnectionClose(session: CursorNativeSession, error: Error | null): void {
  if (session.closeTimer) {
    clearTimeout(session.closeTimer);
    session.closeTimer = null;
  }
  session.disposed = true;
  settleNativeRequests(session);
  session.tools.clear();
  if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);
  if (error && !session.intentionalClose && !session.interrupting && session.started) {
    session.emit({ type: "session.error", message: error.message });
  }
}

function closeNativeSession(session: CursorNativeSession): void {
  if (session.intentionalClose && session.connection.closed) return;
  session.intentionalClose = true;
  session.disposed = true;
  const pendingCount = settleNativeRequests(session);
  session.tools.clear();
  if (sessions.get(session.threadId) === session) sessions.delete(session.threadId);

  const close = () => {
    session.closeTimer = null;
    session.connection.close();
  };
  if (pendingCount === 0) {
    close();
    return;
  }
  if (session.closeTimer) clearTimeout(session.closeTimer);
  session.closeTimer = setTimeout(close, NATIVE_RESPONSE_GRACE_MS);
  session.closeTimer.unref();
}

function registerHandlers(session: CursorNativeSession): void {
  session.connection.registerNotificationHandler("session/update", (params) => {
    handleSessionUpdate(session, params);
  });
  session.connection.registerNotificationHandler("cursor/update_todos", () => undefined);
  session.connection.registerRequestHandler("session/request_permission", (params) =>
    handlePermissionRequest(session, params),
  );
  session.connection.registerRequestHandler("cursor/ask_question", (params) =>
    handleAskQuestion(session, params),
  );
  session.connection.registerRequestHandler("cursor/create_plan", (params) =>
    handleCreatePlan(session, params),
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function drainLoadReplay(session: CursorNativeSession): Promise<void> {
  const gate = session.replayGate;
  if (!gate) return;
  const startedAt = Date.now();
  let observedActivity = gate.activity;
  let quietSince = Date.now();
  while (Date.now() - startedAt < LOAD_REPLAY_DRAIN_MAX_MS) {
    if (session.disposed) return;
    await wait(25);
    if (gate.activity !== observedActivity) {
      observedActivity = gate.activity;
      quietSince = gate.lastActivityAt;
      continue;
    }
    if (Date.now() - quietSince >= LOAD_REPLAY_IDLE_MS) return;
  }
}

function startupArgs(thread: Thread): string[] {
  const args: string[] = [];
  switch (thread.permissionMode) {
    case "autoReview":
      args.push("--auto-review");
      break;
    case "bypassPermissions":
      args.push("--force");
      break;
    default:
      break;
  }
  args.push("acp");
  return args;
}

function setupModels(value: unknown): {
  currentModelId: string | null;
  models: ModelOption[];
  nativeBySlug: Map<string, string>;
} {
  const state = isRecord(value) && isRecord(value.models) ? value.models : null;
  const available = state && Array.isArray(state.availableModels) ? state.availableModels : [];
  const models: ModelOption[] = [];
  const nativeBySlug = new Map<string, string>();
  for (const entry of available) {
    if (!isRecord(entry)) continue;
    const modelId = stringValue(entry.modelId);
    const label = stringValue(entry.name);
    if (!modelId || !label) continue;
    const slug = modelId === "default[]" || label.toLowerCase() === "auto" ? "auto" : modelId;
    if (nativeBySlug.has(slug)) continue;
    nativeBySlug.set(slug, modelId);
    models.push({
      slug,
      label,
      hint: stringValue(entry.description) ?? "Available through Cursor ACP",
      resolved: modelId,
    });
  }
  return {
    currentModelId: state ? stringValue(state.currentModelId) : null,
    models,
    nativeBySlug,
  };
}

function setupMode(value: unknown): string | null {
  return isRecord(value) && isRecord(value.modes)
    ? stringValue(value.modes.currentModeId)
    : null;
}

function desiredMode(permissionMode: PermissionMode): "agent" | "plan" | "ask" {
  return permissionMode === "plan" || permissionMode === "ask" ? permissionMode : "agent";
}

async function applySetupSettings(
  session: CursorNativeSession,
  thread: Thread,
  setup: unknown,
): Promise<void> {
  const advertised = setupModels(setup);
  if (advertised.models.length > 0) {
    session.models = advertised.nativeBySlug;
    session.emit({ type: "models.changed", models: advertised.models });
  }
  const nativeModel = session.models.get(thread.model);
  if (!nativeModel) {
    throw new Error(`Cursor model "${thread.model}" is no longer available`);
  }
  if (advertised.currentModelId !== nativeModel) {
    await session.connection.request(
      "session/set_model",
      { sessionId: session.sessionId, modelId: nativeModel },
      { timeoutMs: SETTINGS_TIMEOUT_MS },
    );
  }
  const mode = desiredMode(thread.permissionMode);
  if (setupMode(setup) !== mode) {
    await session.connection.request(
      "session/set_mode",
      { sessionId: session.sessionId, modeId: mode },
      { timeoutMs: SETTINGS_TIMEOUT_MS },
    );
  }
  session.model = thread.model;
}

interface TurnCompletion {
  error?: string;
  errorCode?: string;
}

function promptCompletion(value: unknown): TurnCompletion {
  if (!isRecord(value)) {
    return {
      error: "Cursor returned an invalid response for the turn.",
      errorCode: "invalid_response",
    };
  }
  const reason = stringValue(value.stopReason);
  switch (reason) {
    case "end_turn":
    case "cancelled":
      return {};
    case "max_tokens":
      return {
        error: "Cursor stopped after reaching the model token limit.",
        errorCode: reason,
      };
    case "max_turn_requests":
      return {
        error: "Cursor stopped after reaching its turn request limit.",
        errorCode: reason,
      };
    case "refusal":
      return { error: "Cursor refused this request.", errorCode: reason };
    default:
      return {
        error: reason ? `Cursor stopped: ${reason}` : "Cursor returned no stop reason.",
        errorCode: reason ?? "missing_stop_reason",
      };
  }
}

function promptFailure(error: unknown): TurnCompletion {
  if (error instanceof AcpRpcError) {
    return {
      error: `Cursor prompt failed: ${error.message}`,
      errorCode: `rpc_${error.code}`,
    };
  }
  return {
    error: `Cursor prompt failed: ${errorMessage(error)}`,
    errorCode: "prompt_failed",
  };
}

async function runPrompt(session: CursorNativeSession, text: string): Promise<void> {
  if (session.disposed || !session.sessionId) {
    throw new AcpTransportError("Cursor ACP session is closed");
  }
  const turn: ActiveTurn = {
    text: "",
    finished: false,
    interrupted: false,
    messageId: null,
    plans: new Set(),
    done: createDeferred<void>(),
  };
  session.activeTurn = turn;
  session.tools.clear();
  session.completedTools.clear();

  try {
    const response = await session.connection.request(
      "session/prompt",
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text }],
      },
    );
    finishAssistant(session, turn, true);
    session.emit({ type: "turn.completed", ...promptCompletion(response) });
  } catch (error) {
    if (turn.interrupted || session.intentionalClose) {
      finishAssistant(session, turn, false);
      session.emit({ type: "turn.completed" });
    } else if (!session.disposed) {
      finishAssistant(session, turn, true);
      session.emit({ type: "turn.completed", ...promptFailure(error) });
    }
  } finally {
    turn.done.resolve(undefined);
    if (session.activeTurn === turn) session.activeTurn = null;
    session.interrupting = false;
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AcpTransportError(`Operation timed out after ${milliseconds}ms`));
    }, milliseconds);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForTurn(turn: ActiveTurn, milliseconds: number): Promise<boolean> {
  if (turn.done.settled) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
    turn.done.promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function interruptSession(session: CursorNativeSession): Promise<void> {
  if (session.disposed || !session.sessionId) return;
  session.interrupting = true;
  const turn = session.activeTurn;
  if (turn) turn.interrupted = true;
  settleNativeRequests(session);
  await Promise.resolve();

  try {
    await withTimeout(
      session.connection.notify("session/cancel", { sessionId: session.sessionId }),
      CANCEL_WRITE_TIMEOUT_MS,
    );
  } catch {
    closeNativeSession(session);
    return;
  }

  if (turn && !(await waitForTurn(turn, CANCEL_FINISH_TIMEOUT_MS))) {
    closeNativeSession(session);
  } else if (!turn) {
    session.interrupting = false;
  }
}

async function applySettings(
  session: CursorNativeSession,
  patch: AgentSettingsPatch,
): Promise<"applied" | "restart"> {
  if (
    patch.permissionMode !== undefined &&
    patch.permissionMode !== session.permissionMode
  ) {
    return "restart";
  }
  if (
    patch.model === undefined ||
    patch.model === session.model
  ) {
    return "applied";
  }
  if (session.disposed || !session.sessionId) return "restart";
  const nativeModel = session.models.get(patch.model);
  if (!nativeModel) throw new Error(`Cursor model "${patch.model}" is no longer available`);
  try {
    await session.connection.request(
      "session/set_model",
      { sessionId: session.sessionId, modelId: nativeModel },
      { timeoutMs: SETTINGS_TIMEOUT_MS },
    );
    session.model = patch.model;
    return "applied";
  } catch (error) {
    if (error instanceof AcpRpcError && error.code === -32602) {
      throw new Error(`Cursor rejected model "${patch.model}": ${error.message}`);
    }
    return "restart";
  }
}

async function open(
  thread: Thread,
  emit: AgentEventSink,
  signal: AbortSignal,
): Promise<AgentSession> {
  const binary = await findCursor();
  if (!binary) throw new Error("Cursor Agent CLI was not found");

  const existing = sessions.get(thread.id);
  if (existing) closeNativeSession(existing);

  let session: CursorNativeSession | null = null;
  const connection = spawnAcp({
    binary,
    args: startupArgs(thread),
    cwd: thread.cwd,
    onStderr(text) {
      const message = text.trim();
      if (message) console.error(`[cursor:${thread.id}] ${message}`);
    },
    onClose(error) {
      if (session) handleConnectionClose(session, error);
    },
  });
  session = {
    threadId: thread.id,
    emit,
    connection,
    sessionId: thread.sessionId,
    model: thread.model,
    models: new Map(
      currentProvider("cursor").models.map((model) => [model.slug, model.resolved ?? model.slug]),
    ),
    permissionMode: thread.permissionMode,
    started: false,
    disposed: false,
    intentionalClose: false,
    interrupting: false,
    activeTurn: null,
    promptTail: Promise.resolve(),
    approvals: new Map(),
    questions: new Map(),
    tools: new Map(),
    completedTools: new Set(),
    replayGate: null,
    closeTimer: null,
  };
  const context = session;
  sessions.set(thread.id, context);
  registerHandlers(context);
  if (signal.aborted) closeNativeSession(context);
  signal.addEventListener("abort", () => closeNativeSession(context), { once: true });

  try {
    await connection.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          image: false,
        },
        clientInfo: { name: "sr03", version: "0.0.0" },
      },
      { timeoutMs: STARTUP_TIMEOUT_MS, signal },
    );
    await connection.request(
      "authenticate",
      { methodId: "cursor_login" },
      { timeoutMs: STARTUP_TIMEOUT_MS, signal },
    );

    let setup: unknown;
    if (thread.sessionId) {
      context.replayGate = { activity: 0, lastActivityAt: Date.now() };
      try {
        setup = await connection.request(
          "session/load",
          {
            sessionId: thread.sessionId,
            cwd: thread.cwd,
            mcpServers: [],
          },
          { timeoutMs: LOAD_TIMEOUT_MS, signal },
        );
        await drainLoadReplay(context);
      } finally {
        context.replayGate = null;
      }
    } else {
      const created = await connection.request(
        "session/new",
        { cwd: thread.cwd, mcpServers: [] },
        { timeoutMs: STARTUP_TIMEOUT_MS, signal },
      );
      const createdSessionId = isRecord(created) ? stringValue(created.sessionId) : null;
      if (!createdSessionId) {
        throw new Error("Cursor ACP did not return a session id");
      }
      context.sessionId = createdSessionId;
      setup = created;
    }

    if (!context.sessionId || context.disposed) {
      throw new Error("Cursor ACP session closed during startup");
    }
    await applySetupSettings(context, thread, setup);
    context.started = true;
    emit({ type: "session.started", sessionId: context.sessionId });
  } catch (error) {
    context.intentionalClose = true;
    context.disposed = true;
    settleNativeRequests(context);
    if (sessions.get(thread.id) === context) sessions.delete(thread.id);
    connection.close();
    throw error;
  }

  return {
    send(text) {
      const prompt = context.promptTail.then(() => runPrompt(context, text));
      context.promptTail = prompt.catch(() => undefined);
      return prompt;
    },
    interrupt() {
      return interruptSession(context);
    },
    async respondToApproval(id, decision) {
      const pending = context.approvals.get(id);
      const choice = pending?.choices.get(decision);
      if (!pending || !choice || pending.settled) return false;
      context.approvals.delete(id);
      if (decision === "deny") denyTool(context, pending.toolCallId);
      settleApproval(pending, {
        outcome: { outcome: "selected", optionId: choice },
      });
      return true;
    },
    async respondToQuestion(id, answers) {
      const pending = context.questions.get(id);
      if (!pending || pending.settled) return false;
      context.questions.delete(id);
      settleQuestion(pending, {
        outcome: {
          outcome: "answered",
          answers: pending.question.questions.map((question) => ({
            questionId: question.id,
            selectedOptionIds: answers[question.id] ?? [],
          })),
        },
      });
      return true;
    },
    applySettings(patch) {
      return applySettings(context, patch);
    },
    close() {
      closeNativeSession(context);
    },
  };
}

async function readUsage(): Promise<Usage> {
  return {
    context: null,
    sessionCostUsd: null,
    plan: null,
    windows: [],
    credits: null,
    windowsAt: null,
  };
}

export const cursorProvider: AgentProvider = {
  id: "cursor",
  open,
  async listCommands() {
    return [];
  },
  readUsage,
};
