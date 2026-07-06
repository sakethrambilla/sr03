import type { ReactNode } from "react";

import { cn } from "./ui.tsx";

const FENCE = /^ {0,3}```+\s*(\S*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const INLINE =
  "`([^`]+)`|\\*\\*([\\s\\S]+?)\\*\\*|~~([\\s\\S]+?)~~|\\*([^\\s*][^*\\n]*?)\\*|\\[([^\\]]*)\\]\\(([^)\\s]+)\\)|(https?:\\/\\/[^\\s<>)\\]]+)";

function isTableRule(line: string): boolean {
  return line.includes("|") && line.includes("-") && /^[\s|:-]+$/.test(line);
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line) ||
    ORDERED.test(line) ||
    BULLET.test(line)
  );
}

function markerType(line: string): "ol" | "ul" | null {
  if (ORDERED.test(line)) return "ol";
  if (BULLET.test(line) && !RULE.test(line)) return "ul";
  return null;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

// strips the shallowest indent shared by every non-blank line
function dedent(lines: string[]): string[] {
  const base = Math.min(...lines.filter((line) => line.trim()).map(indentOf));
  return Number.isFinite(base) ? lines.map((line) => line.slice(base)) : lines;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE, "g");
  let last = 0;
  let n = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const k = `${key}i${n++}`;
    const [, code, strong, strike, em, linkText, href, bare] = match;
    if (code !== undefined) {
      out.push(
        <code key={k} className="rounded bg-accent px-1 py-0.5 font-mono text-[0.86em]">
          {code}
        </code>,
      );
    } else if (strong !== undefined) {
      out.push(
        <strong key={k} className="font-semibold text-foreground">
          {inline(strong, k)}
        </strong>,
      );
    } else if (strike !== undefined) {
      out.push(
        <s key={k} className="text-faint">
          {inline(strike, k)}
        </s>,
      );
    } else if (em !== undefined) {
      out.push(<em key={k}>{inline(em, k)}</em>);
    } else if (linkText !== undefined) {
      out.push(
        <a key={k} href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
          {inline(linkText, k)}
        </a>,
      );
    } else if (bare !== undefined) {
      out.push(
        <a key={k} href={bare} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
          {bare}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function blocks(lines: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;

  while (i < lines.length) {
    const line = lines[i];
    const k = `${key}b${n++}`;

    if (!line.trim()) {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={k} className="overflow-x-auto rounded-lg border border-border bg-background px-3 py-2.5">
          <code className="font-mono text-[12.5px] leading-relaxed">{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr key={k} className="border-border" />);
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level, 6)}` as "h1";
      out.push(
        <Tag
          key={k}
          className={cn(
            "font-semibold text-foreground",
            level <= 1 ? "text-[17px]" : level === 2 ? "text-[15.5px]" : "text-[14px]",
          )}
        >
          {inline(heading[2], k)}
        </Tag>,
      );
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      out.push(
        <blockquote key={k} className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground">
          {blocks(body, k)}
        </blockquote>,
      );
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(cells(lines[i++]));
      out.push(
        <div key={k} className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {head.map((cell, index) => (
                  <th key={index} className="border-b border-border px-2 py-1.5 text-left font-semibold text-foreground">
                    {inline(cell, `${k}h${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} className="border-b border-border/50 px-2 py-1.5 align-top">
                      {inline(cell, `${k}r${rowIndex}c${index}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const marker = ORDERED.exec(line) ?? BULLET.exec(line);
    if (marker) {
      const kind = markerType(line);
      const base = marker[1].length;
      const items: string[][] = [];

      while (i < lines.length) {
        const current = lines[i];
        if (!current.trim()) {
          const next = lines[i + 1];
          const continues =
            next && (indentOf(next) > base || (indentOf(next) === base && markerType(next) === kind));
          if (!continues) break;
          items.at(-1)?.push("");
          i++;
          continue;
        }
        const item = ORDERED.exec(current) ?? BULLET.exec(current);
        if (item && item[1].length <= base) {
          if (item[1].length < base || markerType(current) !== kind) break;
          items.push([item[2]]);
          i++;
          continue;
        }
        if (indentOf(current) > base && items.length) {
          items.at(-1)!.push(current);
          i++;
          continue;
        }
        break;
      }

      const Tag = kind === "ol" ? "ol" : "ul";
      out.push(
        <Tag key={k} className={cn("ml-5 space-y-1.5", kind === "ol" ? "list-decimal" : "list-disc")}>
          {items.map((item, index) => {
            const [first, ...rest] = item;
            const nested = dedent(rest);
            return (
              <li key={index} className="marker:text-faint">
                <span className="whitespace-pre-wrap">{inline(first, `${k}l${index}`)}</span>
                {nested.some((entry) => entry.trim()) ? (
                  <div className="mt-1.5 space-y-1.5">{blocks(nested, `${k}l${index}`)}</div>
                ) : null}
              </li>
            );
          })}
        </Tag>,
      );
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) body.push(lines[i++]);
    out.push(
      <p key={k} className="whitespace-pre-wrap">
        {inline(body.join("\n"), k)}
      </p>,
    );
  }

  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-3 break-words", className)}>{blocks(text.split("\n"), "md")}</div>
  );
}
