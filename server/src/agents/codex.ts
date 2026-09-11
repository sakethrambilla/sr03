// Codex CLI provider adapter. One `codex app-server` process owns each warm thread; JSON-RPC
// (without the jsonrpc field) is normalized into the provider-neutral runtime contract.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { commandCache } from "../db.ts";
import { currentProvider, findModel } from "../models.ts";
import { findCodex } from "../providers.ts";
import type {
  ApprovalDecision,
  Effort,
  EffortOption,
  ModelOption,
  PendingApproval,
  PendingQuestion,
  PermissionMode,
  ProviderAccount,
  SlashCommand,
  Thread,
  ThreadTask,
  Usage,
} from "../types.ts";
import { spawnAcp, type AcpConnection } from "./acp.ts";
import { dedupeByName, scanSkillDirectories } from "./skillScan.ts";
import type {
  AgentEventSink,
  AgentProvider,
  AgentSession,
  AgentSettingsPatch,
} from "./types.ts";

type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexSandboxPolicyType = "readOnly" | "workspaceWrite" | "dangerFullAccess";
type CodexApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  settled: boolean;
}

interface NativeApproval {
  approval: PendingApproval;
  kind: "command" | "file";
  resolve(decision: CodexApprovalDecision): void;
  settled: boolean;
}

interface NativeQuestion {
  question: PendingQuestion;
  resolve(answers: Record<string, { answers: string[] }>): void;
  settled: boolean;
}

interface ActiveTurn {
  id: string | null;
  text: string;
  finished: boolean;
  interrupted: boolean;
  done: Deferred<void>;
}

interface TrackedTool {
  callId: string;
  name: string;
  input: unknown;
  mutatesFiles: boolean;
  output: string;
}

interface CodexNativeSession {
  threadId: string;
  cwd: string;
  emit: AgentEventSink;
  connection: AcpConnection;
  sessionId: string | null;
  turnId: string | null;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  started: boolean;
  disposed: boolean;
  intentionalClose: boolean;
  interrupting: boolean;
  autoApproveFiles: boolean;
  autoApproveAll: boolean;
  activeTurn: ActiveTurn | null;
  promptTail: Promise<void>;
  approvals: Map<string, NativeApproval>;
  questions: Map<string, NativeQuestion>;
  tools: Map<string, TrackedTool>;
  tasks: Map<string, ThreadTask>;
}

const STARTUP_TIMEOUT_MS = 30_000;
const SETTINGS_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_MS = 10 * 60_000;
const CANCEL_WRITE_TIMEOUT_MS = 2_000;
const CANCEL_FINISH_TIMEOUT_MS = 8_000;
const TOOL_OUTPUT_MAX_CHARS = 12_000;
const CLIENT_INFO = { name: "sr03", title: "sr03", version: "0.0.0" };

const EMPTY_USAGE: Usage = {
  context: null,
  sessionCostUsd: null,
  plan: null,
  windows: [],
  credits: null,
  windowsAt: null,
};

const CODEX_SKILL_ROOTS = [".codex/skills", ".agents/skills"];
const sessions = new Map<string, CodexNativeSession>();
const commandsByCwd = new Map<string, SlashCommand[]>();
const liveRefreshes = new Map<string, Promise<void>>();
const probesByCwd = new Map<string, Promise<SlashCommand[]>>();
let lastUsage: Usage = EMPTY_USAGE;

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

function clip(text: string): string {
  return text.length <= TOOL_OUTPUT_MAX_CHARS
    ? text
    : `${text.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n…`;
}

function approvalPolicy(mode: PermissionMode): CodexApprovalPolicy {
  return mode === "bypassPermissions" ? "never" : "on-request";
}

function sandboxMode(mode: PermissionMode): CodexSandboxMode {
  if (mode === "plan" || mode === "ask") return "read-only";
  if (mode === "bypassPermissions") return "danger-full-access";
  return "workspace-write";
}

function sandboxPolicyType(mode: PermissionMode): CodexSandboxPolicyType {
  if (mode === "plan" || mode === "ask") return "readOnly";
  if (mode === "bypassPermissions") return "dangerFullAccess";
  return "workspaceWrite";
}

function threadConfig(thread: Pick<Thread, "cwd" | "model" | "permissionMode">) {
  return {
    cwd: thread.cwd,
    model: thread.model || currentProvider("codex").defaults.model,
    approvalPolicy: approvalPolicy(thread.permissionMode),
    sandbox: sandboxMode(thread.permissionMode),
  };
}

function nativeEffort(model: string, effort: Effort): string | null {
  const option = findModel("codex", model);
  const match = option?.effortLevels?.find((level) => level.value === effort);
  if (match?.native?.value) return match.native.value;
  return option?.effortLevels?.length ? effort : null;
}

