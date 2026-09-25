# Live slash-command list — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch / worktree:** `ai/skills-display-debug-a36085` (this worktree)
**Test command:** `pnpm test` (server: `pnpm -C server test`)
**Lint / typecheck:** `pnpm typecheck`

## Approach
Claude, Cursor and Codex each carry a near-identical copy of "read cache → background probe →
merge into cache", and all three merge the old cache first, so nothing is ever removed, and none of
them tells the page. Extract that loop once into `server/src/agents/commandCatalog.ts`: a
single-flight background refresh that **replaces** the cache with `live ∪ disk scan` and publishes
a new `commands.updated` event when the list changed. Each provider supplies only its `scan` and
`probe`. The web store drops its "ask once" guard, so every "/" refetches (the server still
answers instantly from cache), and it folds `commands.updated` into `commandsByCwd`. The alternative
(fs.watch on skill roots) is out of scope and would still miss plugin skills, which only the CLI
reports.

## Global constraints
- Server TS is type-stripped: no enums, no parameter properties, no namespaces; import with `.ts`.
- `commandCatalog.ts` imports nothing from `db.ts` or `bus.ts` — the store and publish are passed
  in, so tests run without SQLite.
- A probe that returns `[]` means "no answer" (missing binary, timeout): keep the previous list,
  publish nothing.
- `ServerEvent` in `server/src/types.ts` and `web/src/lib/types.ts` change together.
- Zustand selectors never return fresh arrays (existing `NO_COMMANDS` stays).
- Comments: one-liners only where code can't speak; fix any comment the edit makes false.
- Commits: single-line Conventional Commits with the `Co-Authored-By: Claude Opus 5.5
  <noreply@anthropic.com>` trailer; author email `sakethrambilla@gmail.com`.

## File map
| File | Create/Modify | Responsibility |
|---|---|---|
| server/src/agents/commandCatalog.ts | Create | Cache read, single-flight refresh, replace + publish |
| server/src/agents/commandCatalog.test.ts | Create | Unit tests with a fake store/probe/publish |
| server/src/types.ts:274 | Modify | Add `commands.updated` to `ServerEvent` |
| web/src/lib/types.ts:337 | Modify | Mirror `commands.updated` |
| server/src/agents/claude.ts:444-506 | Modify | Use the catalog; delete its private cache/refresh copy |
| server/src/agents/cursor.ts:515-546, 1721-1748 | Modify | Use the catalog; pushed list only while a session is live in that cwd |
| server/src/agents/codex.ts:442-545, 1166 | Modify | Same as Cursor |
| web/src/store.ts:753-764, 979-987 | Modify | Refetch on every call; fold `commands.updated` |
| web/src/components/Composer.tsx:396-400 | Modify | Fix the comment that says the list is asked for once |

## Tasks

### Task 1: The catalog module and wire event

**Files:** Create `server/src/agents/commandCatalog.ts`, `server/src/agents/commandCatalog.test.ts`;
modify `server/src/types.ts`, `web/src/lib/types.ts`.

**Produces:**
```ts
export interface CommandCatalog {
  list(cwd: string): Promise<SlashCommand[]>;   // cached list at once; kicks a refresh
  refresh(cwd: string): Promise<void>;          // single-flight per cwd; never rejects
  remember(cwd: string, commands: SlashCommand[]): void; // write cache, no publish
}
export function createCommandCatalog(options: {
  providerId: ProviderId;
  scan: (cwd: string) => Promise<SlashCommand[]>;
  probe: (cwd: string) => Promise<SlashCommand[]>;
  store: { get(id: string): { json: string } | null; set(id: string, json: string): void };
  publish: (event: ServerEvent) => void;
}): CommandCatalog;
```
Event: `| { type: "commands.updated"; providerId: ProviderId; cwd: string; commands: SlashCommand[] }`.

- [ ] 1. Add the event line directly under `thread.commands` in both `server/src/types.ts` and
      `web/src/lib/types.ts`.
