# Task 1: Cursor `cursor/task` becomes task rows

**Depends on:** nothing

**Files:**
- Modify: `server/src/types.ts` — `ThreadTask.model`, `ProviderCapabilities.subagentTranscripts`
- Modify: `web/src/lib/types.ts` — the same two, mirrored
- Modify: `server/src/models.ts` — Cursor `tasks: true`; `subagentTranscripts` on both blocks
- Modify: `server/src/agents/cursor.ts` — session task map, `cursor/task` handler
- Modify: `server/src/agents/cursor.test.ts` — mock sends `cursor/task`; assertions

**Interfaces:**
- Consumes: a JSON-RPC **request** `cursor/task` with params
  `{ toolCallId: string, description?: string, prompt?: string, subagentType?: string,
  model?: string, agentId?: string, durationMs?: number }`. Cursor sends this through
  `extMethod` and discards the response, so returning `{}` is correct and required.
- Produces: `{ type: "tasks.changed"; tasks: ThreadTask[] }` on the existing `AgentEventSink`.

## Notes before starting

Cursor sends `cursor/task` **more than once per subagent** — once when the tool call starts and
again on completion, when `durationMs` is present. Key the map on `toolCallId` and upsert.

`durationMs` does not become a new field. `ThreadTask` already has `startedAt` / `endedAt`, and
`AgentsPanel.tsx:57` renders the difference. On the completing notification set
`endedAt = startedAt + durationMs`, so one renderer serves both providers.

Cursor reports no token or tool counts for a subagent. `tokens: 0` and `toolUses: 0` are correct
values, not placeholders.

## Steps

- [ ] 1. In `server/src/types.ts`, add `model: string | null;` to `ThreadTask` (after `agentType`),
      and `subagentTranscripts: boolean;` to `ProviderCapabilities` (after `tasks`). Mirror both
      into `web/src/lib/types.ts` in the same edit.

- [ ] 2. In `server/src/models.ts`, set `subagentTranscripts: true` in the Claude capabilities
      block and, in the Cursor block, `tasks: true` and `subagentTranscripts: false`.

- [ ] 3. Run `pnpm typecheck`. Expect: FAIL, in `server/src/agents/claude.ts` — the object literals
      built in `trackTask` are missing `model`. Add `model: null` to both the `task_started` and
      `task_progress` branches. Re-run; expect PASS.

- [ ] 4. In `server/src/agents/cursor.ts`, add `tasks: Map<string, ThreadTask>;` to
      `CursorNativeSession` (beside `tools`, line ~112) and initialise it to `new Map()` wherever
      the session object is constructed.

- [ ] 5. In `server/src/agents/cursor.test.ts`, extend the mock agent so that during a prompt turn
      it sends a `cursor/task` **request** with
      `{ toolCallId: "task-1", description: "Audit the config", subagentType: "explore",
      model: "composer-2.5" }`, and then a second one with the same `toolCallId` plus
      `durationMs: 4200`.

- [ ] 6. In the same file, add a test `emits a task row for a Cursor subagent` that opens the
      adapter against the mock, runs a turn, and asserts on the collected `AgentEvent`s: the last
      `tasks.changed` carries exactly one task, with `description === "Audit the config"`,
      `agentType === "explore"`, `model === "composer-2.5"`, `status === "done"`, and
      `endedAt !== null && endedAt - startedAt === 4200`.

- [ ] 7. Run `pnpm -C server test`.
      Expect: FAIL — `emits a task row for a Cursor subagent`, with no `tasks.changed` event
      collected at all. If it instead fails with an ACP "method not found" error surfacing as a
      turn error, that is the same root cause; continue.

- [ ] 8. In `cursor.ts`, write `handleTaskNotification(session, params)`: parse the params
      defensively with the file's existing `isRecord` / `stringValue` helpers, return `{}` on
      anything unparseable, upsert `session.tasks` keyed by `toolCallId`, and emit
      `{ type: "tasks.changed", tasks: [...session.tasks.values()] }`. A row with `durationMs`
      present is `status: "done"` with `endedAt` set; without it, `status: "running"` and
      `endedAt: null`. Use `agentId ?? toolCallId` as the task `id`, `depth: 1`, `tokens: 0`,
      `toolUses: 0`, `lastTool: null`, `error: null`.

- [ ] 9. Register it in `registerHandlers` (line ~769) alongside the other request handlers:
      `session.connection.registerRequestHandler("cursor/task", (params) =>
      handleTaskNotification(session, params));`

- [ ] 10. Run `pnpm -C server test`. Expect: PASS, all tests in `cursor.test.ts` green.

- [ ] 11. Run `pnpm test && pnpm typecheck`. Expect: both pass, no new failures.

- [ ] 12. `git add server/src/types.ts web/src/lib/types.ts server/src/models.ts server/src/agents/cursor.ts server/src/agents/cursor.test.ts server/src/agents/claude.ts`
       `git commit -m "feat(cursor): surface subagents as task rows"`

## Done when

A Cursor `cursor/task` request produces a single task row that carries the subagent's type, model
and duration, updating in place across the start and completion notifications rather than
producing two rows. `pnpm test` and `pnpm typecheck` are green.
