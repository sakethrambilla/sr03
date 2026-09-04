// The reader behind the table view, in four parts: an RFC 4180 csv parser plus a byte-offset
// index, so a large file can be paged, searched and filtered without rescanning what came
// before; a single-cell write that rewrites one row and copies the rest through; a minimal
// zip reader; and an xlsx parser over it. All four are here because no dependency is.
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";

import { safeJoin } from "./fsbrowse.ts";

// a column keeps only the values ticked in its checklist
export interface TableFilter {
  column: number;
  values: string[];
}

export interface TableQuery {
  search: string;
  filters: TableFilter[];
  header: boolean;
}

export interface TableWindow {
  path: string;
  kind: "csv" | "xlsx";
  sheets: string[];
  sheet: number;
  head: string[] | null;
  rows: string[][];
  // the row index in the file for each row above, which a filtered window doesn't imply
  numbers: number[];
  offset: number;
  total: number;
  // the total is a cap we stopped at rather than the real end of the file
  truncated: boolean;
  filtered: boolean;
  mtimeMs: number;
}

export interface TableValues {
  column: number;
  values: Array<{ value: string; count: number }>;
  truncated: boolean;
}

export const TABLE = /\.(csv|tsv|xlsx|xlsm)$/i;
const SPREADSHEET = /\.(xlsx|xlsm)$/i;

export function tableKind(rel: string): "csv" | "xlsx" | null {
  if (!TABLE.test(rel)) return null;
  return SPREADSHEET.test(rel) ? "xlsx" : "csv";
}

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;
const DELIMITERS = [0x2c, 0x09, 0x3b, 0x7c];

const CHUNK = 1 << 18;
// rows between recorded byte offsets — paging seeks to the nearest one and parses forward
const STRIDE = 500;
// the scan costs ~250 MB/s and one offset per STRIDE rows, so bytes are the binding limit
const SCAN_BYTES = 1 << 29;
const CSV_ROW_CAP = 20_000_000;
const XLSX_ROW_CAP = 50_000;
const XLSX_CELL_CAP = 1_000_000;
const SHARED_STRING_BYTES = 64 * 1024 * 1024;
const SMALL_ENTRY_BYTES = 16 * 1024 * 1024;
const MATCH_CAP = 500_000;
const DISTINCT_CAP = 10_000;
// enough for one row at a recorded offset; a longer row retries with a bigger read
const ROW_WINDOW = 1 << 16;

// ── csv ────────────────────────────────────────────────────────────────────────

// one RFC 4180 state machine, fed bytes so the offsets it reports are byte offsets and a
// multi-byte character can straddle a chunk. `collect` is false for the indexing scan, where
// only the row boundaries matter, and a set of columns for a scan that reads just a few of
// them — building every field otherwise dominates the cost on a wide file.
function parser(delimiter: number, collect: boolean | Set<number>) {
  // one growable buffer for the field in hand — a fresh Buffer.from() per field is the
  // single biggest cost in a full-file scan
  let scratch = Buffer.allocUnsafe(256);
  let length = 0;
  let row: string[] = [];
  let column = 0;
  let quoted = false;
  let afterQuote = false;
  let fieldStarted = false;
  let rowStarted = false;

  const wants = (index: number) =>
    collect === true || (collect !== false && collect.has(index));

  const pushField = () => {
    if (collect !== false) row.push(wants(column) ? scratch.toString("utf8", 0, length) : "");
    column += 1;
    length = 0;
    fieldStarted = false;
  };

  const take = (byte: number) => {
    if (!wants(column)) return;
    if (length === scratch.length) {
      const bigger = Buffer.allocUnsafe(scratch.length * 2);
      scratch.copy(bigger, 0, 0, length);
      scratch = bigger;
    }
    scratch[length] = byte;
    length += 1;
  };

  return {
    // returns false as soon as `emit` does, so a window read can stop mid-chunk.
    // `after` is the offset within the chunk just past the row's terminator
    feed(chunk: Buffer, length: number, emit: (row: string[], after: number) => boolean): boolean {
      for (let i = 0; i < length; i += 1) {
        const byte = chunk[i]!;
        if (quoted) {
          if (afterQuote) {
            afterQuote = false;
            // "" inside a quoted field is one literal quote
            if (byte === QUOTE) {
              take(byte);
              continue;
            }
            quoted = false;
          } else if (byte === QUOTE) {
            afterQuote = true;
            continue;
          } else {
            take(byte);
            rowStarted = true;
            continue;
          }
        }
        if (byte === QUOTE && !fieldStarted) {
          quoted = true;
          fieldStarted = true;
          rowStarted = true;
          continue;
        }
        if (byte === delimiter) {
          pushField();
          rowStarted = true;
          continue;
        }
        if (byte === LF) {
          pushField();
          const done = row;
          row = [];
          column = 0;
          rowStarted = false;
          if (!emit(done, i + 1)) return false;
          continue;
        }
        if (byte === CR) continue;
        take(byte);
        fieldStarted = true;
        rowStarted = true;
      }
      return true;
    },
    // a file that doesn't end in a newline still has a last row
    flush(emit: (row: string[], after: number) => boolean): void {
      if (!rowStarted && length === 0 && row.length === 0) return;
      pushField();
      const done = row;
      row = [];
      column = 0;
      emit(done, 0);
    },
  };
}

