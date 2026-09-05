// The quick-open palette: ⌘P for files, `%` for text across the session folder. The file half
// ranks the folder listing the store already holds, so it never touches the network; the text
// half asks the server, which greps. Picking a result opens it in a file tab, on its line.
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api.ts";
import { rankFiles } from "../lib/search.ts";
import type { TextMatch, Thread } from "../lib/types.ts";
import { FileIcon } from "./ui.tsx";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

export type PaletteMode = "files" | "text";

const TEXT_PREFIX = "%";
const FILE_PREFIX = ">";

// cmdk builds a DOM node per row, and a folder can hold twenty thousand files
const FILE_ROWS = 50;
// long enough that a burst of typing costs one grep rather than one per key
const DEBOUNCE_MS = 120;

interface Parsed {
  mode: PaletteMode;
  term: string;
  line: number | null;
}

function parse(raw: string): Parsed {
  if (raw.startsWith(TEXT_PREFIX)) return { mode: "text", term: raw.slice(1).trim(), line: null };
  const body = (raw.startsWith(FILE_PREFIX) ? raw.slice(1) : raw).trim();
  // a trailing :42 is the line to land on once the file opens
  const suffix = /^(.*):(\d+)$/.exec(body);
  if (suffix) return { mode: "files", term: suffix[1]!.trim(), line: Number(suffix[2]) };
  return { mode: "files", term: body, line: null };
}

function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// the server hands back the line, not where in it the hit was — git counts that column in bytes,
// which drifts on multibyte text — so the span is found here instead
function Highlight({ text, term }: { text: string; term: string }) {
  const trimmed = text.trimStart();
  const at = term ? trimmed.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (at === -1) return <>{trimmed}</>;
  return (
    <>
      {trimmed.slice(0, at)}
      <mark className="bg-transparent text-primary">{trimmed.slice(at, at + term.length)}</mark>
      {trimmed.slice(at + term.length)}
    </>
  );
}

function FileRow({ path }: { path: string }) {
  const dir = dirname(path);
  return (
    <>
      <FileIcon name={path} />
      <span className="shrink-0 truncate text-[13px] text-foreground">{basename(path)}</span>
      {dir ? <span className="min-w-0 truncate text-[11.5px] text-faint">{dir}</span> : null}
    </>
  );
}

export function SearchPalette({
  thread,
  files,
  mode,
  onOpenFile,
  onClose,
}: {
  thread: Thread;
  files: string[];
  mode: PaletteMode;
  onOpenFile: (path: string, line?: number) => void;
  onClose: () => void;
}) {
  const [raw, setRaw] = useState(mode === "text" ? TEXT_PREFIX : "");
  const [matches, setMatches] = useState<TextMatch[]>([]);
  const [searching, setSearching] = useState(false);

  const query = parse(raw);
  const ranked = useMemo(
    () => (query.mode === "files" ? rankFiles(files, query.term, FILE_ROWS) : []),
    [files, query.mode, query.term],
  );

  // only the newest search may write to state — a slow grep must not overwrite a fast one
  const generation = useRef(0);
  const term = query.mode === "text" ? query.term : "";

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    if (!term) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      api.searchText(thread.id, term).then(
        (body) => {
          if (generation.current !== mine) return;
          setMatches(body.matches);
          setSearching(false);
        },
        () => {
          if (generation.current !== mine) return;
          setMatches([]);
          setSearching(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [term, thread.id]);

  const open = (path: string, line?: number) => {
    onOpenFile(path, line);
    onClose();
  };

  const rows = query.mode === "files" ? ranked.length : matches.length;
  const empty =
    query.mode === "text"
      ? term
        ? searching
          ? "Searching…"
          : "No matches"
        : "Type to search the folder's text"
      : "No files";

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Quick open</DialogTitle>
        <DialogDescription className="sr-only">
          Search files in this session's folder, or prefix with % to search their text.
        </DialogDescription>
        <Command shouldFilter={false} className="bg-transparent">
          <CommandInput
            autoFocus
            value={raw}
            onValueChange={setRaw}
            placeholder={
              query.mode === "text"
                ? "Search the folder's text…"
                : "Search files, or % to search text…"
            }
          />

          <CommandList className="max-h-[52vh] p-1">
            {/* cmdk's own Empty counts filtered rows, and this list is filtered here instead */}
            {rows === 0 ? (
              <p className="py-6 text-center text-[12px] text-faint">{empty}</p>
            ) : null}

            {query.mode === "files"
              ? ranked.map((path) => (
                  <CommandItem
                    key={path}
                    value={path}
                    onSelect={() => open(path, query.line ?? undefined)}
                    className="gap-2"
                  >
                    <FileRow path={path} />
                  </CommandItem>
                ))
              : matches.map((match, index) => {
                  const first = index === 0 || matches[index - 1]!.path !== match.path;
                  return (
                    <div key={`${match.path}:${match.line}:${index}`}>
                      {first ? (
                        <div className="flex items-center gap-1.5 px-2 pt-2 pb-1">
                          <FileIcon name={match.path} />
                          <span className="truncate text-[11.5px] text-muted-foreground">
                            {match.path}
                          </span>
                        </div>
                      ) : null}
                      <CommandItem
                        value={`${match.path}:${match.line}:${index}`}
                        onSelect={() => open(match.path, match.line)}
                        className="gap-2 pl-6"
                      >
                        <span className="w-9 shrink-0 text-right font-mono text-[11px] text-faint">
                          {match.line}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">
                          <Highlight text={match.text} term={term} />
                        </span>
                      </CommandItem>
                    </div>
                  );
                })}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
