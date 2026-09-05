// The markdown renderer for assistant replies and .md previews. Hand-written rather than a
// dependency because the interesting part is what it does past markdown: a path in prose becomes
// a link that opens the file, and a shell fence gets a button that runs it in the terminal.
import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { FILE_REF_SOURCE } from "../lib/fileref.ts";
import type { FileLinks, FileRef } from "../lib/fileref.ts";
import { TOKEN_CLASS, tokenize } from "../lib/highlight.ts";
import { Mermaid } from "./Mermaid.tsx";
import { CopyButton, RunIcon, cn } from "./ui.tsx";
import { Button } from "@/components/ui/button";

const FENCE = /^ {0,3}```+\s*(\S*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
// compiled once; matchAll hands each call its own cursor, so the recursion in inline() is safe
const INLINE = new RegExp(
  "`([^`]+)`|\\*\\*([\\s\\S]+?)\\*\\*|~~([\\s\\S]+?)~~|\\*([^\\s*][^*\\n]*?)\\*|\\[([^\\]]*)\\]\\(([^)\\s]+)\\)|(https?:\\/\\/[^\\s<>)\\]]+)" +
    `|(${FILE_REF_SOURCE})`,
  "g",
);
const SCHEME = /^(?:[a-z][\w+.-]*:|\/\/)/i;

// the whole subtree of one message shares these, so neither has to be threaded down
// through every nested list and quote
const Links = createContext<FileLinks | null>(null);
const Run = createContext<((command: string) => void) | null>(null);

function useTarget(text: string): [FileLinks, FileRef] | null {
  const links = useContext(Links);
  const target = links?.resolve(text);
  return links && target ? [links, target] : null;
}

function label(ref: FileRef): string {
  return `Open ${ref.path}${ref.line ? `:${ref.line}` : ""}`;
}

const CODE = "rounded bg-accent/70 px-1 py-0.5 font-mono text-[0.86em] text-code-inline";

function CodeSpan({ text }: { text: string }) {
  const hit = useTarget(text);
  if (!hit) return <code className={CODE}>{text}</code>;
  const [links, target] = hit;
  return (
    <button
      type="button"
      onClick={() => links.open(target)}
      title={label(target)}
      className="group cursor-pointer align-baseline leading-[inherit]"
    >
      <code className={cn(CODE, "underline-offset-2 group-hover:underline")}>{text}</code>
    </button>
  );
}

function PathSpan({ text }: { text: string }) {
  const hit = useTarget(text);
  if (!hit) return <>{text}</>;
  const [links, target] = hit;
  return (
    <button
      type="button"
      onClick={() => links.open(target)}
      title={label(target)}
      className="cursor-pointer align-baseline font-mono text-[0.92em] leading-[inherit] text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
    >
      {text}
    </button>
  );
}

function LinkSpan({ href, children }: { href: string; children: ReactNode }) {
  const hit = useTarget(href);
  if (hit) {
    const [links, target] = hit;
    return (
      <button
        type="button"
        onClick={() => links.open(target)}
        title={label(target)}
        className="cursor-pointer align-baseline leading-[inherit] text-primary underline underline-offset-2"
      >
        {children}
      </button>
    );
  }
  // a relative href that resolves to nothing would navigate away from the app
  if (!SCHEME.test(href)) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  );
}

const SHELL_FENCES = new Set(["sh", "bash", "zsh", "fish", "shell", "console"]);

// closed is false for a fence a stream hasn't finished yet — rendering a diagram from a
// half-written definition would just flash parse errors on every incoming token
function CodeBlock({ lang, body, closed }: { lang: string; body: string; closed: boolean }) {
  const run = useContext(Run);
  // a still-streaming command is a truncated one — running it early is the same risk closed
  // already guards against for a diagram, just with a shell instead of a parser doing the flashing
  const runnable = closed && run && SHELL_FENCES.has(lang.toLowerCase()) && body.trim().length > 0;

  if (closed && lang.toLowerCase() === "mermaid") {
    return (
      <div className="group relative">
        <Mermaid source={body} className="rounded-lg border border-border bg-background px-3 py-2.5" />
        <div className="absolute top-1.5 right-1.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={body} />
        </div>
      </div>
    );
  }

  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-lg border border-border bg-background px-3 py-2.5">
        <code className="font-mono text-[12.5px] leading-relaxed">
          {tokenize(body, lang).map((token, index) => (
            <span key={index} className={TOKEN_CLASS[token.kind]}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
      <div className="absolute top-1.5 right-1.5 flex gap-0.5 rounded-md bg-background/90 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        {runnable ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Run in terminal"
            title="Run in terminal"
            onClick={() => run(body)}
            className="size-6 text-faint hover:text-foreground"
          >
            <RunIcon className="size-3" />
          </Button>
        ) : null}
        <CopyButton text={body} />
      </div>
    </div>
  );
}

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
  let last = 0;
  let n = 0;

  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const k = `${key}i${n++}`;
    const [, code, strong, strike, em, linkText, href, bare, path] = match;
    if (code !== undefined) {
      out.push(<CodeSpan key={k} text={code} />);
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
        <LinkSpan key={k} href={href}>
          {inline(linkText, k)}
        </LinkSpan>,
      );
    } else if (bare !== undefined) {
      out.push(
        <a key={k} href={bare} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
          {bare}
        </a>,
      );
    } else if (path !== undefined) {
      out.push(<PathSpan key={k} text={path} />);
    }
    last = match.index + match[0].length;
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

    const fence = FENCE.exec(line);
    if (fence) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      // still streaming in when the closing ``` hasn't arrived yet
      const closed = i < lines.length;
      if (closed) i++;
      out.push(<CodeBlock key={k} lang={fence[1]} body={body.join("\n")} closed={closed} />);
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

export function Markdown({
  text,
  className,
  files,
  onRun,
}: {
  text: string;
  className?: string;
  files?: FileLinks;
  onRun?: (command: string) => void;
}) {
  return (
    <Links.Provider value={files ?? null}>
      <Run.Provider value={onRun ?? null}>
        <div className={cn("min-w-0 space-y-3 break-words", className)}>
          {blocks(text.split("\n"), "md")}
        </div>
      </Run.Provider>
    </Links.Provider>
  );
}
