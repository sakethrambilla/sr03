export type TokenKind =
  | "comment"
  | "string"
  | "keyword"
  | "control"
  | "number"
  | "type"
  | "function"
  | "property"
  | "plain";

export interface Token {
  text: string;
  kind: TokenKind;
}

interface Grammar {
  line: string[];
  block: boolean;
  template: boolean;
  keywords: Set<string>;
  control: Set<string>;
  // capitalised words only read as types in languages that have them
  types: boolean;
}

const words = (list: string) => new Set(list.split(" "));

const JS_KEYWORDS = words(
  "const let var function class extends implements interface type enum namespace declare abstract " +
    "public private protected readonly static get set new delete typeof instanceof in of as is " +
    "async await yield void this super null undefined true false import export from default " +
    "satisfies keyof infer asserts module require",
);
const JS_CONTROL = words(
  "if else for while do switch case break continue return throw try catch finally with debugger",
);

const SHELL = words(
  "if then else elif fi for while do done case esac function return export local readonly source " +
    "alias unset set shift exit trap eval exec",
);

const PY_KEYWORDS = words(
  "def class lambda import from as global nonlocal None True False self async await pass del assert with",
);
const PY_CONTROL = words("if elif else for while break continue return raise try except finally yield in is not and or");

const CSS_KEYWORDS = words("important inherit initial unset auto none var calc rgb rgba hsl hsla url");

const GRAMMARS: Record<string, Grammar> = {
  js: { line: ["//"], block: true, template: true, keywords: JS_KEYWORDS, control: JS_CONTROL, types: true },
  json: { line: [], block: false, template: false, keywords: words("true false null"), control: new Set(), types: false },
  css: { line: [], block: true, template: false, keywords: CSS_KEYWORDS, control: new Set(), types: false },
  shell: { line: ["#"], block: false, template: false, keywords: SHELL, control: new Set(), types: false },
  python: { line: ["#"], block: false, template: false, keywords: PY_KEYWORDS, control: PY_CONTROL, types: true },
  data: { line: ["#"], block: false, template: false, keywords: words("true false null yes no"), control: new Set(), types: false },
};

const BY_EXTENSION: Record<string, keyof typeof GRAMMARS> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  py: "python",
  yaml: "data",
  yml: "data",
  toml: "data",
};

// a file this big makes retokenising on every keystroke visible, and highlighting
// generated output is rarely what anyone is reading it for
const LIMIT = 200_000;

function grammarFor(name: string): Grammar | null {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const key = BY_EXTENSION[extension];
  return key ? GRAMMARS[key]! : null;
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/;
const NUMBER = /0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/;

function classifyWord(word: string, next: string, grammar: Grammar): TokenKind {
  if (grammar.control.has(word)) return "control";
  if (grammar.keywords.has(word)) return "keyword";
  if (next.startsWith("(")) return "function";
  if (grammar.types && /^[A-Z]/.test(word)) return "type";
  return "plain";
}

// one forward pass, longest-match-first: comments and strings must win over everything
// else so their contents are never tokenised as code
export function tokenize(text: string, filename: string): Token[] {
  const grammar = grammarFor(filename);
  if (!grammar || text.length > LIMIT) return [{ text, kind: "plain" }];

  const tokens: Token[] = [];
  let plain = "";
  let index = 0;

  const push = (value: string, kind: TokenKind) => {
    if (plain) {
      tokens.push({ text: plain, kind: "plain" });
      plain = "";
    }
    tokens.push({ text: value, kind });
  };

  const readString = (quote: string): string => {
    let cursor = index + 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") cursor += 2;
      else if (text[cursor] === quote) return text.slice(index, cursor + 1);
      else if (text[cursor] === "\n" && quote !== "`") return text.slice(index, cursor);
      else cursor += 1;
    }
    return text.slice(index);
  };

  while (index < text.length) {
    const rest = text.slice(index);
    const char = text[index]!;

    if (grammar.block && rest.startsWith("/*")) {
      const end = text.indexOf("*/", index + 2);
      const value = end === -1 ? rest : text.slice(index, end + 2);
      push(value, "comment");
      index += value.length;
      continue;
    }

    const lineComment = grammar.line.find((marker) => rest.startsWith(marker));
    if (lineComment) {
      const end = text.indexOf("\n", index);
      const value = end === -1 ? rest : text.slice(index, end);
      push(value, "comment");
      index += value.length;
      continue;
    }

    if (char === '"' || char === "'" || (char === "`" && grammar.template)) {
      const value = readString(char);
      const after = text.slice(index + value.length).trimStart();
      push(value, after.startsWith(":") ? "property" : "string");
      index += value.length;
      continue;
    }

    if (/\d/.test(char)) {
      const match = NUMBER.exec(rest);
      if (match && match.index === 0) {
        push(match[0], "number");
        index += match[0].length;
        continue;
      }
    }

    const word = IDENTIFIER.exec(rest);
    if (word && word.index === 0) {
      const after = rest.slice(word[0].length).trimStart();
      // a bare `name:` reads as a property in every grammar here
      const kind = after.startsWith(":") ? "property" : classifyWord(word[0], after, grammar);
      push(word[0], kind);
      index += word[0].length;
      continue;
    }

    plain += char;
    index += 1;
  }

  if (plain) tokens.push({ text: plain, kind: "plain" });
  return tokens;
}

export const TOKEN_CLASS: Record<TokenKind, string> = {
  comment: "text-code-comment",
  string: "text-code-string",
  keyword: "text-code-keyword",
  control: "text-code-control",
  number: "text-code-number",
  type: "text-code-type",
  function: "text-code-function",
  property: "text-code-property",
  plain: "text-foreground",
};
