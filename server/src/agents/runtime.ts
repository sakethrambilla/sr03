// Provider-neutral ownership of thread sessions: transcript persistence, stream projection,
// approvals, questions, interrupts, idle parking, clear/rewind, and provider routing.
import { publish } from "../bus.ts";
import { IDLE_PARK_MS } from "../config.ts";
import { messages as messageStore, threads as threadStore, usage as usageStore } from "../db.ts";
import { updateProviderModels } from "../models.ts";
import type {
  ApprovalDecision,
  Message,
  PendingApproval,
  PendingQuestion,
  ProviderId,
  SlashCommand,
  Thread,
  ThreadPhase,
  ThreadTask,
  Usage,
} from "../types.ts";
import { providerFor } from "./registry.ts";
import type { AgentEvent, AgentSession, AgentSettingsPatch } from "./types.ts";

interface ManagedSession {
  threadId: string;
  providerId: ProviderId;
  handle: AgentSession | null;
  opening: Promise<AgentSession>;
  abort: AbortController;
  stopped: boolean;
  interrupted: boolean;
  partial: string;
  toolMessages: Map<string, string>;
  approvals: Map<string, PendingApproval>;
  questions: Map<string, PendingQuestion>;
}

const sessions = new Map<string, ManagedSession>();
const running = new Set<string>();
const reservations = new Set<string>();
const parkTimers = new Map<string, NodeJS.Timeout>();
const tasksByThread = new Map<string, ThreadTask[]>();
const CLEAR = /^\/clear\b/;

function emptyUsage(): Usage {
  return {
    context: null,
    sessionCostUsd: null,
    plan: null,
    windows: [],
    credits: null,
    windowsAt: null,
  };
}