function spawnCodex(
  binary: string,
  cwd: string,
  tag: string,
  onClose?: (error: Error | null) => void,
): AcpConnection {
  return spawnAcp({
    binary,
    args: ["app-server", "--listen", "stdio://"],
    cwd,
    jsonrpc: false,
    label: "Codex",
    onStderr(text) {
      const message = text.trim();
      if (message) console.error(`[codex:${tag}] ${message}`);
    },
    ...(onClose ? { onClose } : {}),
  });
}

async function handshake(connection: AcpConnection): Promise<void> {
  await connection.request(
    "initialize",
    { clientInfo: CLIENT_INFO },
    { timeoutMs: STARTUP_TIMEOUT_MS },
  );
  await connection.notify("initialized", {});
}

function threadIdFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.thread)) return stringValue(value.thread.id);
  return stringValue(value.threadId) ?? stringValue(value.id);
}

function turnIdFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.turn)) return stringValue(value.turn.id);
  return stringValue(value.turnId);
}

function itemFrom(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.item) ? value.item : value;
}

function mapEffort(native: string): Effort | null {
  const key = native.toLowerCase().replace(/[_-\s]/g, "");
  if (key === "none" || key === "off") return "none";
  if (key === "minimal" || key === "min") return "minimal";
  if (key === "low") return "low";
  if (key === "medium" || key === "mid") return "medium";
  if (key === "high") return "high";
  if (key === "xhigh" || key === "extrahigh" || key === "extra") return "xhigh";
  if (key === "max" || key === "maximum" || key === "ultra") return "max";
  return null;
}

const EFFORT_LABELS: Record<Effort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

function parseEffortLevels(entry: Record<string, unknown>): {
  effortLevels?: EffortOption[];
  defaultEffort?: Effort;
} {
  const listed = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : [];
  const levels: EffortOption[] = [];
  const seen = new Set<Effort>();
  for (const option of listed) {
    if (!isRecord(option)) continue;
    const native = stringValue(option.reasoningEffort);
    if (!native) continue;
    const value = mapEffort(native);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    levels.push({
      value,
      label: EFFORT_LABELS[value],
      hint: stringValue(option.description) ?? native,
      native: { configId: "effort", value: native },
    });
  }
  const defaultNative = stringValue(entry.defaultReasoningEffort);
  const defaultEffort = defaultNative ? mapEffort(defaultNative) : undefined;
  return {
    ...(levels.length >= 2 ? { effortLevels: levels } : {}),
    ...(defaultEffort && seen.has(defaultEffort) ? { defaultEffort } : {}),
  };
}