function sniffDelimiter(head: Buffer, rel: string): number {
  if (/\.tsv$/i.test(rel)) return 0x09;
  const counts = new Map(DELIMITERS.map((byte) => [byte, 0]));
  let quoted = false;
  for (const byte of head) {
    if (byte === QUOTE) {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (byte === LF) break;
    const seen = counts.get(byte);
    if (seen !== undefined) counts.set(byte, seen + 1);
  }
  let best = 0x2c;
  let most = 0;
  for (const [byte, count] of counts) {
    if (count > most) {
      best = byte;
      most = count;
    }
  }
  return best;
}

// every cache below is bounded by count, and by age: a workbook nobody has paged for a while
// is a lot of memory to keep for a tab that was probably closed
const CACHE_TTL = 10 * 60_000;

interface Aged {
  usedAt: number;
}

const caches: Array<Map<string, Aged>> = [];

interface CsvIndex extends Aged {
  mtimeMs: number;
  size: number;
  delimiter: number;
  total: number;
  offsets: number[];
  truncated: boolean;
}

const indexes = new Map<string, CsvIndex>();
caches.push(indexes);

function sweep(): void {
  const cutoff = Date.now() - CACHE_TTL;
  for (const cache of caches) {
    for (const [key, entry] of cache) if (entry.usedAt < cutoff) cache.delete(key);
  }
}

function fresh<T extends Aged & { mtimeMs: number; size: number }>(
  cached: T | undefined,
  stats: { mtimeMs: number; size: number },
): T | null {
  if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) return null;
  cached.usedAt = Date.now();
  return cached;
}

function remember<T extends Aged>(cache: Map<string, T>, key: string, value: T, keep: number): T {
  value.usedAt = Date.now();
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > keep) cache.delete(cache.keys().next().value!);
  sweep();
  return value;
}

// one pass over the file: the row count, and the byte offset of every STRIDE-th row so
// paging into the middle of a large file doesn't rescan what came before it
async function indexCsv(target: string, rel: string): Promise<CsvIndex> {
  const stats = await fs.stat(target);
  const cached = fresh(indexes.get(target), stats);
  if (cached) return cached;

  const handle = await fs.open(target, "r");
  try {
    const head = Buffer.alloc(Math.min(stats.size, 8192));
    if (head.length > 0) await handle.read(head, 0, head.length, 0);
    const delimiter = sniffDelimiter(head, rel);
    const walk = parser(delimiter, false);
    const buffer = Buffer.allocUnsafe(CHUNK);
    const offsets = [0];
    let position = 0;
    let total = 0;
    let truncated = false;

    while (position < stats.size) {
      if (position >= SCAN_BYTES) {
        truncated = true;
        break;
      }
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
      if (bytesRead === 0) break;
      const base = position;
      walk.feed(buffer, bytesRead, (_row, after) => {
        total += 1;
        if (total % STRIDE === 0) offsets.push(base + after);
        if (total >= CSV_ROW_CAP) {
          truncated = true;
          return false;
        }
        return true;
      });
      position += bytesRead;
      if (truncated) break;
    }
    if (!truncated) {
      walk.flush(() => {
        total += 1;
        return false;
      });
    }

    return remember(
      indexes,
      target,
      { usedAt: 0, mtimeMs: stats.mtimeMs, size: stats.size, delimiter, total, offsets, truncated },
      6,
    );
  } finally {
    await handle.close();
  }
}

async function readCsv(
  target: string,
  rel: string,
  stats: { mtimeMs: number; size: number },
  offset: number,
  limit: number,
  query: TableQuery,
): Promise<TableWindow> {
  const index = await indexCsv(target, rel);
  const head = query.header ? ((await readRowsAt(target, index.delimiter, [0]))[0] ?? null) : null;
  const base = query.header ? 1 : 0;
  const shape = (
    rows: string[][],
    numbers: number[],
    total: number,
    truncated: boolean,
    filtered: boolean,
  ): TableWindow => ({
    path: rel,
    kind: "csv",
    sheets: [],
    sheet: 0,
    head,
    rows,
    numbers,
    offset,
    total,
    truncated,
    filtered,
    mtimeMs: stats.mtimeMs,
  });

  if (asks(query)) {
    const prepared = prepare(query);
    const list = await matchesOf(target, stats, index, 0, query, prepared);
    const rows = await readRowsAt(target, index.delimiter, list.starts.slice(offset, offset + limit));
    const numbers = list.numbers.slice(offset, offset + limit);
    return shape(rows, numbers, list.numbers.length, list.truncated, true);
  }

  const from = base + offset;
  const anchor = Math.min(Math.floor(from / STRIDE), index.offsets.length - 1);
  const rows: string[][] = [];
  await walkCsv(
    target,
    stats.size,
    index.delimiter,
    true,
    (cells, at) => {
      if (at < from) return true;
      rows.push(cells);
      return rows.length < limit;
    },
    { byte: index.offsets[anchor]!, row: anchor * STRIDE },
  );

  return shape(
    rows,
    rows.map((_row, at) => from + at),
    Math.max(0, index.total - base),
    index.truncated,
    false,
  );
}

