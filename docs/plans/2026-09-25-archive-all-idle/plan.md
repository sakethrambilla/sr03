# Archive all idle sessions — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch / worktree:** `ai/archive-all-open-chats-8b9d16` (this worktree). Branch off as
`feat/archive-idle-sessions` before the first commit.
**Test command:** `pnpm -C server test`
**Lint / typecheck:** `pnpm typecheck`

## Approach
One new server endpoint, `POST /api/projects/:id/archive-idle`, runs a single SQL
`UPDATE … WHERE status != 'running' … RETURNING id`. Because the running check and the write are
one statement, a session that starts a turn mid-request can't be archived (AC 9), and no per-thread
locks are needed. The server then publishes the existing `thread.updated` event for each archived
row, so other tabs and older clients pick it up with no wire change (AC 7, constraint 1). The
client sends the open session's id as `exceptThreadId`, because only the client knows which
session is open. The alternative, a client loop over `PATCH /api/threads/:id`, was rejected: it
takes N round trips and can archive a session that started running between the client's read and
its PATCH.

## Global constraints
- Server TS is type-stripped: no enums, no parameter properties. Import with `.ts` extensions.
- No new dependencies. The icon is lucide `Archive`, aliased in `web/src/components/ui.tsx`.
- UI uses the existing shadcn `Button` / `Tooltip`. Never edit `web/src/components/ui/*`.
- Zustand selectors never return fresh arrays or objects. Derive counts with `useMemo` over
  `state.threads`.
- Comments: one-liners, only where the code can't speak for itself.
- Commits: single-line Conventional Commits, author `sakethrambilla@gmail.com`, ending with the
  `Co-Authored-By` trailer from the session.
- Never test against the user's real `~/.sr03`. Use `SR03_DATA_DIR` pointing at a scratch dir.

## File map
| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/db.ts` (`sql` block ~L317-360, `threads` object ~L485) | Modify | `threads.archiveIdle(projectId, exceptThreadId)`: the atomic update, returns the archived `Thread[]` |
| `server/src/db.test.ts` | Modify | Test for `archiveIdle` |
| `server/src/api.ts` (routes table, before the `/git` route at ~L372) | Modify | `POST /api/projects/:id/archive-idle` route, publishes `thread.updated` per row |
| `web/src/lib/api.ts` (~L91, next to `removeProject`) | Modify | `archiveIdle(projectId, exceptThreadId)` |
| `web/src/store.ts` (interface ~L165, impl next to `setArchived` ~L603) | Modify | `archiveIdle(projectId)` action: calls the api with `activeThreadId`, upserts results, sets `error` on failure |
| `web/src/components/ui.tsx` (`ICONS` + exports) | Modify | `ArchiveIcon` alias |
| `web/src/components/Sidebar.tsx` | Modify | `ArchiveIdleButton` in project headers and the filtered toolbar |
| `web/src/App.tsx` (keydown effect ~L46-60) | Modify | ⌘⇧X handler |
| `SHORTCUTS.md` (Anywhere table) | Modify | ⌘⇧X row |

## Tasks

### Task 1: `threads.archiveIdle` in the db layer

**Depends on:** none
**Files:** modify `server/src/db.ts`, `server/src/db.test.ts`
**Interfaces:**
- Produces: `threads.archiveIdle(projectId: string, exceptThreadId: string | null): Thread[]`.
  It returns the rows it archived, read back after the update, in any order.

Steps:
- [ ] 1. `git switch -c feat/archive-idle-sessions`
- [ ] 2. In `server/src/db.test.ts`, add
  `test("archiveIdle archives idle and errored threads, skipping running, archived and the excepted one", …)`.
  Use the same `mkdtemp` + `SR03_DATA_DIR` + `context.after` setup as the existing tests. Then:
  - Create two projects, `a` and `b`, with `projects.create`.
  - In `a`, create six threads with `threads.create({ projectId, providerId: "claude", title, cwd: directory, branch: null, isWorktree: false, model: "m", permissionMode: "default", effort: "high", fast: false })`: `idle1`, `idle2`,
    `errored`, `running`, `alreadyArchived`, `open`. In `b`, create one thread, `other`.
  - Set state with `threads.update(id, { status: "error" })` on `errored`,
    `{ status: "running" }` on `running`, and `{ archived: true }` on `alreadyArchived`.
  - Call `threads.archiveIdle(a.id, open.id)`.
  - Assert the returned ids, sorted, equal `[idle1, idle2, errored]` sorted, and every returned
    thread has `archived === true`.
  - Assert `threads.byId` shows `running`, `open` and `other` with `archived === false`.
  - Call `threads.archiveIdle(a.id, null)`. Assert it returns exactly `[open]`.
  - Call `threads.archiveIdle(a.id, null)` again. Assert it returns `[]`.
- [ ] 3. Run `pnpm -C server test`. Expect: FAIL with
  `TypeError: threads.archiveIdle is not a function`. If it fails any other way, stop.
- [ ] 4. In `db.ts`, add to the `sql` block:
  ```ts
  threadsArchiveIdle: db.prepare(
    "UPDATE threads SET archived = 1, updated_at = ? WHERE project_id = ? AND archived = 0 AND status != 'running' AND id IS NOT ? RETURNING id",
  ),
  ```
  (`IS NOT ?` makes a `null` except match nothing, so every idle row qualifies.) In the `threads`
  object, add:
  ```ts
  archiveIdle(projectId: string, exceptThreadId: string | null): Thread[] {
    const rows = sql.threadsArchiveIdle.all(Date.now(), projectId, exceptThreadId) as Array<{ id: string }>;
    return rows.flatMap((row) => threads.byId(row.id) ?? []);
  },
  ```
  Match the casting style that neighbouring `sql.*.all(...)` calls use.
- [ ] 5. Run `pnpm -C server test`. Expect: all pass, including the new test.
- [ ] 6. Run `pnpm typecheck`. Expect: exit 0.
- [ ] 7. Commit `server/src/db.ts server/src/db.test.ts`:
  `feat(db): archive a project's idle threads in one statement`

