# Task 2: Claude subagent output is routed to its task

**Depends on:** Task 1 (for `ThreadTask.model` and the `"stopped"` status)

**Files:**
- Modify: `server/src/agents/types.ts` — optional `taskId` on five `AgentEvent` variants
- Modify: `server/src/types.ts` — `thread.task.delta` and `thread.task.delta.end` server events
- Modify: `web/src/lib/types.ts` — the same two, mirrored
- Modify: `server/src/agents/claude.ts` — `forwardSubagentText`, correlation map, stamping
- Modify: `server/src/agents/runtime.ts` — route stamped events; close task streams at turn end

**Interfaces:**
- Consumes: `parent_tool_use_id` (non-null inside a subagent) and `task_started.tool_use_id`.
- Produces: messages persisted with `meta.taskId`, plus
  `{ type: "thread.task.delta"; threadId; taskId; text }` and
  `{ type: "thread.task.delta.end"; threadId; taskId }`.

## Notes before starting

`forwardSubagentText` defaults to false, and with it off the SDK forwards only the subagent's
`tool_use` / `tool_result` blocks — enough for the existing counters, not enough for a transcript.
Turning it on is what makes this task's output non-empty.

**`parent_tool_use_id` is not a property of `SDKMessage`.** `SDKMessage` is a ~38-member union and
only five members carry the field, so `message.parent_tool_use_id` at the top of `handleMessage`
does not compile — `Property 'parent_tool_use_id' does not exist on type 'SDKResultSuccess'`. Read
it inside each `case` that has it.

**There are four emit sites across three cases**, and missing any one produces a plausible-looking
half-feature:

| `case` | line | emits |
|---|---|---|
| `stream_event` | ~533 | `phase` **and** `assistant.delta` |
| `assistant` | ~546 | `assistant.complete` **and** `tool.started` |
| `user` | ~560 | `tool.completed` |

`tool_use_id` is optional on `task_started`. When it is absent the map has no entry, and a message
whose `parent_tool_use_id` is unmapped must fall through to today's behaviour — the main transcript
— never be dropped.

Do **not** try to remove entries from the correlation map when a task settles.
`SDKTaskUpdatedMessage` carries `task_id` and `patch` only, with no `tool_use_id`, so there is
nothing to key the removal on. The map grows by one entry per subagent per session, which is fine.

## Steps

- [ ] 1. In `server/src/agents/types.ts`, add `taskId?: string` to the `phase`, `assistant.delta`,
      `assistant.complete`, `tool.started` and `tool.completed` variants of `AgentEvent`.

- [ ] 2. In `server/src/types.ts`, add to `ServerEvent`:
      `| { type: "thread.task.delta"; threadId: string; taskId: string; text: string }`
      `| { type: "thread.task.delta.end"; threadId: string; taskId: string }`
      Mirror both into `web/src/lib/types.ts`.

- [ ] 3. In `server/src/agents/claude.ts`, add `forwardSubagentText: true` to the options object at
      line ~651, beside `includePartialMessages`.

- [ ] 4. In the same file, add `subagentTasks: Map<string, string>` (tool_use_id → task_id) to the
      session state and initialise it empty. In `trackTask`'s `task_started` branch (line ~124),
      when `message.tool_use_id` is a string, record
      `session.subagentTasks.set(message.tool_use_id, message.task_id)`.

- [ ] 5. Add a helper beside `trackTask`:
      ```ts
      function taskOf(session: ClaudeSession, parentToolUseId: string | null | undefined): string | undefined {
        return parentToolUseId ? session.subagentTasks.get(parentToolUseId) : undefined;
      }
      ```

- [ ] 6. In the `stream_event` case (line ~533), call
      `const taskId = taskOf(session, message.parent_tool_use_id)` and spread
      `...(taskId ? { taskId } : {})` into the `phase` emits and the `assistant.delta` emit.

