import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { FileLinks } from "../lib/fileref.ts";
import type { Message, ThreadPhase } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { ChevronIcon, CopyButton, RewindIcon, cn } from "./ui.tsx";
import { Button } from "@/components/ui/button";

// a run of calls should read as one sentence instead of a stack of tool names
const TOOL_PHRASES: Record<string, { verb: string; noun: string }> = {
  Bash: { verb: "Ran", noun: "commands" },
  BashOutput: { verb: "Read", noun: "outputs" },
  KillShell: { verb: "Stopped", noun: "shells" },
  Read: { verb: "Read", noun: "files" },
  Write: { verb: "Wrote", noun: "files" },
  Edit: { verb: "Edited", noun: "files" },
  NotebookEdit: { verb: "Edited", noun: "notebooks" },
  Glob: { verb: "Searched", noun: "patterns" },
  Grep: { verb: "Searched", noun: "patterns" },
  WebFetch: { verb: "Fetched", noun: "pages" },
  WebSearch: { verb: "Ran", noun: "searches" },
  Task: { verb: "Launched", noun: "agents" },
  TodoWrite: { verb: "Updated", noun: "todos" },
  ExitPlanMode: { verb: "Presented", noun: "plans" },
};

const ANY_TOOL = { verb: "Used", noun: "tools" };
const PATH_KEYS = new Set(["file_path", "notebook_path", "path"]);
const TARGET_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "prompt"];

function toolName(message: Message): string {
  return String(message.meta?.toolName ?? "tool");
}

function toolInput(message: Message): Record<string, unknown> {
  const input = message.meta?.input;
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function toolFailed(message: Message): boolean {
  return message.meta?.isError === true;
}

// only a first line fits on a row, and for a path its tail is the informative half
function toolTarget(input: Record<string, unknown>): string {
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const line = value.split("\n", 1)[0].trim();
    return PATH_KEYS.has(key) ? line.split("/").filter(Boolean).slice(-2).join("/") : line;
  }
  return "";
}

function toolLine(message: Message): string {
  const input = toolInput(message);
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description) return description;
  const name = toolName(message);
  const target = toolTarget(input);
  const phrase = TOOL_PHRASES[name];
  if (!phrase) return target ? `${name} ${target}` : name;
  return target ? `${phrase.verb} ${target}` : `${phrase.verb} ${phrase.noun}`;
}

function groupLine(messages: Message[]): string {
  const names = new Set(messages.map(toolName));
  const phrase = (names.size === 1 ? TOOL_PHRASES[[...names][0]] : null) ?? ANY_TOOL;
  return `${phrase.verb} ${messages.length} ${phrase.noun}`;
}

