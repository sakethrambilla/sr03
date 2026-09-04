// One open file tab: the highlighted listing with its diff markers in the gutter, an editable
// textarea over it, cmd-click navigation to whatever an import or a symbol resolves to, and a
// preview for markdown. A csv, tsv or xlsx hands off to TableView instead.
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api.ts";
import type { FileLinks, LineLink } from "../lib/fileref.ts";
import type { ChangedFile, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { TableView } from "./TableView.tsx";
import { EyeIcon, cn, usePersistedState } from "./ui.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TOKEN_CLASS, tokenize, type Token } from "../lib/highlight.ts";

interface Block {
  id: number;
  start: number;
  end: number;
  removed: string[];
}

type BlockKind = "added" | "modified" | "deleted";

const MARKDOWN = /\.(md|markdown|mdx)$/i;
const DELIMITED = /\.(csv|tsv)$/i;
// binary, so there is no raw mode worth flipping back to — these open straight into the grid
const SPREADSHEET = /\.(xlsx|xlsm)$/i;

// the marker strip plus the number column, which the textarea starts after
const GUTTER = 58;

// a comment or template string arrives as one token spanning several lines, and every line
// has to be its own row for the numbers to keep up with the wrapping
function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ text: part, kind: token.kind });
    });
  }
  return lines;
}

interface Segment {
  link: LineLink | null;
  tokens: Token[];
}

const SHADOWED = new Set<Token["kind"]>(["comment", "string", "property"]);

// every mention of an imported name, so clicking the symbol goes where the specifier goes
function symbols(tokens: Token[], bindings: Map<string, string>): LineLink[] {
  if (bindings.size === 0) return [];
  const links: LineLink[] = [];
  let column = 0;
  let previous = "";
  for (const token of tokens) {
    const path = bindings.get(token.text);
    // a name quoted, commented out, keyed in an object or reached through a dot is not the import
    const own = !SHADOWED.has(token.kind) && !previous.trimEnd().endsWith(".");
    if (path && own) links.push({ start: column, end: column + token.text.length, path });
    column += token.text.length;
    previous = token.text;
  }
  return links;
}

// a link can start and end mid-token and can run across several of them, so the line is
// re-cut along its edges before any of it is rendered
function segment(tokens: Token[], links: LineLink[]): Segment[] {
  if (links.length === 0) return [{ link: null, tokens }];
  const segments: Segment[] = [];
  let column = 0;
  for (const token of tokens) {
    let offset = 0;
    while (offset < token.text.length) {
      const at = column + offset;
      const link = links.find((candidate) => at >= candidate.start && at < candidate.end) ?? null;
      const edge = link ? link.end : (links.find((candidate) => candidate.start > at)?.start ?? Infinity);
      const stop = Math.min(edge, column + token.text.length);
      const piece = { text: token.text.slice(offset, stop - column), kind: token.kind };
      const last = segments.at(-1);
      if (last && last.link === link) last.tokens.push(piece);
      else segments.push({ link, tokens: [piece] });
      offset = stop - column;
    }
    column += token.text.length;
  }
  return segments;
}

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

