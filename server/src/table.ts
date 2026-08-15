import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";

import { safeJoin } from "./fsbrowse.ts";

export interface TableWindow {
  path: string;
  kind: "csv" | "xlsx";
  sheets: string[];
  sheet: number;
  rows: string[][];
  offset: number;
  total: number;
  // the total is a cap we stopped at rather than the real end of the file
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

// ── csv ────────────────────────────────────────────────────────────────────────

// one RFC 4180 state machine, fed bytes so the offsets it reports are byte offsets and a
// multi-byte character can straddle a chunk. `collect` is off for the indexing scan, where
// only the row boundaries matter and building every field would dominate the cost.
function parser(delimiter: number, collect: boolean) {
  let field: number[] = [];
  let row: string[] = [];
  let quoted = false;
  let afterQuote = false;
  let fieldStarted = false;
  let rowStarted = false;

  const pushField = () => {
    if (collect) row.push(Buffer.from(field).toString("utf8"));
    field.length = 0;
    fieldStarted = false;
  };

  const take = (byte: number) => {
    if (collect) field.push(byte);
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
      if (!rowStarted && field.length === 0 && row.length === 0) return;
      pushField();
      const done = row;
      row = [];
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

interface CsvIndex {
  mtimeMs: number;
  size: number;
  delimiter: number;
  total: number;
  offsets: number[];
  truncated: boolean;
}

const indexes = new Map<string, CsvIndex>();

function remember<T>(cache: Map<string, T>, key: string, value: T, keep: number): T {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > keep) cache.delete(cache.keys().next().value!);
  return value;
}

// one pass over the file: the row count, and the byte offset of every STRIDE-th row so
// paging into the middle of a large file doesn't rescan what came before it
async function indexCsv(target: string, rel: string): Promise<CsvIndex> {
  const stats = await fs.stat(target);
  const cached = indexes.get(target);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;

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

    return remember(indexes, target, { mtimeMs: stats.mtimeMs, size: stats.size, delimiter, total, offsets, truncated }, 6);
  } finally {
    await handle.close();
  }
}

async function readCsv(target: string, rel: string, offset: number, limit: number): Promise<TableWindow> {
  const index = await indexCsv(target, rel);
  const anchor = Math.min(Math.floor(offset / STRIDE), index.offsets.length - 1);
  let skip = offset - anchor * STRIDE;
  const rows: string[][] = [];
  const read = parser(index.delimiter, true);
  const stream = createReadStream(target, { start: index.offsets[anchor]! });

  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    const more = read.feed(buffer, buffer.length, (row) => {
      if (skip > 0) {
        skip -= 1;
        return true;
      }
      rows.push(row);
      return rows.length < limit;
    });
    if (!more) {
      stream.destroy();
      break;
    }
  }
  if (rows.length < limit && skip === 0) {
    read.flush((row) => {
      rows.push(row);
      return false;
    });
  }

  return {
    path: rel,
    kind: "csv",
    sheets: [],
    sheet: 0,
    rows,
    offset,
    total: index.total,
    truncated: index.truncated,
  };
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

interface Book {
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

async function openBook(target: string): Promise<Book> {
  const stats = await fs.stat(target);
  const cached = books.get(target);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached;

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
async function readXlsx(target: string, rel: string, sheet: number, offset: number, limit: number): Promise<TableWindow> {
  const book = await openBook(target);
  const index = Math.min(Math.max(sheet, 0), book.entries.length - 1);
  let parsed = book.parsed.get(index);
  if (!parsed) {
    parsed = await readSheet(target, book.entries[index]!, book.shared, book.styles, book.date1904);
    book.parsed.set(index, parsed);
  }
  return {
    path: rel,
    kind: "xlsx",
    sheets: book.names,
    sheet: index,
    rows: parsed.rows.slice(offset, offset + limit),
    offset,
    total: parsed.rows.length,
    truncated: parsed.truncated,
  };
}

export async function readTable(
  root: string,
  rel: string,
  options: { sheet: number; offset: number; limit: number },
): Promise<TableWindow> {
  const kind = tableKind(rel);
  if (!kind) throw new Error("That file isn't a table");
  const target = safeJoin(root, rel);
  const stats = await fs.stat(target);
  if (!stats.isFile()) throw new Error("That path is not a file");
  const offset = Math.max(0, options.offset);
  const limit = Math.min(Math.max(1, options.limit), 2000);
  return kind === "xlsx"
    ? readXlsx(target, rel, options.sheet, offset, limit)
    : readCsv(target, rel, offset, limit);
}