function truncate(value: string, limit = 4000): string {
  return value.length > limit
    ? `${value.slice(0, limit)}\n… (${value.length - limit} more chars)`
    : value;
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

function attachResult(threadId: string, messageId: string, result: string, isError: boolean): void {
  const current = messageStore.byId(messageId);
  if (!current) return;
  const meta = { ...(current.meta ?? {}), result, isError };
  messageStore.setMeta(messageId, meta);
  publish({ type: "thread.message.updated", threadId, message: { ...current, meta } });
}

function keepPartial(session: ManagedSession): void {
  const partial = session.partial.trim();
  session.partial = "";
  if (partial) appendMessage(session.threadId, "assistant", partial, { partial: true });
}

function cancelPark(threadId: string): void {
  const timer = parkTimers.get(threadId);
  if (timer) clearTimeout(timer);
  parkTimers.delete(threadId);
}

function setStatus(threadId: string, status: Thread["status"], sessionId?: string | null): void {
  if (!threadStore.setOwnedStatus(threadId, status, sessionId)) {
    stopSession(threadId);
    return;
  }
  if (status === "running") running.add(threadId);
  else running.delete(threadId);
  publish({ type: "thread.status", threadId, status, sessionId });
  if (status === "idle") schedulePark(threadId);
  else cancelPark(threadId);
}

function schedulePark(threadId: string): void {
  cancelPark(threadId);
  if (!sessions.has(threadId)) return;
  const timer = setTimeout(() => {
    parkTimers.delete(threadId);
    const session = sessions.get(threadId);
    if (
      !session ||
      session.approvals.size > 0 ||
      session.questions.size > 0 ||
      running.has(threadId)
    ) {
      return;
    }
    stopSession(threadId);
  }, IDLE_PARK_MS);
  timer.unref();
  parkTimers.set(threadId, timer);
}

function clearRequests(session: ManagedSession): void {
  for (const approvalId of session.approvals.keys()) {
    publish({ type: "thread.approval.resolved", threadId: session.threadId, approvalId });
  }
  for (const questionId of session.questions.keys()) {
    publish({ type: "thread.question.resolved", threadId: session.threadId, questionId });
  }
  session.approvals.clear();
  session.questions.clear();
}

function stopSession(threadId: string): void {
  cancelPark(threadId);
  const session = sessions.get(threadId);
  if (!session) {
    if (!reservations.has(threadId)) threadStore.release(threadId);
    return;
  }
  session.stopped = true;
  clearRequests(session);
  sessions.delete(threadId);
  session.abort.abort();
  if (session.handle) session.handle.close();
  else void session.opening.then((handle) => handle.close(), () => undefined);
  if (!reservations.has(threadId)) threadStore.release(threadId);
}

function failSession(session: ManagedSession, error: unknown): void {
  if (session.stopped || sessions.get(session.threadId) !== session) return;
  keepPartial(session);
  appendMessage(session.threadId, "error", error instanceof Error ? error.message : String(error));
  setPhase(session.threadId, null);
  setStatus(session.threadId, "error");
  stopSession(session.threadId);
}

function handleEvent(session: ManagedSession, event: AgentEvent): void {
  if (session.stopped || sessions.get(session.threadId) !== session) return;
  if (!threadStore.owns(session.threadId)) {
    stopSession(session.threadId);
    return;
  }
  const { threadId } = session;

  switch (event.type) {
    case "session.started":
      setStatus(threadId, "running", event.sessionId);
      setPhase(threadId, null);
      return;
    case "turn.active":
      if (!running.has(threadId)) setStatus(threadId, "running");
      return;
    case "phase":
      setPhase(threadId, event.phase);
      return;
    case "assistant.delta":
      session.partial += event.text;
      publish({ type: "thread.delta", threadId, text: event.text });
      return;
    case "assistant.complete":
      publish({ type: "thread.delta.end", threadId });
      session.partial = "";
      if (event.text.trim()) appendMessage(threadId, "assistant", event.text);
      return;
    case "tool.started": {
      const saved = appendMessage(threadId, "tool", "", {
        toolName: event.name,
        toolUseId: event.callId,
        input: event.input,
        ...(event.mutatesFiles === undefined ? {} : { mutatesFiles: event.mutatesFiles }),
      });
      session.toolMessages.set(event.callId, saved.id);
      return;
    }
    case "tool.completed": {
      const messageId = session.toolMessages.get(event.callId);
      if (!messageId) return;
      session.toolMessages.delete(event.callId);
      attachResult(threadId, messageId, truncate(event.result), event.isError);
      return;
    }
    case "approval.requested":
      session.approvals.set(event.approval.id, event.approval);
      publish({ type: "thread.approval", approval: event.approval });
      return;
    case "question.requested":
      session.questions.set(event.question.id, event.question);
      publish({ type: "thread.question", question: event.question });
      return;
    case "notice":
      if (event.text.trim()) appendMessage(threadId, "system", event.text);
      return;
    case "commands.changed":
      publish({ type: "thread.commands", threadId, commands: event.commands });
      return;
    case "tasks.changed":
      tasksByThread.set(threadId, event.tasks);
      publish({ type: "thread.tasks", threadId, tasks: event.tasks });
      return;
    case "usage":
      publish({ type: "usage", threadId, usage: event.usage });
      return;
    case "models.changed":
      updateProviderModels(session.providerId, event.models);
      return;
    case "turn.completed":
      clearRequests(session);
      if (session.interrupted) {
        session.interrupted = false;
        keepPartial(session);
        appendMessage(threadId, "system", "Stopped by user");
      } else if (event.error) {
        keepPartial(session);
        appendMessage(threadId, "error", event.error, {
          ...(event.errorCode ? { error: event.errorCode } : {}),
        });
      }
      session.partial = "";
      publish({ type: "thread.delta.end", threadId });
      setPhase(threadId, null);
      setStatus(threadId, "idle");
      void readUsage(threadId);
      return;
    case "session.error":
      failSession(session, new Error(event.message));
      return;
  }
}

function startSession(thread: Thread): ManagedSession {
  const provider = providerFor(thread.providerId);
  const session: ManagedSession = {
    threadId: thread.id,
    providerId: thread.providerId,
    handle: null,
    opening: Promise.resolve(undefined as unknown as AgentSession),
    abort: new AbortController(),
    stopped: false,
    interrupted: false,
    partial: "",
    toolMessages: new Map<string, string>(),
    approvals: new Map<string, PendingApproval>(),
    questions: new Map<string, PendingQuestion>(),
  };
  sessions.set(thread.id, session);
  session.opening = provider
    .open(thread, (event) => handleEvent(session, event), session.abort.signal)
    .then((handle) => {
      if (session.stopped || sessions.get(thread.id) !== session) {
        handle.close();
      } else {
        session.handle = handle;
      }
      return handle;
    });
  return session;
}

export function isClear(text: string): boolean {
  return CLEAR.test(text.trim());
}

export function sendTurn(thread: Thread, text: string): boolean {
  const current = threadStore.byId(thread.id);
  if (!current || running.has(thread.id) || !threadStore.claim(thread.id)) return false;
  if (isClear(text)) {
    truncateThread(current, 0);
    return true;
  }
  const cold = !sessions.has(current.id);
  const session = sessions.get(current.id) ?? startSession(current);
  appendMessage(thread.id, "user", text);
  setStatus(thread.id, "running");
  if (cold) setPhase(thread.id, { kind: "starting" });
  void session.opening
    .then((handle) => handle.send(text))
    .catch((error) => failSession(session, error));
  return true;
}

export function pendingApprovals(): PendingApproval[] {
  return [...sessions.values()].flatMap((session) => [...session.approvals.values()]);
}

export function pendingQuestions(): PendingQuestion[] {
  return [...sessions.values()].flatMap((session) => [...session.questions.values()]);
}

export function pendingQuestion(threadId: string, questionId: string): PendingQuestion | null {
  return sessions.get(threadId)?.questions.get(questionId) ?? null;
}

export async function interrupt(threadId: string): Promise<boolean> {
  const session = sessions.get(threadId);
  if (!session || !threadStore.owns(threadId)) {
    if (session) stopSession(threadId);
    return false;
  }
  session.interrupted = true;
  clearRequests(session);
  if (!session.handle) {
    session.interrupted = false;
    keepPartial(session);
    appendMessage(threadId, "system", "Stopped by user");
    setPhase(threadId, null);
    setStatus(threadId, "idle");
    stopSession(threadId);
    return true;
  }
  try {
    await session.handle.interrupt();
  } catch {}
  if (sessions.get(threadId) === session && session.interrupted) {
    session.interrupted = false;
    keepPartial(session);
    appendMessage(threadId, "system", "Stopped by user");
    publish({ type: "thread.delta.end", threadId });
  }
  setPhase(threadId, null);
  setStatus(threadId, "idle");
  stopSession(threadId);
  return true;
}

export async function resolveApproval(
  threadId: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<boolean> {
  const session = sessions.get(threadId);
  const approval = session?.approvals.get(approvalId);
  const allowed =
    approval &&
    (typeof decision === "object" ? Boolean(approval.questions?.length) : approval.decisions.includes(decision));
  if (!session || !threadStore.owns(threadId) || !approval || !allowed) {
    return false;
  }
  const handle = session.handle ?? (await session.opening);
  if (!(await handle.respondToApproval(approvalId, decision))) return false;
  session.approvals.delete(approvalId);
  publish({ type: "thread.approval.resolved", threadId, approvalId });
  return true;
}

export async function resolveQuestion(
  threadId: string,
  questionId: string,
  answers: Record<string, string[]>,
): Promise<boolean> {
  const session = sessions.get(threadId);
  if (!session?.questions.has(questionId) || !threadStore.owns(threadId)) return false;
  const handle = session.handle ?? (await session.opening);
  if (!(await handle.respondToQuestion(questionId, answers))) return false;
  session.questions.delete(questionId);
  publish({ type: "thread.question.resolved", threadId, questionId });
  return true;
}

export async function applyThreadSettings(
  thread: Thread,
  patch: AgentSettingsPatch,
): Promise<"applied" | "restart"> {
  const session = sessions.get(thread.id);
  if (!session) return "applied";
  if (!threadStore.owns(thread.id)) {
    stopSession(thread.id);
    return "restart";
  }
  const handle = session.handle ?? (await session.opening);
  const result = await handle.applySettings(patch);
  if (result === "restart") stopSession(thread.id);
  return result;
}

// Dropping messages drops the provider-native session too; the next turn starts with empty context.
export function truncateThread(thread: Thread, seq: number): boolean {
  if (!threadStore.owns(thread.id) && !threadStore.claim(thread.id)) return false;
  threadStore.setOwnedStatus(thread.id, "idle");
  closeSession(thread.id);
  running.delete(thread.id);
  messageStore.truncate(thread.id, seq);
  usageStore.remove(thread.id);
  const next = threadStore.update(thread.id, { sessionId: null });
  publish({ type: "thread.truncated", threadId: thread.id, seq });
  setPhase(thread.id, null);
  if (next) publish({ type: "thread.updated", thread: next });
  publish({ type: "usage", threadId: thread.id, usage: emptyUsage() });
  return true;
}

export function closeSession(threadId: string): void {
  const providerId = sessions.get(threadId)?.providerId ?? threadStore.byId(threadId)?.providerId;
  stopSession(threadId);
  tasksByThread.delete(threadId);
  if (providerId) providerFor(providerId).forgetThread?.(threadId);
}

export function liveThreads(): string[] {
  return [...sessions.keys()];
}

export function hasSession(threadId: string): boolean {
  return sessions.has(threadId);
}

export function canOperate(threadId: string): boolean {
  return threadStore.canOperate(threadId);
}

export function reserveThread(threadId: string): boolean {
  if (reservations.has(threadId)) return false;
  if (threadStore.owns(threadId)) {
    reservations.add(threadId);
    return true;
  }
  if (!threadStore.claim(threadId)) return false;
  reservations.add(threadId);
  return true;
}

export function releaseThreadReservation(
  threadId: string,
  status: Thread["status"] = "idle",
): void {
  reservations.delete(threadId);
  threadStore.setOwnedStatus(threadId, status);
  if (!sessions.has(threadId)) threadStore.release(threadId);
}

export function threadTasks(threadId: string): ThreadTask[] {
  return tasksByThread.get(threadId) ?? [];
}

export function listCommands(providerId: ProviderId, cwd: string): Promise<SlashCommand[]> {
  return providerFor(providerId).listCommands(cwd);
}

export async function readUsage(threadId: string | null): Promise<Usage> {
  const thread = threadId ? threadStore.byId(threadId) : null;
  const provider = providerFor(thread?.providerId ?? "claude");
  const usage = await provider.readUsage(threadId);
  publish({ type: "usage", threadId, usage });
  return usage;
}

export function forkSession(thread: Thread): Promise<string | null> {
  const provider = providerFor(thread.providerId);
  if (!thread.sessionId || !provider.forkSession) return Promise.resolve(null);
  return provider.forkSession(thread.sessionId, thread.cwd);
}
