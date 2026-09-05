// The transcript: user bubbles, replies, runs of tool calls collapsed into one expandable row,
// the streaming tail of the turn in flight, and the label for what it is waiting on. Also owns
// the scroll behaviour — pinned to the bottom until you scroll away, with a jump-to-latest pill.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import type { FileLinks } from "../lib/fileref.ts";
import type { Message, ThreadPhase, ThreadTask } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { ChevronIcon, CopyButton, RewindIcon, cn } from "./ui.tsx";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";

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
  Agent: { verb: "Launched", noun: "agents" },
  TodoWrite: { verb: "Updated", noun: "todos" },
  ExitPlanMode: { verb: "Presented", noun: "plans" },
  AskUserQuestion: { verb: "Asked", noun: "questions" },
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

// Cursor keys the row by the tool call; Claude's task id is the SDK task_id, so a unique
// description is the fallback when the ids are different names for the same spawn
function taskForDelegation(message: Message, tasks: ThreadTask[]): ThreadTask | undefined {
  const name = toolName(message);
  if (name !== "Task" && name !== "Agent") return undefined;
  const useId = message.meta?.toolUseId;
  if (typeof useId === "string") {
    const byCall = tasks.find((task) => task.id === useId || task.toolUseId === useId);
    if (byCall) return byCall;
  }
  const description = typeof toolInput(message).description === "string"
    ? (toolInput(message).description as string).trim()
    : "";
  if (!description) return undefined;
  const matches = tasks.filter((task) => task.description === description);
  return matches.length === 1 ? matches[0] : undefined;
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
  onOpenSubagent,
}: {
  message: Message;
  open: boolean;
  onToggle: () => void;
  onOpenSubagent?: () => void;
}) {
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={onOpenSubagent ?? onToggle}
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
        {onOpenSubagent ? null : (
          <ChevronIcon className={cn("size-3 text-faint transition-transform", open ? "" : "-rotate-90")} />
        )}
      </button>
      {open ? (
        <div className="pb-1">
          <ToolDetail message={message} />
        </div>
      ) : null}
    </div>
  );
}