- [ ] 2. Write `commandCatalog.test.ts` (style of `skillScan.test.ts`: `node:test`,
      `node:assert/strict`) with a `Map`-backed fake store and an array-collecting fake publish.
      Cases:
      a. `refresh` replaces: store holds `[a, gone]`, probe → `[a, b]`, scan → `[c]`; after
         `await refresh(cwd)` the store's key `"<providerId>:<cwd>"` parses to `[a, b, c]`
         (sorted by name) and publish got one `commands.updated` with those commands.
      b. empty probe keeps previous: store `[a]`, probe → `[]`; store unchanged, zero publishes.
      c. probe rejects: store unchanged, zero publishes, `refresh` resolves.
      d. unchanged list: store already equals `live ∪ scan`; zero publishes.
      e. single-flight: probe returns a promise you resolve manually; call `refresh` twice before
         resolving; probe called once.
      f. `list` with cache returns the cached list without awaiting the probe (probe never
         resolves in this test).
      g. `list` with no cache and a non-empty scan returns the scan and stores it.
      h. `list` with no cache and an empty scan awaits the refresh and returns the live list.
      i. `remember` stores without publishing.
- [ ] 3. Run `cd server && node --experimental-strip-types --test src/agents/commandCatalog.test.ts`.
      Expect: FAIL — cannot find module `./commandCatalog.ts`.
- [ ] 4. Implement `commandCatalog.ts`:
      - key is `` `${providerId}:${cwd}` `` (matches existing rows, e.g. `claude:/tmp/sr03-repo`).
      - `refresh`: if a `Map<string, Promise<void>>` has the cwd, return it. Otherwise
        `Promise.all([probe(cwd), scan(cwd)])` → if `live.length === 0` return; `fresh =
        dedupeByName([live, scanned])` (from `./skillScan.ts`, live wins); if
        `JSON.stringify(fresh) === store.get(key)?.json` return; else `store.set` and `publish`.
        `.catch` logs `` `[commands:${providerId}] ${message}` `` via `console.error`;
        `.finally` deletes the map entry.
      - `list`: `cached = store.get(key)`; `const pending = refresh(cwd)`; if cached return its
        parse; `scanned = await scan(cwd)`; if non-empty `store.set` and return it; else
        `await pending` and return the stored parse or `[]`.
      - `remember`: `store.set(key, JSON.stringify(commands))`.
- [ ] 5. Re-run step 3. Expect: PASS, 9 tests.
- [ ] 6. `pnpm typecheck`. Expect: exit 0.
- [ ] 7. Commit: `feat(commands): add a shared refresh-and-publish command catalog`.

### Task 2: Claude uses the catalog

**Depends on:** Task 1. **Files:** `server/src/agents/claude.ts`.

