import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { publish } from "./bus.ts";
import { messages as messageStore, threads as threadStore } from "./db.ts";
import type { PendingApproval, PermissionMode, Thread } from "./types.ts";

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
  approvals: Map<string, (decision: ApprovalDecision) => void>;
  alwaysAllow: Set<string>;
  interrupted: boolean;
}

const sessions = new Map<string, Session>();

function truncate(value: string, limit = 4000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} more chars)` : value;
}

function appendMessage(
  threadId: string,
  role: "user" | "assistant" | "tool" | "system" | "error",
  text: string,
  meta?: Record<string, unknown>,
): void {
  const message = messageStore.append({ threadId, role, text, meta });
  publish({ type: "thread.message", threadId, message });
}

function setStatus(threadId: string, status: Thread["status"], sessionId?: string | null): void {
  threadStore.update(threadId, { status, ...(sessionId !== undefined ? { sessionId } : {}) });
  publish({ type: "thread.status", threadId, status, sessionId });
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
      session.approvals.set(approval.id, resolve);
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
  switch (message.type) {
    case "system": {
      if (message.subtype === "init") {
        threadStore.update(threadId, { sessionId: message.session_id });
        publish({ type: "thread.status", threadId, status: "running", sessionId: message.session_id });
      }
      return;
    }
    case "stream_event": {
      const event = message.event;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        publish({ type: "thread.delta", threadId, text: event.delta.text });
      }
      return;
    }
    case "assistant": {
      publish({ type: "thread.delta.end", threadId });
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim().length > 0) {
          appendMessage(threadId, "assistant", block.text);
        } else if (block.type === "tool_use") {
          appendMessage(threadId, "tool", "", {
            toolName: block.name,
            toolUseId: block.id,
            input: block.input,
          });
        }
      }
      return;
    }
    case "result": {
      if (session.interrupted) {
        session.interrupted = false;
        appendMessage(threadId, "system", "Stopped by user");
      } else if (message.subtype !== "success") {
        appendMessage(threadId, "error", `Turn ended: ${message.subtype}`, {
          error: message.subtype,
        });
      }
      publish({ type: "thread.delta.end", threadId });
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
    if (!session.abort.signal.aborted) {
      appendMessage(session.threadId, "error", (error as Error).message);
      setStatus(session.threadId, "error");
    } else {
      setStatus(session.threadId, "idle");
    }
  } finally {
    sessions.delete(session.threadId);
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
    query: undefined as unknown as Query,
  };
  session.query = query({
    prompt: input,
    options: {
      cwd: thread.cwd,
      model: thread.model,
      permissionMode: thread.permissionMode,
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

export function sendTurn(thread: Thread, text: string): void {
  const session = sessions.get(thread.id) ?? startSession(thread);
  appendMessage(thread.id, "user", text);
  setStatus(thread.id, "running");
  session.input.push({
    type: "user",
    session_id: thread.sessionId ?? "",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  } as SDKUserMessage);
}

export async function interrupt(threadId: string): Promise<void> {
  const session = sessions.get(threadId);
  if (!session) {
    setStatus(threadId, "idle");
    return;
  }
  session.interrupted = true;
  for (const [approvalId, resolve] of session.approvals) {
    session.approvals.delete(approvalId);
    publish({ type: "thread.approval.resolved", threadId, approvalId });
    resolve("deny");
  }
  try {
    await session.query.interrupt();
  } catch {
    session.abort.abort();
  }
  setStatus(threadId, "idle");
}

export function resolveApproval(
  threadId: string,
  approvalId: string,
  decision: ApprovalDecision,
): boolean {
  const session = sessions.get(threadId);
  const resolve = session?.approvals.get(approvalId);
  if (!session || !resolve) return false;
  session.approvals.delete(approvalId);
  publish({ type: "thread.approval.resolved", threadId, approvalId });
  resolve(decision);
  return true;
}

export async function applyThreadSettings(
  thread: Thread,
  patch: { model?: string; permissionMode?: PermissionMode },
): Promise<void> {
  const session = sessions.get(thread.id);
  if (!session) return;
  if (patch.model) await session.query.setModel(patch.model).catch(() => undefined);
  if (patch.permissionMode)
    await session.query.setPermissionMode(patch.permissionMode).catch(() => undefined);
}

export function closeSession(threadId: string): void {
  const session = sessions.get(threadId);
  if (!session) return;
  session.input.end();
  session.query.close();
  session.abort.abort();
  sessions.delete(threadId);
}