**Done when:** the new test passes, and so do the full server suite and the typecheck.

### Task 2: endpoint, api client and store action

**Depends on:** Task 1
**Files:** modify `server/src/api.ts`, `web/src/lib/api.ts`, `web/src/store.ts`
**Interfaces:**
- Consumes: `threads.archiveIdle`.
- Produces: `POST /api/projects/:id/archive-idle`, body `{ exceptThreadId?: string | null }`,
  response `Thread[]`, 404 `Project not found` for an unknown id, 400 if `exceptThreadId` is
  present and not a string or null.
- Produces: `api.archiveIdle(projectId: string, exceptThreadId: string | null): Promise<Thread[]>`.
- Produces: store action `archiveIdle: (projectId: string) => Promise<void>`.

Steps:
- [ ] 1. In `server/src/api.ts`, add a route object just before the one whose pattern is
  `/^\/api\/projects\/([^/]+)\/git$/`:
  ```ts
  {
    method: "POST",
    pattern: /^\/api\/projects\/([^/]+)\/archive-idle$/,
    handler: async ({ params, request }) => {
      const body = await readBody(request);
      const project = requireProject(params[0]!);
      const except = body.exceptThreadId ?? null;
      if (except !== null && typeof except !== "string") {
        throw new HttpError(400, "`exceptThreadId` must be a string");
      }
      const archived = threads.archiveIdle(project.id, except);
      for (const thread of archived) publish({ type: "thread.updated", thread });
      return archived;
    },
  },
  ```
  Leave it outside `withThreadOperation`: the single SQL statement already refuses running rows.
- [ ] 2. Verify by hand against a scratch data dir:
  `SR03_DATA_DIR=$(mktemp -d) SR03_PORT=3499 pnpm -C server start`. In another shell:
  `curl -s -XPOST localhost:3499/api/projects/nope/archive-idle -d '{}'` → expect
  `{"error":"Project not found"}`.
  `curl -s -XPOST localhost:3499/api/projects/nope/archive-idle -d '{"exceptThreadId":5}'` → still
  404, because the project check runs first. Stop the server.
- [ ] 3. In `web/src/lib/api.ts`, next to `removeProject`, add:
  ```ts
  archiveIdle: (projectId: string, exceptThreadId: string | null) =>
    post<Thread[]>(`/api/projects/${projectId}/archive-idle`, { exceptThreadId }),
  ```
- [ ] 4. In `web/src/store.ts`, declare `archiveIdle: (projectId: string) => Promise<void>;` next to
  `setArchived` in the state interface. Implement it next to `setArchived`:
  ```ts
  archiveIdle: async (projectId) => {
    try {
      const archived = await api.archiveIdle(projectId, get().activeThreadId);
      set((state) => ({ threads: archived.reduce(upsertThread, state.threads) }));
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },
  ```
  There's no navigation step: the open session is never archived.
- [ ] 5. Run `pnpm typecheck` and `pnpm -C server test`. Expect: both exit 0.
- [ ] 6. Commit the three files: `feat(api): add endpoint to archive a project's idle sessions`

**Done when:** the typecheck and tests pass, and the curl in step 2 returns 404 for an unknown
project.

### Task 3: sidebar button, ⌘⇧X, SHORTCUTS.md

