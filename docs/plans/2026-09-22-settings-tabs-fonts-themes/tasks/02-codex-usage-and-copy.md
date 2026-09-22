# Task 02 — Codex usage scoping and subagent copy

Fixes spec criteria 21 and 22.

Adds no tests. Both counts stay at server 62 (after Task 01) and web 51.

## Background

### Usage is a module global

`server/src/agents/codex.ts` declares `let lastUsage: Usage = EMPTY_USAGE;` at `:119`
(`EMPTY_USAGE` is at `:105`), writes it at `:417` and emits it on the session at `:418`, and reads
it at `:401` and `:1222`.

`readUsage` at `codex.ts:1221` is:

```ts
async function readUsage(): Promise<Usage> {
  return lastUsage;
}
```

It declares **no parameter at all** — TypeScript permits this against the interface. The interface
in `server/src/agents/types.ts:67` is:

```ts
readUsage(threadId: string | null): Promise<Usage>;
forkSession?(sessionId: string, cwd: string): Promise<string>;
forgetThread?(threadId: string): void;
```

So `readUsage` must return `Promise<Usage>` — **not** `Promise<Usage | null>`. When a thread has no
snapshot, return `EMPTY_USAGE`, the same value `lastUsage` is initialised to. Do not widen the
interface; Claude and Cursor implement it too. `forgetThread` is optional and Codex does not
implement it; Claude does, at `claude.ts:822`.

The catalog declares `usage: true` for Codex (`server/src/models.ts:173`), and that stays true —
the app-server exposes real account-wide rate limits. What it does not expose is per-thread context
or cost, so those staying null is correct. The fix is to stop serving one thread's snapshot to
another and to stop serving a deleted thread's snapshot at all.

### Subagent copy is Cursor's

`web/src/components/SubagentView.tsx:37` defines `CursorCard({ task, now })`, whose body hardcodes
at `:52`:

> Cursor reports that a subagent ran, but does not publish what it did. Its result is folded into
> the reply above.

It is rendered at `:136` whenever `provider.capabilities.subagentTranscripts` is false, which
includes Codex — so a Codex collab task card claims Cursor ran it. The file's header comment at
`:1-2` names Cursor in the same way and is equally wrong.

`CursorCard` receives only `task` and `now`. It does **not** receive the thread or the provider —
a new prop is required. The call site at `:136` already has `provider` in scope (it is the same
object being tested at `:127`), so the value is available without threading anything new down.
`EMPTY_PROVIDER` is imported from the store at `:8`; check what `provider` is and what field
carries its display label before writing the prop.

## Steps

1. Read `server/src/agents/codex.ts` at `:100-125` (`EMPTY_USAGE`, `lastUsage`), `:395-420`
   (`parseUsage` and the rate-limit read that writes and emits), and `:1215-1230` (`readUsage`).
2. Read `server/src/agents/claude.ts:250-295` and `:815-830` to see how per-thread usage is stored
   and cleared. Match that shape.
3. Read `server/src/agents/types.ts:62-70` to confirm the exact `readUsage` and `forgetThread`
   signatures before changing anything.
4. Replace the module-global `lastUsage` with a per-thread map keyed by thread id. At the write
   site (`:417`) the session is in scope — use its thread id as the key. Keep emitting on the
   session as it does today.
5. Change `readUsage` to take `threadId: string | null` and return that thread's entry, falling
   back to `EMPTY_USAGE` when there is none, and when `threadId` is null. The return type stays
   `Promise<Usage>`.
6. Check the other read at `:401` — it currently falls back to `lastUsage` inside `parseUsage`.
   Decide what it should fall back to now that there is no single global, and make it explicit.
7. Implement `forgetThread(threadId: string): void` on the Codex adapter, deleting that thread's
   map entry. Match Claude's signature exactly and register it the same way Claude does.
8. Run `pnpm typecheck` — exit 0, no output.
9. Read `web/src/components/SubagentView.tsx` in full.
10. Rename `CursorCard` to something provider-neutral — `NoTranscriptCard` or similar — and give it
    a prop carrying the provider's display label. Pass it from the call site at `:136` using the
    `provider` already in scope there.
11. Rewrite the sentence at `:52` to use that label, so it reads correctly for any provider:
    `` `${label} reports that a subagent ran, but does not publish what it did. Its result is folded
    into the reply above.` ``
12. Update the file's header comment at `:1-2`, which currently says "Cursor gets a card, because
    its protocol never publishes a child stream" — that is now true of two providers.
13. If a store selector is needed for the label, remember the zustand rule: a selector must never
    return a fresh object or array. `NO_TASKS` at `:13` and `EMPTY_PROVIDER` from the store are the
    existing module-level constants used for exactly this reason.
14. Run `pnpm typecheck` and `pnpm test`.

## Verification

```bash
pnpm typecheck && pnpm test
```

Expected: `typecheck` exits 0 with no output. Two summaries: server `tests 62 / pass 62 / fail 0`,
web `tests 51 / pass 51 / fail 0` — unchanged from Task 01.

Live check with `pnpm dev` against `/tmp/sr03-repo`:

| Check | Expected |
|---|---|
| Two Codex threads, a turn run in each, usage meter open on each | Figures belong to the thread being viewed, not carried over from the other |
| Delete one of them, open the other | No figures from the deleted thread |
| A brand-new Codex thread, before any turn | Empty usage, not the previous thread's numbers |
| Codex prompt producing a collab task card (e.g. `Use a subagent to summarise README.md`), task tab opened | Copy names **Codex** |
| The same on a Cursor thread | Copy still names **Cursor** |
| A Claude thread's subagent tab | Still renders the full `Timeline`, not the card |

## Do not

- Do not set `capabilities.usage` to false for Codex — rate limits are real data and the meter
  should keep showing them.
- Do not fabricate per-thread context or cost. `context` and `sessionCostUsd` staying null for
  Codex is correct.
- Do not widen `readUsage`'s return type to `Usage | null` — that breaks Claude and Cursor.
- Do not edit `claude.ts` or `cursor.ts`.
