import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { FileLinks } from "../lib/fileref.ts";
import type { Message } from "../lib/types.ts";
import { Markdown } from "./Markdown.tsx";
import { ChevronIcon, cn } from "./ui.tsx";

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

  return (
    <div className="mb-1 rounded-md bg-background/60 px-2.5 py-2">
      <p className="font-mono text-[11px] font-semibold text-primary">{toolName(message)}</p>
      {entries.map(([key, value]) => (
        <div key={key} className="mt-1.5">
          <p className="text-[10.5px] text-faint">{key}</p>
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-muted-foreground">
            {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          </pre>
        </div>
      ))}
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
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">
          {toolLine(message)}
        </span>
        <ChevronIcon className={cn("size-3 text-faint transition-transform", open ? "" : "-rotate-90")} />
      </button>
      {open ? <ToolDetail message={message} /> : null}
    </div>
  );
}

const ToolGroup = memo(function ToolGroup({ messages }: { messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const single = messages.length === 1;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {single ? null : (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
        >
          {groupLine(messages)}
          <ChevronIcon className={cn("size-3 text-faint transition-transform", open ? "" : "-rotate-90")} />
        </button>
      )}
      {single || open ? (
        <div className="min-w-0 rounded-lg border border-border/70 bg-card/50 p-1">
          {messages.map((message) => (
            <ToolRow
              key={message.id}
              message={message}
              open={openRow === message.id}
              onToggle={() => setOpenRow(openRow === message.id ? null : message.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
});

// a settled message never changes, but a streaming token rerenders the whole timeline —
// without this every bubble reparses its markdown for each token that arrives
const Bubble = memo(function Bubble({
  message,
  files,
  onRun,
}: {
  message: Message;
  files: FileLinks;
  onRun: (command: string) => void;
}) {
  if (message.role === "system") {
    return <p className="text-center text-[11px] text-faint">{message.text}</p>;
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap text-foreground">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <Markdown
      text={message.text}
      files={files}
      onRun={onRun}
      className={cn(
        "text-[14px] leading-[1.65]",
        message.role === "error"
          ? "rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-destructive"
          : "text-foreground",
      )}
    />
  );
});

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

export function Timeline({
  threadId,
  messages,
  streaming,
  running,
  files,
  onRun,
}: {
  threadId: string;
  messages: Message[];
  streaming: string;
  running: boolean;
  files: FileLinks;
  onRun: (command: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const opened = useRef<string | null>(null);
  const rows = useMemo(() => toRows(messages), [messages]);

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
            <Bubble key={row.id} message={row.message} files={files} onRun={onRun} />
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
          <p className="text-[12px] text-faint">Working…</p>
        ) : null}
      </div>
    </div>
  );
}