- [ ] 7. In the `assistant` case (line ~546), do the same for the `assistant.complete` and
      `tool.started` emits. In the `user` case (line ~560), do the same for the `tool.completed`
      emit — `message.parent_tool_use_id` is on `SDKUserMessage`, so it narrows here too.

- [ ] 8. At `handleMessage`'s top (line ~516), leave `turn.active` firing for `assistant` and
      `stream_event` **only when the message has no `parent_tool_use_id`**. A subagent's frames
      must not re-mark the parent turn active. Narrow with
      `"parent_tool_use_id" in message && message.parent_tool_use_id` rather than a bare property
      read, for the same union reason as above.

- [ ] 9. In `server/src/agents/runtime.ts`, add `taskPartials: Map<string, string>` to
      `ManagedSession` (beside `toolMessages`) and initialise it empty.

- [ ] 10. In `handleEvent`, handle the stamped variants:
       - `phase` (line ~179) — when `event.taskId` is set, **return without publishing**. Per-task
         phase is not rendered anywhere in this plan, and publishing it would overwrite the
         parent's `phaseByThread`.
       - `assistant.delta` (~182) — when set, append to `session.taskPartials`, publish
         `thread.task.delta`, and return **without touching `session.partial`**.
       - `assistant.complete` (~186) — when set, publish `thread.task.delta.end`, clear that task's
         `taskPartials` entry, and `appendMessage(threadId, "assistant", event.text, { taskId })`
         behind the same `if (event.text.trim())` guard the existing line uses. Do not publish
         `thread.delta.end` and do not clear `session.partial`.
       - `tool.started` (~191) — when set, add `taskId: event.taskId` to the meta object.
       - `tool.completed` — no change; it resolves through `session.toolMessages` by `callId`, and
         `attachResult` writes back to whichever message that is.

- [ ] 11. In the same file, add:
       ```ts
       function endTaskStreams(session: ManagedSession): void
       ```
       which, for each entry in `session.taskPartials`, persists a trimmed non-empty partial as
       `appendMessage(threadId, "assistant", partial, { taskId, partial: true })`, publishes
       `thread.task.delta.end` for that task, and clears the map. Call it from `turn.completed`
       (line ~232) beside the existing `keepPartial` handling. Without this, a subagent stopped
       mid-sentence leaves an orphan tail in the client's buffer for the life of the session and
       its text is never persisted — which is what spec criterion 5 turns on.

- [ ] 12. Run `pnpm typecheck`. Expect: PASS. Run `pnpm test`. Expect: PASS, no new failures —
       no existing test exercises subagents, so this is a regression check, not a proof.

- [ ] 13. Start the app: `pnpm dev`. Add `/tmp/sr03-repo` as a project, create a Claude thread, and
       send: `Use the Explore subagent to list every file in this repo and report what it found.`
       Wait for the turn to finish.

- [ ] 14. Confirm in the UI that the agents panel shows a subagent row; that the main transcript
       does **not** contain the subagent's file listing, only the parent's summary of it; and that
       the waiting label under the composer never named a tool the subagent was running. Subagent
       messages disappearing with no tab yet to read them in is the expected state here.

- [ ] 15. Assert on the database that the messages exist and are stamped:
       `sqlite3 ~/.sr03/sr03.db "select count(*) from messages where json_extract(meta,'\$.taskId') is not null;"`
       Expect: a number greater than 0. If it is 0 while the panel showed a row, the correlation
       map is empty — check whether `task_started` carried `tool_use_id` before changing anything
       else.

- [ ] 16. `git add server/src/agents/types.ts server/src/types.ts web/src/lib/types.ts server/src/agents/claude.ts server/src/agents/runtime.ts`
       `git commit -m "feat(claude): route subagent output to its task"`

## Done when

A Claude turn that spawns a subagent persists that subagent's messages with `meta.taskId`, they no
longer appear in the parent's transcript, the parent's own streaming text and waiting label are
unaffected, no task stream is left open after the turn ends, and the sqlite count in step 15 is
greater than zero.
