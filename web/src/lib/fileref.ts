export interface FileRef {
  path: string;
  line?: number;
}

// a stretch of one rendered line that names another file, in columns of that line
export interface LineLink {
  start: number;
  end: number;
  path: string;
}

export interface FileIndex {
  resolve: (text: string) => FileRef | null;
  imports: (from: string, line: string) => LineLink[];
  bindings: (from: string, text: string) => Map<string, string>;
}

export interface FileLinks extends FileIndex {
  open: (ref: FileRef) => void;
}

// either something with a slash in it, or a bare name carrying an extension — anything
// looser matches most of the words in a sentence
export const FILE_REF_SOURCE =
  "(?:\\.{0,2}\\/)?(?:[\\w.@+-]+\\/)+[\\w.@+-]+(?::\\d+){0,2}" +
  "|(?:\\.{1,2}\\/)?[\\w@+-]+(?:\\.[\\w@+-]+)*\\.[A-Za-z][\\w+]*(?::\\d+){0,2}";

const TRAILING = /[.,;:!?'")\]}]+$/;
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;
const ANCHOR = /#L(\d+)$/;

const JS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro)$/i;
const CSS_FILE = /\.(css|scss|less)$/i;
const PY_FILE = /\.py$/i;

// the quoted half of `from "x"`, `require("x")`, `import("x")` and a bare `import "x"`
const JS_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|^\s*(?:import|export)\s+)(['"`])([^'"`\n]+)\1/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(['"])([^'"\n]+)\1/g;
const PY_IMPORT = /^\s*(?:from|import)\s+(\.*[\w.]*)/;

// the names a file gives what it imports, which a clause can spread over several lines
const JS_BINDING = /^[ \t]*(?:import|export)[ \t]+([^;'"]*?)[ \t]*from[ \t]*['"]([^'"\n]+)['"]/gm;
const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([\s\S]*?\)|[^\n]*)/gm;
const PY_PLAIN = /^[ \t]*import[ \t]+([^\n(]*)$/gm;
const NAME = /^[A-Za-z_$][\w$]*$/;

// `A as B`, `* as NS`, `type A` — whichever of those, the file goes on to call it B, NS or A
function localName(entry: string): string | null {
  const cleaned = entry.split("#")[0]!.replace(/\btype\b/g, " ").replace(/[()]/g, " ").trim();
  const aliased = /\bas\b\s+([A-Za-z_$][\w$]*)$/.exec(cleaned);
  const name = aliased ? aliased[1]! : cleaned;
  return NAME.test(name) ? name : null;
}

function jsNames(clause: string): string[] {
  const braces = /\{([^}]*)\}/.exec(clause);
  const outside = braces ? clause.slice(0, braces.index) + clause.slice(braces.index + braces[0].length) : clause;
  const entries = [...(braces?.[1] ?? "").split(","), ...outside.split(",")];
  return entries.map(localName).filter((name): name is string => name !== null);
}

// a specifier names a module, not a file, so try every extension the tree might spell it with
const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
];
const INDEXES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
// NodeNext spells a TypeScript import with the extension it will compile to
const REWRITE: Record<string, string> = { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".mts", ".cjs": ".cts" };

function join(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

// leading dots count packages upwards: `.models` is a sibling, `..models` one level out
function pythonModule(from: string, module: string): string {
  const dots = /^\.*/.exec(module)![0].length;
  const rest = module.slice(dots).replace(/\./g, "/");
  if (dots === 0) return rest;
  return join(from, `./${"../".repeat(dots - 1)}${rest}`);
}

// floor is how much of the tail a match has to keep, so a bare package name can never
// come down to whichever index.ts or __init__.py the tree happens to hold
function candidates(base: string, python: boolean): { path: string; floor: number }[] {
  if (python) {
    return [
      { path: `${base}.py`, floor: 1 },
      { path: `${base}/__init__.py`, floor: 2 },
    ];
  }
  const list = [{ path: base, floor: 1 }];
  const written = base.slice(base.lastIndexOf("."));
  if (REWRITE[written]) list.push({ path: base.slice(0, -written.length) + REWRITE[written], floor: 1 });
  for (const extension of EXTENSIONS) list.push({ path: base + extension, floor: 1 });
  for (const index of INDEXES) list.push({ path: base + index, floor: 2 });
  return list;
}

export function createFileIndex(files: string[]): FileIndex {
  const exact = new Set(files);
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const list = byName.get(name);
    if (list) list.push(file);
    else byName.set(name, [file]);
  }

  const lookup = (ref: string, floor = 1): string | null => {
    if (exact.has(ref)) return ref;
    const parts = ref.split("/").filter((part) => part && part !== ".");
    if (parts.length === 0) return null;
    const named = byName.get(parts[parts.length - 1]!) ?? [];
    // an absolute path, one written from another root, or one behind an alias: drop leading
    // segments until a tail lands, either exactly or on a single file in the tree
    for (let i = 0; i <= parts.length - floor; i += 1) {
      const tail = parts.slice(i).join("/");
      if (exact.has(tail)) return tail;
      const matches = named.filter((file) => file.endsWith(`/${tail}`));
      if (matches.length === 1) return matches[0]!;
    }
    return null;
  };

  const parse = (text: string): FileRef | null => {
    let ref = text.trim().replace(TRAILING, "");
    if (!ref) return null;
    let line: number | undefined;
    const anchor = ANCHOR.exec(ref);
    const suffix = anchor ? null : LINE_SUFFIX.exec(ref);
    if (anchor) {
      line = Number(anchor[1]);
      ref = ref.slice(0, anchor.index);
    } else if (suffix) {
      line = Number(suffix[1]);
      ref = ref.slice(0, suffix.index);
    }
    const path = lookup(ref);
    if (!path) return null;
    return line ? { path, line } : { path };
  };

  // every bubble re-resolves its refs on each render, and the answers never change
  const cache = new Map<string, FileRef | null>();
  const modules = new Map<string, string | null>();

  // an alias like `@/lib/x` never lands exactly, but lookup's suffix match finds it anyway
  const resolveImport = (from: string, specifier: string): string | null => {
    const key = `${from} ${specifier}`;
    if (modules.has(key)) return modules.get(key)!;
    const python = PY_FILE.test(from);
    const base = python ? pythonModule(from, specifier) : join(from, specifier);
    // a relative specifier is already a whole path, so only an exact file answers it
    const relative = specifier.startsWith(".");
    let found: string | null = null;
    if (base) {
      for (const candidate of candidates(base, python)) {
        found = relative
          ? (exact.has(candidate.path) ? candidate.path : null)
          : lookup(candidate.path, candidate.floor);
        if (found) break;
      }
    }
    modules.set(key, found);
    return found;
  };

  const imports = (from: string, line: string): LineLink[] => {
    if (PY_FILE.test(from)) {
      const match = PY_IMPORT.exec(line);
      const module = match?.[1];
      if (!match || !module) return [];
      const path = resolveImport(from, module);
      if (!path) return [];
      const start = match.index + match[0].length - module.length;
      return [{ start, end: start + module.length, path }];
    }
    const pattern = CSS_FILE.test(from) ? CSS_IMPORT : JS_FILE.test(from) ? JS_IMPORT : null;
    if (!pattern) return [];
    const found: LineLink[] = [];
    pattern.lastIndex = 0;
    for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
      const specifier = match[2]!;
      const path = resolveImport(from, specifier);
      // the closing quote is the last character of the match, so the specifier ends one before it
      const start = match.index + match[0].length - specifier.length - 1;
      if (path) found.push({ start, end: start + specifier.length, path });
    }
    return found;
  };

  // what each imported name points at, so a click on the name itself lands the same way
  // a click on the specifier does
  const bindings = (from: string, text: string): Map<string, string> => {
    const found = new Map<string, string>();
    const bind = (name: string | null, specifier: string) => {
      if (!name || found.has(name)) return;
      const path = resolveImport(from, specifier);
      if (path) found.set(name, path);
    };

    if (PY_FILE.test(from)) {
      PY_FROM.lastIndex = 0;
      for (let match = PY_FROM.exec(text); match; match = PY_FROM.exec(text)) {
        for (const entry of match[2]!.split(",")) bind(localName(entry), match[1]!);
      }
      PY_PLAIN.lastIndex = 0;
      for (let match = PY_PLAIN.exec(text); match; match = PY_PLAIN.exec(text)) {
        for (const entry of match[1]!.split(",")) {
          const module = entry.split("#")[0]!.split(/\bas\b/)[0]!.trim();
          if (!module) continue;
          // `import a.b` binds only `a`, since that is what the file writes
          bind(localName(entry) ?? module.split(".")[0]!, module);
        }
      }
      return found;
    }

    if (!JS_FILE.test(from)) return found;
    JS_BINDING.lastIndex = 0;
    for (let match = JS_BINDING.exec(text); match; match = JS_BINDING.exec(text)) {
      for (const name of jsNames(match[1]!)) bind(name, match[2]!);
    }
    return found;
  };

  return {
    resolve: (text) => {
      if (cache.has(text)) return cache.get(text)!;
      const found = parse(text);
      cache.set(text, found);
      return found;
    },
    imports,
    bindings,
  };
}