const ToolGroup = memo(function ToolGroup({
  messages,
  tasks,
  onOpenSubagent,
}: {
  messages: Message[];
  tasks: ThreadTask[];
  onOpenSubagent?: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const single = messages.length === 1 ? messages[0] : null;
  const match = single ? taskForDelegation(single, tasks) : undefined;
  const openMatched = match && onOpenSubagent ? () => onOpenSubagent(match.id) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        onClick={openMatched ?? (() => setOpen(!open))}
        className={cn(
          "flex w-fit max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] transition hover:bg-accent hover:text-foreground",
          messages.some(toolFailed) ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <span className="min-w-0 truncate">{single ? toolLine(single) : groupLine(messages)}</span>
        {openMatched ? null : (
          <ChevronIcon
            className={cn("size-3 shrink-0 text-faint transition-transform", open ? "" : "-rotate-90")}
          />
        )}
      </button>
      {open && !openMatched ? (
        <div className="min-w-0 rounded-lg border border-border/70 bg-card/50 p-1">
          {single ? (
            <ToolDetail message={single} />
          ) : (
            messages.map((message) => {
              const row = taskForDelegation(message, tasks);
              return (
                <ToolRow
                  key={message.id}
                  message={message}
                  open={openRow === message.id}
                  onToggle={() => setOpenRow(openRow === message.id ? null : message.id)}
                  onOpenSubagent={row && onOpenSubagent ? () => onOpenSubagent(row.id) : undefined}
                />
              );
            })
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

// the growing message is split at the last paragraph break outside a fence: the settled
// part is handed to a memoized Markdown that skips re-rendering once its text stops changing,
// so a long reply stops re-parsing everything it already said on every incoming token
const SettledMarkdown = memo(Markdown);

function splitStreaming(text: string): { settled: string; tail: string } {
  let inFence = false;
  let boundary = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith("```", i)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (!inFence && text[i] === "\n" && text[i + 1] === "\n") boundary = i + 2;
  }
  return boundary === -1 ? { settled: "", tail: text } : { settled: text.slice(0, boundary), tail: text.slice(boundary) };
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
  onRewind?: (message: Message) => void;
}) {
  if (message.role === "system") {
    return <p className="text-center text-[11px] text-faint">{message.text}</p>;
  }

  if (message.role === "user") {
    return (
      // the turn rail scrolls to this node and watches it for the in-view tick
      <div data-message-id={message.id} className="group flex flex-col items-end">
        <div className="max-w-[85%] rounded-lg bg-accent px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
          {message.text}
        </div>
        <MessageActions>
          {copyable ? <CopyButton text={message.text} /> : null}
          {onRewind ? (
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
          ) : null}
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

type RailItem = { id: string; prompt: string; reply: string | null };

// a prompt written over several lines has to read as one line in the preview
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// one tick per user turn, previewed by the prompt and that turn's last word — an error is left
// out of the preview, but the turn still gets its tick so it stays reachable
function toRailItems(messages: Message[]): RailItem[] {
  const items: RailItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      items.push({ id: message.id, prompt: oneLine(message.text), reply: null });
      continue;
    }
    const turn = items[items.length - 1];
    if (turn && message.role === "assistant") turn.reply = oneLine(message.text) || null;
  }
  return items;
}

const RAIL_CONTENT_WIDTH = 768; // max-w-3xl, the transcript's content column
const RAIL_PERSISTENT_GUTTER = 48;
const RAIL_STRIP_LEFT = 12;
const RAIL_STRIP_MAX_WIDTH = 40;
const RAIL_TICK_SPACING = 8;
const RAIL_MIN_TICKS = 3;

function railGutter(width: number): number {
  return Math.max(0, (width - Math.min(width, RAIL_CONTENT_WIDTH)) / 2);
}

// the rail overlays the scroller's left edge while the content column stays centered, so a
// fixed-width hit strip would sit on top of the message text and swallow its clicks — cap it to
// the gutter, where 0 leaves the rail inert
function railStripWidth(width: number): number {
  return Math.max(
    0,
    Math.min(RAIL_STRIP_MAX_WIDTH, Math.floor(railGutter(width)) - RAIL_STRIP_LEFT),
  );
}

// ticks are evenly spaced rather than proportional: it is a table of contents, not a scrollbar,
// so a turn that wrote a 400-line diff doesn't swallow the rail
function railTickTop(index: number, count: number): number {
  return count <= 1 ? 0 : (index / (count - 1)) * 100;
}

// capped against the transcript pane, not the viewport: the header, the composer and an open
// terminal all sit outside it, and a rail taller than the pane would overhang onto them
function railHeight(count: number): string {
  return `min(${Math.max(1, (count - 1) * RAIL_TICK_SPACING)}px, calc(100% - 4rem))`;
}

function railIndexAt(top: number, height: number, pointerY: number, count: number): number | null {
  if (count <= 0 || height <= 0) return null;
  if (count === 1) return 0;
  const progress = Math.min(1, Math.max(0, (pointerY - top) / height));
  return Math.round(progress * (count - 1));
}

// The turn rail: a tick per user message in the transcript's left gutter, hover for the turn and
// click to jump to it. One button covers the whole rail — a 2px tick is impossible to hover on
// its own — and pointer Y picks the nearest tick.
function TurnRail({
  items,
  stripWidth,
  persistent,
  onSelect,
  registerTick,
}: {
  items: RailItem[];
  stripWidth: number;
  persistent: boolean;
  onSelect: (id: string) => void;
  registerTick: (id: string, node: HTMLElement | null) => void;
}) {
  const strip = useRef<HTMLButtonElement>(null);
  // the offset rides along with the index so the preview can be pinned to its tick without
  // re-measuring; the rail's height is a CSS min(), which only the layout knows
  const [active, setActive] = useState<{ index: number; offset: number } | null>(null);

  const at = active !== null && active.index < items.length ? active : null;
  const item = at === null ? null : items[at.index];

  const resolve = (index: number | null) => {
    const rect = strip.current?.getBoundingClientRect();
    if (rect === undefined || index === null) return null;
    const clamped = Math.min(items.length - 1, Math.max(0, index));
    return { index: clamped, offset: (railTickTop(clamped, items.length) / 100) * rect.height };
  };

  const fromPointer = (pointerY: number) => {
    const rect = strip.current?.getBoundingClientRect();
    if (!rect) return null;
    return resolve(railIndexAt(rect.top, rect.height, pointerY, items.length));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === "ArrowDown"
        ? (at?.index ?? -1) + 1
        : event.key === "ArrowUp"
          ? (at?.index ?? items.length) - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : null;
    if (step !== null) {
      event.preventDefault();
      setActive(resolve(step));
      return;
    }
    // Enter would otherwise fire a click with no pointer position to read
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (item) onSelect(item.id);
    }
  };

  if (items.length < RAIL_MIN_TICKS) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-y-0 left-0 z-20 hidden w-18 [@media(pointer:fine)]:block",
        persistent
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 hover:opacity-100 focus-within:opacity-100",
      )}
    >
      <Popover open={item !== null}>
        <PopoverAnchor asChild>
          <button
            ref={strip}
            type="button"
            aria-label={item ? `Jump to message: ${item.prompt}` : "Jump to a message"}
            style={{ height: railHeight(items.length), width: stripWidth }}
            // every pixel of travel would otherwise reposition the preview
            onMouseMove={(event) => {
              const next = fromPointer(event.clientY);
              setActive((current) => (current?.index === next?.index ? current : next));
            }}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive((current) => current ?? resolve(0))}
            onBlur={() => setActive(null)}
            onKeyDown={onKeyDown}
            onClick={(event) => {
              // an activation with no pointer behind it has no clientY to read, and would
              // otherwise clamp to the first turn rather than the one being announced
              const next = event.detail === 0 ? at : fromPointer(event.clientY);
              if (next) onSelect(items[next.index].id);
              event.currentTarget.blur();
            }}
            className={cn(
              "absolute top-1/2 left-3 -translate-y-1/2 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none",
              stripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
            )}
          >
            <span aria-hidden className="absolute top-0 left-3 h-full w-px bg-border/15" />
            {items.map((tick, index) => {
              const distance = at === null ? null : Math.abs(index - at.index);
              return (
                <span
                  key={tick.id}
                  aria-hidden
                  ref={(node) => registerTick(tick.id, node)}
                  data-in-view="false"
                  style={{ top: `${railTickTop(index, items.length)}%` }}
                  className={cn(
                    "absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                    distance === 0
                      ? "w-6 bg-muted-foreground/75"
                      : distance === 1
                        ? "w-4"
                        : distance === 2
                          ? "w-2.5"
                          : "w-2",
                  )}
                />
              );
            })}
          </button>
        </PopoverAnchor>
        {/* aligned to the rail's top rather than the tick, since a moving anchor doesn't
            reposition an open popover — alignOffset does */}
        <PopoverContent
          side="right"
          align="start"
          alignOffset={at?.offset ?? 0}
          sideOffset={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="pointer-events-none w-80 rounded-lg p-3"
        >
          <p className="truncate text-[13px] font-medium">{item?.prompt || "User message"}</p>
          {item?.reply ? (
            <p className="mt-1 line-clamp-3 text-[12.5px] leading-5 text-muted-foreground">
              {item.reply}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
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
const NO_TASKS: ThreadTask[] = [];

function StreamingReply({
  text,
  files,
  onRun,
}: {
  text: string;
  files: FileLinks;
  onRun: (command: string) => void;
}) {
  const { settled, tail } = useMemo(() => splitStreaming(text), [text]);
  return (
    <>
      {settled ? (
        <SettledMarkdown
          text={settled}
          files={files}
          onRun={onRun}
          className="text-[14px] leading-[1.65] text-foreground"
        />
      ) : null}
      <Markdown
        text={`${tail}▏`}
        files={files}
        onRun={onRun}
        className="text-[14px] leading-[1.65] text-foreground"
      />
    </>
  );
}

// subscribed here rather than in the chat view, so a streaming frame re-renders the
// transcript and nothing around it
export function Timeline({
  threadId,
  taskId,
  running,
  files,
  onRun,
  onRewind,
  onOpenSubagent,
}: {
  threadId: string;
  taskId?: string;
  running: boolean;
  files: FileLinks;
  onRun: (command: string) => void;
  onRewind?: (message: Message) => void;
  onOpenSubagent?: (taskId: string) => void;
}) {
  const allMessages = useStore((state) => state.messagesByThread[threadId] ?? NO_MESSAGES);
  const tasks = useStore((state) => state.tasksByThread[threadId] ?? NO_TASKS);
  const loaded = useStore((state) => Boolean(state.loadedThreads[threadId]));
  const streaming = useStore((state) =>
    taskId
      ? (state.streamByTask[threadId]?.[taskId] ?? "")
      : (state.streamByThread[threadId] ?? ""),
  );
  const phase = useStore((state) => (taskId ? null : (state.phaseByThread[threadId] ?? null)));
  const messages = useMemo(
    () =>
      taskId
        ? allMessages.filter((message) => message.meta?.taskId === taskId)
        : allMessages.filter((message) => typeof message.meta?.taskId !== "string"),
    [allMessages, taskId],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const opened = useRef<string | null>(null);
  const rows = useMemo(() => toRows(messages), [messages]);
  const copyable = useMemo(() => finalReplies(messages), [messages]);
  const railItems = useMemo(() => toRailItems(messages), [messages]);
  const [pinned, setPinned] = useState(true);
  const [rail, setRail] = useState({ stripWidth: 0, persistent: false });
  const ticks = useRef(new Map<string, HTMLElement>());
  const jumping = useRef<number | null>(null);
  const empty = messages.length === 0 && !streaming;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // a thread opens at its newest message; after that, someone who scrolled up to read
    // something stays put instead of being yanked back down on every token
    const fresh = opened.current !== threadId;
    opened.current = threadId;
    // a rail jump animates, so a token landing mid-flight would read a position that is still
    // near the bottom and yank us off the message we just jumped to
    if (!fresh && jumping.current !== null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
    if (!fresh && !atBottom) {
      setPinned(false);
      return;
    }
    setPinned(true);
    el.scrollTop = el.scrollHeight;
  }, [threadId, messages.length, streaming]);

  // scrolling back down by hand re-arms auto-scroll for the rest of the turn
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= 120);
  };

  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinned(true);
  };

  const registerTick = useCallback((id: string, node: HTMLElement | null) => {
    if (node) ticks.current.set(id, node);
    else ticks.current.delete(id);
  }, []);

  const jumpToMessage = useCallback((id: string) => {
    const el = scroller.current;
    const node = el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!el || !node) return;
    const top = node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    setPinned(false);
    // scrollend would be exact, but Safari only grew it recently, so the animation is timed out
    if (jumping.current !== null) window.clearTimeout(jumping.current);
    jumping.current = window.setTimeout(() => (jumping.current = null), 700);
    // the content column's own top padding, so the bubble doesn't land against the edge
    el.scrollTo({ top: Math.max(0, top - 24), behavior: "smooth" });
  }, []);

  // scrolling must not re-render the transcript, so the highlight is written onto the tick nodes
  useEffect(() => {
    const el = scroller.current;
    if (!el || railItems.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId;
          const tick = id === undefined ? undefined : ticks.current.get(id);
          if (tick) tick.dataset.inView = entry.isIntersecting ? "true" : "false";
        }
      },
      { root: el },
    );
    for (const node of el.querySelectorAll("[data-message-id]")) observer.observe(node);
    return () => observer.disconnect();
  }, [railItems]);

  // the sidebar, the file tree and the agents panel all change how much gutter is left
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      const next = {
        stripWidth: railStripWidth(width),
        persistent: railGutter(width) >= RAIL_PERSISTENT_GUTTER,
      };
      setRail((current) =>
        current.stripWidth === next.stripWidth && current.persistent === next.persistent
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded, empty]);

  // "not read yet" and "genuinely empty" would otherwise show the same copy, so a thread
  // that has messages coming just renders nothing until they land instead of claiming it's new
  if (!loaded) return null;

  if (empty && !taskId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-[13px] text-faint">Send a message to start this thread.</p>
      </div>
    );
  }

  return (
    // the rail sits outside the scroller, which is the only way it can stay put while the
    // transcript scrolls under it
    <div className="relative flex min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {!pinned && (streaming || running || messages.length > 0) ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="sticky top-3 left-1/2 z-10 -ml-14 flex w-28 -translate-x-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/95 px-3 py-1 text-[11.5px] text-muted-foreground shadow-md shadow-black/20 backdrop-blur transition hover:text-foreground"
          >
            <ChevronIcon className="size-3 rotate-180" />
            Jump to latest
          </button>
        ) : null}
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
          {rows.map((row) =>
            "tools" in row ? (
              <ToolGroup
                key={row.id}
                messages={row.tools}
                tasks={tasks}
                onOpenSubagent={onOpenSubagent}
              />
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
            <StreamingReply text={streaming} files={files} onRun={onRun} />
          ) : running ? (
            <Activity phase={phase} />
          ) : null}
        </div>
      </div>
      {taskId ? null : (
        <TurnRail
          items={railItems}
          stripWidth={rail.stripWidth}
          persistent={rail.persistent}
          onSelect={jumpToMessage}
          registerTick={registerTick}
        />
      )}
    </div>
  );
}
