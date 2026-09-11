// The file editor's text behaviours — indent, outdent, auto-indent on Enter and the comment
// toggle. Pure string math: each returns the span to replace and where the selection lands, so
// the caller can apply it through the textarea's own insertText and keep the native undo stack.
import { lineComment } from "./highlight.ts";

export interface Selection {
  start: number;
  end: number;
}

export interface Edit {
  from: number;
  to: number;
  text: string;
  start: number;
  end: number;
}

const PY = /\.(py|pyi)$/i;
// only an opener that ends the line opens a block; one closed on the same line does not
const OPENER = /[([{]$/;

// the file's own indentation wins, so an edit never mixes widths with what is already there
export function indentUnit(value: string, filename: string): string {
  for (const line of value.split("\n")) {
    if (/^\t/.test(line)) return "\t";
    const spaces = /^( +)\S/.exec(line);
    if (spaces) return spaces[1]!.length >= 4 ? "    " : " ".repeat(spaces[1]!.length);
  }
  return PY.test(filename) ? "    " : "  ";
}

function lineStart(value: string, index: number): number {
  return value.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(value: string, index: number): number {
  const next = value.indexOf("\n", index);
  return next === -1 ? value.length : next;
}

// the lines a selection touches, as one replaceable span
function block(value: string, sel: Selection) {
  const from = lineStart(value, sel.start);
  const to = lineEnd(value, sel.end);
  return { from, to, lines: value.slice(from, to).split("\n") };
}

export function indent(value: string, sel: Selection, unit: string): Edit {
  const { from, to, lines } = block(value, sel);
  // a caret inside one line indents to the next tab stop instead of shifting the whole line
  if (sel.start === sel.end && lines.length === 1) {
    const width = unit === "\t" ? 1 : unit.length - ((sel.start - from) % unit.length);
    const text = unit === "\t" ? "\t" : " ".repeat(width);
    return { from: sel.start, to: sel.end, text, start: sel.start + text.length, end: sel.start + text.length };
  }
  const text = lines.map((line) => (line ? unit + line : line)).join("\n");
  return { from, to, text, start: from, end: from + text.length };
}

export function outdent(value: string, sel: Selection, unit: string): Edit {
  const { from, to, lines } = block(value, sel);
  const text = lines
    .map((line) => {
      if (line.startsWith("\t")) return line.slice(1);
      const width = Math.min(unit === "\t" ? 1 : unit.length, /^ */.exec(line)![0].length);
      return line.slice(width);
    })
    .join("\n");
  return { from, to, text, start: from, end: from + text.length };
}

export function newline(value: string, sel: Selection, unit: string, filename: string): Edit {
  const from = lineStart(value, sel.start);
  const line = value.slice(from, sel.start);
  const lead = /^[ \t]*/.exec(line)![0];
  const code = line.trimEnd();
  const deeper = OPENER.test(code) || (PY.test(filename) && code.endsWith(":"));
  const text = "\n" + lead + (deeper ? unit : "");
  const caret = sel.start + text.length;
  return { from: sel.start, to: sel.end, text, start: caret, end: caret };
}

// null where the file's kind has no line comment to toggle
export function comment(value: string, sel: Selection, filename: string): Edit | null {
  const marker = lineComment(filename);
  if (!marker) return null;
  const { from, to, lines } = block(value, sel);
  const filled = lines.filter((line) => line.trim());
  if (!filled.length) return null;
  const commented = filled.every((line) => line.trimStart().startsWith(marker));
  const column = Math.min(...filled.map((line) => /^[ \t]*/.exec(line)![0].length));
  const text = lines
    .map((line) => {
      if (!line.trim()) return line;
      if (!commented) return line.slice(0, column) + marker + " " + line.slice(column);
      const at = line.indexOf(marker);
      const after = line.slice(at + marker.length);
      return line.slice(0, at) + (after.startsWith(" ") ? after.slice(1) : after);
    })
    .join("\n");
  return { from, to, text, start: from, end: from + text.length };
}