function parseListedModels(value: unknown): ModelOption[] {
  const listed = isRecord(value) && Array.isArray(value.data) ? value.data : [];
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    if (!isRecord(entry) || entry.hidden === true) continue;
    const slug = stringValue(entry.id) ?? stringValue(entry.model);
    const label = stringValue(entry.displayName) ?? slug;
    if (!slug || !label) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      label,
      hint: stringValue(entry.description) ?? "Available through Codex",
      resolved: stringValue(entry.model) ?? slug,
      ...parseEffortLevels(entry),
    });
  }
  models.sort((left, right) => {
    const leftDefault = listed.some(
      (entry) => isRecord(entry) && entry.isDefault === true && (entry.id === left.slug || entry.model === left.slug),
    );
    const rightDefault = listed.some(
      (entry) => isRecord(entry) && entry.isDefault === true && (entry.id === right.slug || entry.model === right.slug),
    );
    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
  return models;
}

export async function discoverCodexModels(): Promise<ModelOption[]> {
  const binary = await findCodex();
  if (!binary) return [];
  const connection = spawnCodex(binary, os.tmpdir(), "models");
  try {
    await handshake(connection);
    const models: ModelOption[] = [];
    let cursor: string | null = null;
    do {
      const listed: unknown = await connection.request(
        "model/list",
        { includeHidden: false, ...(cursor ? { cursor } : {}) },
        { timeoutMs: SETTINGS_TIMEOUT_MS },
      );
      models.push(...parseListedModels(listed));
      cursor = isRecord(listed) ? stringValue(listed.nextCursor) : null;
    } while (cursor);
    if (models.length === 0) return [];
    const seen = new Set<string>();
    return models.filter((model) => {
      if (seen.has(model.slug)) return false;
      seen.add(model.slug);
      return true;
    });
  } catch (error) {
    console.error(`[codex:models] ${errorMessage(error)}`);
    return [];
  } finally {
    connection.close();
  }
}

function parseAccount(value: unknown): ProviderAccount | null {
  if (!isRecord(value) || !isRecord(value.account)) return null;
  const account = value.account;
  const type = stringValue(account.type);
  if (type === "apiKey") {
    return { email: null, organization: null, plan: "API key" };
  }
  if (type === "chatgpt") {
    return {
      email: stringValue(account.email),
      organization: null,
      plan: stringValue(account.planType),
    };
  }
  if (type) return { email: null, organization: null, plan: type };
  return null;
}

export async function probeCodexAccount(binary: string): Promise<ProviderAccount | null> {
  const connection = spawnCodex(binary, os.tmpdir(), "account");
  try {
    await handshake(connection);
    const account = await connection.request(
      "account/read",
      { refreshToken: false },
      { timeoutMs: SETTINGS_TIMEOUT_MS },
    );
    return parseAccount(account);
  } catch (error) {
    console.error(`[codex:account] ${errorMessage(error)}`);
    return null;
  } finally {
    connection.close();
  }
}

function parseRateWindow(
  id: string,
  label: string,
  value: unknown,
): { id: string; label: string; utilization: number; resetsAt: number | null } | null {
  if (!isRecord(value) || typeof value.usedPercent !== "number") return null;
  const resetsAt =
    typeof value.resetsAt === "number" && Number.isFinite(value.resetsAt)
      ? value.resetsAt * 1000
      : null;
  return { id, label, utilization: value.usedPercent / 100, resetsAt };
}

function parseUsage(value: unknown): Usage {
  const snapshot = isRecord(value) && isRecord(value.rateLimits) ? value.rateLimits : value;
  if (!isRecord(snapshot)) return lastUsage;
  const windows = [
    parseRateWindow("primary", "Primary", snapshot.primary),
    parseRateWindow("secondary", "Secondary", snapshot.secondary),
  ].filter((window): window is NonNullable<typeof window> => window !== null);
  return {
    context: null,
    sessionCostUsd: null,
    plan: stringValue(snapshot.planType),
    windows,
    credits: null,
    windowsAt: Date.now(),
  };
}

function publishUsage(session: CodexNativeSession | null, value: unknown): void {
  lastUsage = parseUsage(value);
  session?.emit({ type: "usage", usage: lastUsage });
}

async function refreshUsage(session: CodexNativeSession): Promise<void> {
  try {
    const snapshot = await session.connection.request(
      "account/rateLimits/read",
      {},
      { timeoutMs: SETTINGS_TIMEOUT_MS },
    );
    publishUsage(session, snapshot);
  } catch {
    // Usage is best-effort; a missing meter must not fail the turn.
  }
}

function commandCacheKey(cwd: string): string {
  return `codex:${cwd}`;
}

function readCommandCache(cwd: string): SlashCommand[] | null {
  const row = commandCache.get(commandCacheKey(cwd));
  return row ? (JSON.parse(row.json) as SlashCommand[]) : null;
}

function writeCommandCache(cwd: string, commands: SlashCommand[]): void {
  commandCache.set(commandCacheKey(cwd), JSON.stringify(commands));
}

async function scanCodexCommands(cwd: string): Promise<SlashCommand[]> {
  const home = os.homedir();
  const roots = [
    ...CODEX_SKILL_ROOTS.map((relative) => path.join(cwd, ...relative.split("/"))),
    ...CODEX_SKILL_ROOTS.map((relative) => path.join(home, ...relative.split("/"))),
  ];
  const lists = await Promise.all(roots.map((root) => scanSkillDirectories(root)));
  return dedupeByName(lists);
}

function parseSkills(value: unknown): SlashCommand[] {
  const entries = isRecord(value) && Array.isArray(value.data) ? value.data : [];
  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.skills)) continue;
    for (const skill of entry.skills) {
      if (!isRecord(skill) || skill.enabled === false) continue;
      const name = stringValue(skill.name);
      if (!name) continue;
      commands.push({
        name,
        description: stringValue(skill.description) ?? "",
        argumentHint: "",
      });
    }
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

async function probeCommands(cwd: string): Promise<SlashCommand[]> {
  const binary = await findCodex();
  if (!binary) return [];
  const connection = spawnCodex(binary, cwd, "commands");
  try {
    await handshake(connection);
    const listed = await connection.request(
      "skills/list",
      { cwds: [cwd] },
      { timeoutMs: STARTUP_TIMEOUT_MS },
    );
    return parseSkills(listed);
  } catch (error) {
    console.error(`[codex:commands] ${errorMessage(error)}`);
    return [];
  } finally {
    connection.close();
  }
}

function refreshLiveCommands(cwd: string): void {
  if (liveRefreshes.has(cwd)) return;
  const pending = probeCommands(cwd)
    .then((live) => {
      if (live.length) writeCommandCache(cwd, dedupeByName([readCommandCache(cwd) ?? [], live]));
    })
    .catch((error) => console.error(`[commands:codex] ${errorMessage(error)}`))
    .finally(() => liveRefreshes.delete(cwd));
  liveRefreshes.set(cwd, pending);
}

