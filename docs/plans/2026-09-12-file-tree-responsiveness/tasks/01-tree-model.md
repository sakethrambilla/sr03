# Task 1: Pure tree model in lib/

**Depends on:** nothing
**Files:**
- Create: `web/src/lib/filetree.ts`
- Create: `web/src/lib/filetree.test.ts`

**Interfaces — produces:**

```ts
import type { TreeEntry } from "./types.ts";

export interface TreeRow { entry: TreeEntry; depth: number }

export const INDENT = 12;
export const ROW_HEIGHT = 22;
export const OVERSCAN = 20;
export const REFRESH_CONCURRENCY = 16;
export const AUTO_EXPAND_MAX_CHANGES = 200;

export function parentOf(path: string): string;
export function ancestors(path: string): string[];
export function compareEntries(a: TreeEntry, b: TreeEntry): number;
export function projectRows(
  dirs: Readonly<Record<string, readonly TreeEntry[]>>,
  expanded: ReadonlySet<string>,
): TreeRow[];
export function dirtyAncestors(changedPaths: Iterable<string>): Set<string>;
export function autoExpandFor(changedPaths: ReadonlySet<string>): Set<string> | null;
export function toggleSubtree(
  expanded: ReadonlySet<string>,
  dirs: Readonly<Record<string, readonly TreeEntry[]>>,
  dir: string,
): Set<string>;

export interface DirLoadToken { dir: string; revision: number }
export interface DirLoadTracker {
  begin(dir: string): DirLoadToken;
  isCurrent(token: DirLoadToken): boolean;
}
export function createDirLoadTracker(): DirLoadTracker;

export function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void>;

export function insertEntry(entries: readonly TreeEntry[], entry: TreeEntry): TreeEntry[];
export function removeEntry(entries: readonly TreeEntry[], path: string): TreeEntry[];
export function replaceEntry(
  entries: readonly TreeEntry[],
  fromPath: string,
  next: TreeEntry,
): TreeEntry[];
```

**Consumes:** `TreeEntry` from `web/src/lib/types.ts`. Nothing else — this module imports no React
and no DOM.

## Behaviour notes the implementer must not improvise

- `projectRows` walks `dirs[""]` as the root and recurses into a child only when it is a directory
  **and** its path is in `expanded`. A directory in `expanded` whose listing is not yet in `dirs`
  contributes its own row and no children. Depth of a root-level entry is 0.
- `compareEntries` must reproduce the server's order exactly — see
  `server/src/fsbrowse.ts:233`: directories first, then `name.localeCompare(name)`.
- `dirtyAncestors` returns every ancestor directory of every changed path. `"a/b/c.ts"` contributes
  `"a"` and `"a/b"`. A root-level changed file contributes nothing.
- `autoExpandFor` returns `null` when the set has more than `AUTO_EXPAND_MAX_CHANGES` entries —
  `null` means "too many to be useful, leave the tree alone", which is distinct from an empty set
  meaning "nothing to expand".
- `toggleSubtree(expanded, dirs, dir)` when `dir` is expanded removes `dir` and every path starting
  `` `${dir}/` ``; when it is not, adds `dir` plus every already-loaded key of `dirs` starting
  `` `${dir}/` ``. Never mutates the input set.
- `createDirLoadTracker` keeps one revision per directory: `begin` increments that directory's
  revision and returns it; `isCurrent` is true only while no later `begin` for the same directory
  has run. Orca additionally carries a session counter to invalidate everything on a worktree
  switch; sr03 does not need one, because `App.tsx:83` renders `<ChatView key={thread.id}>`, so the
  whole panel — tracker included — is remounted when the session changes. Do not add a `reset`.
- `forEachWithConcurrency` keeps at most `limit` promises in flight, starts the next as each
  settles, and **never rejects** — a task that throws is swallowed so one bad directory cannot
  abort the rest of a refresh. `limit <= 0` is treated as 1.
- `insertEntry` / `removeEntry` / `replaceEntry` return new arrays, leave the input untouched, and
  keep `compareEntries` order. `insertEntry` with a path already present replaces it rather than
  duplicating.

## Steps

Steps 1a–1e each write one `describe` block into `web/src/lib/filetree.test.ts`, importing from
`./filetree.ts`, which does not exist yet. Write them in order; run step 2 once, after 1e.

- [ ] 1a. Path helpers and ordering.
      - `parentOf("a/b/c.ts") === "a/b"`, `parentOf("README.md") === ""`
      - `ancestors("a/b/c.ts")` deep-equals `["a", "a/b"]`; `ancestors("README.md")` is `[]`
      - `compareEntries` puts a directory before a file, and orders two files by name

- [ ] 1b. Projection.
      - a two-level fixture with only the root expanded yields root entries at depth 0, no children
      - with a nested dir expanded, its children appear at depth 1 immediately after their parent
      - a dir in `expanded` whose listing is absent yields the dir row, no children, and no throw

- [ ] 1c. Change-set policy.
      - `dirtyAncestors(["a/b/c.ts", "d.ts"])` equals `new Set(["a", "a/b"])`
      - `autoExpandFor` of 201 paths returns `null`; of 3 paths returns their ancestor set
      - `toggleSubtree` collapsing a dir also drops its descendants, and does not mutate the input

- [ ] 1d. Load tracker.
      - a token is current right after `begin`
      - a second `begin` on the same dir makes the first token stale
      - a `begin` on a *different* dir leaves the first token current

- [ ] 1e. Concurrency and entry edits.
      - `forEachWithConcurrency` with limit 2 over 5 tasks never exceeds 2 in flight (track a
        counter), visits all 5, and resolves even when one task rejects
      - `insertEntry` places a new file in sorted position; inserting an existing path replaces it
        rather than duplicating
      - `replaceEntry` re-sorts when the replacement's name changes its position — Task 6 relies on
        this for rename
      - `toggleSubtree`'s expand branch restores already-loaded descendants, not just the dir itself
      - `removeEntry` and `replaceEntry` leave the input array unmodified

- [ ] 2. Run `node --experimental-strip-types --test web/src/lib/filetree.test.ts`.
      Expect: FAIL — `Cannot find module '.../web/src/lib/filetree.ts'`.
      If it fails any other way, stop and reconcile before continuing.

- [ ] 3. Create `web/src/lib/filetree.ts` implementing every export in the Interfaces block above.
      Match the file-header comment style of `web/src/lib/layout.ts` — one short paragraph saying
      what the module owns. Do not add a comment to anything the signature already explains.

- [ ] 4. Run `node --experimental-strip-types --test web/src/lib/filetree.test.ts`.
      Expect: PASS — `# fail 0`, and a `# pass` count matching the number of tests written.

- [ ] 5. Run `pnpm -C web typecheck`. Expect: no output, exit 0.

- [ ] 6. Run the full suite: `pnpm test`. Expect: no new failures against the pre-task baseline.

- [ ] 7. Commit:
      `git add web/src/lib/filetree.ts web/src/lib/filetree.test.ts`
      `git commit -m "feat(files): extract the file tree model into a tested module"`

## Done when

`web/src/lib/filetree.ts` exports every symbol in the Interfaces block, `filetree.test.ts` covers
each of them, `pnpm -C web test` is green, and `FileTree.tsx` is untouched.
