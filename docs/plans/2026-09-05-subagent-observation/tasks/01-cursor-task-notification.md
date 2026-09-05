# Task 1: Cursor `cursor/task` becomes task rows

**Depends on:** nothing

**Files:**
- Modify: `server/src/types.ts` — `ThreadTask.model`, `"stopped"` status, two new capabilities
- Modify: `web/src/lib/types.ts` — the same three, mirrored
- Modify: `server/src/models.ts` — Cursor `tasks: true`; the two capabilities on both blocks
- Modify: `server/src/agents/cursor.ts` — session task map, `cursor/task` handlers
- Modify: `server/src/agents/claude.ts` — `model: null` on the rows it builds; `"stopped"` mapping
- Modify: `server/src/agents/cursor.test.ts` — mock sends `cursor/task`; assertions

**Interfaces:**
- Consumes: `cursor/task` carrying
  `{ toolCallId: string, description?: string, prompt?: string, subagentType?: string,
  model?: string, agentId?: string, durationMs?: number }`. Read the plan's
  **Provenance for the Cursor protocol** section before starting — this is undocumented, and it
  must be registered as **both** a request and a notification.
- Produces: `{ type: "tasks.changed"; tasks: ThreadTask[] }` on the existing `AgentEventSink`.

## Notes before starting

Cursor sends `cursor/task` **more than once per subagent** — once when the tool call starts and
again on completion, when `durationMs` is present. Key the map on `toolCallId` and upsert.

**Derive the row `id` from `toolCallId` alone**, never from `agentId ?? toolCallId`. `agentId` may
be absent on one notification and present on the other; a row whose id changes between them is a
row that any open tab loses track of.

`durationMs` does not become a new field. `ThreadTask` already has `startedAt` / `endedAt`, and
`AgentsPanel.tsx:52` renders the difference. On the completing notification set
`endedAt = startedAt + durationMs`, so one renderer serves both providers.

Cursor reports no token or tool counts for a subagent. `tokens: 0` and `toolUses: 0` are correct
values, not placeholders.

## Steps

- [ ] 1. In `server/src/types.ts`, in `ThreadTask`: add `model: string | null;` after `agentType`,
      and widen `status` to `"running" | "done" | "failed" | "stopped"`. In
      `ProviderCapabilities`, add `subagentTranscripts: boolean;` and `stopSubagents: boolean;`
      after `tasks`. Mirror all of it into `web/src/lib/types.ts` in the same edit.

- [ ] 2. In `server/src/models.ts`, add `subagentTranscripts: true` and `stopSubagents: true` to
      the Claude capabilities block, and `tasks: true`, `subagentTranscripts: false`,
      `stopSubagents: false` to the Cursor block.

- [ ] 3. Run `pnpm typecheck`.
      Expect: FAIL in `server/src/agents/claude.ts` — the object literals in `trackTask` are
      missing `model`. Add `model: null` to both the `task_started` and `task_progress` branches.
      In the same file change `TASK_STATUS` (line ~104) so `stopped` maps to `"stopped"` rather
      than `"failed"`, leaving `killed` on `"failed"`. Re-run; expect PASS.

- [ ] 4. In `server/src/agents/cursor.ts`, add `tasks: Map<string, ThreadTask>;` to
      `CursorNativeSession` (beside `tools`, line ~112) and initialise it to `new Map()` wherever
      the session object is constructed.

- [ ] 5. In `server/src/agents/cursor.test.ts`, extend the mock agent so that during a prompt turn
      it sends a `cursor/task` **request** (with an `id`) carrying
      `{ toolCallId: "task-1", description: "Audit the config", subagentType: "explore",
      model: "composer-2.5" }`, and then a `cursor/task` **notification** (no `id`) with
      `{ toolCallId: "task-1", durationMs: 4200 }`. Using a different framing for each of the two
      is deliberate: it proves both dispatch tables are wired.

- [ ] 6. In the same file, add a test `emits one task row for a Cursor subagent` that opens the
      adapter against the mock, runs a turn, and asserts on the collected `AgentEvent`s: the last
      `tasks.changed` carries exactly one task — one, not two — with
      `description === "Audit the config"`, `agentType === "explore"`,
      `model === "composer-2.5"`, `status === "done"`, and
      `endedAt !== null && endedAt - startedAt === 4200`.

- [ ] 7. Run `pnpm -C server test`.
      Expect: FAIL — `emits one task row for a Cursor subagent`, with no `tasks.changed` event
      collected, so the assertion reads roughly `Expected values to be strictly equal: undefined
      !== 'Audit the config'`. If instead the turn errors with an ACP method-not-found, that is the
      same root cause; continue.

- [ ] 8. In `cursor.ts`, write `handleTaskNotification(session, params): Record<string, never>`:
      parse `params` defensively with the file's existing `isRecord` / `stringValue` helpers and
      return `{}` on anything unparseable; upsert `session.tasks` keyed by `toolCallId`; emit
      `{ type: "tasks.changed", tasks: [...session.tasks.values()] }`; return `{}`. A payload
      carrying `durationMs` sets `status: "done"` and `endedAt: startedAt + durationMs`; one
      without sets `status: "running"` and `endedAt: null`. Fields on a new row: `id: toolCallId`,
      `description: description ?? prompt ?? "Subagent task"`, `agentType: subagentType ?? null`,
      `model: model ?? null`, `depth: 1`, `tokens: 0`, `toolUses: 0`, `lastTool: null`,
      `error: null`, `startedAt: Date.now()`. On an existing row keep `startedAt` and overwrite
      only the fields the new payload carries.

- [ ] 9. Register it **twice** in `registerHandlers` (line ~769), because `extMethod` may frame it
      either way and `acp.ts` dispatches requests and notifications from disjoint maps:
      ```ts
      session.connection.registerRequestHandler("cursor/task", (params) =>
        handleTaskNotification(session, params),
      );
      session.connection.registerNotificationHandler("cursor/task", (params) => {
        handleTaskNotification(session, params);
      });
      ```

- [ ] 10. Run `pnpm -C server test`. Expect: PASS, all tests in `cursor.test.ts` green, including
       the existing ones.

- [ ] 11. Run `pnpm test && pnpm typecheck`. Expect: both pass, no new failures.

- [ ] 12. `git add server/src/types.ts web/src/lib/types.ts server/src/models.ts server/src/agents/cursor.ts server/src/agents/cursor.test.ts server/src/agents/claude.ts`
       `git commit -m "feat(cursor): surface subagents as task rows"`

## Done when

A Cursor `cursor/task` produces exactly one task row carrying the subagent's type, model and
duration, updated in place across both notifications and regardless of which framing each arrives
in. `pnpm test` and `pnpm typecheck` are green.