async function warmCommands(cwd: string): Promise<void> {
  const scanned = await scanCodexCommands(cwd);
  if (scanned.length) writeCommandCache(cwd, dedupeByName([readCommandCache(cwd) ?? [], scanned]));
  refreshLiveCommands(cwd);
}

function listCommands(cwd: string): Promise<SlashCommand[]> {
  const pushed = commandsByCwd.get(cwd);
  if (pushed) return Promise.resolve(pushed);
  const cached = readCommandCache(cwd);
  if (cached) {
    refreshLiveCommands(cwd);
    return Promise.resolve(cached);
  }
  const known = probesByCwd.get(cwd);
  if (known) return known;
  return scanCodexCommands(cwd).then((scanned) => {
    if (scanned.length) {
      writeCommandCache(cwd, scanned);
      refreshLiveCommands(cwd);
      return scanned;
    }
    const pending = probeCommands(cwd).then((commands) => {
      if (commands.length) writeCommandCache(cwd, commands);
      else probesByCwd.delete(cwd);
      return commands;
    });
    probesByCwd.set(cwd, pending);
    return pending;
  });
}

function finishAssistant(session: CodexNativeSession, turn: ActiveTurn, emit: boolean): void {
  if (turn.finished) return;
  turn.finished = true;
  if (turn.text && emit) session.emit({ type: "assistant.complete", text: turn.text });
  turn.text = "";
}

function appendMessage(session: CodexNativeSession, text: string): void {
  const turn = session.activeTurn;
  if (!turn) {
    session.emit({ type: "assistant.delta", text });
    session.emit({ type: "assistant.complete", text });
    return;
  }
  turn.text += text;
  session.emit({ type: "assistant.delta", text });
}

function toolName(item: Record<string, unknown>): string {
  const type = stringValue(item.type);
  if (type === "commandExecution") return "command";
  if (type === "fileChange") return "fileChange";
  if (type === "mcpToolCall") {
    const server = stringValue(item.server);
    const tool = stringValue(item.tool);
    return server && tool ? `${server}/${tool}` : (tool ?? "mcp");
  }
  if (type === "webSearch") return "webSearch";
  return type ?? "tool";
}

function toolInput(item: Record<string, unknown>): unknown {
  const type = stringValue(item.type);
  if (type === "commandExecution") {
    return { command: item.command, cwd: item.cwd };
  }
  if (type === "fileChange") return { changes: item.changes };
  if (type === "mcpToolCall") return item.arguments ?? item;
  if (type === "webSearch") return { query: item.query, action: item.action };
  return item;
}

function startTool(session: CodexNativeSession, item: Record<string, unknown>): void {
  const callId = stringValue(item.id);
  if (!callId || session.tools.has(callId)) return;
  const type = stringValue(item.type);
  const mutatesFiles = type === "fileChange";
  const tool: TrackedTool = {
    callId,
    name: toolName(item),
    input: toolInput(item),
    mutatesFiles,
    output: "",
  };
  session.tools.set(callId, tool);
  session.emit({
    type: "tool.started",
    callId,
    name: tool.name,
    input: tool.input,
    mutatesFiles,
  });
  session.emit({ type: "phase", phase: { kind: "tool", name: tool.name } });
}

function completeTool(session: CodexNativeSession, item: Record<string, unknown>): void {
  const callId = stringValue(item.id);
  if (!callId) return;
  const tool = session.tools.get(callId);
  const status = stringValue(item.status);
  const isError = status === "failed" || status === "declined";
  const streamed = stringValue(item.aggregatedOutput) ?? stringValue(tool?.output);
  const output =
    status === "declined"
      ? "Tool denied by user."
      : streamed ?? (status === "failed" ? "failed" : "done");
  if (tool) session.tools.delete(callId);
  session.emit({
    type: "tool.completed",
    callId,
    result: clip(output),
    isError,
  });
  session.emit({ type: "phase", phase: null });
}

function upsertTask(session: CodexNativeSession, item: Record<string, unknown>): void {
  const id = stringValue(item.id);
  if (!id) return;
  const status = stringValue(item.status);
  const mapped: ThreadTask["status"] =
    status === "failed" ? "failed" : status === "interrupted" ? "stopped" : status === "completed" ? "done" : "running";
  const existing = session.tasks.get(id);
  const startedAt = existing?.startedAt ?? Date.now();
  const task: ThreadTask = {
    id,
    description: stringValue(item.prompt) ?? stringValue(item.tool) ?? "Subagent",
    agentType: stringValue(item.tool),
    model: stringValue(item.model),
    status: mapped,
    tokens: existing?.tokens ?? 0,
    toolUses: existing?.toolUses ?? 0,
    lastTool: existing?.lastTool ?? null,
    error: mapped === "failed" ? (stringValue(item.error) ?? "failed") : null,
    depth: 0,
    startedAt,
    endedAt: mapped === "running" ? null : Date.now(),
    toolUseId: id,
  };
  session.tasks.set(id, task);
  session.emit({ type: "tasks.changed", tasks: [...session.tasks.values()] });
}

