import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { ChangedFile, Message, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { CloseIcon, cn } from "./ui.tsx";

const NO_MESSAGES: Message[] = [];

interface Block {
  id: number;
  start: number;
  end: number;
  removed: string[];
}

type BlockKind = "added" | "modified" | "deleted";

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

const GUTTER = "w-2.5 shrink-0";

const MARKER: Record<BlockKind, string> = {
  added: "bg-git-added",
  modified: "bg-git-modified",
  deleted: "bg-git-deleted",
};

export function FileView({
  thread,
  path,
  onClose,
}: {
  thread: Thread;
  path: string;
  onClose: () => void;
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
  const [openBlock, setOpenBlock] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .file(thread.id, path)
      .then((next) => {
        if (cancelled) return;
        setFile(next);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [thread.id, path, thread.status, messageCount]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const slash = path.lastIndexOf("/");
  const blocks = file ? parseBlocks(file.diff) : [];
  const lines = file && !file.binary ? file.text.replace(/\n$/, "").split("\n") : [];
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
            {blocks.length} change{blocks.length === 1 ? "" : "s"} · click a marker
          </span>
        ) : null}
        {file?.truncated ? (
          <span className="shrink-0 font-mono text-[10.5px] text-git-modified">truncated</span>
        ) : null}
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose} aria-label="Back to the conversation">
          <CloseIcon />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? <p className="px-4 py-4 text-[12px] text-destructive">{error}</p> : null}
        {file?.binary ? (
          <p className="px-4 py-6 text-[12px] text-faint">This is a binary file.</p>
        ) : null}

        <div className="w-max min-w-full font-mono text-[12px] leading-[1.5]">
          {lines.map((text, index) => {
            const number = index + 1;
            const block = covers.get(number);
            const anchored = startsAt.get(number);
            const expanded = anchored && openBlock === anchored.id;

            return (
              <div key={number}>
                {expanded
                  ? anchored.removed.map((removed, removedIndex) => (
                      <div key={removedIndex} className="flex bg-git-deleted/15">
                        <span className={cn(GUTTER, "flex")}>
                          <span className="w-1 bg-git-deleted" />
                        </span>
                        <span className="w-12 shrink-0 pr-2 text-right text-faint select-none">−</span>
                        <span className="pr-4 whitespace-pre text-git-deleted">{removed || " "}</span>
                      </div>
                    ))
                  : null}
                <div
                  className={cn(
                    "flex",
                    block && kindOf(block) !== "deleted" && "bg-git-added/10",
                    expanded && "bg-git-added/15",
                  )}
                >
                  {anchored ? (
                    // the bar itself is hairline-thin, so the whole gutter column is the hit target
                    <button
                      onClick={() => setOpenBlock(expanded ? null : anchored.id)}
                      title={
                        expanded
                          ? "Hide what changed here"
                          : `${kindOf(anchored)} — show what changed here`
                      }
                      className={cn(GUTTER, "group flex cursor-pointer items-stretch")}
                    >
                      <span
                        className={cn(
                          "w-1 transition group-hover:brightness-125",
                          MARKER[kindOf(anchored)],
                          kindOf(anchored) === "deleted" && "h-1 self-start",
                        )}
                      />
                    </button>
                  ) : (
                    <span className={cn(GUTTER, "flex")}>
                      <span className={cn("w-1", block && MARKER[kindOf(block)])} />
                    </span>
                  )}
                  <span className="w-12 shrink-0 pr-2 text-right text-faint select-none">
                    {number}
                  </span>
                  <span className="pr-4 whitespace-pre text-foreground">{text || " "}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
