# Task 1: Store an editor layout on the thread

**Depends on:** nothing
**Files:**
- Modify: `server/src/types.ts`
- Create: `server/src/layout.ts`
- Create: `server/src/layout.test.ts`
- Modify: `server/package.json` (test glob)
- Modify: `server/src/db.ts`
- Modify: `server/src/api.ts`
- Modify: `web/src/lib/types.ts` (mirror only — no behaviour)

**Interfaces:**
- Produces: `PATCH /api/threads/:id/layout`, body `{ layout: EditorLayout | null }`, returns the
  updated `Thread`, publishes `thread.updated`.
- Produces: `parseLayout(value: unknown): EditorLayout | null` — returns null for anything malformed,
  never throws.
- Produces: `threads.setLayout(id: string, layout: EditorLayout | null): Thread | null`.
- Wire shape, identical on both sides:
  ```ts
  export type LayoutAxis = "horizontal" | "vertical";
  export type EditorTab = { kind: "chat" } | { kind: "file"; path: string };
  export interface EditorGroup { id: string; tabs: EditorTab[]; active: number }
  export interface EditorLayout { axis: LayoutAxis; groups: EditorGroup[]; sizes: number[] }
  ```
  A tab is tagged rather than a bare string so a file named `chat` can never be mistaken for the
  transcript. `active` indexes into the group's own `tabs`, so a group always has exactly one active
  tab and there is no "active names a tab not in this group" case to validate. `sizes` has one
  fraction per group and is parallel to `groups`.

## Steps

- [ ] 1. In `server/src/types.ts`, add the three types above next to `Thread`, and add
      `layout: EditorLayout | null;` to `Thread` after `archived`.

- [ ] 2. Create `server/src/layout.ts` exporting `parseLayout(value: unknown): EditorLayout | null`.
      Return `null` unless every one of these holds: `axis` is `"horizontal"` or `"vertical"`;
      `groups` is an array of 1 to 3 objects; each group has a non-empty string `id` and a
      non-empty `tabs` array whose entries are each `{kind:"chat"}` or
      `{kind:"file",path:<non-empty>}`; `active` is an integer index into that group's own `tabs`;
      no file path appears twice across the whole layout; exactly one `{kind:"chat"}` tab exists;
      `sizes` is an array of finite positive numbers the same length as `groups`. Accept a JSON string as
      well as an object, so the db and the route can share one entry point.

- [ ] 3. Create `server/src/layout.test.ts` using `node:test` and `node:assert/strict`, mirroring the
      style of `server/src/agents/acp.test.ts`. Cover: a valid two-group layout round-trips
      unchanged; a file literally named `chat` coexists with the transcript; four groups returns
      null; an unknown axis returns null; the same file in two groups returns null; zero chat tabs
      returns null; two chat tabs returns null; an out-of-range or non-integer `active` returns
      null; an unknown tab `kind` returns null; `sizes` of the wrong length or a non-positive size
      returns null; a malformed JSON string returns null; `null` and `undefined` return null.

- [ ] 4. In `server/package.json`, change the `test` script to
      `node --experimental-strip-types --test src/*.test.ts src/agents/*.test.ts`.

- [ ] 5. Run `pnpm test`.
      Expect: FAIL — the layout tests run and fail, the two ACP suites still pass. If `layout.test.ts`
      is not collected at all, the glob in step 4 is wrong; fix that before writing any implementation.

- [ ] 6. Implement `parseLayout` until `pnpm test` passes. Expect: PASS, all suites, no skips.

- [ ] 7. In `server/src/db.ts`, add `layout TEXT` to the `CREATE TABLE IF NOT EXISTS threads` body,
      and add a matching guard inside the existing `BEGIN IMMEDIATE` migration block alongside the
      `owner_id` one:
      ```ts
      if (!threadColumns.includes("layout")) {
        db.exec("ALTER TABLE threads ADD COLUMN layout TEXT");
      }
      ```