**Depends on:** Task 2
**Files:** modify `web/src/components/ui.tsx`, `web/src/components/Sidebar.tsx`,
`web/src/App.tsx`, `SHORTCUTS.md`
**Interfaces:** consumes the store's `archiveIdle(projectId)`.

Steps:
- [ ] 1. In `ui.tsx`, add `Archive` to the `lucide-react` import, `ArchiveIcon: Archive` to
  `ICONS`, and `export const ArchiveIcon = icon(ICONS.ArchiveIcon);` with the other exports.
- [ ] 2. In `Sidebar.tsx`, import `ArchiveIcon`. Add, next to `NewSessionButton`:
  ```tsx
  function ArchiveIdleButton({ project, hover }: { project: Project; hover?: boolean }) {
    const threads = useStore((state) => state.threads);
    const activeThreadId = useStore((state) => state.activeThreadId);
    const archiveIdle = useStore((state) => state.archiveIdle);
    const count = useMemo(
      () =>
        threads.filter(
          (thread) =>
            thread.projectId === project.id &&
            !thread.archived &&
            thread.status !== "running" &&
            thread.id !== activeThreadId,
        ).length,
      [threads, project.id, activeThreadId],
    );
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            disabled={count === 0}
            onClick={() => void archiveIdle(project.id)}
            aria-label="Archive idle sessions"
            className={cn("size-6 shrink-0 text-faint", hover && "opacity-0 group-hover:opacity-100")}
          >
            <ArchiveIcon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Archive idle sessions <span className="text-faint">⌘⇧X</span>
        </TooltipContent>
      </Tooltip>
    );
  }
  ```
  A disabled button swallows pointer events, so the tooltip won't show on it. That's acceptable.
- [ ] 3. Render it in two places, each just before `<NewSessionButton … />`:
  in the project header, `<ArchiveIdleButton project={project} hover />`, and in the toolbar
  row, `{selected ? <ArchiveIdleButton project={selected} /> : null}`.
- [ ] 4. In `App.tsx`, add `const projects = useStore((state) => state.projects);` and
  `const archiveIdle = useStore((state) => state.archiveIdle);`. `thread` (from
  `useActiveThread()`) is already in scope. Add a branch to the
  existing keydown handler:
  ```ts
  } else if (key === "x") {
    event.preventDefault();
    // the sidebar owns the folder filter and unmounts when hidden, so read its persisted value
    const filtered = localStorage.getItem("sr03:sidebar.project");
    const projectId =
      thread?.projectId ?? projects.find((project) => project.id === filtered)?.id ?? null;
    if (projectId) void archiveIdle(projectId);
  }
  ```
  Add `thread?.projectId`, `projects` and `archiveIdle` to the effect's dependency array.
- [ ] 5. In `SHORTCUTS.md`, under **Anywhere**, add:
  `| \`⌘⇧X\` | Archive every idle session in the open session's folder, or in the sidebar's picked folder | \`web/src/App.tsx\` |`
- [ ] 6. Run `pnpm typecheck`. Expect: exit 0.
- [ ] 7. Verify in the browser against scratch data. Run
  `SR03_DATA_DIR=$(mktemp -d) pnpm dev`, open http://localhost:5399, and add the scratch repo
  `/tmp/sr03-repo` (setup in CLAUDE.md "Testing changes"). Create four sessions there and run one
  short turn in each so they're idle. Then:
  - Open session 1 and hover the project header. Click the archive button. Expect sessions 2–4
    in Archived and session 1 still listed (AC 1, 2).
  - The button is now disabled (AC 3).
  - Pick the folder in the filter. The button appears in the toolbar row (AC 4).
  - Unarchive two sessions, open a second browser tab, and press ⌘⇧X in the first. Both tabs
    show them archived (AC 5, 7).
  - Open the draft with ⌘⇧N, set the filter to All, and press ⌘⇧X. The network tab shows no
    `archive-idle` request (AC 6).
  - Start a long turn in one session and click archive while it runs. That session stays
    unarchived (AC 1, 9).
- [ ] 8. Commit the four files: `feat(sidebar): add button and shortcut to archive idle sessions`

**Done when:** the typecheck passes, every browser check in step 7 behaves as described, and
`SHORTCUTS.md` has the row.

## Risks
- **⌘⇧X in a browser tab.** Chrome doesn't bind it, but an extension might. Check in the packaged
  app too if the browser check misbehaves.
- **`RETURNING` needs SQLite ≥ 3.35.** The bundled `node:sqlite` here is 3.51.2, so this is fine.
- **AC 8 (server failure)** is covered by the store's existing `error` path. There's no scripted
  check. To force it, stop the server and click the button: the app's error banner should show.
- **Hidden sidebar.** The shortcut reads the persisted filter straight from localStorage because
  `Sidebar` unmounts when hidden. If the storage key changes, update both places.
