# Task 01 — Codex turn lifecycle

Fixes spec criteria 19 and 20.

Raises the **server** test count from 60 to 62. The web count (51) is untouched.

## Background

`server/src/agents/codex.ts` tracks the in-flight turn on `session.activeTurn` (an `ActiveTurn`
with `text`, `finished` and related fields). Two bugs live in that lifecycle.

### 1. The assistant-message latch fires per message, not per turn

`finishAssistant` at `codex.ts:539`:

```ts
function finishAssistant(session: CodexNativeSession, turn: ActiveTurn, emit: boolean): void {
  if (turn.finished) return;
  turn.finished = true;
  if (turn.text && emit) session.emit({ type: "assistant.complete", text: turn.text });
  turn.text = "";
}
```

`handleItemCompleted` (starts `codex.ts:675`) calls it at `codex.ts:691`, on **every** `agentMessage`
completed item. After the first message of a turn `turn.finished` is already `true`, so:

- the reconciliation guard at `codex.ts:682` — `if (turn && !turn.finished && text && text !== turn.text)`
  — is skipped, so the `text.startsWith(prefix)` catch-up at `codex.ts:684` never runs, and
- `finishAssistant` returns at its first line without emitting.

`appendMessage` (`codex.ts:546`) still emits `assistant.delta`, so the text appears live. But
`runtime.ts` clears `session.partial` at `turn.completed` without `keepPartial`, so it is gone on
reload.

**The invariant to restore:** exactly one `assistant.complete` per completed agent message, and
`turn.finished` set exactly once, at turn end — not at message end.

Cursor holds this invariant: `cursor.ts:1127` calls `finishAssistant` once, from the turn-end path.

### 2. A failed turn with no error message completes silently

`handleTurnCompleted` at `codex.ts:712-734` has a `status === "interrupted"` branch and an `else`
branch that emit the identical `{ type: "turn.completed" }`, and a `status === "failed"` carrying
no `error.message` falls through to a clean completion.

### Not in this task

Plan deltas are **not** being changed. `item/plan/delta` at `codex.ts:757` folds plan text into the
reply, and Cursor's `appendPlan` (`cursor.ts:302-310`) does the same thing deliberately — it calls
`appendAssistant`, using `turn.plans` (a `Set<string>`, `cursor.ts:79`) only to de-duplicate and a
`force` flag to gate folding once the reply has started. Codex is consistent with its sibling here.
See the spec's Open Questions.

## Steps

1. Read `server/src/agents/codex.ts` in full — at minimum the `ActiveTurn` type, `finishAssistant`
   (`:539`), `appendMessage` (`:546`), `handleItemCompleted` (`:675`), `handleTurnCompleted`
   (`:712`), and the `turn/start` caller that creates the turn.
2. Read `server/src/agents/cursor.ts:1115-1140` — the turn-end paths (success, interrupt, error) and
   where each calls `finishAssistant`. This is the shape to match.
3. Read `server/src/agents/runtime.ts:250-285` to confirm how `turn.completed` clears
   `session.partial` and what `keepPartial` does.
4. **Enumerate the turn-end paths in `codex.ts` before changing anything.** Write them down: normal
   completion, interrupt, and process error/crash. You will need each of them in step 6.
5. **Message-end change.** In `handleItemCompleted`'s `agentMessage` branch:
   - Drop the `!turn.finished` term from the guard at `:682`. That term was the latch symptom.
   - Where the branch currently calls `finishAssistant(session, turn, true)` at `:691`, instead
     complete just this message: emit `{ type: "assistant.complete", text: turn.text }` when
     `turn.text` is non-empty, then reset `turn.text = ""`. Do **not** touch `turn.finished`.
   - Leave the `else if (text) session.emit({ type: "assistant.complete", text })` fallback for the
     no-active-turn case as it is.
   - Factor the emit-and-reset into a small named helper rather than inlining it in two places, if
     that reads better — the invariant matters, the exact arrangement does not.
6. **Turn-end change.** Ensure `finishAssistant(session, turn, …)` is called on **every** path
   enumerated in step 4, so a turn whose final message never produced a completed item still
   flushes its tail. `handleTurnCompleted:714` already calls it; check the interrupt and crash
   paths and add the call where it is absent. `emit` is `false` on the interrupt/intentional-close
   path, matching `cursor.ts:1131`.
7. Run `pnpm test`. Server should still report `tests 60`, `pass 60`, `fail 0`.
8. **Failed-turn change.** In `handleTurnCompleted`, collapse the duplicate `interrupted` and `else`
   branches into one, and make `status === "failed"` emit an error even when `error.message` is
   absent, using a fixed fallback string such as `"Codex turn failed"`. Match how `cursor.ts`
   surfaces a failed turn — find it before writing this.
9. Run `pnpm typecheck`. Expect exit 0, no output.
10. Open `server/src/agents/codex.test.ts` and read the existing 8 cases to learn the fixture style
    — how a fake app-server is driven and how emitted events are collected.
11. Add a test: drive two `agentMessage` item/completed notifications inside one turn, and assert
    **two** `assistant.complete` events are emitted, carrying the two texts in order.
12. Add a test: drive a `turn/completed` with `status: "failed"` and no `error.message`, and assert
    an error event is emitted rather than a bare `turn.completed`.
13. Run `pnpm test`. Server must report `tests 62`, `pass 62`, `fail 0`; web unchanged at
    `tests 51`, `pass 51`, `fail 0`.
14. Re-read the comments in every function touched and correct any the change made false — in
    particular any comment describing the completed payload as "the full message", and the
    `// completed payload is the full message; deltas already streamed the prefix` comment at
    `codex.ts:683`, which is about the guard you just changed.

## Verification

```bash
pnpm typecheck && pnpm test
```

Expected: `typecheck` exits 0 with no output. `pnpm test` prints two summaries — server
`tests 62 / pass 62 / fail 0`, then web `tests 51 / pass 51 / fail 0`.

Then a live check. In one shell:

```bash
mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main && echo hello > README.md && git add . && git commit -qm init
```

In another, from the repo root run `pnpm dev`, open `http://localhost:5399`, add `/tmp/sr03-repo`
as a project, create a Codex thread, and send a prompt that reliably produces two separate
assistant messages — for example: `Write a haiku about git in one message, then send a second,
separate message with a haiku about merge conflicts.`

Expected: both haikus visible in the transcript; **reload the page and both are still there.**
Before the fix, only the first survives — that difference is the test.

Then confirm nothing regressed on the single-message path: send an ordinary one-message prompt,
reload, confirm the reply is intact. Interrupt a turn mid-stream and confirm the partial reply is
handled as it was before.

## Do not

- Do not change plan-delta handling. See Background → Not in this task.
- Do not add subagent transcripts, `stopTask`, or per-thread cost — the Codex protocol does not
  expose them and they are explicitly out of scope.
- Do not touch `claude.ts` or `cursor.ts`. Read them; do not edit them.
- Do not change `runtime.ts`'s `keepPartial` semantics to work around the latch — fix the latch.
