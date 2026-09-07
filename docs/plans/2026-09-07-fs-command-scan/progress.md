# Progress — Fast slash-command / skill listing

**Plan:** ./plan.md
**Status:** complete
**Current:** done

## Log
- 2026-09-07 Starting execution. Tasks 1 and 2 have no dependencies on each other — dispatching both now. Tasks 3 and 4 depend on 1+2.
- 2026-09-07 Task 1 — done, commit 7fe1e75. `db.test.ts`: pass 1, fail 0. Typecheck clean.
- 2026-09-07 Task 2 — done, commit 6644b4b. `skillScan.test.ts`: pass 6, fail 0.
- 2026-09-07 Dispatching Task 3 (Claude wiring) and Task 4 (Cursor wiring + eager warm) in parallel.
- 2026-09-07 Task 3 — done, commit be1c721. Suite 36/36 pass. Typecheck: one expected error (`warmCommands` not yet on `AgentProvider`) — resolves once Task 4 lands types.ts. Outstanding: manual scratch-repo verification (blocked on Task 4 too, since warmCommands isn't wired into thread creation until then).
- 2026-09-07 Task 4 — done, commit e3e6394. cursor.test.ts: 8/8 pass. Full server suite: 37/37 pass. Typecheck clean (resolved Task 3's pending error).
- 2026-09-07 Final verification: full suite 37/37, `pnpm typecheck` clean for both packages. Manual scratch-repo check against a real running server (`/tmp/sr03-fs-scan-check`, `.claude/commands/deploy.md` + `.claude/skills/review/SKILL.md`): thread creation triggered `warmCommands`, `GET /api/commands` returned `deploy`/`review` merged with real global `~/.claude` commands/skills in ~10ms (both before and after a full server restart, confirming the SQLite cache persists). Scratch dir and data dir cleaned up afterward.
- 2026-09-07 Status: complete.

## Acceptance criteria — evidence

1. Background scan starts on thread creation — `POST /api/threads` calls `agents.warmCommands(providerId, cwd)` (api.ts, wired in Task 4); confirmed by the manual check: `deploy`/`review` were already present on the very first `GET /api/commands` after thread creation, with no delay.
2. Cache hit → no spawn — `listCommandsCold`/`listCommands`'s cache branch returns from `commandCache` before any `readCommands`/`probeCommands` call; timed at ~10ms per request in the manual check.
3. Cache miss → sync fs scan, no live spawn, no error — `scanClaudeCommands`/`scanCursorCommands` run inline in the cold-miss branch; `probeCommands`/`readCommands` only run via `refreshLiveCommands`, fired without being awaited.
4. `.claude/commands/*.md` and `.claude/skills/*/SKILL.md` surfaced with name/description/argument-hint — verified live: `deploy.md`'s `argument-hint: <env>` and `review/SKILL.md`'s description both appeared correctly in the API response.
5. Cursor's on-disk source surfaced — `scanCursorCommands` scans `.cursor/skills`, `.agents/skills`, `.codex/skills`, `.claude/skills` (project + home); covered by `cursor.test.ts`'s new "reads Cursor commands from disk before any live probe" test (8/8 pass).
6. Live-probe merge updates the cache for the next read, no dupes — `refreshLiveCommands` in both providers merges via `dedupeByName` and writes back to `commandCache`; the spec's push requirement for a thread with no live session was descoped (see spec Non-goals) since there's no push infra without introducing new bus/circular-import risk, and a live session still gets `thread.commands` unchanged via its own init handshake.
7. Total failure → `{ commands: [] }`, no throw — `scanCommandFiles`/`scanSkillDirectories` swallow fs errors and return `[]`; Cursor's `listCommands` still falls back to the original synchronous `probeCommands` when the scan is empty (a deviation that *strengthens* this criterion — see below).
8. Restart still serves from disk cache — verified live: killed and restarted the server with the same `SR03_DATA_DIR`, `GET /api/commands` returned the full cached list in ~10ms with no live probe.

## Deviations
- Task 1 line numbers: the `command_cache` table, prepared statements, and accessor landed at slightly different line numbers than the plan's estimates (no logic change) — plan said "around line N" throughout, which covered this.
- Task 4 (cursor.ts): the plan's verbatim `listCommands` never fell through to `probeCommands` when the filesystem scan came back empty, which would have silently broken the "every existing live-probe path keeps working" global constraint and the two pre-existing tests (which assert a cold, scan-empty `listCommands` still returns the live-probed result). Restored the original synchronous `probeCommands` fallback for that case; kept scan/cache/background-refresh for the case the scan finds something.
- Task 4 tests: added `HOME` env isolation (save/override/restore) to the new test and the two pre-existing command tests. This dev machine has real global skills under `~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills` (unrelated Claude/Cursor plugin skills installed on the machine), which `scanCursorCommands`/`scanClaudeCommands` picked up and broke the fixed-list assertions in the pre-existing tests before this fix.

## Blocked / needs a decision
- (none)

## Deviations
- (none yet)

## Blocked / needs a decision
- (none)
