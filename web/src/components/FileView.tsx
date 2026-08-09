import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api.ts";
import type { ChangedFile, Message, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { cn } from "./ui.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TOKEN_CLASS, tokenize } from "../lib/highlight.ts";

const NO_MESSAGES: Message[] = [];

interface Block {
  id: number;
  start: number;
  end: number;
  removed: string[];
}

type BlockKind = "added" | "modified" | "deleted";

// 12px text at leading-1.5, which the gutter rows hard-code as h-[18px]
const LINE = 18;

function kindOf(block: Block): BlockKind {
  if (block.end < block.start) return "deleted";
  return block.removed.length === 0 ? "added" : "modified";
}

// walks the unified diff and groups each run of -/+ lines into one block, anchored on
// the line numbers of the file as it is now
function parseBlocks(diff: string): Block[] {
  const blocks: Block[] = [];
  let pending: Block | null = null;
  let line = 0;
  let inHunk = false;

  const flush = () => {
    if (pending) blocks.push(pending);
    pending = null;
  };

  for (const raw of diff.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      flush();
      line = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;

    if (raw.startsWith("+")) {
      pending ??= { id: blocks.length, start: line, end: line - 1, removed: [] };
      pending.end = line;
      line += 1;
    } else if (raw.startsWith("-")) {
      pending ??= { id: blocks.length, start: line, end: line - 1, removed: [] };
      pending.removed.push(raw.slice(1));
    } else {
      flush();
      line += 1;
    }
  }
  flush();
  return blocks;
}

const MARKER: Record<BlockKind, string> = {
  added: "bg-git-added",
  modified: "bg-git-modified",
  deleted: "bg-git-deleted",
};

// the editor is a textarea, so a peek can't push rows apart the way it did in the
// read-only view — the removed lines hang off the marker instead
function Marker({ block }: { block: Block }) {
  const kind = kindOf(block);
  const bar = cn("w-1", MARKER[kind], kind === "deleted" && "h-1 self-start");

  if (block.removed.length === 0) {
    return (
      <span className="flex w-2.5 shrink-0 items-stretch">
        <span className={bar} />
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        title={`${kind} — show what was here`}
        className="group flex w-2.5 shrink-0 cursor-pointer items-stretch outline-none"
      >
        <span className={cn(bar, "transition group-hover:brightness-125")} />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        className="max-h-64 w-auto max-w-xl overflow-auto p-0"
      >
        <pre className="px-3 py-2 font-mono text-[11.5px] leading-[1.55]">
          {block.removed.map((line, index) => (
            <div key={index} className="whitespace-pre text-git-deleted">
              −{line}
            </div>
          ))}
        </pre>
      </PopoverContent>
    </Popover>
  );
}

export function FileView({
  thread,
  path,
  active,
  onClose,
  onDirtyChange,
  onSaved,
  registerSave,
  reveal,
}: {
  thread: Thread;
  path: string;
  active: boolean;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  registerSave: (path: string, save: (() => Promise<boolean>) | null) => void;
  reveal: { line: number; key: number } | null;
}) {
  const messageCount = useStore((state) => (state.messagesByThread[thread.id] ?? NO_MESSAGES).length);
  const [file, setFile] = useState<{
    text: string;
    binary: boolean;
    truncated: boolean;
    status: ChangedFile["status"] | null;
    diff: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [lineCount, setLineCount] = useState(1);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const layer = useRef<HTMLPreElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<number | null>(null);
  // deliberately uncontrolled: a React-controlled value resets the browser's own
  // undo stack on every keystroke, which kills cmd+z
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .file(thread.id, path)
      .then((next) => {
        if (cancelled) return;
        setFile(next);
        setError(null);
        // an edit in progress wins over whatever landed on disk; otherwise follow the file
        if (!dirty && editor.current && editor.current.value !== next.text) {
          editor.current.value = next.text;
        }
        if (!dirty) {
          setLineCount(next.text.split("\n").length);
          setText(next.text);
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [thread.id, path, thread.status, messageCount]);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // a reference clicked in the chat lands here, but only once the file it names has loaded
  const jumped = useRef<number | null>(null);
  useEffect(() => {
    if (!file || !reveal || jumped.current === reveal.key) return;
    jumped.current = reveal.key;
    scroller.current?.scrollTo({ top: Math.max(0, (reveal.line - 1) * LINE - 96) });
    setFlash(reveal.line);
    const timer = window.setTimeout(() => setFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [file, reveal]);

  const save = async (): Promise<boolean> => {
    const text = editor.current?.value;
    if (text === undefined || saving) return false;
    setSaving(true);
    try {
      await api.saveFile(thread.id, path, text);
      const next = await api.file(thread.id, path);
      setFile(next);
      setDirty(editor.current?.value !== next.text);
      setError(null);
      onSaved();
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  // the close dialog offers to save, and only this component holds the edited text
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    registerSave(path, () => latest.current());
    return () => registerSave(path, null);
  }, [registerSave, path]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
        return;
      }
      // undo and redo belong to the textarea, so only Escape is handled here
      if (event.key === "Escape" && !dirty) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose, dirty, saving, path, thread.id]);

  const slash = path.lastIndexOf("/");
  const blocks = file ? parseBlocks(file.diff) : [];
  const startsAt = new Map(blocks.map((block) => [block.start, block]));
  const covers = new Map<number, Block>();
  for (const block of blocks) {
    for (let line = block.start; line <= block.end; line += 1) covers.set(line, block);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 bg-card/40 px-4 py-1.5">
        <span className="min-w-0 truncate font-mono text-[12px]">
          <span className="text-faint">{slash === -1 ? "" : path.slice(0, slash + 1)}</span>
          <span className="text-foreground">{path.slice(slash + 1)}</span>
        </span>
        {blocks.length > 0 ? (
          <span className="shrink-0 font-mono text-[10.5px] text-faint">
            {blocks.length} change{blocks.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {file?.truncated ? (
          <span className="shrink-0 font-mono text-[10.5px] text-git-modified">truncated</span>
        ) : null}
        <div className="flex-1" />
        {saving ? (
          <span className="shrink-0 font-mono text-[10.5px] text-faint">Saving…</span>
        ) : dirty ? (
          <span className="shrink-0 font-mono text-[10.5px] text-git-modified">unsaved · ⌘S</span>
        ) : null}
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        {error ? <p className="px-4 py-4 text-[12px] text-destructive">{error}</p> : null}
        {file?.binary ? (
          <p className="px-4 py-6 text-[12px] text-faint">This is a binary file.</p>
        ) : null}

        {file && !file.binary ? (
          <div className="flex min-w-full font-mono text-[12px] leading-[1.5]">
            <div className="sticky left-0 z-10 shrink-0 bg-card/40 select-none">
              {Array.from({ length: lineCount }, (_, index) => {
                const number = index + 1;
                const anchored = startsAt.get(number);
                const block = covers.get(number);
                return (
                  <div key={number} className="flex h-[18px] items-stretch">
                    {/* only the visible tab mounts a peek: Radix keeps a closed popover
                        mounted for its exit animation, which never runs under display:none */}
                    {anchored && active ? (
                      <Marker block={anchored} />
                    ) : (
                      <span className="flex w-2.5 shrink-0 items-stretch">
                        <span
                          className={cn(
                            "w-1",
                            anchored ? MARKER[kindOf(anchored)] : block && MARKER[kindOf(block)],
                          )}
                        />
                      </span>
                    )}
                    <span className="w-12 pr-2 text-right text-faint">{number}</span>
                  </div>
                );
              })}
            </div>
            <div className="relative min-w-0 flex-1">
              {flash !== null ? (
                <span
                  aria-hidden
                  style={{ top: (flash - 1) * LINE, height: LINE }}
                  className="pointer-events-none absolute inset-x-0 animate-pulse bg-primary/15"
                />
              ) : null}
              <pre
                ref={layer}
                aria-hidden
                className="pointer-events-none absolute inset-0 m-0 overflow-hidden pl-1 font-mono text-[12px] leading-[1.5] whitespace-pre"
              >
                {tokenize(text, path).map((token, index) => (
                  <span key={index} className={TOKEN_CLASS[token.kind]}>
                    {token.text}
                  </span>
                ))}
              </pre>
              <textarea
                  ref={editor}
                defaultValue={file.text}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setLineCount(value.split("\n").length);
                  setText(value);
                  setDirty(value !== file.text);
                }}
                onScroll={(event) => {
                  // the highlight layer sits behind the textarea and has to track its
                  // horizontal scroll, since only the textarea scrolls sideways
                  if (layer.current) layer.current.scrollLeft = event.currentTarget.scrollLeft;
                }}
                wrap="off"
                spellCheck={false}
                rows={lineCount}
                  className="relative w-full resize-none overflow-x-auto overflow-y-hidden bg-transparent pl-1 font-mono text-[12px] leading-[1.5] text-transparent caret-foreground outline-none selection:bg-primary/30"
                />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