- [ ] 8. In `toThread`, add `layout: parseLayout(row.layout),`. A pre-existing row has SQL NULL here
      and must yield `null` without any migration step.

- [ ] 8b. Adding a required field to `Thread` breaks every other place one is built. Add
      `layout: null` to the `Thread` literal in `threads.create` (`server/src/db.ts`) and to the
      three `const thread: Thread = {...}` fixtures in `server/src/agents/cursor.test.ts`
      (`server/tsconfig.json` includes `src`, so the test file is typechecked too). Without this,
      step 12 fails with four `TS2741: Property 'layout' is missing` errors.

- [ ] 9. Add to the `threads` object, next to `update`:
      ```ts
      // deliberately not threads.update: that writes updated_at, and threadsList is ordered by it,
      // so a dragged tab would jump the session to the top of the sidebar
      setLayout(id: string, layout: EditorLayout | null): Thread | null {
        sql.threadSetLayout.run(layout ? JSON.stringify(layout) : null, id);
        return threads.byId(id);
      },
      ```
      with `threadSetLayout: db.prepare("UPDATE threads SET layout = ? WHERE id = ?")` added to the
      `sql` object. Do **not** add `layout` to `THREAD_COLUMNS`.

- [ ] 10. In `server/src/api.ts`, add a route to the table, placed directly after the existing
      `PATCH /api/threads/([^/]+)` entry:
      ```ts
      {
        method: "PATCH",
        pattern: /^\/api\/threads\/([^/]+)\/layout$/,
        handler: async ({ params, request }) => {
          const body = await readBody(request);
          const thread = requireThread(params[0]!);
          const layout = body.layout === null ? null : parseLayout(body.layout);
          if (body.layout !== null && layout === null) {
            throw new HttpError(400, "`layout` is not a valid editor layout");
          }
          const updated = threads.setLayout(thread.id, layout);
          if (!updated) throw new HttpError(404, "Thread not found");
          publish({ type: "thread.updated", thread: updated });
          return updated;
        },
      },
      ```
      Import `parseLayout` from `./layout.ts`. This route must **not** be wrapped in
      `withThreadOperation` and must not consult `agents.canOperate` — a layout change touches no
      agent state, and going through either would queue it behind a running turn or 409 it when the
      thread is live in another sr03 instance.

- [ ] 11. Mirror the three types and the `Thread.layout` field into `web/src/lib/types.ts`, matching
      the existing ordering of that file. No other web change in this task.

- [ ] 12. Run `pnpm typecheck`. Expect: both packages clean.

- [ ] 13. Verify against a live server. In one shell `pnpm dev`; in another, with `$T` set to any
      thread id from `curl -s localhost:3399/api/state | head -c 400`:
      ```bash
      curl -s -X PATCH localhost:3399/api/threads/$T/layout -H 'content-type: application/json' -d '{"layout":{"axis":"horizontal","groups":[{"id":"g1","tabs":[{"kind":"chat"}],"active":0},{"id":"g2","tabs":[{"kind":"file","path":"README.md"}],"active":0}],"sizes":[1,1]}}'
      ```
      Expect: 200 and a thread JSON whose `layout` echoes what was sent. Then
      `curl -s localhost:3399/api/state` and confirm the same thread carries the layout and that its
      **position in the `threads` array has not changed** — that is the `updated_at` check.
      Then send `-d '{"layout":{"axis":"sideways","groups":[]}}'` and expect status 400 with the
      body ``{"error":"`layout` is not a valid editor layout"}`` — note the backticks around
      `layout`, matching the house style of the other 400s in `api.ts`.

- [ ] 14. Commit:
      `git add server/src/types.ts server/src/layout.ts server/src/layout.test.ts server/package.json server/src/db.ts server/src/api.ts server/src/agents/cursor.test.ts web/src/lib/types.ts`
      `git commit -m "feat(threads): persist an editor layout per thread"`

## Done when
`pnpm test` passes including the new suite, a layout round-trips through the new route, an invalid
one is rejected with 400, and saving a layout does not reorder the sidebar. No client behaviour has
changed yet.
