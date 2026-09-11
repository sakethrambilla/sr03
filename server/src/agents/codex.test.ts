// Adapter contract test against a deterministic executable that speaks Codex app-server JSON-RPC
// without the jsonrpc field. It covers handshake, resume, streaming, approvals, questions,
// interrupt, model discovery, skills, and fork.
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
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.154.0\\n");
  process.exit(0);
}
const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (value) => fs.appendFileSync(process.env.MOCK_CODEX_LOG, JSON.stringify(value) + "\\n");
(async () => {
for await (const line of lines) {
  const message = JSON.parse(line);
  log(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "mock-codex" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_1" } } });
  } else if (message.method === "thread/resume") {
    if (message.params.threadId === "missing") {
      send({ id: message.id, error: { code: -32000, message: "unknown thread" } });
    } else {
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
  } else if (message.method === "thread/fork") {
    send({ id: message.id, result: { thread: { id: "thr_forked" } } });
  } else if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [
          {
            id: "gpt-5.4",
            model: "gpt-5.4",
            displayName: "GPT-5.4",
            description: "Default Codex model",
            isDefault: true,
            hidden: false,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "medium", description: "Balanced" },
              { reasoningEffort: "high", description: "Deep" }
            ]
          },
          {
            id: "gpt-5.3-codex",
            model: "gpt-5.3-codex",
            displayName: "GPT-5.3 Codex",
            description: "Codex-tuned",
            isDefault: false,
            hidden: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Low" },
              { reasoningEffort: "medium", description: "Medium" },
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "extra-high", description: "Extra High" }
            ]
          }
        ]
      }
    });
  } else if (message.method === "skills/list") {
    send({
      id: message.id,
      result: {
        data: [{
          cwd: (message.params && message.params.cwds && message.params.cwds[0]) || "",
          errors: [],
          skills: [
            { name: "worktree", description: "Create a worktree", enabled: true, path: "/tmp/worktree", scope: "repo" },
            { name: "hidden", description: "Off", enabled: false, path: "/tmp/hidden", scope: "repo" }
          ]
        }]
      }
    });
  } else if (message.method === "account/read") {
    send({
      id: message.id,
      result: { account: { type: "chatgpt", email: "user@example.com", planType: "plus" } }
    });
  } else if (message.method === "account/rateLimits/read") {
    send({
      id: message.id,
      result: { rateLimits: { primary: { usedPercent: 10, resetsAt: 0 }, planType: "plus" } }
    });
  } else if (message.method === "turn/start") {
    const text = (message.params && message.params.input && message.params.input[0] && message.params.input[0].text) || "";
    send({ id: message.id, result: { turn: { id: "turn_1", status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1", status: "inProgress" } } });
    if (text.includes("interrupt-me")) {
      continue;
    }
    if (text.includes("plain")) {
      send({ method: "item/reasoning/summaryTextDelta", params: { itemId: "think-1", threadId: "thr_1", turnId: "turn_1", summaryIndex: 0, delta: "hmm" } });
      send({ method: "item/agentMessage/delta", params: { itemId: "msg-1", threadId: "thr_1", turnId: "turn_1", delta: "Hello" } });
      send({
        method: "item/completed",
        params: {
          item: { id: "msg-1", type: "agentMessage", text: "Hello" },
          threadId: "thr_1",
          turnId: "turn_1"
        }
      });
      send({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } } });
      continue;
    }
    send({
      method: "item/started",
      params: {
        item: { id: "cmd-1", type: "commandExecution", command: "ls", cwd: process.cwd() },
        startedAtMs: 1,
        threadId: "thr_1",
        turnId: "turn_1"
      }
    });
    send({
      method: "item/commandExecution/outputDelta",
      params: { itemId: "cmd-1", threadId: "thr_1", turnId: "turn_1", delta: "file.txt\\n" }
    });
    send({
      id: "approval-cmd",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "cmd-1",
        threadId: "thr_1",
        turnId: "turn_1",
        startedAtMs: 1,
        command: "ls",
        cwd: process.cwd(),
        reason: "shell"
      }
    });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "interrupted" } } });
  } else if (message.id === "approval-cmd") {
    send({
      method: "item/completed",
      params: {
        item: { id: "cmd-1", type: "commandExecution", status: "declined", aggregatedOutput: "" },
        threadId: "thr_1",
        turnId: "turn_1"
      }
    });
    send({
      method: "item/started",
      params: {
        item: { id: "file-1", type: "fileChange", changes: [] },
        startedAtMs: 2,
        threadId: "thr_1",
        turnId: "turn_1"
      }
    });
    send({
      id: "approval-file",
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "file-1",
        threadId: "thr_1",
        turnId: "turn_1",
        startedAtMs: 2,
        reason: "edit README.md"
      }
    });
  } else if (message.id === "approval-file") {
    send({
      method: "item/completed",
      params: {
        item: { id: "file-1", type: "fileChange", status: "completed" },
        threadId: "thr_1",
        turnId: "turn_1"
      }
    });
    send({
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        isBlocking: true,
        itemId: "ask-1",
        threadId: "thr_1",
        turnId: "turn_1",
        questions: [{
          id: "color",
          header: "Choose",
          question: "Which color?",
          options: [{ label: "Blue", description: "Cool" }, { label: "Red", description: "Warm" }]
        }]
      }
    });
  } else if (message.id === "question-1") {
    send({ method: "item/agentMessage/delta", params: { itemId: "msg-2", threadId: "thr_1", turnId: "turn_1", delta: "Done." } });
    send({
      method: "item/completed",
      params: {
        item: { id: "msg-2", type: "agentMessage", text: "Done." },
        threadId: "thr_1",
        turnId: "turn_1"
      }
    });
    send({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } } });
  } else if (message.id) {
    send({ id: message.id, result: {} });
  }
}
})();
`;

function waitFor<T>(subscribe: (resolve: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => subscribe(resolve));
}

async function readLog(logPath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(logPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function withMock(
  context: { after: (fn: () => Promise<void> | void) => void },
  prefix: string,
): Promise<{ directory: string; logPath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const binary = path.join(directory, "codex");
  const logPath = path.join(directory, "messages.ndjson");
  await fs.writeFile(binary, MOCK_AGENT, { mode: 0o755 });
  await fs.writeFile(logPath, "");

  const previousPath = process.env.PATH;
  const previousData = process.env.SR03_DATA_DIR;
  const previousLog = process.env.MOCK_CODEX_LOG;
  const previousHome = process.env.HOME;
  process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
  process.env.SR03_DATA_DIR = path.join(directory, "data");
  process.env.MOCK_CODEX_LOG = logPath;
  process.env.HOME = directory;
  context.after(async () => {
    process.env.PATH = previousPath;
    if (previousData === undefined) delete process.env.SR03_DATA_DIR;
    else process.env.SR03_DATA_DIR = previousData;
    if (previousLog === undefined) delete process.env.MOCK_CODEX_LOG;
    else process.env.MOCK_CODEX_LOG = previousLog;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, logPath };
}

function threadFor(directory: string, extra: Partial<Thread> = {}): Thread {
  return {
    id: extra.id ?? "codex-adapter-test",
    projectId: "project",
    providerId: "codex",
    title: "Test",
    cwd: directory,
    branch: null,
    isWorktree: false,
    model: extra.model ?? "gpt-5.4",
    permissionMode: extra.permissionMode ?? "default",
    effort: extra.effort ?? "high",
    fast: false,
    sessionId: extra.sessionId ?? null,
    status: "idle",
    archived: false,
    layout: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  };
}

test("normalizes Codex app-server handshake and interactive events", async (context) => {
  const { directory, logPath } = await withMock(context, "sr03-codex-test-");
  const { codexProvider } = await import("./codex.ts");
  const events: AgentEvent[] = [];
  let commandApproval: PendingApproval | null = null;
  let fileApproval: PendingApproval | null = null;
  let resolveCommand = (_value: PendingApproval) => {};
  let resolveFile = (_value: PendingApproval) => {};
  let resolveQuestion = (_value: PendingQuestion) => {};
  const commandReady = waitFor<PendingApproval>((resolve) => {
    resolveCommand = resolve;
  });
  const fileReady = waitFor<PendingApproval>((resolve) => {
    resolveFile = resolve;
  });
  const questionReady = waitFor<PendingQuestion>((resolve) => {
    resolveQuestion = resolve;
  });

  const session = await codexProvider.open(
    threadFor(directory),
    (event) => {
      events.push(event);
      if (event.type === "approval.requested") {
        if (!commandApproval) {
          commandApproval = event.approval;
          resolveCommand(event.approval);
        } else if (!fileApproval) {
          fileApproval = event.approval;
          resolveFile(event.approval);
        }
      }
      if (event.type === "question.requested") resolveQuestion(event.question);
    },
    new AbortController().signal,
  );
  context.after(() => session.close());

  const started = events.find((event) => event.type === "session.started");
  assert.equal(started?.type === "session.started" ? started.sessionId : null, "thr_1");

  const turn = session.send("Run the mock flow");
  const command = await commandReady;
  assert.equal(command.toolName, "command");
  assert.equal(await session.respondToApproval(command.id, "deny"), true);
  const file = await fileReady;
  assert.equal(file.toolName, "fileChange");
  assert.equal(await session.respondToApproval(file.id, "always"), true);
  const question = await questionReady;
  assert.equal(await session.respondToQuestion(question.id, { color: ["Blue"] }), true);
  await turn;

  const meaningful = events.filter((event) =>
    ["assistant.complete", "tool.started", "tool.completed"].includes(event.type),
  );
  assert.deepEqual(
    meaningful.map((event) => {
      if (event.type === "assistant.complete") return ["assistant", event.text];
      if (event.type === "tool.started") return ["tool-start", event.name, event.mutatesFiles];
      if (event.type === "tool.completed") return ["tool-end", event.isError, event.result];
      return [];
    }),
    [
      ["tool-start", "command", false],
      ["tool-end", true, "Tool denied by user."],
      ["tool-start", "fileChange", true],
      ["tool-end", false, "done"],
      ["assistant", "Done."],
    ],
  );

  const sent = await readLog(logPath);
  assert.ok(sent.every((message) => !("jsonrpc" in message)));
  const initialize = sent.find((message) => message.method === "initialize");
  assert.deepEqual((initialize?.params as { clientInfo?: unknown })?.clientInfo, {
    name: "sr03",
    title: "sr03",
    version: "0.0.0",
  });
  assert.ok(sent.some((message) => message.method === "initialized"));
  assert.ok(sent.some((message) => message.method === "thread/start"));
  assert.ok(!sent.some((message) => message.method === "thread/resume"));

  const commandDecision = sent.find((message) => message.id === "approval-cmd");
  assert.deepEqual(commandDecision?.result, { decision: "decline" });
  const fileDecision = sent.find((message) => message.id === "approval-file");
  assert.deepEqual(fileDecision?.result, { decision: "acceptForSession" });
  const questionResponse = sent.find((message) => message.id === "question-1");
  assert.deepEqual(questionResponse?.result, {
    answers: { color: { answers: ["Blue"] } },
  });
});

test("resumes a stored Codex thread id", async (context) => {
  const { directory, logPath } = await withMock(context, "sr03-codex-resume-");
  const { codexProvider } = await import("./codex.ts");
  const session = await codexProvider.open(
    threadFor(directory, { id: "codex-resume-test", sessionId: "thr_resume" }),
    () => {},
    new AbortController().signal,
  );
  context.after(() => session.close());

  const sent = await readLog(logPath);
  assert.ok(
    sent.some(
      (message) =>
        message.method === "thread/resume" &&
        (message.params as { threadId?: string }).threadId === "thr_resume",
    ),
  );
  assert.ok(!sent.some((message) => message.method === "thread/start"));
});

test("falls back to thread/start when resume fails", async (context) => {
  const { directory, logPath } = await withMock(context, "sr03-codex-resume-miss-");
  const { codexProvider } = await import("./codex.ts");
  const events: AgentEvent[] = [];
  const session = await codexProvider.open(
    threadFor(directory, { id: "codex-resume-miss", sessionId: "missing" }),
    (event) => events.push(event),
    new AbortController().signal,
  );
  context.after(() => session.close());

  const started = events.find((event) => event.type === "session.started");
  assert.equal(started?.type === "session.started" ? started.sessionId : null, "thr_1");
  const sent = await readLog(logPath);
  assert.ok(sent.some((message) => message.method === "thread/resume"));
  assert.ok(sent.some((message) => message.method === "thread/start"));
});

test("streams a turn without approvals and applies the next-turn settings stash", async (context) => {
  const { directory, logPath } = await withMock(context, "sr03-codex-plain-");
  const { discoverCodexModels, codexProvider } = await import("./codex.ts");
  const { updateProviderModels } = await import("../models.ts");
  updateProviderModels("codex", await discoverCodexModels());

  const session = await codexProvider.open(
    threadFor(directory, { id: "codex-plain-test" }),
    () => {},
    new AbortController().signal,
  );
  context.after(() => session.close());

  assert.equal(await session.applySettings({ model: "gpt-5.3-codex", effort: "xhigh" }), "applied");
  await session.send("plain hello");

  const sent = await readLog(logPath);
  const turn = sent.find((message) => message.method === "turn/start");
  const params = turn?.params as {
    model?: string;
    effort?: string;
    approvalPolicy?: string;
    sandboxPolicy?: { type?: string };
  };
  assert.equal(params.model, "gpt-5.3-codex");
  assert.equal(params.effort, "extra-high");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.sandboxPolicy?.type, "workspaceWrite");
});

test("interrupts an in-flight Codex turn", async (context) => {
  const { directory, logPath } = await withMock(context, "sr03-codex-interrupt-");
  const { codexProvider } = await import("./codex.ts");
  const events: AgentEvent[] = [];
  const session = await codexProvider.open(
    threadFor(directory, { id: "codex-interrupt-test" }),
    (event) => events.push(event),
    new AbortController().signal,
  );
  context.after(() => session.close());

  const turn = session.send("interrupt-me now");
  await waitFor<void>((resolve) => {
    if (events.some((event) => event.type === "turn.active")) resolve();
    const timer = setInterval(() => {
      if (events.some((event) => event.type === "turn.active")) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
    timer.unref();
  });
  await session.interrupt();
  await turn;

  const sent = await readLog(logPath);
  assert.ok(
    sent.some(
      (message) =>
        message.method === "turn/interrupt" &&
        (message.params as { turnId?: string }).turnId === "turn_1",
    ),
  );
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("discovers Codex models without opening a thread", async (context) => {
  const { logPath } = await withMock(context, "sr03-codex-models-");
  const { discoverCodexModels } = await import("./codex.ts");
  const models = await discoverCodexModels();
  assert.deepEqual(
    models.map(({ slug, label, resolved }) => ({ slug, label, resolved })),
    [
      { slug: "gpt-5.4", label: "GPT-5.4", resolved: "gpt-5.4" },
      { slug: "gpt-5.3-codex", label: "GPT-5.3 Codex", resolved: "gpt-5.3-codex" },
    ],
  );
  const ladder = (slug: string) =>
    models.find((model) => model.slug === slug)?.effortLevels?.map((level) => level.value) ?? null;
  assert.deepEqual(ladder("gpt-5.4"), ["low", "medium", "high"]);
  assert.equal(models.find((model) => model.slug === "gpt-5.4")?.defaultEffort, "high");
  assert.deepEqual(ladder("gpt-5.3-codex"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(
    models.find((model) => model.slug === "gpt-5.3-codex")?.effortLevels?.at(-1)?.native,
    { configId: "effort", value: "extra-high" },
  );

  const sent = await readLog(logPath);
  assert.ok(sent.some((message) => message.method === "model/list"));
  assert.ok(!sent.some((message) => message.method === "thread/start"));
  assert.ok(sent.every((message) => !("jsonrpc" in message)));
});

test("reads Codex commands without opening a thread", async (context) => {
  const { directory, logPath } = await withMock(context, "sr03-codex-commands-");
  const { codexProvider } = await import("./codex.ts");
  const commands = await codexProvider.listCommands(directory);
  assert.deepEqual(commands, [
    { name: "worktree", description: "Create a worktree", argumentHint: "" },
  ]);
  const sent = await readLog(logPath);
  assert.ok(sent.some((message) => message.method === "skills/list"));
});

test("forks a Codex thread over a short-lived connection", async (context) => {
  const { directory, logPath } = await withMock(context, "sr03-codex-fork-");
  const { codexProvider } = await import("./codex.ts");
  assert.equal(typeof codexProvider.forkSession, "function");
  const forked = await codexProvider.forkSession?.("thr_1", directory);
  assert.equal(forked, "thr_forked");
  const sent = await readLog(logPath);
  assert.ok(
    sent.some(
      (message) =>
        message.method === "thread/fork" &&
        (message.params as { threadId?: string }).threadId === "thr_1",
    ),
  );
});
