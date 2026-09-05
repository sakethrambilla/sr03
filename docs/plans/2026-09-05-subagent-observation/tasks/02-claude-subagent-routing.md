# Task 2: Claude subagent output is routed to its task

**Depends on:** Task 1 (for `ThreadTask.model`)

**Files:**
- Modify: `server/src/agents/types.ts` — optional `taskId` on four `AgentEvent` variants
- Modify: `server/src/types.ts` — `thread.task.delta` and `thread.task.delta.end` server events
- Modify: `web/src/lib/types.ts` — the same two, mirrored
- Modify: `server/src/agents/claude.ts` — `forwardSubagentText`, correlation map, stamping
- Modify: `server/src/agents/runtime.ts` — route stamped events to `meta.taskId` and task deltas

**Interfaces:**
- Consumes: `SDKMessage.parent_tool_use_id` (non-null inside a subagent) and
  `task_started.tool_use_id` (the Agent tool call that spawned it).
- Produces: messages persisted with `meta.taskId`, plus
  `{ type: "thread.task.delta"; threadId; taskId; text }` and
  `{ type: "thread.task.delta.end"; threadId; taskId }`.

## Notes before starting

`forwardSubagentText` defaults to false, and with it off the SDK forwards only the subagent's
`tool_use` / `tool_result` blocks — enough for the existing counters, not enough for a transcript.
Turning it on is what makes this task's output non-empty.

**`stream_event` carries `parent_tool_use_id` too**, and sr03 sets `includePartialMessages: true`
([claude.ts:651](../../../server/src/agents/claude.ts:651)). Handling `assistant` but not
`stream_event` leaves the child's text streaming into the parent's composer, which looks like
duplicated text rather than a routing bug. Both are handled in step 3.

`tool_use_id` is optional on `task_started`. When it is absent the map has no entry, and a message
whose `parent_tool_use_id` is unmapped must fall through to today's behaviour — the main transcript
— never be dropped.

## Steps

- [ ] 1. In `server/src/agents/types.ts`, add `taskId?: string` to the `assistant.delta`,
      `assistant.complete`, `tool.started` and `tool.completed` variants of `AgentEvent`.

- [ ] 2. In `server/src/agents/claude.ts`, add `forwardSubagentText: true` to the options object at
      line ~651, beside `includePartialMessages`. Add a `subagentTasks: Map<string, string>`
      (tool_use_id → task_id) to the session state, and in `trackTask`'s `task_started` branch
      (line ~124) record `message.tool_use_id → message.task_id` when `tool_use_id` is present.
      Clear the entry in the `task_updated` branch once the task reaches a settled status.

- [ ] 3. In `handleMessage` (line ~515), read `const taskId = message.parent_tool_use_id ?
      session.subagentTasks.get(message.parent_tool_use_id) : undefined` at the top, and pass
      `...(taskId ? { taskId } : {})` into every `assistant.delta`, `assistant.complete`,
      `tool.started` and `tool.completed` emit — in **both** the `stream_event` case (line ~533)
      and the `assistant` case (line ~546). Also skip the `turn.active` emit at line ~516 when
      `taskId` is set: a subagent's frames must not re-mark the parent turn active.

- [ ] 4. In `server/src/types.ts`, add to `ServerEvent`:
      `| { type: "thread.task.delta"; threadId: string; taskId: string; text: string }`
      `| { type: "thread.task.delta.end"; threadId: string; taskId: string }`
      Mirror both into `web/src/lib/types.ts`.

- [ ] 5. In `server/src/agents/runtime.ts`, in `handleEvent`:
      - `assistant.delta` (line ~182) — when `event.taskId` is set, publish
        `thread.task.delta` and **return without touching `session.partial`**.
      - `assistant.complete` (line ~186) — when set, publish `thread.task.delta.end` and
        `appendMessage(threadId, "assistant", event.text, { taskId: event.taskId })`; do not
        publish `thread.delta.end` and do not clear `session.partial`.
      - `tool.started` (line ~191) — when set, add `taskId: event.taskId` to the meta object.
      - `tool.completed` needs no change; it resolves through `session.toolMessages` by `callId`.

- [ ] 6. Run `pnpm typecheck`. Expect: PASS. Run `pnpm test`. Expect: PASS, no new failures —
      no existing test exercises subagents, so this is a regression check, not a proof.

- [ ] 7. Start the app: `pnpm dev`. Add `/tmp/sr03-repo` as a project, create a Claude thread, and
      send: `Use the Explore subagent to list every file in this repo and report what it found.`
      Wait for the turn to finish.

- [ ] 8. Confirm in the UI that the agents panel shows a subagent row, and that the main transcript
      does **not** contain the subagent's file listing — only the parent's summary of it. Subagent
      messages disappearing from the transcript with no tab yet to read them in is the expected
      state at this point.

- [ ] 9. Assert on the database that the messages exist and are stamped. Run:
      `sqlite3 ~/.sr03/sr03.db "select count(*) from messages where json_extract(meta,'$.taskId') is not null;"`
      Expect: a number greater than 0. If it is 0 while the panel showed a row, the correlation map
      is empty — check whether `task_started` carried `tool_use_id` before changing anything else.

- [ ] 10. `git add server/src/agents/types.ts server/src/types.ts web/src/lib/types.ts server/src/agents/claude.ts server/src/agents/runtime.ts`
       `git commit -m "feat(claude): route subagent output to its task"`

## Done when

A Claude turn that spawns a subagent persists that subagent's messages with `meta.taskId`, they no
longer appear in the parent's transcript, the parent's own streaming text is unaffected, and the
sqlite count in step 9 is greater than zero.
