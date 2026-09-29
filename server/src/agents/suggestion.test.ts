import assert from "node:assert/strict";
import { test } from "node:test";

import type { Message } from "../types.ts";
import { buildSuggestionPrompt, cleanSuggestion } from "./suggestion.ts";

let seq = 0;
function message(role: Message["role"], text: string, meta: Message["meta"] = null): Message {
  seq += 1;
  return { id: `m${seq}`, threadId: "t", seq, role, text, meta, createdAt: seq };
}

test("cleanSuggestion keeps plain suggestions", () => {
  assert.equal(cleanSuggestion("  run the tests \n"), "run the tests");
  assert.equal(cleanSuggestion('"commit this"'), "commit this");
  assert.equal(cleanSuggestion("yes"), "yes");
  assert.equal(cleanSuggestion("/review"), "/review");
});

test("cleanSuggestion rejects meta, evaluative and assistant-voice text", () => {
  const rejected = [
    "",
    null,
    "done",
    "No suggestion",
    "(silence)",
    "[nothing]",
    "Suggestion: run it",
    "hmm",
    "one two three four five six seven eight nine ten eleven twelve thirteen",
    "a".repeat(100),
    "Fix it. Then run tests",
    "**run** tests",
    "a\nb",
    "looks good to me",
    "thanks, run tests",
    "Let me run the tests",
    "I'll commit",
    "Here's the plan",
    "what about the tests?",
  ];
  for (const raw of rejected) assert.equal(cleanSuggestion(raw), null, String(raw));
});

test("buildSuggestionPrompt keeps user and assistant turns in order", () => {
  const prompt = buildSuggestionPrompt([
    message("user", "fix the bug"),
    message("tool", ""),
    message("assistant", "Fixed it in a.ts"),
    message("system", "Stopped"),
    message("user", "ok"),
    message("assistant", "Done."),
  ]);
  const user = prompt.indexOf("User: fix the bug");
  const assistant = prompt.indexOf("Assistant: Fixed it in a.ts");
  assert.ok(user >= 0 && assistant > user);
  assert.ok(!prompt.includes("Stopped"));
  assert.ok(prompt.includes("Reply with ONLY the suggestion"));
  assert.ok(prompt.trimEnd().endsWith("no quotes or explanation."));
});

test("buildSuggestionPrompt keeps only the last 12 messages", () => {
  const messages = Array.from({ length: 30 }, (_, index) =>
    message(index % 2 === 0 ? "user" : "assistant", `message-${index}-end`),
  );
  const prompt = buildSuggestionPrompt(messages);
  assert.ok(!prompt.includes("message-0-end"));
  assert.ok(!prompt.includes("message-17-end"));
  assert.ok(prompt.includes("message-18-end"));
  assert.ok(prompt.includes("message-29-end"));
});

test("buildSuggestionPrompt clips long messages", () => {
  const prompt = buildSuggestionPrompt([message("assistant", "x".repeat(5000))]);
  const line = prompt.split("\n\n").find((part) => part.startsWith("Assistant: "))!;
  const body = line.slice("Assistant: ".length);
  assert.ok(body.endsWith("…"));
  assert.ok(body.length <= 1501);
});

test("buildSuggestionPrompt skips subagent messages", () => {
  const prompt = buildSuggestionPrompt([
    message("user", "main request"),
    message("assistant", "subagent chatter", { taskId: "task-1" }),
  ]);
  assert.ok(prompt.includes("main request"));
  assert.ok(!prompt.includes("subagent chatter"));
});
