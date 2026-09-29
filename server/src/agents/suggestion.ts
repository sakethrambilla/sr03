import { settings } from "../db.ts";
import type { Message } from "../types.ts";

export const SUGGESTION_KEY = "prompt-suggestions";

const MAX_MESSAGES = 12;
const MAX_CHARS = 1500;

const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next.]
Look at the user's recent messages and original request. Predict what THEY would type — not what you think they should do.
THE TEST: would they think "I was just about to type that"?
Examples: user asked "fix the bug and run tests", bug is fixed → "run the tests". After code written → "try it out". Assistant offers options → the one the user would likely pick. Assistant asks to continue → "yes" or "go ahead". Task complete, obvious follow-up → "commit this" or "push it". After an error or misunderstanding → nothing.
Never suggest: evaluative text ("looks good", "thanks"), questions, assistant-voice ("Let me…", "I'll…", "Here's…"), new ideas the user didn't ask about, multiple sentences.
Stay silent if the next step isn't obvious from what the user said.
Format: 2-12 words, matching the user's style. Or nothing.
Do not use any tools. Reply with ONLY the suggestion, no quotes or explanation.`;

const ONE_WORD_OK = new Set([
  "yes", "yeah", "yep", "yup", "sure", "ok", "okay", "push", "commit", "deploy", "stop", "continue", "check", "no",
]);

export function suggestionsEnabled(): boolean {
  return settings.all()[SUGGESTION_KEY] !== "false";
}

export function buildSuggestionPrompt(messages: Message[]): string {
  const transcript = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.text.trim() && !m.meta?.taskId)
    .slice(-MAX_MESSAGES)
    .map((m) => {
      const text = m.text.trim();
      const clipped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
      return `${m.role === "user" ? "User" : "Assistant"}: ${clipped}`;
    })
    .join("\n\n");
  return `Conversation so far:\n\n${transcript}\n\n${SUGGESTION_PROMPT}`;
}

export function cleanSuggestion(raw: string | null | undefined): string | null {
  let text = (raw ?? "").trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
    text = text.slice(1, -1).trim();
  }
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;
  const rejected =
    !text ||
    lower === "done" ||
    lower.includes("nothing found") ||
    lower.startsWith("nothing to suggest") ||
    lower.startsWith("no suggestion") ||
    /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
    /^\W*silence\W*$/.test(lower) ||
    /^\(.*\)$|^\[.*\]$/.test(text) ||
    /^\w+:\s/.test(text) ||
    (words === 1 && !text.startsWith("/") && !ONE_WORD_OK.has(lower)) ||
    words > 12 ||
    text.length >= 100 ||
    /[.!?]\s+[A-Z]/.test(text) ||
    /[\n*]/.test(text) ||
    text.endsWith("?") ||
    /thanks|thank you|looks good|sounds good|that works|nice|great|perfect|makes sense|awesome/.test(lower) ||
    /^(let me|i'll|i've|i'm|i can|i would|i think|here's|here is|that's|this is|you can|you should|sure,|of course|certainly)/i.test(text);
  return rejected ? null : text;
}