// the byte range of one row, so a cell edit can rewrite that span and copy the rest through
async function locateRow(
  target: string,
  size: number,
  index: CsvIndex,
  row: number,
): Promise<{ start: number; end: number; cells: string[] }> {
  const anchor = Math.min(Math.floor(row / STRIDE), index.offsets.length - 1);
  const found: { at: { start: number; end: number; cells: string[] } | null } = { at: null };
  await walkCsv(
    target,
    size,
    index.delimiter,
    true,
    (cells, at, start) => {
      if (at < row) return true;
      if (at === row) {
        // the last row of the file has no next one, so its span runs to the end
        found.at = { start, end: size, cells };
        return true;
      }
      found.at!.end = start;
      return false;
    },
    { byte: index.offsets[anchor]!, row: anchor * STRIDE },
  );
  if (!found.at) throw new Error(`Row ${row + 1} is past the end of the file`);
  return found.at;
}

function serialize(cells: string[], delimiter: number): string {
  const separator = String.fromCharCode(delimiter);
  return cells
    .map((cell) =>
      /["\r\n]/.test(cell) || cell.includes(separator) ? `"${cell.replace(/"/g, '""')}"` : cell,
    )
    .join(separator);
}

// the edit is written to a sibling and renamed over, so a failure part-way through can't
// leave the file half rewritten
export async function writeCell(
  root: string,
  rel: string,
  options: { row: number; column: number; value: string; mtimeMs: number },
): Promise<{ path: string; row: number; cells: string[]; mtimeMs: number }> {
  if (tableKind(rel) !== "csv") throw new Error("Only csv and tsv files can be edited here");
  if (options.column < 0 || options.row < 0) throw new Error("That cell is out of range");
  const target = safeJoin(root, rel);
  const stats = await fs.stat(target);
  if (!stats.isFile()) throw new Error("That path is not a file");
  if (options.mtimeMs > 0 && Math.round(stats.mtimeMs) !== Math.round(options.mtimeMs)) {
    throw new Error("This file changed on disk since it was read — reopen it and try again");
  }

  const index = await indexCsv(target, rel);
  const found = await locateRow(target, stats.size, index, options.row);
  const cells = [...found.cells];
  while (cells.length <= options.column) cells.push("");
  cells[options.column] = options.value;

  // whatever ended the row has to survive, since everything after it is copied byte for byte
  const width = Math.min(2, found.end - found.start);
  const tail = Buffer.alloc(width);
  const peek = await fs.open(target, "r");
  try {
    if (width > 0) await peek.read(tail, 0, width, found.end - width);
  } finally {
    await peek.close();
  }
  const terminator = tail.at(-1) === LF ? (tail.at(-2) === CR ? "\r\n" : "\n") : "";

  const temp = `${target}.sr03-${process.pid}-${Date.now().toString(36)}`;
  try {
    const source = await fs.open(target, "r");
    const sink = await fs.open(temp, "w");
    try {
      const buffer = Buffer.allocUnsafe(CHUNK);
      const copy = async (from: number, to: number) => {
        let at = from;
        while (at < to) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(CHUNK, to - at), at);
          if (bytesRead === 0) break;
          await sink.write(buffer, 0, bytesRead);
          at += bytesRead;
        }
      };
      await copy(0, found.start);
      await sink.write(Buffer.from(serialize(cells, index.delimiter) + terminator, "utf8"));
      await copy(found.end, stats.size);
    } finally {
      await source.close();
      await sink.close();
    }
    await fs.rename(temp, target);
  } catch (cause) {
    await fs.rm(temp, { force: true });
    throw cause;
  }

  const after = await fs.stat(target);
  return { path: rel, row: options.row, cells, mtimeMs: after.mtimeMs };
}

// ── query ─────────────────────────────────────────────────────────────────────

interface Prepared {
  needle: RegExp | null;
  allow: Array<{ column: number; values: Set<string> }>;
  columns: boolean | Set<number>;
  header: boolean;
}

function asks(query: TableQuery): boolean {
  return query.search.trim() !== "" || query.filters.some((filter) => filter.column >= 0);
}

function prepare(query: TableQuery, also?: number): Prepared {
  const search = query.search.trim();
  const allow = query.filters
    .filter((filter) => filter.column >= 0 && filter.column !== also)
    .map((filter) => ({ column: filter.column, values: new Set(filter.values) }));
  const columns = new Set(allow.map((one) => one.column));
  if (also !== undefined) columns.add(also);
  return {
    needle: search ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null,
    allow,
    // a search reads every column; a checklist only reads the ones it filters on
    columns: search ? true : columns,
    header: query.header,
  };
}

function keeps(row: string[], prepared: Prepared): boolean {
  for (const one of prepared.allow) {
    if (!one.values.has(row[one.column] ?? "")) return false;
  }
  const needle = prepared.needle;
  if (!needle) return true;
  for (const cell of row) {
    if (needle.test(cell)) return true;
  }
  return false;
}

function queryKey(query: TableQuery, sheet: number, also?: number): string {
  const filters = query.filters
    .filter((filter) => filter.column >= 0 && filter.column !== also)
    .map((filter) => `${filter.column}:${[...filter.values].sort().join("\u0001")}`)
    .sort()
    .join("\u0002");
  const parts = [sheet, query.header ? 1 : 0, query.search.trim().toLowerCase(), filters, also ?? ""];
  return parts.join("\u0003");
}

interface MatchList extends Aged {
  mtimeMs: number;
  size: number;
  numbers: number[];
  starts: number[];
  truncated: boolean;
}

const matched = new Map<string, MatchList>();
caches.push(matched);

// the shape every full-file scan shares — the visitor stops it by returning false, and the
// return says whether the whole file was seen or a cap cut it short
async function walkCsv(
  target: string,
  size: number,
  delimiter: number,
  collect: boolean | Set<number>,
  visit: (cells: string[], row: number, start: number) => boolean,
  begin?: { byte: number; row: number },
): Promise<boolean> {
  const handle = await fs.open(target, "r");
  try {
    const read = parser(delimiter, collect);
    const buffer = Buffer.allocUnsafe(CHUNK);
    const opened = begin?.byte ?? 0;
    let position = opened;
    let row = begin?.row ?? 0;
    let start = position;
    let stopped = false;

    const step = (cells: string[], end: number): boolean => {
      const at = row;
      const from = start;
      row += 1;
      start = end;
      if (visit(cells, at, from)) return true;
      stopped = true;
      return false;
    };

    while (position < size && position - opened < SCAN_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
      if (bytesRead === 0) break;
      const base = position;
      const more = read.feed(buffer, bytesRead, (cells, after) => step(cells, base + after));
      position += bytesRead;
      if (!more) break;
    }
    if (!stopped && position >= size) read.flush((cells) => step(cells, size));
    return !stopped && position >= size;
  } finally {
    await handle.close();
  }
}

// one scan records both the row index and its byte offset for every match, so paging a
// filtered view costs a seek per row instead of another pass over the file
async function scanCsv(
  target: string,
  size: number,
  index: CsvIndex,
  prepared: Prepared,
): Promise<{ numbers: number[]; starts: number[]; truncated: boolean }> {
  const numbers: number[] = [];
  const starts: number[] = [];
  let capped = false;
  const whole = await walkCsv(target, size, index.delimiter, prepared.columns, (cells, row, start) => {
    if (row === 0 && prepared.header) return true;
    if (!keeps(cells, prepared)) return true;
    numbers.push(row);
    starts.push(start);
    if (numbers.length >= MATCH_CAP) {
      capped = true;
      return false;
    }
    return true;
  });
  return { numbers, starts, truncated: capped || !whole };
}

async function scanValues(
  target: string,
  size: number,
  index: CsvIndex,
  prepared: Prepared,
  column: number,
  tally: (value: string) => void,
): Promise<boolean> {
  const whole = await walkCsv(target, size, index.delimiter, prepared.columns, (cells, row) => {
    if (row === 0 && prepared.header) return true;
    if (keeps(cells, prepared)) tally(cells[column] ?? "");
    return true;
  });
  return !whole;
}

async function matchesOf(
  target: string,
  stats: { mtimeMs: number; size: number },
  index: CsvIndex,
  sheet: number,
  query: TableQuery,
  prepared: Prepared,
): Promise<MatchList> {
  const key = `${target}\u0004${queryKey(query, sheet)}`;
  const cached = fresh(matched.get(key), stats);
  if (cached) return cached;
  const found = await scanCsv(target, stats.size, index, prepared);
  return remember(matched, key, { ...found, usedAt: 0, mtimeMs: stats.mtimeMs, size: stats.size }, 4);
}

// a filtered page is rows scattered through the file, so each is read from its recorded
// offset rather than by parsing everything before it
async function readRowsAt(target: string, delimiter: number, starts: number[]): Promise<string[][]> {
  if (starts.length === 0) return [];
  const handle = await fs.open(target, "r");
  try {
    const rows: string[][] = [];
    for (const start of starts) {
      const found: { row: string[] | null } = { row: null };
      let size = ROW_WINDOW;
      for (let attempt = 0; attempt < 6 && found.row === null; attempt += 1) {
        const buffer = Buffer.allocUnsafe(size);
        const { bytesRead } = await handle.read(buffer, 0, size, start);
        if (bytesRead === 0) break;
        const read = parser(delimiter, true);
        read.feed(buffer, bytesRead, (cells) => {
          found.row = cells;
          return false;
        });
        // no terminator in the window: the file ends here, or the row is longer than it
        if (found.row === null) {
          if (bytesRead < size) {
            read.flush((cells) => {
              found.row = cells;
              return false;
            });
          } else {
            size *= 4;
          }
        }
      }
      rows.push(found.row ?? []);
    }
    return rows;
  } finally {
    await handle.close();
  }
}

// ── zip ────────────────────────────────────────────────────────────────────────

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const SENTINEL_32 = 0xffffffff;

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

// the 32-bit size and offset fields are sentinels on a zip64 archive, with the real
// values in an extra field that carries only the ones that overflowed
function readZip64Extra(dir: Buffer, start: number, length: number, entry: ZipEntry): void {
  let cursor = start;
  while (cursor + 4 <= start + length) {
    const id = dir.readUInt16LE(cursor);
    const size = dir.readUInt16LE(cursor + 2);
    if (id === 0x0001) {
      let field = cursor + 4;
      if (entry.size === SENTINEL_32) {
        entry.size = Number(dir.readBigUInt64LE(field));
        field += 8;
      }
      if (entry.compressed === SENTINEL_32) {
        entry.compressed = Number(dir.readBigUInt64LE(field));
        field += 8;
      }
      if (entry.offset === SENTINEL_32) entry.offset = Number(dir.readBigUInt64LE(field));
      return;
    }
    cursor += 4 + size;
  }
}

async function readZipDirectory(target: string, size: number): Promise<Map<string, ZipEntry>> {
  const handle = await fs.open(target, "r");
  try {
    const tailSize = Math.min(size, 66_000);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);

    let end = -1;
    for (let i = tailSize - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD) {
        end = i;
        break;
      }
    }
    if (end === -1) throw new Error("That file isn't a readable spreadsheet");

    let count = tail.readUInt16LE(end + 10);
    let dirSize = tail.readUInt32LE(end + 12);
    let dirOffset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || dirSize === SENTINEL_32 || dirOffset === SENTINEL_32) {
      const locator = end - 20;
      if (locator >= 0 && tail.readUInt32LE(locator) === ZIP64_LOCATOR) {
        const record = Buffer.alloc(56);
        await handle.read(record, 0, 56, Number(tail.readBigUInt64LE(locator + 8)));
        if (record.readUInt32LE(0) === ZIP64_EOCD) {
          count = Number(record.readBigUInt64LE(32));
          dirSize = Number(record.readBigUInt64LE(40));
          dirOffset = Number(record.readBigUInt64LE(48));
        }
      }
    }

    const dir = Buffer.alloc(dirSize);
    await handle.read(dir, 0, dirSize, dirOffset);
    const entries = new Map<string, ZipEntry>();
    let cursor = 0;
    for (let i = 0; i < count && cursor + 46 <= dirSize; i += 1) {
      if (dir.readUInt32LE(cursor) !== CENTRAL) break;
      const nameLength = dir.readUInt16LE(cursor + 28);
      const extraLength = dir.readUInt16LE(cursor + 30);
      const commentLength = dir.readUInt16LE(cursor + 32);
      const entry: ZipEntry = {
        name: dir.toString("utf8", cursor + 46, cursor + 46 + nameLength),
        method: dir.readUInt16LE(cursor + 10),
        compressed: dir.readUInt32LE(cursor + 20),
        size: dir.readUInt32LE(cursor + 24),
        offset: dir.readUInt32LE(cursor + 42),
      };
      if (entry.size === SENTINEL_32 || entry.compressed === SENTINEL_32 || entry.offset === SENTINEL_32) {
        readZip64Extra(dir, cursor + 46 + nameLength, extraLength, entry);
      }
      entries.set(entry.name, entry);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

// the local header repeats the name and carries its own extra field, so the data can only
// be found through it — the central directory's lengths don't apply here
async function openEntry(target: string, entry: ZipEntry): Promise<Readable> {
  if (entry.compressed === 0) return Readable.from([]);
  const handle = await fs.open(target, "r");
  const header = Buffer.alloc(30);
  try {
    await handle.read(header, 0, 30, entry.offset);
  } finally {
    await handle.close();
  }
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = createReadStream(target, { start, end: start + entry.compressed - 1 });
  if (entry.method === 0) return raw;
  const inflate = zlib.createInflateRaw();
  raw.on("error", (cause) => inflate.destroy(cause));
  return raw.pipe(inflate);
}

async function entryText(target: string, entry: ZipEntry | undefined, cap: number): Promise<string> {
  if (!entry) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of await openEntry(target, entry)) {
    chunks.push(chunk as Buffer);
    total += (chunk as Buffer).length;
    if (total >= cap) break;
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── xlsx ──────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    return ENTITIES[body] ?? whole;
  });
}

const TEXT = /<t[^>]*>([\s\S]*?)<\/t>/g;

function joinText(xml: string): string {
  let out = "";
  for (const match of xml.matchAll(TEXT)) out += match[1]!;
  return unescapeXml(out);
}

const REF = /(?:^|\s)r="([^"]*)"/;
const STYLE = /(?:^|\s)s="([^"]*)"/;
const TYPE = /(?:^|\s)t="([^"]*)"/;

function columnIndex(ref: string): number {
  let index = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

const BUILTIN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_TIMES = new Set([18, 19, 20, 21, 45, 46, 47]);

interface Styles {
  formats: number[];
  codes: Map<number, string>;
}

function isDate(numFmt: number, styles: Styles): boolean {
  if (BUILTIN_DATES.has(numFmt)) return true;
  const code = styles.codes.get(numFmt);
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(bare);
}

function isTimeOnly(numFmt: number, styles: Styles): boolean {
  if (BUILTIN_TIMES.has(numFmt)) return true;
  const code = styles.codes.get(numFmt);
  if (!code) return false;
  const bare = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  return /[hs]/i.test(bare) && !/[yd]/i.test(bare);
}

// a serial is days since the epoch, except the 1900 system counts a 29 Feb 1900 that
// never existed, so anything before 1 Mar 1900 sits a day off the rest
function serialToText(serial: number, timeOnly: boolean, date1904: boolean): string {
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : serial < 60
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);
  const at = new Date(epoch + Math.round(serial * 86_400_000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  if (timeOnly) return clock;
  const day = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  return Number.isInteger(serial) ? day : `${day} ${clock}`;
}

function parseStyles(xml: string): Styles {
  const codes = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\s+([^>]*?)\/?>/g)) {
    const attrs = match[1]!;
    const id = /numFmtId="([^"]*)"/.exec(attrs);
    const code = /formatCode="([^"]*)"/.exec(attrs);
    if (id && code) codes.set(Number(id[1]), unescapeXml(code[1]!));
  }
  const formats: number[] = [];
  const block = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (block) {
    for (const match of block[1]!.matchAll(/<xf\s+([^>]*?)\/?>/g)) {
      const id = /(?:^|\s)numFmtId="([^"]*)"/.exec(match[1]!);
      formats.push(id ? Number(id[1]) : 0);
    }
  }
  return { formats, codes };
}

async function readSharedStrings(target: string, entry: ZipEntry | undefined): Promise<string[]> {
  const strings: string[] = [];
  if (!entry) return strings;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let seen = 0;
  for await (const chunk of await openEntry(target, entry)) {
    pending += decoder.write(chunk as Buffer);
    seen += (chunk as Buffer).length;
    let cursor = 0;
    while (true) {
      const start = pending.indexOf("<si", cursor);
      if (start === -1) break;
      const close = pending.indexOf(">", start);
      if (close === -1) break;
      if (pending[close - 1] === "/") {
        strings.push("");
        cursor = close + 1;
        continue;
      }
      const end = pending.indexOf("</si>", close);
      if (end === -1) break;
      strings.push(joinText(pending.slice(close + 1, end)));
      cursor = end + 5;
    }
    pending = pending.slice(cursor);
    if (seen >= SHARED_STRING_BYTES) break;
  }
  return strings;
}

interface Sheet {
  rows: string[][];
  truncated: boolean;
}

async function readSheet(
  target: string,
  entry: ZipEntry,
  shared: string[],
  styles: Styles,
  date1904: boolean,
): Promise<Sheet> {
  const rows: string[][] = [];
  let cells = 0;
  let truncated = false;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const stream = await openEntry(target, entry);

  const cellValue = (attrs: string, inner: string): string => {
    const type = TYPE.exec(attrs)?.[1] ?? "n";
    if (type === "inlineStr") return joinText(inner);
    const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    if (raw === undefined) return type === "s" ? "" : joinText(inner);
    if (type === "s") return shared[Number(raw)] ?? "";
    if (type === "str" || type === "e") return unescapeXml(raw);
    if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
    const style = STYLE.exec(attrs)?.[1];
    const numFmt = style === undefined ? 0 : (styles.formats[Number(style)] ?? 0);
    const value = Number(raw);
    if (Number.isFinite(value) && isDate(numFmt, styles)) {
      return serialToText(value, isTimeOnly(numFmt, styles), date1904);
    }
    return unescapeXml(raw);
  };

  // cells hold escaped text, so a bare "<c" only ever starts a cell — splitting on it is
  // safe and much cheaper than matching the open and close tags as a pair
  const pushRow = (number: number, body: string) => {
    while (rows.length < number - 1 && rows.length < XLSX_ROW_CAP) rows.push([]);
    if (rows.length >= XLSX_ROW_CAP) {
      truncated = true;
      return false;
    }
    const row: string[] = [];
    let column = 0;
    for (const piece of body.split("<c")) {
      const close = piece.indexOf(">");
      if (close === -1) continue;
      const attrs = piece.slice(0, close);
      if (!attrs.startsWith(" ") && !attrs.startsWith("/") && attrs !== "") continue;
      const ref = REF.exec(attrs)?.[1];
      const found = ref ? columnIndex(ref) : column;
      const at = found < 0 ? column : found;
      while (row.length < at) row.push("");
      const ends = piece.indexOf("</c>", close);
      const inner = attrs.endsWith("/") || ends === -1 ? "" : piece.slice(close + 1, ends);
      row[at] = cellValue(attrs, inner);
      column = at + 1;
      cells += 1;
    }
    rows.push(row);
    if (cells >= XLSX_CELL_CAP) {
      truncated = true;
      return false;
    }
    return true;
  };

  for await (const chunk of stream) {
    pending += decoder.write(chunk as Buffer);
    let cursor = 0;
    let running = true;
    while (running) {
      const start = pending.indexOf("<row", cursor);
      if (start === -1) break;
      const close = pending.indexOf(">", start);
      if (close === -1) break;
      const attrs = pending.slice(start + 4, close);
      const number = Number(REF.exec(attrs)?.[1] ?? rows.length + 1);
      if (pending[close - 1] === "/") {
        running = pushRow(number, "");
        cursor = close + 1;
        continue;
      }
      const end = pending.indexOf("</row>", close);
      if (end === -1) break;
      running = pushRow(number, pending.slice(close + 1, end));
      cursor = end + 6;
    }
    pending = pending.slice(cursor);
    if (!running || pending.includes("</sheetData>")) break;
    // nothing in flight and no row starting: keep only enough to catch a split tag
    if (!pending.includes("<row") && pending.length > 64) pending = pending.slice(-8);
  }
  stream.destroy();
  return { rows, truncated };
}

interface Book extends Aged {
  mtimeMs: number;
  size: number;
  names: string[];
  entries: ZipEntry[];
  shared: string[];
  styles: Styles;
  date1904: boolean;
  parsed: Map<number, Sheet>;
}

const books = new Map<string, Book>();
caches.push(books);

async function openBook(target: string): Promise<Book> {
  const stats = await fs.stat(target);
  const cached = fresh(books.get(target), stats);
  if (cached) return cached;

  const zip = await readZipDirectory(target, stats.size);
  const workbook = await entryText(target, zip.get("xl/workbook.xml"), SMALL_ENTRY_BYTES);
  if (!workbook) throw new Error("That spreadsheet has no readable workbook");
  const rels = await entryText(target, zip.get("xl/_rels/workbook.xml.rels"), SMALL_ENTRY_BYTES);

  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\s+([^>]*?)\/?>/g)) {
    const attrs = match[1]!;
    const id = /Id="([^"]*)"/.exec(attrs)?.[1];
    const to = /Target="([^"]*)"/.exec(attrs)?.[1];
    if (id && to) targets.set(id, to.startsWith("/") ? to.slice(1) : `xl/${to.replace(/^\.\//, "")}`);
  }

  const names: string[] = [];
  const entries: ZipEntry[] = [];
  for (const match of workbook.matchAll(/<sheet\s+([^>]*?)\/?>/g)) {
    const attrs = match[1]!;
    const name = /(?:^|\s)name="([^"]*)"/.exec(attrs)?.[1];
    const id = /r:id="([^"]*)"/.exec(attrs)?.[1];
    const entry = id ? zip.get(targets.get(id) ?? "") : undefined;
    if (!name || !entry) continue;
    names.push(unescapeXml(name));
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error("That spreadsheet has no readable sheets");

  const book: Book = {
    usedAt: 0,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    names,
    entries,
    shared: await readSharedStrings(target, zip.get("xl/sharedStrings.xml")),
    styles: parseStyles(await entryText(target, zip.get("xl/styles.xml"), SMALL_ENTRY_BYTES)),
    date1904: /date1904="(1|true)"/.test(workbook),
    parsed: new Map(),
  };
  return remember(books, target, book, 2);
}

// a deflate stream has no random access, so the sheet is parsed once up to the row cap and
// paged out of memory after that — unlike a csv, which is indexed and seekable
async function sheetOf(book: Book, target: string, at: number): Promise<Sheet> {
  const parsed = book.parsed.get(at);
  if (parsed) return parsed;
  const read = await readSheet(target, book.entries[at]!, book.shared, book.styles, book.date1904);
  book.parsed.set(at, read);
  return read;
}

function sheetIndex(book: Book, sheet: number): number {
  return Math.min(Math.max(sheet, 0), book.entries.length - 1);
}

async function readXlsx(
  target: string,
  rel: string,
  stats: { mtimeMs: number },
  sheet: number,
  offset: number,
  limit: number,
  query: TableQuery,
): Promise<TableWindow> {
  const book = await openBook(target);
  const at = sheetIndex(book, sheet);
  const parsed = await sheetOf(book, target, at);
  const base = query.header ? 1 : 0;
  const numbers: number[] = [];
  let total = 0;

  if (asks(query)) {
    const prepared = prepare(query);
    const all: number[] = [];
    for (let row = base; row < parsed.rows.length; row += 1) {
      if (keeps(parsed.rows[row]!, prepared)) all.push(row);
    }
    total = all.length;
    numbers.push(...all.slice(offset, offset + limit));
  } else {
    total = Math.max(0, parsed.rows.length - base);
    for (let row = base + offset; row < parsed.rows.length && numbers.length < limit; row += 1) {
      numbers.push(row);
    }
  }

  return {
    path: rel,
    kind: "xlsx",
    sheets: book.names,
    sheet: at,
    head: query.header ? (parsed.rows[0] ?? null) : null,
    rows: numbers.map((row) => parsed.rows[row] ?? []),
    numbers,
    offset,
    total,
    truncated: parsed.truncated,
    filtered: asks(query),
    mtimeMs: stats.mtimeMs,
  };
}

export async function readTable(
  root: string,
  rel: string,
  options: { sheet: number; offset: number; limit: number; query: TableQuery },
): Promise<TableWindow> {
  const kind = tableKind(rel);
  if (!kind) throw new Error("That file isn't a table");
  const target = safeJoin(root, rel);
  const stats = await fs.stat(target);
  if (!stats.isFile()) throw new Error("That path is not a file");
  const offset = Math.max(0, options.offset);
  const limit = Math.min(Math.max(1, options.limit), 2000);
  return kind === "xlsx"
    ? readXlsx(target, rel, stats, options.sheet, offset, limit, options.query)
    : readCsv(target, rel, stats, offset, limit, options.query);
}

function collate(counts: Map<string, number>): TableValues["values"] {
  const values = [...counts].map(([value, count]) => ({ value, count }));
  values.sort((left, right) => {
    const a = Number(left.value);
    const b = Number(right.value);
    // a column of numbers should read in numeric order, not "10" before "9"
    if (left.value !== "" && right.value !== "" && Number.isFinite(a) && Number.isFinite(b)) {
      return a - b;
    }
    return left.value.localeCompare(right.value);
  });
  return values;
}

interface ValueList extends Aged {
  mtimeMs: number;
  size: number;
  list: TableValues;
}

const tallied = new Map<string, ValueList>();
caches.push(tallied);

// like a spreadsheet's own filter, the checklist offers what the other columns still allow
export async function readValues(
  root: string,
  rel: string,
  options: { sheet: number; column: number; query: TableQuery },
): Promise<TableValues> {
  const kind = tableKind(rel);
  if (!kind) throw new Error("That file isn't a table");
  if (options.column < 0) throw new Error("`column` is required");
  const target = safeJoin(root, rel);
  const stats = await fs.stat(target);
  const key = `${target}\u0004${queryKey(options.query, options.sheet, options.column)}`;
  const cached = fresh(tallied.get(key), stats);
  if (cached) return cached.list;

  const prepared = prepare(options.query, options.column);
  const counts = new Map<string, number>();
  let truncated = false;

  const tally = (value: string) => {
    const seen = counts.get(value);
    if (seen !== undefined) counts.set(value, seen + 1);
    else if (counts.size < DISTINCT_CAP) counts.set(value, 1);
    else truncated = true;
  };

  if (kind === "xlsx") {
    const book = await openBook(target);
    const parsed = await sheetOf(book, target, sheetIndex(book, options.sheet));
    for (let row = prepared.header ? 1 : 0; row < parsed.rows.length; row += 1) {
      const cells = parsed.rows[row]!;
      if (keeps(cells, prepared)) tally(cells[options.column] ?? "");
    }
    truncated = truncated || parsed.truncated;
  } else {
    const index = await indexCsv(target, rel);
    const cut = await scanValues(target, stats.size, index, prepared, options.column, tally);
    truncated = truncated || cut;
  }

  const list = { column: options.column, values: collate(counts), truncated };
  remember(tallied, key, { usedAt: 0, mtimeMs: stats.mtimeMs, size: stats.size, list }, 12);
  return list;
}