function handleItemStarted(session: CodexNativeSession, params: unknown): void {
  const item = itemFrom(params);
  if (!item) return;
  const type = stringValue(item.type);
  if (type === "agentMessage") return;
  if (type === "reasoning") {
    session.emit({ type: "phase", phase: { kind: "thinking" } });
    return;
  }
  if (type === "collabAgentToolCall" || type === "collabToolCall") {
    upsertTask(session, item);
    return;
  }
  if (
    type === "commandExecution" ||
    type === "fileChange" ||
    type === "mcpToolCall" ||
    type === "webSearch"
  ) {
    startTool(session, item);
  }
}

function handleItemCompleted(session: CodexNativeSession, params: unknown): void {
  const item = itemFrom(params);
  if (!item) return;
  const type = stringValue(item.type);
  if (type === "agentMessage") {
    const text = stringValue(item.text);
    const turn = session.activeTurn;
    if (turn && !turn.finished && text && text !== turn.text) {
      // completed payload is the full message; deltas already streamed the prefix
      const prefix = turn.text;
      if (text.startsWith(prefix)) {
        const rest = text.slice(prefix.length);
        if (rest) appendMessage(session, rest);
      }
    }
    if (turn) finishAssistant(session, turn, true);
    else if (text) session.emit({ type: "assistant.complete", text });
    return;
  }
  if (type === "reasoning") {
    session.emit({ type: "phase", phase: null });
    return;
  }
  if (type === "collabAgentToolCall" || type === "collabToolCall") {
    upsertTask(session, item);
    return;
  }
  if (
    type === "commandExecution" ||
    type === "fileChange" ||
    type === "mcpToolCall" ||
    type === "webSearch"
  ) {
    completeTool(session, item);
  }
}

function handleTurnCompleted(session: CodexNativeSession, params: unknown): void {
  const turn = session.activeTurn;
  if (turn?.done.settled) return;
  if (turn) finishAssistant(session, turn, true);
  const status = isRecord(params) && isRecord(params.turn) ? stringValue(params.turn.status) : null;
  const error =
    isRecord(params) && isRecord(params.turn) && isRecord(params.turn.error)
      ? stringValue(params.turn.error.message)
      : null;
  if (status === "failed" && error) {
    session.emit({ type: "turn.completed", error });
  } else if (status === "interrupted" || turn?.interrupted) {
    session.emit({ type: "turn.completed" });
  } else {
    session.emit({ type: "turn.completed" });
  }
  void refreshUsage(session);
  if (turn) {
    turn.done.resolve(undefined);
    if (session.activeTurn === turn) session.activeTurn = null;
  }
  session.interrupting = false;
}

function registerHandlers(session: CodexNativeSession): void {
  const { connection } = session;
  connection.registerNotificationHandler("item/started", (params) => {
    handleItemStarted(session, params);
  });
  connection.registerNotificationHandler("item/completed", (params) => {
    handleItemCompleted(session, params);
  });
  connection.registerNotificationHandler("item/agentMessage/delta", (params) => {
    if (!isRecord(params)) return;
    const delta = stringValue(params.delta);
    if (delta) appendMessage(session, delta);
  });
  connection.registerNotificationHandler("item/commandExecution/outputDelta", (params) => {
    if (!isRecord(params)) return;
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (!itemId || !delta) return;
    const tool = session.tools.get(itemId);
    if (tool) tool.output += delta;
  });
  connection.registerNotificationHandler("item/plan/delta", (params) => {
    if (!isRecord(params)) return;
    const delta = stringValue(params.delta);
    if (delta) appendMessage(session, delta);
  });
  connection.registerNotificationHandler("item/reasoning/summaryTextDelta", () => {
    session.emit({ type: "phase", phase: { kind: "thinking" } });
  });
  connection.registerNotificationHandler("item/reasoning/textDelta", () => {
    session.emit({ type: "phase", phase: { kind: "thinking" } });
  });
  connection.registerNotificationHandler("turn/started", (params) => {
    const id = turnIdFrom(params);
    if (id) {
      session.turnId = id;
      if (session.activeTurn) session.activeTurn.id = id;
    }
    session.emit({ type: "turn.active" });
  });
  connection.registerNotificationHandler("turn/completed", (params) => {
    handleTurnCompleted(session, params);
  });
  connection.registerNotificationHandler("account/rateLimits/updated", (params) => {
    publishUsage(session, params);
  });
  connection.registerNotificationHandler("skills/changed", () => {
    refreshLiveCommands(session.cwd);
  });

  connection.registerRequestHandler("item/commandExecution/requestApproval", (params) =>
    handleCommandApproval(session, params),
  );
  connection.registerRequestHandler("item/fileChange/requestApproval", (params) =>
    handleFileApproval(session, params),
  );
  connection.registerRequestHandler("item/tool/requestUserInput", (params) =>
    handleUserInput(session, params),
  );
}