// a streaming token re-renders the chat around this; without memo every open file would
// re-run its tokeniser and reconcile thousands of rows per frame
export const FileView = memo(function FileView({
  thread,
  path,
  active,
  onClose,
  onDirtyChange,
  onSaved,
  registerSave,
  reveal,
  links,
}: {
  thread: Thread;
  path: string;
  active: boolean;
  onClose: (path: string) => void;
  onDirtyChange: (path: string, dirty: boolean) => void;
  onSaved: () => void;
  registerSave: (path: string, save: (() => Promise<boolean>) | null) => void;
  reveal: { line: number; key: number } | null;
  links: FileLinks;
}) {
  const fsTick = useStore((state) => state.fsVersionByThread[thread.id] ?? 0);
  const [file, setFile] = useState<{
    text: string;
    binary: boolean;
    truncated: boolean;
    status: ChangedFile["status"] | null;
    diff: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [wrap, setWrap] = usePersistedState<boolean>("wrap", false);
  const rows = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<number | null>(null);
  // held cmd (or ctrl) is what turns an import specifier into something clickable
  const [linking, setLinking] = useState(false);
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
        if (!dirty) setText(next.text);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [thread.id, path, fsTick]);

  useEffect(() => onDirtyChange(path, dirty), [path, dirty, onDirtyChange]);

  useEffect(() => {
    if (!active) {
      setLinking(false);
      return;
    }
    const track = (event: KeyboardEvent) => setLinking(event.metaKey || event.ctrlKey);
    const clear = () => setLinking(false);
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", clear);
    };
  }, [active]);

  // a reference clicked in the chat lands here, but only once the file it names has loaded
  const jumped = useRef<number | null>(null);
  useEffect(() => {
    if (!file || !reveal || jumped.current === reveal.key) return;
    jumped.current = reveal.key;
    const row = rows.current?.querySelector<HTMLElement>(`[data-line="${reveal.line}"]`);
    scroller.current?.scrollTo({ top: Math.max(0, (row?.offsetTop ?? 0) - 96) });
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
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "v") {
        if (!MARKDOWN.test(path) && !DELIMITED.test(path)) return;
        event.preventDefault();
        setPreview((current) => !current);
        return;
      }
      // undo and redo belong to the textarea, so only Escape is handled here
      if (event.key === "Escape" && !dirty) onClose(path);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onClose, dirty, saving, path, thread.id]);

  const slash = path.lastIndexOf("/");
  const markdown = MARKDOWN.test(path);
  const delimited = DELIMITED.test(path);
  const reading = markdown && preview;
  const grid = SPREADSHEET.test(path) || (delimited && preview);
  const lines = useMemo(() => {
    if (!file || file.binary) return [] as Segment[][];
    const bindings = links.bindings(path, text);
    return toLines(tokenize(text, path)).map((tokens) => {
      const found = [
        ...links.imports(path, tokens.map((token) => token.text).join("")),
        ...symbols(tokens, bindings),
      ];
      // segment walks the line forwards and takes the first link it can reach
      return segment(tokens, found.sort((a, b) => a.start - b.start));
    });
  }, [file?.binary, text, path, links]);
  const diff = file?.diff ?? "";
  const { blocks, startsAt, covers } = useMemo(() => {
    const blocks = file ? parseBlocks(diff) : [];
    const covers = new Map<number, Block>();
    for (const block of blocks) {
      for (let line = block.start; line <= block.end; line += 1) covers.set(line, block);
    }
    return { blocks, startsAt: new Map(blocks.map((block) => [block.start, block])), covers };
  }, [file === null, diff]);

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
        {file?.truncated && !grid ? (
          <span className="shrink-0 font-mono text-[10.5px] text-git-modified">truncated</span>
        ) : null}
        <div className="flex-1" />
        {markdown || delimited ? (
          <Toggle
            size="sm"
            pressed={preview}
            onPressedChange={setPreview}
            aria-label={delimited ? "Preview as a table" : "Preview markdown"}
            title={delimited ? "Preview as a table ⇧⌘V" : "Preview markdown ⇧⌘V"}
            className="size-6 shrink-0 text-faint data-[state=on]:text-foreground"
          >
            <EyeIcon className="size-3.5" />
          </Toggle>
        ) : null}
        {saving ? (
          <span className="shrink-0 font-mono text-[10.5px] text-faint">Saving…</span>
        ) : dirty ? (
          <span className="shrink-0 font-mono text-[10.5px] text-git-modified">unsaved · ⌘S</span>
        ) : null}
      </header>

      {grid ? (
        <TableView thread={thread} path={path} />
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
          {error ? <p className="px-4 py-4 text-[12px] text-destructive">{error}</p> : null}
          {file?.binary ? (
            <p className="px-4 py-6 text-[12px] text-faint">This is a binary file.</p>
          ) : null}

          {file && !file.binary && reading ? (
            <div className="mx-auto max-w-3xl px-6 py-6">
              <Markdown text={text} className="text-[14px] leading-[1.7] text-foreground" />
            </div>
          ) : null}

          {file && !file.binary && !reading ? (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className={cn(
                    "relative font-mono text-[12px] leading-[1.5]",
                    wrap ? "" : "w-max min-w-full",
                  )}
                >
                  <div ref={rows}>
                    {lines.map((segments, index) => {
                      const number = index + 1;
                      const anchored = startsAt.get(number);
                      const block = covers.get(number);
                      return (
                        <div
                          key={number}
                          data-line={number}
                          className={cn("flex items-stretch", flash === number && "bg-primary/15")}
                        >
                          {/* pinned so the numbers survive a sideways scroll, which is what
                              the column used to be for before it moved into the rows */}
                          <span className="sticky left-0 z-10 flex shrink-0 items-stretch bg-card/40">
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
                            <span className="w-12 pr-2 text-right text-faint select-none">{number}</span>
                          </span>
                          {/* the caret belongs to the textarea laid over this, which is why the
                              text it is colouring must not take the click itself */}
                          <span
                            className={cn(
                              "pointer-events-none pl-1",
                              wrap
                                ? "min-w-0 flex-1 break-words whitespace-pre-wrap"
                                : "shrink-0 whitespace-pre",
                            )}
                          >
                            {segments.map((part, position) => {
                              const pieces = part.tokens.map((token, at) => (
                                <span key={at} className={TOKEN_CLASS[token.kind]}>
                                  {token.text}
                                </span>
                              ));
                              const target = part.link;
                              if (!target) return <Fragment key={position}>{pieces}</Fragment>;
                              return (
                                <span
                                  key={position}
                                  title={`Open ${target.path}`}
                                  onClick={(event) => {
                                    if (!event.metaKey && !event.ctrlKey) return;
                                    event.preventDefault();
                                    links.open({ path: target.path });
                                  }}
                                  // lifted over the textarea only while the key is down, so an
                                  // ordinary click still lands a caret here
                                  className={cn(
                                    linking &&
                                      "pointer-events-auto relative z-20 cursor-pointer underline decoration-dotted underline-offset-2 hover:decoration-primary hover:decoration-solid",
                                  )}
                                >
                                  {pieces}
                                </span>
                              );
                            })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {/* inset past the gutter rather than padded, so the markers stay clickable and
                      the text lands at exactly the offset the rows above it use */}
                  <textarea
                    ref={editor}
                    defaultValue={file.text}
                    onInput={(event) => {
                      const value = event.currentTarget.value;
                      setText(value);
                      setDirty(value !== file.text);
                    }}
                    wrap={wrap ? "soft" : "off"}
                    spellCheck={false}
                    style={{ left: GUTTER }}
                    className={cn(
                      "absolute inset-y-0 right-0 resize-none overflow-hidden bg-transparent pl-1 font-mono text-[12px] leading-[1.5] text-transparent caret-foreground outline-none selection:bg-primary/30",
                      wrap && "break-words",
                    )}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
                  Word wrap
                </ContextMenuCheckboxItem>
              </ContextMenuContent>
            </ContextMenu>
          ) : null}
        </div>
      )}
    </div>
  );
});
