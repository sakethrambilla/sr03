export interface FileRef {
  path: string;
  line?: number;
}

export interface FileLinks {
  resolve: (text: string) => FileRef | null;
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

export interface FileIndex {
  resolve: (text: string) => FileRef | null;
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

  const lookup = (ref: string): string | null => {
    if (exact.has(ref)) return ref;
    const parts = ref.split("/").filter((part) => part && part !== ".");
    if (parts.length === 0) return null;
    // an absolute path, or one written from some other root: drop leading segments until one lands
    for (let i = 1; i < parts.length; i += 1) {
      const tail = parts.slice(i).join("/");
      if (exact.has(tail)) return tail;
    }
    // a bare name, or a tail of one, but only when nothing else in the tree shares it
    const candidates = byName.get(parts[parts.length - 1]) ?? [];
    const matches =
      parts.length > 1
        ? candidates.filter((file) => file.endsWith(`/${parts.join("/")}`))
        : candidates;
    return matches.length === 1 ? matches[0] : null;
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

  return {
    resolve: (text) => {
      if (cache.has(text)) return cache.get(text)!;
      const found = parse(text);
      cache.set(text, found);
      return found;
    },
  };
}
