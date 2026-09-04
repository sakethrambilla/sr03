// The csv / xlsx viewer: rows paged in from the server a window at a time, a search that costs a
// full pass so it waits for Enter, per-column value checklists, the sheet picker, and single-cell
// edits written back through the mtime the window was read at.
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../lib/api.ts";
import type { TableFilter, TableValues, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { CloseIcon, FilterIcon, SearchIcon, cn, usePersistedState } from "./ui.tsx";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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

const NO_FILTERS: TableFilter[] = [];
const PAGE = 500;
// the DOM is the limit here rather than the file — past this the footer's jump takes over.
// wide sheets multiply rows by columns fast, so this stays well under what a browser tab
// can hold comfortably rather than at the ceiling of what it can hold at all
const LOADED = 2_000;
const NUMERIC = /^-?[\d,]*\.?\d+%?$/;
const SPREADSHEET = /\.(xlsx|xlsm)$/i;

function letters(index: number): string {
  let name = "";
  for (let at = index; at >= 0; at = Math.floor(at / 26) - 1) {
    name = String.fromCharCode(65 + (at % 26)) + name;
  }
  return name;
}

const CELL = "border-b border-r border-border/40 px-2 py-1 align-top";
const GUTTER = "sticky left-0 z-10 w-14 min-w-14 bg-card text-right text-faint select-none";

// the values on offer are the ones the other columns' filters still allow, so ticking
// through several columns narrows the way it does in a spreadsheet
function ColumnFilter({
  thread,
  path,
  sheet,
  header,
  search,
  filters,
  column,
  onApply,
}: {
  thread: Thread;
  path: string;
  sheet: number;
  header: boolean;
  search: string;
  filters: TableFilter[];
  column: number;
  onApply: (values: string[] | null) => void;
}) {
  const active = filters.find((one) => one.column === column) ?? null;
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<TableValues | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [needle, setNeedle] = useState("");
  const key = JSON.stringify(filters);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setList(null);
    setError(null);
    setNeedle("");
    api
      .tableValues(thread.id, path, { sheet, column, search, filters, header })
      .then((next) => {
        if (cancelled) return;
        setList(next);
        // nothing ticked yet means everything is in play
        setPicked(new Set(active ? active.values : next.values.map((one) => one.value)));
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open, thread.id, path, sheet, column, header, search, key]);

  const shown = list
    ? list.values.filter((one) => !needle || one.value.toLowerCase().includes(needle.toLowerCase()))
    : [];

  const toggle = (value: string, on: boolean) => {
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(value);
      else next.delete(value);
      return next;
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={active ? `Filtered to ${active.values.length} value(s)` : "Filter this column"}
          className={cn(
            "shrink-0 cursor-pointer rounded p-0.5 outline-none hover:bg-accent",
            active ? "text-primary" : "text-faint",
          )}
        >
          <FilterIcon className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        {error ? <p className="px-3 py-2 text-[11.5px] text-destructive">{error}</p> : null}
        {!list && !error ? (
          <p className="px-3 py-2 text-[11.5px] text-faint">Reading the column…</p>
        ) : null}
        {list ? (
          <div className="flex flex-col">
            <div className="border-b border-border/60 p-2">
              <Input
                value={needle}
                onChange={(event) => setNeedle(event.target.value)}
                placeholder="Find a value"
                className="h-6 text-[11.5px]"
              />
            </div>
            <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10.5px]"
                onClick={() => setPicked(new Set(shown.map((one) => one.value)))}
              >
                All
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10.5px]"
                onClick={() => setPicked(new Set())}
              >
                None
              </Button>
              <span className="ml-auto font-mono text-[10px] text-faint">
                {list.values.length.toLocaleString()}
                {list.truncated ? "+" : ""} values
              </span>
            </div>
            <div className="max-h-56 overflow-auto py-1">
              {shown.map((one) => (
                <label
                  key={one.value}
                  className="flex cursor-pointer items-center gap-2 px-2 py-0.5 hover:bg-accent/60"
                >
                  <Checkbox
                    className="size-3.5"
                    checked={picked.has(one.value)}
                    onCheckedChange={(on) => toggle(one.value, on === true)}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={one.value}>
                    {one.value === "" ? "(empty)" : one.value}
                  </span>
                  <span className="font-mono text-[10px] text-faint">
                    {one.count.toLocaleString()}
                  </span>
                </label>
              ))}
              {shown.length === 0 ? (
                <p className="px-2 py-1 text-[11px] text-faint">No values match.</p>
              ) : null}
            </div>
            {list.truncated ? (
              <p className="border-t border-border/60 px-2 py-1 text-[10.5px] text-git-modified">
                Too many distinct values to list them all — search above the grid instead.
              </p>
            ) : null}
            <div className="flex items-center gap-2 border-t border-border/60 p-2">
              <Button
                size="sm"
                className="h-6 flex-1 text-[11px]"
                onClick={() => {
                  onApply(picked.size === list.values.length ? null : [...picked]);
                  setOpen(false);
                }}
              >
                Apply
              </Button>
              {active ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[11px]"
                  onClick={() => {
                    onApply(null);
                    setOpen(false);
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function TableView({ thread, path }: { thread: Thread; path: string }) {
  const fsTick = useStore((state) => state.fsVersionByThread[thread.id] ?? 0);
  const [sheet, setSheet] = useState(0);
  const [header, setHeader] = usePersistedState<boolean>("table-header", true);
  const [typed, setTyped] = useState("");
  // a search is a full pass over the file, so it waits for Enter rather than each keystroke
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TableFilter[]>(NO_FILTERS);
  const [meta, setMeta] = useState<{
    sheets: string[];
    total: number;
    truncated: boolean;
    filtered: boolean;
    mtimeMs: number;
  } | null>(null);
  const [head, setHead] = useState<string[] | null>(null);
  const [base, setBase] = useState(0);
  const [rows, setRows] = useState<string[][]>([]);
  const [numbers, setNumbers] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("");
  const [editing, setEditing] = useState<{ row: number; column: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // a reset bumps this, so a page that was already in flight can't land on the new view
  const run = useRef(0);
  const view = { sheet, search, filters, header };
  const key = `${sheet} ${search} ${JSON.stringify(filters)} ${header}`;

  const load = async (offset: number, replace: boolean) => {
    const token = run.current;
    setBusy(true);
    try {
      const data = await api.table(thread.id, path, { ...view, offset, limit: PAGE });
      if (run.current !== token) return;
      setMeta({
        sheets: data.sheets,
        total: data.total,
        truncated: data.truncated,
        filtered: data.filtered,
        mtimeMs: data.mtimeMs,
      });
      setHead(data.head);
      setError(null);
      if (replace) {
        setBase(offset);
        setRows(data.rows);
        setNumbers(data.numbers);
      } else {
        setRows((current) => [...current, ...data.rows]);
        setNumbers((current) => [...current, ...data.numbers]);
      }
    } catch (cause) {
      if (run.current === token) setError((cause as Error).message);
    } finally {
      if (run.current === token) setBusy(false);
    }
  };

  const reset = (offset: number) => {
    run.current += 1;
    setRows([]);
    setNumbers([]);
    setEditing(null);
    scroller.current?.scrollTo({ top: 0 });
    void load(offset, true);
  };

  useEffect(() => {
    run.current += 1;
    setRows([]);
    setNumbers([]);
    setMeta(null);
    setEditing(null);
    scroller.current?.scrollTo({ top: 0 });
    void load(0, true);
  }, [thread.id, path, key]);

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
  }, [fsTick]);

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

  const width = useMemo(
    () => rows.reduce((widest, row) => Math.max(widest, row.length), head?.length ?? 1),
    [rows, head],
  );

  // a column of numbers reads far better right-aligned, and a data file is mostly numbers
  const numeric = useMemo(() => {
    const flags: boolean[] = [];
    for (let column = 0; column < width; column += 1) {
      let seen = 0;
      let count = 0;
      for (const row of rows) {
        const value = row[column];
        if (!value) continue;
        seen += 1;
        if (NUMERIC.test(value)) count += 1;
      }
      flags.push(seen > 0 && count / seen > 0.8);
    }
    return flags;
  }, [rows, width]);

  const sheets = meta?.sheets ?? [];
  const editable = !SPREADSHEET.test(path);
  const active = search.trim() !== "" || filters.length > 0;

  const apply = (column: number, values: string[] | null) => {
    setFilters((current) => {
      const rest = current.filter((one) => one.column !== column);
      if (values === null) return rest;
      return [...rest, { column, values }].sort((a, b) => a.column - b.column);
    });
  };

  const jump = () => {
    const row = Number(target.replace(/[^\d]/g, ""));
    if (!Number.isFinite(row) || row < 1 || !meta) return;
    setTarget("");
    // the box takes a row of the file, and the header is not one of the body's rows
    reset(Math.min(Math.max(row - 1 - (header ? 1 : 0), 0), Math.max(meta.total - 1, 0)));
  };

  const commit = async (row: number, column: number, value: string) => {
    setEditing(null);
    const at = numbers.indexOf(row);
    if (at === -1 || (rows[at]?.[column] ?? "") === value) return;
    setSaving(true);
    try {
      const saved = await api.saveCell(thread.id, path, {
        row,
        column,
        value,
        mtimeMs: meta?.mtimeMs ?? 0,
      });
      setRows((current) => current.map((cells, index) => (index === at ? saved.cells : cells)));
      setMeta((current) => (current ? { ...current, mtimeMs: saved.mtimeMs } : current));
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <div className="relative shrink-0">
          <SearchIcon className="pointer-events-none absolute top-1.5 left-2 size-3 text-faint" />
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setSearch(typed);
              if (event.key === "Escape") {
                setTyped("");
                setSearch("");
              }
            }}
            placeholder="Search every column, then Enter"
            className="h-6 w-56 pl-7 text-[11.5px]"
          />
        </div>
        {search.trim() ? (
          <button
            type="button"
            onClick={() => {
              setTyped("");
              setSearch("");
            }}
            title="Clear the search"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 font-mono text-[10.5px] text-foreground"
          >
            {search.trim()}
            <CloseIcon className="size-3 text-faint" />
          </button>
        ) : null}
        {filters.map((one) => (
          <button
            key={one.column}
            type="button"
            onClick={() => apply(one.column, null)}
            title="Remove this filter"
            className="flex max-w-48 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 font-mono text-[10.5px] text-foreground"
          >
            <span className="truncate">
              {(header ? head?.[one.column] : "") || letters(one.column)}
              {": "}
              {one.values.length === 1 ? one.values[0] || "(empty)" : `${one.values.length} values`}
            </span>
            <CloseIcon className="size-3 shrink-0 text-faint" />
          </button>
        ))}
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={() => {
              setTyped("");
              setSearch("");
              setFilters(NO_FILTERS);
            }}
          >
            Clear all
          </Button>
        ) : null}
        <div className="flex-1" />
        {saving ? <span className="font-mono text-[10.5px] text-faint">Saving…</span> : null}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        {error ? <p className="px-4 py-4 text-[12px] text-destructive">{error}</p> : null}
        {!error && meta && rows.length === 0 && !busy ? (
          <p className="px-4 py-6 text-[12px] text-faint">
            {active ? "Nothing matches this filter." : "This sheet has no rows."}
          </p>
        ) : null}

        {rows.length > 0 ? (
          // the generated table wraps itself in a scroller of its own, which would capture the
          // sticky header — this neutralises it so the header pins to the scroller above
          <div className="[&>[data-slot=table-container]]:overflow-visible">
            <Table className="w-max border-separate border-spacing-0 font-mono text-[11.5px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={cn("sticky top-0 z-20 h-auto bg-card", CELL, GUTTER)} />
                  {Array.from({ length: width }, (_unused, column) => (
                    <TableHead
                      key={column}
                      className={cn(
                        "sticky top-0 z-[15] h-auto max-w-96 bg-card text-[11px] font-medium",
                        CELL,
                      )}
                    >
                      <span className="flex items-center gap-1">
                        <span
                          className={cn("min-w-0 flex-1 truncate", numeric[column] && "text-right")}
                          title={header ? head?.[column] : undefined}
                        >
                          {(header ? head?.[column] : "") || letters(column)}
                        </span>
                        <ColumnFilter
                          thread={thread}
                          path={path}
                          sheet={sheet}
                          header={header}
                          search={search}
                          filters={filters}
                          column={column}
                          onApply={(values) => apply(column, values)}
                        />
                      </span>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => {
                  const at = numbers[index] ?? 0;
                  return (
                    <TableRow key={at}>
                      <TableCell className={cn(CELL, GUTTER, "tabular-nums")}>{at + 1}</TableCell>
                      {Array.from({ length: width }, (_unused, column) => {
                        const value = row[column] ?? "";
                        if (editing && editing.row === at && editing.column === column) {
                          return (
                            <TableCell key={column} className={cn(CELL, "p-0")}>
                              <input
                                autoFocus
                                defaultValue={value}
                                onFocus={(event) => event.currentTarget.select()}
                                onBlur={(event) =>
                                  void commit(at, column, event.currentTarget.value)
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    void commit(at, column, event.currentTarget.value);
                                  }
                                  if (event.key === "Escape") setEditing(null);
                                }}
                                className="w-full min-w-32 bg-background px-2 py-1 font-mono text-[11.5px] text-foreground outline-1 outline-primary"
                              />
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell
                            key={column}
                            title={value || undefined}
                            onDoubleClick={
                              editable ? () => setEditing({ row: at, column }) : undefined
                            }
                            className={cn(
                              CELL,
                              "max-w-96 truncate",
                              numeric[column] && "text-right tabular-nums",
                              editable && "cursor-text",
                            )}
                          >
                            {value}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <p className="px-4 py-2 text-[11px] text-faint">{busy ? "Reading…" : ""}</p>
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
          {rows.length === 0
            ? "no rows"
            : `showing ${(base + 1).toLocaleString()}–${(base + rows.length).toLocaleString()} of ${(
                meta?.total ?? 0
              ).toLocaleString()}${meta?.truncated ? "+" : ""}${meta?.filtered ? " matched" : ""}`}
        </span>
        {rows.length >= LOADED ? (
          <span className="shrink-0 font-mono text-[10.5px] text-git-modified">
            {active ? "narrow the filter to read further" : "jump to read further"}
          </span>
        ) : null}

        <div className="flex-1" />

        {editable ? (
          <span className="shrink-0 font-mono text-[10.5px] text-faint">
            double-click a cell to edit
          </span>
        ) : null}

        {!meta?.filtered ? (
          <>
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
          </>
        ) : null}
      </footer>
    </div>
  );
}
