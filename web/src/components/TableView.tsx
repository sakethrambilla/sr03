import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api.ts";
import type { Message, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { cn, usePersistedState } from "./ui.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const NO_MESSAGES: Message[] = [];
const PAGE = 500;
// the DOM is the limit here rather than the file — past this the footer's jump takes over
const LOADED = 10_000;
const NUMERIC = /^-?[\d,]*\.?\d+%?$/;

function letters(index: number): string {
  let name = "";
  for (let at = index; at >= 0; at = Math.floor(at / 26) - 1) {
    name = String.fromCharCode(65 + (at % 26)) + name;
  }
  return name;
}

const CELL = "border-b border-r border-border/40 px-2 py-1 align-top";
const GUTTER = "sticky left-0 z-10 w-14 min-w-14 bg-card text-right text-faint select-none";

export function TableView({ thread, path }: { thread: Thread; path: string }) {
  const messageCount = useStore(
    (state) => (state.messagesByThread[thread.id] ?? NO_MESSAGES).length,
  );
  const [sheet, setSheet] = useState(0);
  const [header, setHeader] = usePersistedState<boolean>("table-header", true);
  const [meta, setMeta] = useState<{ sheets: string[]; total: number; truncated: boolean } | null>(
    null,
  );
  const [head, setHead] = useState<string[] | null>(null);
  const [base, setBase] = useState(0);
  const [rows, setRows] = useState<string[][]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  // a reset bumps this, so a page that was already in flight can't land on the new window
  const run = useRef(0);

  const load = async (offset: number, replace: boolean) => {
    const token = run.current;
    setBusy(true);
    try {
      const data = await api.table(thread.id, path, sheet, offset, PAGE);
      if (run.current !== token) return;
      setMeta({ sheets: data.sheets, total: data.total, truncated: data.truncated });
      setError(null);
      if (!replace) {
        setRows((current) => [...current, ...data.rows]);
        return;
      }
      setBase(offset);
      setRows(data.rows);
      // the first row is kept aside so jumping deep into the file doesn't lose the header
      if (offset === 0) setHead(data.rows[0] ?? null);
    } catch (cause) {
      if (run.current === token) setError((cause as Error).message);
    } finally {
      if (run.current === token) setBusy(false);
    }
  };

  const reset = (offset: number) => {
    run.current += 1;
    setRows([]);
    if (offset === 0) setHead(null);
    void load(offset, true);
  };

  useEffect(() => {
    run.current += 1;
    setRows([]);
    setHead(null);
    setMeta(null);
    scroller.current?.scrollTo({ top: 0 });
    void load(0, true);
  }, [thread.id, path, sheet]);

  // a turn may have rewritten the file, so the same window is re-read rather than
  // throwing the reader back to the top of it
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    run.current += 1;
    void load(base, true);
  }, [messageCount, thread.status]);

  const loaded = base + rows.length;
  const more = meta !== null && loaded < meta.total && rows.length < LOADED;

  // the scroller drives paging itself, and the immediate call tops up a first page that
  // didn't fill the view
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const onScroll = () => {
      if (!more || busy) return;
      if (node.scrollTop + node.clientHeight < node.scrollHeight - 400) return;
      void load(loaded, false);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => node.removeEventListener("scroll", onScroll);
  }, [more, busy, loaded]);

  // row 0 is the header row itself, so it leaves the body only when the window includes it
  const dropFirst = header && base === 0;
  const body = dropFirst ? rows.slice(1) : rows;
  const firstNumber = base + (dropFirst ? 2 : 1);

  const width = useMemo(
    () => body.reduce((widest, row) => Math.max(widest, row.length), head?.length ?? 1),
    [body, head],
  );

  // a column of numbers reads far better right-aligned, and a data file is mostly numbers
  const numeric = useMemo(() => {
    const flags: boolean[] = [];
    for (let column = 0; column < width; column += 1) {
      let seen = 0;
      let numbers = 0;
      for (const row of body) {
        const value = row[column];
        if (!value) continue;
        seen += 1;
        if (NUMERIC.test(value)) numbers += 1;
      }
      flags.push(seen > 0 && numbers / seen > 0.8);
    }
    return flags;
  }, [body, width]);

  const sheets = meta?.sheets ?? [];

  const jump = () => {
    const row = Number(target.replace(/[^\d]/g, ""));
    if (!Number.isFinite(row) || row < 1 || !meta) return;
    setTarget("");
    scroller.current?.scrollTo({ top: 0 });
    reset(Math.min(Math.max(row - 1, 0), Math.max(meta.total - 1, 0)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        {error ? <p className="px-4 py-4 text-[12px] text-destructive">{error}</p> : null}
        {!error && meta && body.length === 0 && !busy ? (
          <p className="px-4 py-6 text-[12px] text-faint">This sheet has no rows.</p>
        ) : null}

        {body.length > 0 ? (
          // the generated table wraps itself in a scroller of its own, which would capture the
          // sticky header — this neutralises it so the header pins to the scroller above
          <div className="[&>[data-slot=table-container]]:overflow-visible">
          <Table className="w-max border-separate border-spacing-0 font-mono text-[11.5px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={cn("sticky top-0 z-20 h-auto bg-card", CELL, GUTTER)} />
                {Array.from({ length: width }, (_, column) => (
                  <TableHead
                    key={column}
                    className={cn(
                      "sticky top-0 z-[15] h-auto max-w-96 truncate bg-card text-[11px] font-medium",
                      CELL,
                      numeric[column] && "text-right",
                    )}
                    title={header ? head?.[column] : undefined}
                  >
                    {(header ? head?.[column] : "") || letters(column)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {body.map((row, index) => (
                <TableRow key={base + index}>
                  <TableCell className={cn(CELL, GUTTER, "tabular-nums")}>
                    {firstNumber + index}
                  </TableCell>
                  {Array.from({ length: width }, (_, column) => (
                    <TableCell
                      key={column}
                      title={row[column] || undefined}
                      className={cn(
                        CELL,
                        "max-w-96 truncate",
                        numeric[column] && "text-right tabular-nums",
                      )}
                    >
                      {row[column] ?? ""}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        ) : null}

        <p className="px-4 py-2 text-[11px] text-faint">{busy ? "Loading…" : ""}</p>
      </div>

      <footer className="flex shrink-0 items-center gap-3 border-t border-border/60 bg-card/40 px-3 py-1.5">
        {sheets.length > 1 ? (
          <Select value={String(sheet)} onValueChange={(next) => setSheet(Number(next))}>
            <SelectTrigger size="sm" className="h-6 w-44 shrink-0 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sheets.map((name, index) => (
                <SelectItem key={name} value={String(index)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-faint">
          <Checkbox
            checked={header}
            onCheckedChange={(next) => setHeader(next === true)}
            className="size-3.5"
          />
          Header row
        </label>

        <span className="shrink-0 font-mono text-[10.5px] text-faint">
          {body.length === 0
            ? "no rows"
            : `rows ${firstNumber.toLocaleString()}–${(
                firstNumber + body.length - 1
              ).toLocaleString()} of ${(meta?.total ?? 0).toLocaleString()}${
                meta?.truncated ? "+" : ""
              }`}
        </span>
        {rows.length >= LOADED ? (
          <span className="shrink-0 font-mono text-[10.5px] text-git-modified">
            jump to read further
          </span>
        ) : null}

        <div className="flex-1" />

        <Input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") jump();
          }}
          placeholder="row"
          inputMode="numeric"
          className="h-6 w-20 shrink-0 font-mono text-[11.5px]"
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!target.trim()}
          onClick={jump}
          className="h-6 shrink-0 px-2 text-[11px]"
        >
          Jump
        </Button>
      </footer>
    </div>
  );
}
