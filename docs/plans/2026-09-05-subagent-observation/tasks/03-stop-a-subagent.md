# Task 3: Stop one subagent

**Depends on:** Task 1 (task rows exist for both providers)

**Files:**
- Modify: `server/src/agents/types.ts` — optional `stopTask` on `AgentSession`
- Modify: `server/src/agents/claude.ts` — implement it via the SDK's `Query.stopTask`
- Modify: `server/src/agents/runtime.ts` — export `stopTask(threadId, taskId)`
- Modify: `server/src/api.ts` — `POST /api/threads/:id/tasks/:taskId/stop`

**Interfaces:**
- Consumes: `Query.stopTask(taskId: string): Promise<void>` — already on the SDK's `Query`
  interface, beside `interrupt` and `backgroundTasks`.
- Produces: `POST /api/threads/:id/tasks/:taskId/stop` → `{ ok: true }`, or `409` when this server
  does not own the session, or `501` when the provider cannot stop a task.

## Notes before starting

`stopTask` is **optional on `AgentSession`**, not required. Cursor's ACP exposes no way to stop an
individual subagent — the only lever is `session/cancel`, which stops the whole turn — so the
Cursor adapter deliberately does not implement it and the route answers `501`. Do not make the
Cursor adapter cancel the turn instead: stopping one subagent and killing the whole turn are
different actions, and silently substituting one for the other is worse than an honest refusal.

The SDK emits a `task_notification` with status `stopped` when the stop lands. `trackTask` already
maps `stopped → "failed"` via its `TASK_STATUS` table (`claude.ts:108`). Leave that mapping alone
in this task — the row reading "failed" after a user-initiated stop is a wording problem for
task 5, not a routing problem here.

Model the route on the existing interrupt route at `api.ts:1007`, including the 409.

## Steps

- [ ] 1. In `server/src/agents/types.ts`, add `stopTask?(taskId: string): Promise<void>;` to
      `AgentSession`, directly after `interrupt`.

- [ ] 2. In `server/src/agents/claude.ts`, add to the returned session object (after `interrupt`,
      line ~688):
      ```ts
      async stopTask(taskId) {
        await session.query.stopTask(taskId);
      },
      ```

- [ ] 3. In `server/src/agents/runtime.ts`, export:
      ```ts
      export async function stopTask(threadId: string, taskId: string): Promise<"ok" | "unowned" | "unsupported"> {
      ```
      Return `"unowned"` when there is no live handle for the thread, `"unsupported"` when the
      handle has no `stopTask`, and `"ok"` after awaiting it. Model the handle lookup on
      `interrupt` (line ~319).

- [ ] 4. In `server/src/api.ts`, add a route beside the interrupt one:
      ```ts
      {
        method: "POST",
        pattern: /^\/api\/threads\/([^/]+)\/tasks\/([^/]+)\/stop$/,
        handler: async ({ params }) => { ... },
      }
      ```
      `requireThread(params[0]!)`, call `agents.stopTask(thread.id, params[1]!)`, and map
      `"unowned"` to `new HttpError(409, "This server does not own the running session")` and
      `"unsupported"` to `new HttpError(501, "This provider cannot stop a single subagent")`.
      Return `{ ok: true }` otherwise.

- [ ] 5. Run `pnpm typecheck && pnpm test`. Expect: both pass.

- [ ] 6. Start `pnpm dev` and, in a Claude thread on `/tmp/sr03-repo`, send:
      `Use the Explore subagent to read every file in this repo one at a time and summarise each.`
      While the agents panel shows the subagent running, read its task id from the panel row or
      from the `thread.tasks` frames in the browser devtools' WS inspector.

- [ ] 7. With that id, run:
      `curl -sS -X POST http://localhost:3399/api/threads/<threadId>/tasks/<taskId>/stop`
      Expect: `{"ok":true}`, and within a second or two the agents panel row stops advancing its
      token and tool counts and settles to a terminal status.

- [ ] 8. Repeat step 7 against a Cursor thread's task id.
      Expect: HTTP 501 with the message `This provider cannot stop a single subagent`, and the
      Cursor turn keeps running — confirm it is still running in the UI.

- [ ] 9. `git add server/src/agents/types.ts server/src/agents/claude.ts server/src/agents/runtime.ts server/src/api.ts`
      `git commit -m "feat(agents): stop a single subagent"`

## Done when

A running Claude subagent can be stopped by its task id and settles to a terminal status without
ending its parent turn; the same request against Cursor returns 501 and changes nothing.
