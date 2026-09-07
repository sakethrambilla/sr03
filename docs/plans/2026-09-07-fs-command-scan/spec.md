# Fast slash-command / skill listing

## Problem
Today, the first time a user types `/` in a thread's composer for a given
`(provider, cwd)` pair, sr03 has to boot a whole live agent to answer "what
commands exist here": for Claude it spins up a fresh Agent SDK session just to
call `supportedCommands()`, and for Cursor it spawns the actual `cursor-agent
acp` subprocess and waits (up to 45s) for a pushed notification. The result is
only cached in memory for the life of the server process, so every restart,
every new project, and every new worktree pays this cold-start cost again. By
contrast, t3.codes answers the same question instantly by scanning the
filesystem locations Claude Code and Cursor already read their commands and
skills from, precomputing that scan ahead of time, and persisting the result
to disk.

## Goal
Typing `/` in any thread shows a non-empty, usable command list within one
render frame when a cache exists, by discovering commands/skills through a
filesystem scan first, computed eagerly per `(provider, cwd)` and persisted to
disk, with the existing live-CLI probe kept only as a fallback that fills in
what the filesystem can't see (e.g. Claude's built-in commands) and refreshes
the cache in the background.

## Non-goals
- No changes to how commands are *executed* once picked — only how the list
  is *discovered and displayed*.
- No change to the `/api/commands` request/response shape or the
  `SlashCommand` wire type (`name`, `description`, `argumentHint`).
- No removal of the existing live-probe code paths (`readCommands` in
  claude.ts, `probeCommands` in cursor.ts) — they remain as the fallback/
  enrichment source, not dead code.
- No client-side UI redesign of the command menu or the "Reading commands…"
  state; if the cache makes that state disappear in practice, that's a side
  effect, not a requirement of this work.
- No new push notification when a background live-probe refresh finds
  commands after a client already has a (fs-scanned) list in hand — the
  refreshed list only takes effect on that `cwd`'s next `GET /api/commands`.
  A thread with an actual live session open is unaffected: it already gets
  `thread.commands` pushed via that session's own init handshake, unchanged.
- No attempt to scan for MCP-server-provided or dynamically-registered
  commands that don't correspond to a file on disk.
- No cross-machine or cross-user cache sharing — the cache is local to one
  sr03 server instance's SQLite database, same as `usage`.

## Behaviour
When a project or worktree is opened (a thread is created, or an existing
thread's cwd is first touched), sr03 kicks off a background scan of that
provider's known command/skill directories for that `cwd` and writes the
result to a small on-disk cache, without blocking anything the user is doing.

When the user later types `/` in the composer:
- If a cache entry exists for `(providerId, cwd)`, it is returned immediately
  — no process spawn, no network wait beyond the existing `/api/commands`
  round trip which is now serving cached/scanned data.
- If no cache entry exists yet (first-ever request for that pair, e.g. right
  after a fresh checkout with no prior background scan), the filesystem scan
  runs synchronously as part of that request — still no CLI/ACP spawn — and
  its result is returned and cached.
- Independently of the filesystem answer, sr03 continues to fall back to the
  existing live-CLI probe to pick up anything the filesystem can't express
  (Claude's built-in commands like `/clear`, `/compact`, which aren't files).
  That probe now runs in the background rather than gating the response, and
  when it completes, its result is merged with the filesystem result and
  written to the cache, so the *next* `/api/commands` read for that
  `(providerId, cwd)` sees the full list. A thread whose live session is
  already open keeps getting `thread.commands` pushed the way it does today,
  unchanged, via that session's own init handshake — this plan does not add a
  new push path for a thread with no live session, since there is no open
  socket audience for it to reach until that thread's session starts anyway.
- If both the filesystem scan and the live probe fail or find nothing, the
  command list is empty, matching today's failure behavior.

## Acceptance criteria
1. When a thread is created for a `(providerId, cwd)` pair that has never
   been scanned before, the server starts a filesystem scan for that pair
   without waiting for the client to type `/`.
2. When the user types `/` and a disk cache entry already exists for that
   `(providerId, cwd)`, `GET /api/commands` returns that cached list without
   spawning a Claude SDK session or a `cursor-agent acp` process.
3. When the user types `/` and no disk cache entry exists yet, `GET
   /api/commands` returns a filesystem-scanned list (possibly empty) without
   blocking on a live CLI/ACP round trip, and does not error.
4. When a `.claude/commands/*.md` file or a `.claude/skills/*/SKILL.md` file
   exists under the project root or the user's `~/.claude` directory, its
   name, description, and (for commands) argument hint appear in the returned
   list, matching what the live Claude CLI would report for that entry.
5. When the equivalent Cursor on-disk command source (identified during
   planning/research) contains an entry, it appears in the returned list the
   same way.
6. When the background live-probe fallback later completes and finds
   commands the filesystem scan missed (e.g. Claude built-ins), those are
   merged into the cached list without duplicating names already found by the
   filesystem scan, so the next `GET /api/commands` for that `(providerId,
   cwd)` includes them. (Pushing that update to a client already showing a
   stale list is out of scope — see Non-goals.)
7. When the filesystem scan finds nothing and the live probe also fails
   (e.g. the CLI binary is missing), `GET /api/commands` returns
   `{ commands: [] }`, same as today, and does not throw.
8. When the server restarts, a `(providerId, cwd)` pair that was scanned
   before the restart still answers from the disk cache on the first request
   after restart, without re-running a live probe first.

## Constraints
- Must not add a new runtime dependency beyond what's already used for YAML/
  frontmatter parsing needs (check if one exists in the repo already; if not,
  a minimal hand-rolled frontmatter parser is preferred over adding a
  dependency, consistent with the project's "Node built-ins... reuse what's
  here" convention).
- Persistence must go through the existing `server/src/db.ts` SQLite layer
  (matching the `usage` table's key/blob idiom), not a new raw JSON file —
  there is no existing on-disk JSON cache convention in this codebase to
  extend.
- The wire type `SlashCommand { name, description, argumentHint }` in
  `server/src/types.ts` and `web/src/lib/types.ts` must stay identical and
  in sync; if it needs a new field it must be added to both files.
- Must work for both a bare project root and a git worktree path as `cwd`
  (threads are not always worktrees — see `isWorktree` in the thread schema).

## Open questions
- Where does the Cursor CLI (`cursor-agent`) actually keep user/project
  custom commands on disk, if anywhere? Proceeding on the assumption that
  this is unknown today and needs a research task before implementation can
  start on the Cursor side; the plan below front-loads that research as its
  first task so it can invalidate or confirm the approach before the Claude
  work is mirrored onto Cursor.
- Whether Cursor's built-in (non-custom) commands are even file-discoverable
  at all, or whether Cursor's `listCommands` must keep relying entirely on
  the live ACP probe with only the disk *cache* (not a filesystem *scan*)
  speeding up the repeat case. Proceeding on the assumption that the research
  task's finding determines this, and the plan accommodates either outcome.
