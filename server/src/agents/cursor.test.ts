// Adapter contract test against a deterministic executable that speaks the same ACP methods as
// Cursor. It covers setup settings, transcript segmentation, permissions, and question responses.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentEvent } from "./types.ts";
import type { PendingApproval, PendingQuestion, Thread } from "../types.ts";

const MOCK_AGENT = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let promptId = null;
(async () => {
for await (const line of lines) {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.MOCK_CURSOR_LOG, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (message.method === "authenticate") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: "mock-session",
        modes: { currentModeId: "agent", availableModes: [] },
        models: {
          currentModelId: "composer-2.5[fast=true]",
          availableModels: [
            { modelId: "default[]", name: "Auto" },
            { modelId: "composer-2.5[fast=true]", name: "Composer 2.5" }
          ]
        }
      }
    });
  } else if (message.method === "session/set_model" || message.method === "session/set_mode") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "cursor/list_available_models") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        models: [
          { value: "default", name: "Auto", configOptions: [] },
          { value: "composer-2.5", name: "Composer 2.5", configOptions: [{ id: "fast", name: "Fast" }] }
        ]
      }
    });
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "mock-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "before",
          content: { type: "text", text: "Before tool." }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "mock-session",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Write a file",
          kind: "edit",
          rawInput: { path: "proof.txt" }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: "permission-1",
      method: "session/request_permission",
      params: {
        sessionId: "mock-session",
        toolCall: { toolCallId: "tool-1", title: "Write a file" },
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "reject-once", kind: "reject_once" }
        ]
      }
    });
  } else if (message.id === "permission-1") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "mock-session",
        update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" }
      }
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "mock-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "after",
          content: { type: "text", text: "After tool." }
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: "question-1",
      method: "cursor/ask_question",
      params: {
        title: "Choose",
        questions: [{
          id: "color",
          prompt: "Which color?",
          options: [{ id: "blue", label: "Blue" }, { id: "red", label: "Red" }]
        }]
      }
    });
  } else if (message.id === "question-1") {
    send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
  }
}
})();
`;

function waitFor<T>(subscribe: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => subscribe(resolve));
}

test("normalizes Cursor ACP setup and interactive events", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-test-"));
  const binary = path.join(directory, "cursor-agent");
  const logPath = path.join(directory, "messages.ndjson");
  await fs.writeFile(binary, MOCK_AGENT, { mode: 0o755 });

  const previousPath = process.env.PATH;
  const previousData = process.env.SR03_DATA_DIR;
  const previousLog = process.env.MOCK_CURSOR_LOG;
  process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
  process.env.SR03_DATA_DIR = path.join(directory, "data");
  process.env.MOCK_CURSOR_LOG = logPath;
  context.after(async () => {
    process.env.PATH = previousPath;
    if (previousData === undefined) delete process.env.SR03_DATA_DIR;
    else process.env.SR03_DATA_DIR = previousData;
    if (previousLog === undefined) delete process.env.MOCK_CURSOR_LOG;
    else process.env.MOCK_CURSOR_LOG = previousLog;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { cursorProvider } = await import("./cursor.ts");
  const events: AgentEvent[] = [];
  let resolveApproval = (_value: PendingApproval) => {};
  let resolveQuestion = (_value: PendingQuestion) => {};
  const approvalReady = waitFor<PendingApproval>((resolve) => {
    resolveApproval = resolve;
  });
  const questionReady = waitFor<PendingQuestion>((resolve) => {
    resolveQuestion = resolve;
  });
  const thread: Thread = {
    id: "cursor-adapter-test",
    projectId: "project",
    providerId: "cursor",
    title: "Test",
    cwd: directory,
    branch: null,
    isWorktree: false,
    model: "auto",
    permissionMode: "ask",
    effort: "high",
    sessionId: null,
    status: "idle",
    archived: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const session = await cursorProvider.open(
    thread,
    (event) => {
      events.push(event);
      if (event.type === "approval.requested") resolveApproval(event.approval);
      if (event.type === "question.requested") resolveQuestion(event.question);
    },
    new AbortController().signal,
  );
  context.after(() => session.close());

  const turn = session.send("Run the mock flow");
  const approval = await approvalReady;
  assert.equal(await session.respondToApproval(approval.id, "deny"), true);
  const question = await questionReady;
  assert.equal(await session.respondToQuestion(question.id, { color: ["blue"] }), true);
  await turn;

  const setupModels = events.find((event) => event.type === "models.changed");
  assert.deepEqual(
    setupModels?.type === "models.changed"
      ? setupModels.models.map(({ slug, resolved }) => ({ slug, resolved }))
      : [],
    [
      { slug: "auto", resolved: "default" },
      { slug: "composer-2.5", resolved: "composer-2.5" },
    ],
  );

  const meaningful = events.filter((event) =>
    ["assistant.complete", "tool.started", "tool.completed"].includes(event.type),
  );
  assert.deepEqual(
    meaningful.map((event) => {
      if (event.type === "assistant.complete") return ["assistant", event.text];
      if (event.type === "tool.started") return ["tool-start", event.mutatesFiles];
      if (event.type === "tool.completed") return ["tool-end", event.isError, event.result];
      return [];
    }),
    [
      ["assistant", "Before tool."],
      ["tool-start", true],
      ["tool-end", true, "Tool denied by user."],
      ["assistant", "After tool."],
    ],
  );

  const sent = (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(
    sent.some(
      (message) =>
        message.method === "session/set_model" &&
        (message.params as { modelId?: string }).modelId === "default",
    ),
  );
  assert.ok(
    sent.some(
      (message) =>
        message.method === "session/set_mode" &&
        (message.params as { modeId?: string }).modeId === "ask",
    ),
  );
  const questionResponse = sent.find((message) => message.id === "question-1");
  assert.deepEqual(questionResponse?.result, {
    outcome: {
      outcome: "answered",
      answers: [{ questionId: "color", selectedOptionIds: ["blue"] }],
    },
  });
});

test("discovers Cursor models without opening a thread", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-models-"));
  const binary = path.join(directory, "cursor-agent");
  const logPath = path.join(directory, "messages.ndjson");
  await fs.writeFile(binary, MOCK_AGENT, { mode: 0o755 });

  const previousPath = process.env.PATH;
  const previousData = process.env.SR03_DATA_DIR;
  const previousLog = process.env.MOCK_CURSOR_LOG;
  process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
  process.env.SR03_DATA_DIR = path.join(directory, "data");
  process.env.MOCK_CURSOR_LOG = logPath;
  context.after(async () => {
    process.env.PATH = previousPath;
    if (previousData === undefined) delete process.env.SR03_DATA_DIR;
    else process.env.SR03_DATA_DIR = previousData;
    if (previousLog === undefined) delete process.env.MOCK_CURSOR_LOG;
    else process.env.MOCK_CURSOR_LOG = previousLog;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const { discoverCursorModels } = await import("./cursor.ts");
  const models = await discoverCursorModels();
  assert.deepEqual(
    models.map(({ slug, label, resolved }) => ({ slug, label, resolved })),
    [
      { slug: "auto", label: "Auto", resolved: "default" },
      { slug: "composer-2.5", label: "Composer 2.5", resolved: "composer-2.5" },
    ],
  );
  const sent = (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(sent.some((message) => message.method === "cursor/list_available_models"));
  assert.ok(!sent.some((message) => message.method === "session/new"));
});
