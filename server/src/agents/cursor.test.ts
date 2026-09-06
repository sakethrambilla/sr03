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
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "mock-session",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "worktree", description: "Create a worktree" },
            { name: "alias", description: "Name a thing" }
          ]
        }
      }
    });
  } else if (message.method === "session/set_model" || message.method === "session/set_mode") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "session/set_config_option") {
    if (message.params.configId === "thinking") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown model config option: thinking" } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
    }
  } else if (message.method === "cursor/list_available_models") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        models: [
          { value: "default", name: "Auto", configOptions: [] },
          { value: "composer-2.5", name: "Composer 2.5", configOptions: [
            { id: "fast", name: "Fast\u200b", description: "Faster, more usage", category: "model_config", type: "select", currentValue: "true",
              options: [{ value: "false", name: "Off" }, { value: "true", name: "Fast\u200b" }] }
          ] },
          { value: "kimi-k3", name: "Kimi K3", configOptions: [
            { id: "reasoning", name: "Reasoning", description: "Reasoning effort.", category: "thought_level", type: "select", currentValue: "max",
              options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "max", name: "Max" }] }
          ] },
          { value: "gpt-5.3-codex", name: "Codex 5.3", configOptions: [
            { id: "reasoning", name: "Reasoning", description: "Reasoning effort.", category: "thought_level", type: "select", currentValue: "medium",
              options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "extra-high", name: "Extra High" }] },
            { id: "fast", name: "Fast", description: "2x cost, faster.", category: "model_config", type: "select", currentValue: "false",
              options: [{ value: "false", name: "Off" }, { value: "true", name: "Fast" }] }
          ] },
          { value: "claude-opus-4-5", name: "Claude Opus 4.5", configOptions: [
            { id: "thinking", name: "Thinking", description: "Use thinking?", category: "thought_level", type: "select", currentValue: "true",
              options: [{ value: "false", name: "Off" }, { value: "true", name: "On" }] }
          ] }
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
    send({
      jsonrpc: "2.0",
      id: "task-req-1",
      method: "cursor/task",
      params: {
        toolCallId: "task-1",
        description: "Audit the config",
        subagentType: "explore",
        model: "composer-2.5"
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
    send({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: { toolCallId: "task-1", durationMs: 4200 }
    });
    // a trailing update with no duration must not pull the settled row back to running
    send({
      jsonrpc: "2.0",
      method: "cursor/task",
      params: { toolCallId: "task-1", description: "Audit the config" }
    });
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
    fast: false,
    sessionId: null,
    status: "idle",
    archived: false,
  layout: null,
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
      { slug: "kimi-k3", resolved: "kimi-k3" },
      { slug: "gpt-5.3-codex", resolved: "gpt-5.3-codex" },
      { slug: "claude-opus-4-5", resolved: "claude-opus-4-5" },
    ],
  );

  const pushed = events.find((event) => event.type === "commands.changed");
  assert.deepEqual(
    pushed?.type === "commands.changed" ? pushed.commands : [],
    [
      { name: "alias", description: "Name a thing", argumentHint: "" },
      { name: "worktree", description: "Create a worktree", argumentHint: "" },
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
  // Auto carries no config options at all, so setup must not try to tune it
  assert.ok(!sent.some((message) => message.method === "session/set_config_option"));
  const questionResponse = sent.find((message) => message.id === "question-1");
  assert.deepEqual(questionResponse?.result, {
    outcome: {
      outcome: "answered",
      answers: [{ questionId: "color", selectedOptionIds: ["blue"] }],
    },
  });
});

const FAILING_AGENT = `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
(async () => {
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  } else if (message.method === "authenticate") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.id) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "no session for you" } });
  }
}
})();
`;

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
      { slug: "kimi-k3", label: "Kimi K3", resolved: "kimi-k3" },
      { slug: "gpt-5.3-codex", label: "Codex 5.3", resolved: "gpt-5.3-codex" },
      { slug: "claude-opus-4-5", label: "Claude Opus 4.5", resolved: "claude-opus-4-5" },
    ],
  );

  const ladder = (slug: string) =>
    models.find((model) => model.slug === slug)?.effortLevels?.map((level) => level.value) ?? null;
  // a sparse ladder keeps only the rungs the model actually has
  assert.deepEqual(ladder("kimi-k3"), ["low", "high", "max"]);
  assert.deepEqual(models.find((model) => model.slug === "kimi-k3")?.defaultEffort, "max");
  // `extra-high` is the same rung as `xhigh` under a different spelling
  assert.deepEqual(ladder("gpt-5.3-codex"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(
    models.find((model) => model.slug === "gpt-5.3-codex")?.effortLevels?.at(-1)?.native,
    { configId: "reasoning", value: "extra-high" },
  );
  // an on/off thinking switch is still a two-rung ladder
  assert.deepEqual(ladder("claude-opus-4-5"), ["none", "high"]);
  assert.equal(ladder("auto"), null);
  assert.equal(ladder("composer-2.5"), null);

  assert.deepEqual(models.find((model) => model.slug === "composer-2.5")?.fast, {
    hint: "Faster, more usage",
    default: true,
  });
  assert.equal(models.find((model) => model.slug === "kimi-k3")?.fast, undefined);
  // zero-width padding in Cursor's own labels must not reach the picker
  assert.equal(
    models.find((model) => model.slug === "composer-2.5")?.fast?.hint.includes("\u200b"),
    false,
  );
  const sent = (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(sent.some((message) => message.method === "cursor/list_available_models"));
  assert.ok(!sent.some((message) => message.method === "session/new"));
});

test("tunes effort and fast for the selected model", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-tuning-"));
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

  const { discoverCursorModels, cursorProvider } = await import("./cursor.ts");
  const { updateProviderModels } = await import("../models.ts");
  updateProviderModels("cursor", await discoverCursorModels());

  const thread: Thread = {
    id: "cursor-tuning-test",
    projectId: "project",
    providerId: "cursor",
    title: "Test",
    cwd: directory,
    branch: null,
    isWorktree: false,
    model: "gpt-5.3-codex",
    permissionMode: "default",
    effort: "xhigh",
    fast: true,
    sessionId: null,
    status: "idle",
    archived: false,
  layout: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const session = await cursorProvider.open(thread, () => {}, new AbortController().signal);
  session.close();

  const sent = (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const methods = sent.map((message) => message.method);
  const configCalls = sent
    .filter((message) => message.method === "session/set_config_option")
    .map((message) => message.params as { configId: string; value: string })
    .map(({ configId, value }) => `${configId}=${value}`);

  // the option set belongs to the model, so tuning must follow the model call
  assert.ok(methods.indexOf("session/set_model") < methods.indexOf("session/set_config_option"));
  // `xhigh` is stored canonically and sent back in this model's own spelling
  assert.ok(configCalls.includes("reasoning=extra-high"));
  // the mock rejects `thinking` with -32602, which must not fail setup
  assert.ok(configCalls.includes("thinking=true"));
  assert.ok(configCalls.includes("fast=true"));
});

test("asserts fast even when it is off", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-fastoff-"));
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

  const { discoverCursorModels, cursorProvider } = await import("./cursor.ts");
  const { updateProviderModels } = await import("../models.ts");
  updateProviderModels("cursor", await discoverCursorModels());

  const thread: Thread = {
    id: "cursor-fastoff-test",
    projectId: "project",
    providerId: "cursor",
    title: "Test",
    cwd: directory,
    branch: null,
    isWorktree: false,
    model: "composer-2.5",
    permissionMode: "default",
    effort: "high",
    fast: false,
    sessionId: null,
    status: "idle",
    archived: false,
  layout: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const session = await cursorProvider.open(thread, () => {}, new AbortController().signal);
  session.close();

  const configCalls = (await fs.readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((message) => message.method === "session/set_config_option")
    .map((message) => message.params as { configId: string; value: string })
    .map(({ configId, value }) => `${configId}=${value}`);

  // Cursor defaults this model to fast, and persists that globally — off must be written, not skipped
  assert.deepEqual(configCalls, ["fast=false"]);
});

test("reads Cursor commands without opening a thread", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-commands-"));
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
  const commands = await cursorProvider.listCommands(directory);
  assert.deepEqual(
    commands.map(({ name, argumentHint }) => ({ name, argumentHint })),
    [
      { name: "alias", argumentHint: "" },
      { name: "worktree", argumentHint: "" },
    ],
  );
});

test("falls back to no commands when Cursor errors", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-commands-fail-"));
  const binary = path.join(directory, "cursor-agent");
  const logPath = path.join(directory, "messages.ndjson");
  await fs.writeFile(binary, FAILING_AGENT, { mode: 0o755 });

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
  assert.deepEqual(await cursorProvider.listCommands(directory), []);
});

test("emits one task row for a Cursor subagent", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-task-"));
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
    id: "cursor-task-test",
    projectId: "project",
    providerId: "cursor",
    title: "Test",
    cwd: directory,
    branch: null,
    isWorktree: false,
    model: "auto",
    permissionMode: "ask",
    effort: "high",
    fast: false,
    sessionId: null,
    status: "idle",
    archived: false,
    layout: null,
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

  const last = events.findLast((event) => event.type === "tasks.changed");
  const task = last?.type === "tasks.changed" ? last.tasks[0] : undefined;
  assert.equal(last?.type === "tasks.changed" ? last.tasks.length : 0, 1);
  assert.equal(task?.description, "Audit the config");
  assert.equal(task?.agentType, "explore");
  assert.equal(task?.model, "composer-2.5");
  assert.equal(task?.status, "done");
  assert.ok(task?.endedAt !== null && task.endedAt - task.startedAt === 4200);
});