function ToolDetail({ message }: { message: Message }) {
  // description is already the row's label, so it would only be repeated here
  const entries = Object.entries(toolInput(message)).filter(([key]) => key !== "description");
  const result = typeof message.meta?.result === "string" ? message.meta.result : null;

  return (
    <div className="rounded-md bg-background/60 px-2.5 py-2">
      <p className="font-mono text-[11px] font-semibold text-primary">{toolName(message)}</p>
      {entries.map(([key, value]) => (
        <div key={key} className="mt-1.5">
          <p className="text-[10.5px] text-faint">{key}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted-foreground">
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </pre>
        </div>
      ))}
      {result !== null ? (
        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          <p className={cn("text-[10.5px]", toolFailed(message) ? "text-destructive" : "text-faint")}>
            {toolFailed(message) ? "error" : "output"}
          </p>
          <pre
            className={cn(
              "max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed",
              toolFailed(message) ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {result || "(empty)"}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

function ToolRow({
  message,
  open,
  onToggle,
}: {
  message: Message;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-accent/60"
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12.5px]",
            toolFailed(message) ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {toolLine(message)}
        </span>
        <ChevronIcon className={cn("size-3 text-faint transition-transform", open ? "" : "-rotate-90")} />
      </button>
      {open ? (
        <div className="pb-1">
          <ToolDetail message={message} />
        </div>
      ) : null}
    </div>
  );
}

const ToolGroup = memo(function ToolGroup({ messages }: { messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const single = messages.length === 1 ? messages[0] : null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-fit max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] transition hover:bg-accent hover:text-foreground",
          messages.some(toolFailed) ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <span className="min-w-0 truncate">{single ? toolLine(single) : groupLine(messages)}</span>
        <ChevronIcon
          className={cn("size-3 shrink-0 text-faint transition-transform", open ? "" : "-rotate-90")}
        />
      </button>
      {open ? (
        <div className="min-w-0 rounded-lg border border-border/70 bg-card/50 p-1">
          {single ? (
            <ToolDetail message={single} />
          ) : (
            messages.map((message) => (
              <ToolRow
                key={message.id}
                message={message}
                open={openRow === message.id}
                onToggle={() => setOpenRow(openRow === message.id ? null : message.id)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
});

// the row is always laid out so nothing shifts when it appears, and only its ink fades in
function MessageActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-6 items-center opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
      {children}
    </div>
  );
}

// a settled message never changes, but a streaming token rerenders the whole timeline —
// without this every bubble reparses its markdown for each token that arrives
const Bubble = memo(function Bubble({
  message,
  copyable,
  files,
  onRun,
  onRewind,
}: {
  message: Message;
  copyable: boolean;
  files: FileLinks;
  onRun: (command: string) => void;
  onRewind: (message: Message) => void;
}) {
  if (message.role === "system") {
    return <p className="text-center text-[11px] text-faint">{message.text}</p>;
  }

  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end">
        <div className="max-w-[85%] rounded-lg bg-accent px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap text-foreground">
          {message.text}
        </div>
        <MessageActions>
          {copyable ? <CopyButton text={message.text} /> : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Rewind to here"
            title="Rewind to here"
            onClick={() => onRewind(message)}
            className="size-6 text-faint hover:text-foreground"
          >
            <RewindIcon className="size-3" />
          </Button>
        </MessageActions>
      </div>
    );
  }

  return (
    <div className="group flex min-w-0 flex-col items-start">
      <Markdown
        text={message.text}
        files={files}
        onRun={onRun}
        className={cn(
          "w-full text-[14px] leading-[1.65]",
          message.role === "error"
            ? "rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-destructive"
            : "text-foreground",
        )}
      />
      {message.meta?.partial === true ? (
        <p className="text-[11px] text-faint">Stopped before the reply finished</p>
      ) : null}
      {copyable ? (
        <MessageActions>
          <CopyButton text={message.text} />
        </MessageActions>
      ) : null}
    </div>
  );
});

// the model spends whole seconds thinking or running a tool with nothing on screen, so the
// wait is named — and timed once it stops being short
function Activity({ phase }: { phase: ThreadPhase | null }) {
  const label =
    phase?.kind === "starting"
      ? "Starting session…"
      : phase?.kind === "thinking"
        ? "Thinking…"
        : phase?.kind === "tool"
          ? `Running ${phase.name}…`
          : "Working…";
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    setSeconds(0);
    const timer = window.setInterval(() => setSeconds((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [label]);

  return (
    <p className="text-[12px] text-faint">
      {label}
      {seconds >= 3 ? <span className="ml-1.5 tabular-nums">{seconds}s</span> : null}
    </p>
  );
}

// copying is offered on the reply that ends a turn, not on the commentary the model writes
// between tool calls — walking back from the newest, the first model message after each user
// message is that turn's last word
function finalReplies(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  let pending = true;
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const { id, role } = messages[at];
    if (role === "user") {
      pending = true;
    } else if (role === "assistant" || role === "error") {
      if (pending) ids.add(id);
      pending = false;
    }
  }
  return ids;
}

type Row = { id: string; message: Message } | { id: string; tools: Message[] };

// consecutive tool calls collapse into one row, the way the Claude Code transcript folds them
function toRows(messages: Message[]): Row[] {
  const rows: Row[] = [];
  for (const message of messages) {
    if (message.role !== "tool") {
      rows.push({ id: message.id, message });
      continue;
    }
    const last = rows[rows.length - 1];
    if (last && "tools" in last) last.tools.push(message);
    else rows.push({ id: message.id, tools: [message] });
  }
  return rows;
}

const NO_MESSAGES: Message[] = [];

// subscribed here rather than in the chat view, so a streaming frame re-renders the transcript
// and nothing around it
export function Timeline({
  threadId,
  running,
  files,
  onRun,
  onRewind,
}: {
  threadId: string;
  running: boolean;
  files: FileLinks;
  onRun: (command: string) => void;
  onRewind: (message: Message) => void;
}) {
  const messages = useStore((state) => state.messagesByThread[threadId] ?? NO_MESSAGES);
  const streaming = useStore((state) => state.streamByThread[threadId] ?? "");
  const phase = useStore((state) => state.phaseByThread[threadId] ?? null);
  const scroller = useRef<HTMLDivElement>(null);
  const opened = useRef<string | null>(null);
  const rows = useMemo(() => toRows(messages), [messages]);
  const copyable = useMemo(() => finalReplies(messages), [messages]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // a thread opens at its newest message; after that, someone who scrolled up to read
    // something stays put instead of being yanked back down on every token
    const fresh = opened.current !== threadId;
    opened.current = threadId;
    if (!fresh && el.scrollHeight - el.scrollTop - el.clientHeight > 120) return;
    el.scrollTop = el.scrollHeight;
  }, [threadId, messages.length, streaming]);

  if (messages.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-[13px] text-faint">Send a message to start this thread.</p>
      </div>
    );
  }

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
        {rows.map((row) =>
          "tools" in row ? (
            <ToolGroup key={row.id} messages={row.tools} />
          ) : (
            <Bubble
              key={row.id}
              message={row.message}
              copyable={row.message.role === "user" || copyable.has(row.message.id)}
              files={files}
              onRun={onRun}
              onRewind={onRewind}
            />
          ),
        )}
        {streaming ? (
          <Markdown
            text={`${streaming}▏`}
            files={files}
            onRun={onRun}
            className="text-[14px] leading-[1.65] text-foreground"
          />
        ) : running ? (
          <Activity phase={phase} />
        ) : null}
      </div>
    </div>
  );
}