function autoDecision(session: CodexNativeSession, kind: "command" | "file"): CodexApprovalDecision | null {
  if (session.autoApproveAll) return "accept";
  if (kind === "file" && session.autoApproveFiles) return "accept";
  return null;
}

function handleCommandApproval(
  session: CodexNativeSession,
  value: unknown,
): Promise<{ decision: CodexApprovalDecision }> {
  const auto = autoDecision(session, "command");
  if (auto) return Promise.resolve({ decision: auto });
  if (!isRecord(value) || session.disposed) return Promise.resolve({ decision: "cancel" });
  const command = stringValue(value.command) ?? "command";
  const approval: PendingApproval = {
    id: randomUUID(),
    threadId: session.threadId,
    toolName: "command",
    input: { command, cwd: value.cwd, reason: value.reason },
    decisions: ["allow", "always", "deny"],
  };
  return new Promise((resolve) => {
    session.approvals.set(approval.id, {
      approval,
      kind: "command",
      resolve(decision) {
        resolve({ decision });
      },
      settled: false,
    });
    session.emit({ type: "approval.requested", approval });
  });
}

function handleFileApproval(
  session: CodexNativeSession,
  value: unknown,
): Promise<{ decision: CodexApprovalDecision }> {
  const auto = autoDecision(session, "file");
  if (auto) return Promise.resolve({ decision: auto });
  if (!isRecord(value) || session.disposed) return Promise.resolve({ decision: "cancel" });
  const approval: PendingApproval = {
    id: randomUUID(),
    threadId: session.threadId,
    toolName: "fileChange",
    input: { reason: value.reason, grantRoot: value.grantRoot, itemId: value.itemId },
    decisions: ["allow", "always", "deny"],
  };
  return new Promise((resolve) => {
    session.approvals.set(approval.id, {
      approval,
      kind: "file",
      resolve(decision) {
        resolve({ decision });
      },
      settled: false,
    });
    session.emit({ type: "approval.requested", approval });
  });
}

function handleUserInput(
  session: CodexNativeSession,
  value: unknown,
): Promise<{ answers: Record<string, { answers: string[] }> }> {
  if (!isRecord(value) || session.disposed) return Promise.resolve({ answers: {} });
  const listed = Array.isArray(value.questions) ? value.questions : [];
  const questions: PendingQuestion["questions"] = [];
  for (const [index, entry] of listed.entries()) {
    if (!isRecord(entry)) continue;
    const id = stringValue(entry.id) ?? `question-${index + 1}`;
    const prompt = stringValue(entry.question) ?? stringValue(entry.header);
    if (!prompt) continue;
    const options = Array.isArray(entry.options)
      ? entry.options.flatMap((option) => {
          if (!isRecord(option)) return [];
          const label = stringValue(option.label);
          if (!label) return [];
          return [{ id: stringValue(option.id) ?? label, label }];
        })
      : [];
    questions.push({
      id,
      prompt,
      options: options.length > 0 ? options : [{ id: "ok", label: "OK" }],
      allowMultiple: false,
    });
  }
  if (questions.length === 0) return Promise.resolve({ answers: {} });
  const question: PendingQuestion = {
    id: randomUUID(),
    threadId: session.threadId,
    title: stringValue(value.header) ?? null,
    questions,
  };
  return new Promise((resolve) => {
    session.questions.set(question.id, {
      question,
      resolve(answers) {
        resolve({ answers });
      },
      settled: false,
    });
    session.emit({ type: "question.requested", question });
  });
}

function settleNativeRequests(session: CodexNativeSession, decision: CodexApprovalDecision): void {
  for (const pending of session.approvals.values()) {
    if (pending.settled) continue;
    pending.settled = true;
    pending.resolve(decision);
  }
  session.approvals.clear();
  for (const pending of session.questions.values()) {
    if (pending.settled) continue;
    pending.settled = true;
    pending.resolve({});
  }
  session.questions.clear();
}