- [ ] 1. Below `scanClaudeCommands`, add
      `const catalog = createCommandCatalog({ providerId: "claude", scan: scanClaudeCommands,
      probe: readCommands, store: commandCache, publish });` — import `publish` from `../bus.ts`
      (check it isn't already imported) and `createCommandCatalog` from `./commandCatalog.ts`.
- [ ] 2. Delete `commandCacheKey`, `readCommandCache`, `writeCommandCache`, `liveRefreshes`,
      `refreshLiveCommands` and `listCommandsCold` plus their comments (lines ~457-500).
- [ ] 3. `warmCommands(cwd)` becomes `return catalog.refresh(cwd);` keeping its
      "Populates the cache ahead of the first '/'" comment. In `listCommands`, replace both
      `listCommandsCold(cwd)` calls with `catalog.list(cwd)`.
- [ ] 4. Drop `dedupeByName` from the `./skillScan.ts` import if it is now unused.
- [ ] 5. `pnpm typecheck && pnpm -C server test`. Expect: exit 0, no failures.
- [ ] 6. Commit: `refactor(claude): refresh slash commands through the catalog`.

### Task 3: Cursor and Codex use the catalog

**Depends on:** Task 1. **Files:** `server/src/agents/cursor.ts`, `server/src/agents/codex.ts`.

Apply to each file (`<P>` = `cursor` / `codex`, `scan<P>` = `scanCursorCommands` /
`scanCodexCommands`):

- [ ] 1. Add `const catalog = createCommandCatalog({ providerId: "<P>", scan: scan<P>,
      probe: probeCommands, store: commandCache, publish });` after `probeCommands` is defined
      (a `const` referencing a function declaration is fine anywhere after the declaration's
      module scope; place it right above `listCommands`).
- [ ] 2. Delete `commandCacheKey`, `readCommandCache`, `writeCommandCache`, `liveRefreshes`,
      `refreshLiveCommands`, and `probesByCwd` (codex declares it at line 118).
- [ ] 3. `warmCommands(cwd)` becomes `return catalog.refresh(cwd);`.
- [ ] 4. `listCommands(cwd)` becomes:
      ```ts
      const pushed = commandsByCwd.get(cwd);
      if (pushed && [...sessions.values()].some((session) => session.cwd === cwd)) {
        return Promise.resolve(pushed);
      }
      return catalog.list(cwd);
      ```
      Add the one-liner above it: `// a live session's own list wins; once it closes the catalog does`.
- [ ] 5. Codex only: line ~1166 `writeCommandCache(thread.cwd, commands)` → `catalog.remember(thread.cwd, commands)`.
      Cursor: grep `writeCommandCache` and replace any remaining call the same way.
- [ ] 6. Fix the comments above the deleted refresh code that say "merges into the cache".
- [ ] 7. `pnpm typecheck && pnpm -C server test`. Expect: exit 0; `cursor.test.ts` and
      `codex.test.ts` still pass.
- [ ] 8. Commit: `refactor(agents): refresh cursor and codex commands through the catalog`.

### Task 4: Web refetches on each "/" and applies pushes

**Depends on:** Tasks 1-3. **Files:** `web/src/store.ts`, `web/src/components/Composer.tsx`.

- [ ] 1. In `loadCommands` (store.ts:753) delete `if (get().commandsByCwd[key]) return;` and
      change the comment to `// the server answers from cache and refreshes behind it, so asking on every "/" is cheap`.
- [ ] 2. In `applyEvent`, next to `case "thread.commands"`, add:
      ```ts
      case "commands.updated": {
        const key = commandKey(event.providerId, event.cwd);
        set((state) => ({ commandsByCwd: { ...state.commandsByCwd, [key]: event.commands } }));
        return;
      }
      ```
- [ ] 3. Composer.tsx:396-397 comment → `// asked for on each "/" rather than on mount — most sessions never type one`.
- [ ] 4. `pnpm typecheck && pnpm test`. Expect: exit 0.
- [ ] 5. Manual end-to-end (scratch repo per CLAUDE.md, never a real project):
      `mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main && echo hello > README.md && git add . && git commit -qm init`
      then `pnpm dev`, open http://localhost:5399, add `/tmp/sr03-repo`, and for each provider:
      a. Type "/" in a new thread's composer (no turn run). Note the list.
      b. `mkdir -p ~/.claude/skills/zz-sr03-probe && printf -- '---\ndescription: probe\n---\n' > ~/.claude/skills/zz-sr03-probe/SKILL.md`
         (for Codex use `~/.agents/skills/`). Clear the box, type "/" again, leave the menu open.
         Expect: `zz-sr03-probe` appears within one refresh (seconds) without reload.
      c. `rm -rf ~/.claude/skills/zz-sr03-probe` (resp. `~/.agents/...`), press "/" again.
         Expect: it disappears after the refresh.
      d. For Claude, `mermaid:mermaid-skill` is listed.
- [ ] 6. Commit: `fix(web): refetch slash commands and apply live updates`.

## Risks
- A provider that legitimately reports zero live commands (e.g. Codex with no skills) can't
  clear its cache after the last skill is deleted, because `[]` means "no answer". Acceptable:
  Claude and Cursor always report built-ins; noted rather than fixed.
- Every "/" now does a cold probe per provider-folder if none is in flight — one CLI spawn per
  keystroke burst at most (single-flight). If this proves noisy, add a minimum interval in the
  catalog; not done now.
- A `commands.updated` from a cold refresh may briefly overwrite a running Claude thread's list
  in the same folder; the next "/" re-reads the live session and corrects it.
