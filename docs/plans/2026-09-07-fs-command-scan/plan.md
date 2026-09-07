# Fast slash-command / skill listing — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch / worktree:** `feat/fs-command-scan` (run from this worktree, `t3-codes-performance-3f2160`)
**Test command:** `cd server && node --experimental-strip-types --test src/*.test.ts src/agents/*.test.ts` (or `pnpm -C server test`)
**Lint / typecheck:** `pnpm typecheck` (runs both packages)

## Approach

Mirror t3.codes' split: keep discovery (slow, CLI-dependent) out of the request path entirely.
Both providers get a pure filesystem scanner (`server/src/agents/skillScan.ts`, shared since Claude
Code and Cursor both lay out custom commands/skills as a directory of `SKILL.md` files, and Claude
additionally has flat `.md` command files) that never spawns a process. Results are persisted in a
new `command_cache` SQLite table (mirroring the existing `usage` table's id/json/updated_at shape),
so a warm cache survives a server restart. `listCommands(cwd)` becomes: return the cache if present
(kicking off a background live-probe refresh to catch anything only the CLI knows, like Claude's
built-ins), otherwise scan the filesystem synchronously (still no process spawn) and cache that.
The existing live-probe functions (`readCommands` in claude.ts, `probeCommands` in cursor.ts) are
untouched in behavior — they're just moved off the hot path and merged into the cache instead of
being awaited by the request. That merge only takes effect on the *next* read of the cache — no new
push path is added for a thread with no live session (see spec Non-goals); a thread with a live
session already gets `thread.commands` pushed via its own init handshake, unchanged by this plan.

Research finding (already resolved, no separate spike needed): t3.codes' own `CursorSkills.ts`
driver establishes that Cursor has no CLI-exposed "commands" directory distinct from skills — it
scans `.cursor/skills`, `.agents/skills`, `.codex/skills`, and `.claude/skills` under both the
project root and the user's home directory, and Cursor invokes any of them as `/name`. This plan's
Cursor scanner reuses that exact root list.

## Global constraints
- No new runtime dependency. Frontmatter parsing is a minimal hand-rolled `key: value` line reader
  (top-level fields only — no nested YAML) since the only two fields consumed are `description` and
  `argument-hint`; this is deliberately narrower than Claude Code's/Cursor's own YAML parsing and is
  acceptable because the live-probe fallback still supplies the exactly-correct answer in the
  background.
- Persistence goes through `server/src/db.ts`, matching the `usage` table idiom exactly (id/json/
  updated_at, prepared statements in the `sql` object, one accessor object per table).
- `SlashCommand { name, description, argumentHint }` in `server/src/types.ts` and
  `web/src/lib/types.ts` is unchanged — no wire-format changes in this plan.
- Every existing live-probe code path (`readCommands`, `cachedCommands`→removed, `probeCommands`,
  `commandsByCwd`, `probesByCwd`) keeps working; nothing here removes the fallback.
- A scan or cache read must never throw out of `listCommands` — on any filesystem error the affected
  root contributes zero commands, matching how `readdir`/`readFile` failures are already swallowed
  elsewhere in this codebase.

## File map
| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/db.ts` | Modify | Add `command_cache` table + `commandCache` accessor (get/set), mirroring `usage` |
| `server/src/db.test.ts` | Create | Unit test for the new `commandCache` accessor |
| `server/src/agents/skillScan.ts` | Create | Shared, process-free filesystem scan: frontmatter parsing, `scanCommandFiles`, `scanSkillDirectories`, `dedupeByName` |
| `server/src/agents/skillScan.test.ts` | Create | Unit tests for the scan helpers |
| `server/src/agents/claude.ts:413-455,767` | Modify | Replace in-memory `cachedCommands`/`commandsByCwd` with disk-cache-backed `listCommandsCold` fed by `scanClaudeCommands`; add exported `warmCommands`; register it on `claudeProvider` |
| `server/src/agents/cursor.ts:475-506,1577-1646` | Modify | Add `scanCursorCommands`, disk-cache read in `listCommands`, exported `warmCommands`; register it on `cursorProvider` |
| `server/src/agents/cursor.test.ts` | Modify | Extend with a filesystem-scan-hits-cache-without-a-push test |
| `server/src/agents/types.ts:62-68` | Modify | Add optional `warmCommands?(cwd: string): void` to `AgentProvider` |
| `server/src/agents/runtime.ts:501-503` | Modify | Add exported `warmCommands(providerId, cwd)` delegating to the provider |
| `server/src/api.ts:492-503` | Modify | Call `agents.warmCommands(providerId, cwd)` right after `threads.create(...)` |

## Tasks

### Task 1: `command_cache` table and accessor

**Depends on:** nothing
**Files:**
- Modify: `server/src/db.ts`
- Create: `server/src/db.test.ts`

**Interfaces:**
- Produces: `export const commandCache = { get(id: string): { id: string; json: string; updatedAt: number } | null, set(id: string, json: string): void }`

#### Steps

- [ ] 1. In `server/src/db.ts`, inside the `db.exec(\`...\`)` boot block (after the `usage` table,
      before `server_instances`, around line 87), add:
      ```sql
      CREATE TABLE IF NOT EXISTS command_cache (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ```

- [ ] 2. In the `sql` object (after `usageRemove`, around line 279), add two prepared statements:
      ```ts
      commandCacheGet: db.prepare("SELECT id, json, updated_at FROM command_cache WHERE id = ?"),
      commandCacheSet: db.prepare(
        "INSERT INTO command_cache (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      ),
      ```

- [ ] 3. After the `usage` accessor (after line 359), add:
      ```ts
      // a scanned/probed command list keyed by "<providerId>:<cwd>", so a cold cwd answers
      // from disk instead of re-scanning or re-spawning a CLI after every restart
      export const commandCache = {
        get(id: string): { id: string; json: string; updatedAt: number } | null {
          const row = sql.commandCacheGet.get(id) as
            | { id: string; json: string; updated_at: number }
            | undefined;
          return row ? { id: row.id, json: row.json, updatedAt: row.updated_at } : null;
        },

        set(id: string, json: string): void {
          sql.commandCacheSet.run(id, json, Date.now());
        },
      };
      ```

- [ ] 4. Create `server/src/db.test.ts`:
      ```ts
      import assert from "node:assert/strict";
      import { test } from "node:test";
      import fs from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";

      test("commandCache round-trips a value and reports a miss as null", async (context) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-db-"));
        const previous = process.env.SR03_DATA_DIR;
        process.env.SR03_DATA_DIR = directory;
        context.after(async () => {
          if (previous === undefined) delete process.env.SR03_DATA_DIR;
          else process.env.SR03_DATA_DIR = previous;
          await fs.rm(directory, { recursive: true, force: true });
        });

        const { commandCache } = await import("./db.ts");
        assert.equal(commandCache.get("claude:/tmp/nope"), null);
        commandCache.set("claude:/tmp/proj", JSON.stringify([{ name: "foo" }]));
        const row = commandCache.get("claude:/tmp/proj");
        assert.ok(row);
        assert.deepEqual(JSON.parse(row.json), [{ name: "foo" }]);
      });
      ```

- [ ] 5. Run `cd server && node --experimental-strip-types --test src/db.test.ts`.
      Expect: `# pass 1`, `# fail 0`.

- [ ] 6. `git add server/src/db.ts server/src/db.test.ts`
      `git commit -m "feat(server): add command_cache table for scanned/probed commands"`

**Done when:** `commandCache.get`/`.set` round-trip through a fresh SQLite file and the new test
passes.

---

### Task 2: Shared filesystem scan helpers

**Depends on:** nothing (parallel with Task 1)
**Files:**
- Create: `server/src/agents/skillScan.ts`
- Create: `server/src/agents/skillScan.test.ts`

**Interfaces:**
- Produces:
  - `parseFrontmatter(contents: string): Record<string, string>`
  - `scanCommandFiles(root: string): Promise<SlashCommand[]>`
  - `scanSkillDirectories(root: string): Promise<SlashCommand[]>`
  - `dedupeByName(lists: SlashCommand[][]): SlashCommand[]`

#### Steps

- [ ] 1. Create `server/src/agents/skillScan.ts`:
      ```ts
      // Shared filesystem discovery for the two on-disk layouts Claude Code and Cursor both use:
      // a flat directory of `<name>.md` command files, and a directory of `<name>/SKILL.md` skill
      // folders. Both file kinds share the same frontmatter shape (`---` fences around `key: value`
      // lines), so both providers' scanners route through this module rather than each parsing
      // their own copy.
      import fs from "node:fs/promises";
      import path from "node:path";

      import type { SlashCommand } from "../types.ts";

      const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

      // top-level `key: value` lines only — no nested YAML. The two fields this project reads
      // (description, argument-hint) are always flat, and a nested value would just be dropped.
      export function parseFrontmatter(contents: string): Record<string, string> {
        const match = FRONTMATTER.exec(contents);
        if (!match?.[1]) return {};
        const fields: Record<string, string> = {};
        for (const line of match[1].split("\n")) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim();
          const value = line
            .slice(colon + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (key) fields[key] = value;
        }
        return fields;
      }

      // Claude Code's custom-command layout: one `<root>/<name>.md` file per command.
      export async function scanCommandFiles(root: string): Promise<SlashCommand[]> {
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const commands: SlashCommand[] = [];
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const contents = await fs.readFile(path.join(root, entry.name), "utf8").catch(() => null);
          if (contents === null) continue;
          const frontmatter = parseFrontmatter(contents);
          commands.push({
            name: entry.name.slice(0, -3),
            description: frontmatter.description ?? "",
            argumentHint: frontmatter["argument-hint"] ?? "",
          });
        }
        return commands;
      }

      // The skill layout Claude Code and Cursor share: one `<root>/<name>/SKILL.md` per skill.
      export async function scanSkillDirectories(root: string): Promise<SlashCommand[]> {
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const commands: SlashCommand[] = [];
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const contents = await fs
            .readFile(path.join(root, entry.name, "SKILL.md"), "utf8")
            .catch(() => null);
          if (contents === null) continue;
          const frontmatter = parseFrontmatter(contents);
          commands.push({
            name: entry.name,
            description: frontmatter.description ?? "",
            argumentHint: "",
          });
        }
        return commands;
      }

      // First list to carry a name wins, so callers order lists highest-precedence-first.
      export function dedupeByName(lists: SlashCommand[][]): SlashCommand[] {
        const byName = new Map<string, SlashCommand>();
        for (const list of lists) {
          for (const command of list) {
            if (!byName.has(command.name)) byName.set(command.name, command);
          }
        }
        return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
      }
      ```

- [ ] 2. Write the failing test first — create `server/src/agents/skillScan.test.ts`:
      ```ts
      import assert from "node:assert/strict";
      import { test } from "node:test";
      import fs from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";

      import { dedupeByName, parseFrontmatter, scanCommandFiles, scanSkillDirectories } from "./skillScan.ts";

      test("parseFrontmatter reads top-level fields between fences", () => {
        const fields = parseFrontmatter('---\ndescription: Do the thing\nargument-hint: "<name>"\n---\nbody');
        assert.deepEqual(fields, { description: "Do the thing", "argument-hint": "<name>" });
      });

      test("parseFrontmatter returns {} when there is no frontmatter", () => {
        assert.deepEqual(parseFrontmatter("just a body"), {});
      });

      test("scanCommandFiles reads one command per markdown file", async (context) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-scan-cmd-"));
        context.after(() => fs.rm(directory, { recursive: true, force: true }));
        await fs.writeFile(
          path.join(directory, "deploy.md"),
          "---\ndescription: Ship it\nargument-hint: <env>\n---\nbody",
        );
        await fs.writeFile(path.join(directory, "notes.txt"), "ignored, not markdown");
        const commands = await scanCommandFiles(directory);
        assert.deepEqual(commands, [
          { name: "deploy", description: "Ship it", argumentHint: "<env>" },
        ]);
      });

      test("scanCommandFiles returns [] for a missing directory", async () => {
        assert.deepEqual(await scanCommandFiles("/does/not/exist"), []);
      });

      test("scanSkillDirectories reads one skill per SKILL.md folder", async (context) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-scan-skill-"));
        context.after(() => fs.rm(directory, { recursive: true, force: true }));
        await fs.mkdir(path.join(directory, "review"), { recursive: true });
        await fs.writeFile(
          path.join(directory, "review", "SKILL.md"),
          "---\ndescription: Review a diff\n---\nbody",
        );
        const commands = await scanSkillDirectories(directory);
        assert.deepEqual(commands, [{ name: "review", description: "Review a diff", argumentHint: "" }]);
      });

      test("dedupeByName keeps the first list's entry on a name collision", () => {
        const merged = dedupeByName([
          [{ name: "review", description: "project", argumentHint: "" }],
          [{ name: "review", description: "user", argumentHint: "" }],
          [{ name: "deploy", description: "user", argumentHint: "" }],
        ]);
        assert.deepEqual(merged, [
          { name: "deploy", description: "user", argumentHint: "" },
          { name: "review", description: "project", argumentHint: "" },
        ]);
      });
      ```

- [ ] 3. Run `cd server && node --experimental-strip-types --test src/agents/skillScan.test.ts`.
      Expect: `# pass 6`, `# fail 0`.
      If `scanCommandFiles`/`scanSkillDirectories` fail before step 1's file exists, that's
      expected — reconcile by writing step 1 first per this task's ordering, then re-run.

- [ ] 4. `git add server/src/agents/skillScan.ts server/src/agents/skillScan.test.ts`
      `git commit -m "feat(server): add shared filesystem scan for commands and skills"`

**Done when:** all 6 assertions pass and `skillScan.ts` has no dependency on `db.ts` or either
provider file (pure filesystem in, `SlashCommand[]` out).

---

### Task 3: Wire the scan + disk cache into Claude

**Depends on:** Task 1, Task 2
**Files:**
- Modify: `server/src/agents/claude.ts:413-455` (the `terminalOnly`/`commandsByCwd`/`toCommands`/
  `readCommands`/`cachedCommands`/`listCommands` block), and the `claudeProvider` object literal
  around line 767

**Interfaces:**
- Consumes: `commandCache` from `./db.ts` (a sibling of `./agents/`, so `../db.ts` from
  `server/src/agents/claude.ts`), `scanCommandFiles`/`scanSkillDirectories`/`dedupeByName` from
  `./skillScan.ts`
- Produces: `warmCommands(cwd: string): Promise<void>` (new, exported for the runtime wiring in
  Task 4, and registered on `claudeProvider`)

#### Steps

- [ ] 1. In `server/src/agents/claude.ts`, add to the existing import block:
      ```ts
      import os from "node:os";
      import path from "node:path";

      import { commandCache } from "../db.ts";
      import { dedupeByName, scanCommandFiles, scanSkillDirectories } from "./skillScan.ts";
      ```
      (Check the top of the file first — `path` or `os` may already be imported for other reasons;
      if so, don't duplicate the import line, just add the missing specifier.)

- [ ] 2. Replace lines 413-455 (from `const terminalOnly = new Set<string>();` through the closing
      brace of `listCommands`) with:
      ```ts
      const terminalOnly = new Set<string>();

      function toCommands(commands: SlashCommand[]): SlashCommand[] {
        return commands
          .filter((command) => !terminalOnly.has(command.name))
          .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }))
          .sort((left, right) => left.name.localeCompare(right.name));
      }

      async function readCommands(cwd: string): Promise<SlashCommand[]> {
        const session = query({
          prompt: (async function* () {})(),
          options: {
            cwd,
            systemPrompt: { type: "preset", preset: "claude_code" },
            settingSources: ["user", "project", "local"],
          },
        });
        try {
          return toCommands(await session.supportedCommands());
        } finally {
          session.close();
        }
      }

      // Project-scope commands win a name collision; user-scope skills win one, matching how
      // Claude Code itself resolves a skill defined in both scopes.
      async function scanClaudeCommands(cwd: string): Promise<SlashCommand[]> {
        const home = os.homedir();
        const [projectCommands, userCommands, userSkills, projectSkills] = await Promise.all([
          scanCommandFiles(path.join(cwd, ".claude", "commands")),
          scanCommandFiles(path.join(home, ".claude", "commands")),
          scanSkillDirectories(path.join(home, ".claude", "skills")),
          scanSkillDirectories(path.join(cwd, ".claude", "skills")),
        ]);
        return dedupeByName([projectCommands, userCommands, userSkills, projectSkills]);
      }

      function commandCacheKey(cwd: string): string {
        return `claude:${cwd}`;
      }

      function readCommandCache(cwd: string): SlashCommand[] | null {
        const row = commandCache.get(commandCacheKey(cwd));
        return row ? (JSON.parse(row.json) as SlashCommand[]) : null;
      }

      function writeCommandCache(cwd: string, commands: SlashCommand[]): void {
        commandCache.set(commandCacheKey(cwd), JSON.stringify(commands));
      }

      // A cold live probe spawns a whole SDK session, so it always runs in the background and
      // merges into the cache rather than being awaited by a request. Claude's built-in commands
      // (/clear, /compact, ...) have no file to scan, so this is what supplies them.
      const liveRefreshes = new Map<string, Promise<void>>();
      function refreshLiveCommands(cwd: string): void {
        if (liveRefreshes.has(cwd)) return;
        const pending = readCommands(cwd)
          .then((live) => writeCommandCache(cwd, dedupeByName([readCommandCache(cwd) ?? [], live])))
          .catch((error: Error) => console.error(`[commands:claude] ${error.message}`))
          .finally(() => liveRefreshes.delete(cwd));
        liveRefreshes.set(cwd, pending);
      }

      // Populates the disk cache ahead of the first "/" — called when a thread is created.
      async function warmCommands(cwd: string): Promise<void> {
        const scanned = await scanClaudeCommands(cwd);
        if (scanned.length) writeCommandCache(cwd, dedupeByName([readCommandCache(cwd) ?? [], scanned]));
        refreshLiveCommands(cwd);
      }

      async function listCommandsCold(cwd: string): Promise<SlashCommand[]> {
        const cached = readCommandCache(cwd);
        if (cached) {
          refreshLiveCommands(cwd);
          return cached;
        }
        const scanned = await scanClaudeCommands(cwd);
        writeCommandCache(cwd, scanned);
        refreshLiveCommands(cwd);
        return scanned;
      }

      function listCommands(cwd: string): Promise<SlashCommand[]> {
        const live = [...sessions.values()].find((session) => session.cwd === cwd);
        if (!live) return listCommandsCold(cwd);
        return live.query.supportedCommands().then(toCommands).catch(() => listCommandsCold(cwd));
      }
      ```
      This removes `commandsByCwd`/`cachedCommands` entirely — every caller of `cachedCommands` in
      this file was `listCommands`, already updated above. Search the file for any other reference
      to `cachedCommands` or `commandsByCwd` and update it the same way if one turns up.

- [ ] 3. In the `claudeProvider` object literal (around line 764, alongside the existing
      `listCommands,`), add `warmCommands,` on its own line.

- [ ] 4. Run `pnpm -C server typecheck` (or `cd server && tsc --noEmit`).
      Expect: no new errors. If `os`/`path` report as unused-elsewhere or duplicate-import errors,
      resolve by merging with the existing import lines rather than adding a second one.

- [ ] 5. Verify `scanClaudeCommands` end-to-end without touching the SDK — run this ad hoc script
      (not committed) to sanity-check the scan against a throwaway directory:
      ```bash
      mkdir -p /tmp/sr03-claude-scan/.claude/commands /tmp/sr03-claude-scan/.claude/skills/review
      printf -- '---\ndescription: Ship it\nargument-hint: <env>\n---\n' > /tmp/sr03-claude-scan/.claude/commands/deploy.md
      printf -- '---\ndescription: Review a diff\n---\n' > /tmp/sr03-claude-scan/.claude/skills/review/SKILL.md
      cd server && node --experimental-strip-types -e '
        import("./src/agents/claude.ts").then(async () => {});
      '
      ```
      This module has no standalone export for `scanClaudeCommands` (it is not exported — internal
      to the cold path), so instead exercise it through the real entry point: start the dev server
      (`pnpm dev` from the repo root) with `SR03_DATA_DIR=/tmp/sr03-claude-cache`, add
      `/tmp/sr03-claude-scan` as a project, create a Claude thread on it, and in the composer type
      `/`. Expect the menu to show `deploy` (with the `<env>` argument hint) and `review` alongside
      Claude's built-ins, with no multi-second delay before the "Reading commands…" line is
      replaced. This follows CLAUDE.md's documented convention that a change to provider sessions
      is verified with a real turn against a scratch repo, not the user's real projects.

- [ ] 6. `git add server/src/agents/claude.ts`
      `git commit -m "feat(claude): scan the filesystem for commands before probing the CLI"`

**Done when:** `/` in a Claude thread on a fresh `cwd` shows scanned commands immediately, a
second `/` in the same `cwd` (or after a server restart) is served from `command_cache` without a
new SDK session, and `pnpm -C server test` and `pnpm typecheck` are both clean.

---

### Task 4: Wire the scan + disk cache into Cursor, and trigger eager warming

**Depends on:** Task 1, Task 2 (independent of Task 3 — can run in parallel)
**Files:**
- Modify: `server/src/agents/cursor.ts:475-506,1577-1646`
- Modify: `server/src/agents/cursor.test.ts`
- Modify: `server/src/agents/types.ts:62-68`
- Modify: `server/src/agents/runtime.ts:501-503`
- Modify: `server/src/api.ts:492-503`

**Interfaces:**
- Produces: `warmCommands(cwd: string): Promise<void>` on `cursorProvider`, matching Task 3's
  Claude shape; `AgentProvider.warmCommands?(cwd: string): void`; `runtime.warmCommands(providerId,
  cwd): void`

#### Steps

- [ ] 1. In `server/src/agents/cursor.ts`, `os` is already imported at line 4
      (`import os from "node:os";`) — leave that line alone. Add a new `path` import directly
      below it, and the two new module imports alongside the existing `../models.ts`/`../providers.ts`
      imports:
      ```ts
      import path from "node:path";
      ```
      ```ts
      import { commandCache } from "../db.ts";
      import { dedupeByName, scanSkillDirectories } from "./skillScan.ts";
      ```

- [ ] 2. After the existing `commandsByCwd`/`parseAvailableCommands`/`handleSessionUpdate` block
      (leave lines 475-506 untouched — that's the live-push cache, still needed), add:
      ```ts
      // Cursor has no CLI-exposed "commands" directory distinct from skills: it invokes any of
      // these as `/name`. Same four root names t3.codes' CursorSkills driver scans, under both the
      // project cwd and the user's home directory.
      const CURSOR_SKILL_ROOTS = [".cursor/skills", ".agents/skills", ".codex/skills", ".claude/skills"];

      async function scanCursorCommands(cwd: string): Promise<SlashCommand[]> {
        const home = os.homedir();
        const roots = [
          ...CURSOR_SKILL_ROOTS.map((relative) => path.join(cwd, ...relative.split("/"))),
          ...CURSOR_SKILL_ROOTS.map((relative) => path.join(home, ...relative.split("/"))),
        ];
        const lists = await Promise.all(roots.map((root) => scanSkillDirectories(root)));
        return dedupeByName(lists);
      }

      function commandCacheKey(cwd: string): string {
        return `cursor:${cwd}`;
      }

      function readCommandCache(cwd: string): SlashCommand[] | null {
        const row = commandCache.get(commandCacheKey(cwd));
        return row ? (JSON.parse(row.json) as SlashCommand[]) : null;
      }

      function writeCommandCache(cwd: string, commands: SlashCommand[]): void {
        commandCache.set(commandCacheKey(cwd), JSON.stringify(commands));
      }

      // A cold probe spawns the actual cursor-agent ACP process, so it always runs in the
      // background and merges into the cache rather than being awaited by a request.
      const liveRefreshes = new Map<string, Promise<void>>();
      function refreshLiveCommands(cwd: string): void {
        if (liveRefreshes.has(cwd)) return;
        const pending = probeCommands(cwd)
          .then((live) => {
            if (live.length) writeCommandCache(cwd, dedupeByName([readCommandCache(cwd) ?? [], live]));
          })
          .catch((error) => console.error(`[commands:cursor] ${errorMessage(error)}`))
          .finally(() => liveRefreshes.delete(cwd));
        liveRefreshes.set(cwd, pending);
      }

      // Populates the disk cache ahead of the first "/" — called when a thread is created.
      async function warmCommands(cwd: string): Promise<void> {
        const scanned = await scanCursorCommands(cwd);
        if (scanned.length) writeCommandCache(cwd, dedupeByName([readCommandCache(cwd) ?? [], scanned]));
        refreshLiveCommands(cwd);
      }
      ```

- [ ] 3. Replace the existing `listCommands` function (currently at lines ~1633-1645, the one
      reading `commandsByCwd`/`probesByCwd`) with:
      ```ts
      function listCommands(cwd: string): Promise<SlashCommand[]> {
        const pushed = commandsByCwd.get(cwd);
        if (pushed) return Promise.resolve(pushed);
        const cached = readCommandCache(cwd);
        if (cached) {
          refreshLiveCommands(cwd);
          return Promise.resolve(cached);
        }
        const known = probesByCwd.get(cwd);
        if (known) return known;
        return scanCursorCommands(cwd).then((scanned) => {
          if (scanned.length) writeCommandCache(cwd, scanned);
          refreshLiveCommands(cwd);
          return scanned;
        });
      }
      ```
      `probeCommands`, `commandsByCwd`, and `probesByCwd` themselves are unchanged — this only
      changes what `listCommands` checks before falling through to a live probe.

- [ ] 4. In the `cursorProvider` object literal (alongside the existing `listCommands,`), add
      `warmCommands,` on its own line.

- [ ] 5. In `server/src/agents/types.ts`, in the `AgentProvider` interface (lines 61-68), add after
      `listCommands(cwd: string): Promise<SlashCommand[]>;`:
      ```ts
      warmCommands?(cwd: string): void;
      ```

- [ ] 6. In `server/src/agents/runtime.ts`, alongside the existing `listCommands` export (around
      line 501), add:
      ```ts
      export function warmCommands(providerId: ProviderId, cwd: string): void {
        providerFor(providerId).warmCommands?.(cwd);
      }
      ```

- [ ] 7. In `server/src/api.ts`, in the `POST /api/threads` handler, right after
      `const thread = threads.create({...});` (around line 492) and before
      `publish({ type: "thread.updated", thread });`, add:
      ```ts
      agents.warmCommands(providerId, cwd);
      ```
      (`agents` is already imported in this file as the module exposing `listCommands`,
      `releaseThreadReservation`, etc. — confirm the import name at the top of `api.ts` and use
      whatever alias is already in use there rather than introducing a new one.)

- [ ] 8. Write the failing test first — append to `server/src/agents/cursor.test.ts`, placed near
      the two existing `listCommands` tests (`"reads Cursor commands without opening a thread"` /
      `"falls back to no commands when Cursor errors"`, around line 549) so the three read
      consecutively. `findCursor()` (`server/src/providers.ts:28`) falls back to hardcoded absolute
      paths (e.g. `~/.local/bin/cursor-agent`) even when `PATH` is cleared, so a real installed
      Cursor CLI cannot be locked out that way — instead reuse the existing `MOCK_AGENT` fixture
      (defined near the top of this file) exactly like the two neighboring tests do, so any
      background live-probe this test triggers talks to the fast, deterministic mock rather than a
      real CLI:
      ```ts
      test("reads Cursor commands from disk before any live probe", async (context) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sr03-cursor-fs-"));
        const binary = path.join(directory, "cursor-agent");
        const logPath = path.join(directory, "messages.ndjson");
        await fs.writeFile(binary, MOCK_AGENT, { mode: 0o755 });
        await fs.mkdir(path.join(directory, ".cursor", "skills", "review"), { recursive: true });
        await fs.writeFile(
          path.join(directory, ".cursor", "skills", "review", "SKILL.md"),
          "---\ndescription: Review a diff\n---\nbody",
        );

        const previousPath = process.env.PATH;
        const previousData = process.env.SR03_DATA_DIR;
        const previousLog = process.env.MOCK_CURSOR_LOG;
        process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
        process.env.SR03_DATA_DIR = path.join(directory, "data");
        process.env.MOCK_CURSOR_LOG = logPath;
        context.after(async () => {
          process.env.PATH = previousPath;
          if (previousData === undefined) delete process.env.SR03_DATA_DIR;
          else process.env.SR03_DATA_DIR = previousData;
          if (previousLog === undefined) delete process.env.MOCK_CURSOR_LOG;
          else process.env.MOCK_CURSOR_LOG = previousLog;
          await fs.rm(directory, { recursive: true, force: true });
        });

        // the mock binary is on PATH ahead of any real cursor-agent, so this only ever talks to
        // it — the scan result must still come back immediately, before that mock is ever spoken to
        const { cursorProvider } = await import("./cursor.ts");
        const commands = await cursorProvider.listCommands(directory);
        assert.deepEqual(commands, [{ name: "review", description: "Review a diff", argumentHint: "" }]);
      });
      ```

- [ ] 9. Run `cd server && node --experimental-strip-types --test src/agents/cursor.test.ts`.
      Expect: FAIL before step 2/3 are applied (`scanCursorCommands` doesn't exist / old
      `listCommands` tries to reach the missing binary and returns `[]` instead of the skill). If
      it fails with a syntax/import error instead, fix the import before re-running.

- [ ] 10. Re-run the same command after steps 1-4 are in place.
       Expect: all tests in the file pass, including the two pre-existing ones and the new one —
       check the summary line for `# fail 0`.

- [ ] 11. Run `pnpm -C server test && pnpm typecheck`.
       Expect: full server suite green, no new typecheck errors.

- [ ] 12. Manually verify the eager-warm wiring per CLAUDE.md's scratch-repo convention: create a
       scratch repo, add `.cursor/skills/review/SKILL.md` to it (same content as step 8's), add it
       as a project, create a Cursor thread on it, and type `/` immediately. Expect `review` to
       appear without a "Reading commands…" flash, since `warmCommands` ran at thread-creation time
       in step 7 and the "/" only ever needed to read `/api/commands`.

- [ ] 13. `git add server/src/agents/cursor.ts server/src/agents/cursor.test.ts server/src/agents/types.ts server/src/agents/runtime.ts server/src/api.ts`
       `git commit -m "feat(cursor): scan the filesystem for skills and warm the cache eagerly"`

**Done when:** Task 8-11's automated tests are green, and the manual check in step 12 shows no
"Reading commands…" flash for a freshly created thread whose cwd already has a scannable skill.

## Risks
- **`readCommands`/`probeCommands` still run on every cold `warmCommands` call.** This plan does
  not remove the live-CLI cost — it moves it off the request path. A project with hundreds of
  threads all opened at once would still fire that many background SDK sessions / ACP subprocesses
  concurrently. If that turns out to matter in practice, a follow-up could rate-limit or dedupe
  `warmCommands` across threads sharing a `cwd` (the `liveRefreshes`/`probesByCwd` maps already
  dedupe *within* one provider module's lifetime, but not across a burst of near-simultaneous
  thread creations before the first one's promise is registered — check this if it comes up).
- **Hand-rolled frontmatter parser diverges from the real YAML Claude Code/Cursor use** for any
  skill relying on nested structure (e.g. Cursor's `metadata.surfaces` scoping). Such a skill would
  still show up (from the fs scan) even if the real CLI would hide it, until the background live
  probe corrects the cache. Acceptable per the spec's constraint favoring no new dependency; call
  this out to the user if a specific skill misbehaves.
- **`command_cache` never expires or gets invalidated on file changes.** A command file edited or
  deleted after the first scan won't be reflected until the next `warmCommands` call for that
  `cwd` (next thread creation) or a `listCommandsCold` cache-miss (which won't happen once cached).
  Out of scope per the spec's non-goals, but worth flagging if the user expects live-editing support.