function handleConnectionClose(session: CodexNativeSession, error: Error | null): void {
  if (session.disposed) return;
  session.disposed = true;
  sessions.delete(session.threadId);
  settleNativeRequests(session, "cancel");
  const turn = session.activeTurn;
  if (turn && !turn.done.settled) {
    finishAssistant(session, turn, false);
    if (!session.intentionalClose) {
      session.emit({
        type: "turn.completed",
        error: error?.message ?? "Codex session closed",
      });
    } else {
      session.emit({ type: "turn.completed" });
    }
    turn.done.resolve(undefined);
    session.activeTurn = null;
  }
  if (!session.intentionalClose && error) {
    session.emit({ type: "session.error", message: error.message });
  }
}

function closeNativeSession(session: CodexNativeSession): void {
  session.intentionalClose = true;
  settleNativeRequests(session, "cancel");
  if (!session.connection.closed) session.connection.close();
  handleConnectionClose(session, null);
}

async function waitForTurn(turn: ActiveTurn, milliseconds: number): Promise<boolean> {
  if (turn.done.settled) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
    turn.done.promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitUntil(predicate: () => boolean, milliseconds: number): Promise<boolean> {
  if (predicate()) return true;
  const deadline = Date.now() + milliseconds;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      const timer = setTimeout(tick, 20);
      timer.unref();
    };
    tick();
  });
}

