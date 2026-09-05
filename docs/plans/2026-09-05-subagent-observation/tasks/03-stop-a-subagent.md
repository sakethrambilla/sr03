# Task 3: Stop one subagent

**Depends on:** Task 1 (task rows and the `stopSubagents` capability exist)

**Files:**
- Modify: `server/src/agents/types.ts` — optional `stopTask` on `AgentSession`
- Modify: `server/src/agents/claude.ts` — implement it via the SDK's `Query.stopTask`
- Modify: `server/src/agents/runtime.ts` — export `stopTask(threadId, taskId)`
- Modify: `server/src/api.ts` — `POST /api/threads/:id/tasks/:taskId/stop`

**Interfaces:**
- Consumes: `Query.stopTask(taskId: string): Promise<void>` — already on the SDK's `Query`
  interface (`sdk.d.ts:2886`), beside `interrupt` and `backgroundTasks`.
- Produces: `POST /api/threads/:id/tasks/:taskId/stop` → `{ ok: true }`; `409` when this server
  does not own the session; `501` when the provider cannot stop a single task.

## Notes before starting

`stopTask` is **optional on `AgentSession`**, not required. Cursor's ACP exposes no way to stop an
individual subagent — the only lever is `session/cancel`, which stops the whole turn — so the
Cursor adapter deliberately does not implement it and the route answers `501`. Do not make the
Cursor adapter cancel the turn instead: stopping one subagent and killing the whole turn are
different actions, and silently substituting one for the other is worse than an honest refusal.

Task 1 already changed `TASK_STATUS` so the SDK's `stopped` reaches the row as `"stopped"`. Nothing
further is needed here for the row to read correctly.

Model the route on the interrupt route at `api.ts:1007`. Model the handle lookup on `interrupt`
(`runtime.ts:319`), which distinguishes three states that matter here: no session at all, a session
this server does not own, and a session that exists but whose `handle` is still opening.

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
      export async function stopTask(
        threadId: string,
        taskId: string,
      ): Promise<"ok" | "unowned" | "unavailable" | "unsupported"> {
      ```
      - no `sessions.get(threadId)`, or `!threadStore.owns(threadId)` → `"unowned"`
      - a session whose `handle` is still null → `"unavailable"` (it exists and is ours, it is just
        not up yet; answering `"unowned"` here would tell the user something false)
      - a handle without `stopTask` → `"unsupported"`
      - otherwise `await handle.stopTask(taskId)` and return `"ok"`

- [ ] 4. In `server/src/api.ts`, add a route beside the interrupt one:
      ```ts
      {
        method: "POST",
        pattern: /^\/api\/threads\/([^/]+)\/tasks\/([^/]+)\/stop$/,
        handler: async ({ params }) => { ... },
      }
      ```
      `requireThread(params[0]!)`, call `agents.stopTask(thread.id, params[1]!)`, and map:
      `"unowned"` → `HttpError(409, "This server does not own the running session")`;
      `"unavailable"` → `HttpError(409, "This session is still starting")`;
      `"unsupported"` → `HttpError(501, "This provider cannot stop a single subagent")`;
      `"ok"` → `{ ok: true }`.

- [ ] 5. Run `pnpm typecheck && pnpm test`. Expect: both pass.

- [ ] 6. Start `pnpm dev` and, in a Claude thread on `/tmp/sr03-repo`, send:
      `Use the Explore subagent to read every file in this repo one at a time and summarise each.`
      While the agents panel shows the subagent running, read its task id from the `thread.tasks`
      frames in the browser devtools' WS inspector.

- [ ] 7. With that id, run:
      `curl -sS -X POST http://localhost:3399/api/threads/<threadId>/tasks/<taskId>/stop`
      Expect: `{"ok":true}`, and within a second or two the agents panel row stops advancing its
      token and tool counts and settles. Its status dot goes non-running.

- [ ] 8. Repeat step 7 against a Cursor thread's task id.
      Expect: HTTP 501 with the message `This provider cannot stop a single subagent`, and the
      Cursor turn keeps running — confirm it is still running in the UI.

- [ ] 9. `git add server/src/agents/types.ts server/src/agents/claude.ts server/src/agents/runtime.ts server/src/api.ts`
      `git commit -m "feat(agents): stop a single subagent"`

## Done when

A running Claude subagent can be stopped by its task id and settles without ending its parent turn;
the same request against Cursor returns 501 and changes nothing; a request against a session that
is still starting returns 409 with a message that says so.