async function interruptSession(session: CodexNativeSession): Promise<void> {
  if (session.disposed || !session.sessionId) return;
  session.interrupting = true;
  const turn = session.activeTurn;
  if (turn) turn.interrupted = true;
  settleNativeRequests(session, "cancel");
  if (!(turn?.id || session.turnId)) {
    await waitUntil(() => Boolean(session.turnId || session.activeTurn?.id || session.disposed), CANCEL_WRITE_TIMEOUT_MS);
  }
  const turnId = session.activeTurn?.id ?? session.turnId;
  if (!turnId) {
    closeNativeSession(session);
    return;
  }
  try {
    await session.connection.request(
      "turn/interrupt",
      { threadId: session.sessionId, turnId },
      { timeoutMs: CANCEL_WRITE_TIMEOUT_MS },
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

async function runTurn(session: CodexNativeSession, text: string): Promise<void> {
  if (session.disposed || !session.sessionId) {
    throw new Error("Codex session is closed");
  }
  const turn: ActiveTurn = {
    id: null,
    text: "",
    finished: false,
    interrupted: false,
    done: createDeferred<void>(),
  };
  session.activeTurn = turn;
  session.tools.clear();
  const effort = nativeEffort(session.model, session.effort);
  session.emit({ type: "turn.active" });
  try {
    const result = await session.connection.request(
      "turn/start",
      {
        threadId: session.sessionId,
        input: [{ type: "text", text }],
        cwd: session.cwd,
        model: session.model,
        approvalPolicy: approvalPolicy(session.permissionMode),
        sandboxPolicy: { type: sandboxPolicyType(session.permissionMode) },
        ...(effort ? { effort } : {}),
      },
      { timeoutMs: TURN_TIMEOUT_MS },
    );
    const id = turnIdFrom(result);
    if (id) {
      turn.id = id;
      session.turnId = id;
    }
    const status =
      isRecord(result) && isRecord(result.turn) ? stringValue(result.turn.status) : null;
    if (status && status !== "inProgress") handleTurnCompleted(session, result);
    await turn.done.promise;
  } catch (error) {
    if (turn.interrupted || session.intentionalClose) {
      finishAssistant(session, turn, false);
      if (!turn.done.settled) session.emit({ type: "turn.completed" });
    } else if (!session.disposed) {
      finishAssistant(session, turn, true);
      session.emit({
        type: "turn.completed",
        error: `Codex turn failed: ${errorMessage(error)}`,
      });
    }
    turn.done.resolve(undefined);
  } finally {
    if (session.activeTurn === turn) session.activeTurn = null;
    session.interrupting = false;
  }
}

async function startOrResume(
  connection: AcpConnection,
  thread: Thread,
): Promise<string> {
  const config = threadConfig(thread);
  if (thread.sessionId) {
    try {
      const resumed = await connection.request(
        "thread/resume",
        { threadId: thread.sessionId, ...config },
        { timeoutMs: STARTUP_TIMEOUT_MS },
      );
      const id = threadIdFrom(resumed);
      if (id) return id;
    } catch (error) {
      console.error(`[codex:${thread.id}] resume failed: ${errorMessage(error)}`);
    }
  }
  const started = await connection.request(
    "thread/start",
    config,
    { timeoutMs: STARTUP_TIMEOUT_MS },
  );
  const id = threadIdFrom(started);
  if (!id) throw new Error("Codex thread/start returned no thread id");
  return id;
}

async function open(
  thread: Thread,
  emit: AgentEventSink,
  signal: AbortSignal,
): Promise<AgentSession> {
  const binary = await findCodex();
  if (!binary) throw new Error("Codex CLI was not found");

  const existing = sessions.get(thread.id);
  if (existing) closeNativeSession(existing);

  let session: CodexNativeSession | null = null;
  const connection = spawnCodex(binary, thread.cwd, thread.id, (error) => {
    if (session) handleConnectionClose(session, error);
  });

  if (signal.aborted) {
    connection.close();
    throw new Error("Codex session aborted");
  }
  const onAbort = () => {
    if (session) closeNativeSession(session);
    else connection.close();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    await handshake(connection);
    const context: CodexNativeSession = {
      threadId: thread.id,
      cwd: thread.cwd,
      emit,
      connection,
      sessionId: null,
      turnId: null,
      model: thread.model || currentProvider("codex").defaults.model,
      effort: thread.effort,
      permissionMode: thread.permissionMode,
      started: true,
      disposed: false,
      intentionalClose: false,
      interrupting: false,
      autoApproveFiles: thread.permissionMode === "acceptEdits",
      autoApproveAll: thread.permissionMode === "bypassPermissions",
      activeTurn: null,
      promptTail: Promise.resolve(),
      approvals: new Map(),
      questions: new Map(),
      tools: new Map(),
      tasks: new Map(),
    };
    session = context;
    sessions.set(thread.id, context);
    registerHandlers(context);
    const sessionId = await startOrResume(connection, thread);
    context.sessionId = sessionId;
    emit({ type: "session.started", sessionId });
    void refreshUsage(context);
    void context.connection
      .request("skills/list", { cwds: [thread.cwd] }, { timeoutMs: STARTUP_TIMEOUT_MS })
      .then((listed) => {
        const commands = parseSkills(listed);
        if (!commands.length || context.disposed) return;
        commandsByCwd.set(thread.cwd, commands);
        writeCommandCache(thread.cwd, commands);
        emit({ type: "commands.changed", commands });
      })
      .catch((error) => console.error(`[codex:${thread.id}] ${errorMessage(error)}`));

    return {
      async send(text) {
        const queued = context.promptTail.then(() => runTurn(context, text));
        context.promptTail = queued.catch(() => undefined);
        await queued;
      },
      interrupt() {
        return interruptSession(context);
      },
      async respondToApproval(id, decision: ApprovalDecision) {
        const pending = context.approvals.get(id);
        if (!pending || pending.settled) return false;
        pending.settled = true;
        context.approvals.delete(id);
        const mapped: CodexApprovalDecision =
          typeof decision === "object"
            ? "decline"
            : decision === "always"
              ? "acceptForSession"
              : decision === "allow"
                ? "accept"
                : "decline";
        pending.resolve(mapped);
        return true;
      },
      async respondToQuestion(id, answers) {
        const pending = context.questions.get(id);
        if (!pending || pending.settled) return false;
        pending.settled = true;
        context.questions.delete(id);
        const payload: Record<string, { answers: string[] }> = {};
        for (const question of pending.question.questions) {
          const selected = answers[question.id] ?? answers[question.prompt] ?? [];
          payload[question.id] = { answers: selected };
        }
        pending.resolve(payload);
        return true;
      },
      async applySettings(patch: AgentSettingsPatch) {
        if (patch.model) context.model = patch.model;
        if (patch.effort) context.effort = patch.effort;
        if (patch.permissionMode) {
          context.permissionMode = patch.permissionMode;
          context.autoApproveFiles = patch.permissionMode === "acceptEdits";
          context.autoApproveAll = patch.permissionMode === "bypassPermissions";
        }
        return "applied";
      },
      close() {
        signal.removeEventListener("abort", onAbort);
        closeNativeSession(context);
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", onAbort);
    if (session) closeNativeSession(session);
    else connection.close();
    throw error;
  }
}

async function readUsage(): Promise<Usage> {
  return lastUsage;
}

async function forkSession(sessionId: string, cwd: string): Promise<string> {
  const binary = await findCodex();
  if (!binary) throw new Error("Codex CLI was not found");
  const connection = spawnCodex(binary, cwd, "fork");
  try {
    await handshake(connection);
    const result = await connection.request(
      "thread/fork",
      { threadId: sessionId },
      { timeoutMs: STARTUP_TIMEOUT_MS },
    );
    const id = threadIdFrom(result);
    if (!id) throw new Error("Codex thread/fork returned no thread id");
    return id;
  } finally {
    connection.close();
  }
}

export const codexProvider: AgentProvider = {
  id: "codex",
  open,
  listCommands,
  warmCommands,
  readUsage,
  forkSession,
};
