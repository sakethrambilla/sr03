# Task 5: favorites table + worktree-management API routes

**Depends on:** Task 4
**Files:**
- Modify: `server/src/db.ts`
- Modify: `server/src/api.ts`
- Modify: `web/src/lib/types.ts`

**Interfaces consumed:** `git.lockWorktree`, `git.unlockWorktree`,
`git.moveWorktree`, `git.fetchWorktree`, `git.pullWorktree`,
`git.pushWorktree`, `git.mergedBranches`, `git.listWorktrees` (all Task
4), plus existing `agents.canOperate`/`reserveThread`/`closeSession`/
`releaseThreadReservation`, `withThreadOperations`, `requireProject`,
`readBody`, `requireString`, `HttpError`, `publish`.

**Interfaces produced:** `worktreeFavorites` accessor and
`threads.setCwd` in `db.ts`; nine new/modified REST routes.

## Steps

- [ ] 1. In `server/src/db.ts`, add a new table to the schema `db.exec`
      block (right after the `server_instances` table, around line 95):
      ```sql
      CREATE TABLE IF NOT EXISTS worktree_favorites (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, path)
      );
      ```

- [ ] 2. Add three prepared statements to the `sql` object (around line
      329, next to the other `thread*`/settings statements):
      ```ts
      worktreeFavoritesList: db.prepare(
        "SELECT path FROM worktree_favorites WHERE project_id = ? ORDER BY created_at ASC",
      ),
      worktreeFavoriteAdd: db.prepare(
        "INSERT INTO worktree_favorites (project_id, path, created_at) VALUES (?, ?, ?) ON CONFLICT(project_id, path) DO NOTHING",
      ),
      worktreeFavoriteRemove: db.prepare(
        "DELETE FROM worktree_favorites WHERE project_id = ? AND path = ?",
      ),
      threadSetCwd: db.prepare("UPDATE threads SET cwd = ?, updated_at = ? WHERE id = ?"),
      ```

- [ ] 3. Add a new exported accessor, right after the `projects` object
      (around line 382):
      ```ts
      export const worktreeFavorites = {
        list(projectId: string): string[] {
          return (sql.worktreeFavoritesList.all(projectId) as Array<{ path: string }>).map((row) => row.path);
        },
        add(projectId: string, path: string): void {
          sql.worktreeFavoriteAdd.run(projectId, path, Date.now());
        },
        remove(projectId: string, path: string): void {
          sql.worktreeFavoriteRemove.run(projectId, path);
        },
      };
      ```

- [ ] 4. Add `setCwd` to the existing `threads` object (right after
      `touch`, around line 507):
      ```ts
      setCwd(id: string, cwd: string): void {
        sql.threadSetCwd.run(cwd, Date.now(), id);
      },
      ```

- [ ] 5. In `server/src/api.ts`, add `worktreeFavorites` to the existing
      db import line (around line 30):
      ```ts
      import { messages, projects, settings, threads, worktreeFavorites } from "./db.ts";
      ```

- [ ] 6. Modify the existing `GET /^\/api\/projects\/([^/]+)\/git$/`
      route (around line 341) so each returned worktree carries its
      favorite state:
      ```ts
      {
        method: "GET",
        pattern: /^\/api\/projects\/([^/]+)\/git$/,
        handler: async ({ params }) => {
          const project = requireProject(params[0]!);
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) return { isGit: false, branches: [], worktrees: [] };
          const [branches, worktrees] = await Promise.all([
            git.listBranches(info.root),
            git.listWorktrees(info.root),
          ]);
          const favorites = new Set(worktreeFavorites.list(project.id));
          return {
            isGit: true,
            root: info.root,
            branch: info.branch,
            dirty: info.dirty,
            branches,
            worktrees: worktrees.map((worktree) => ({ ...worktree, favorite: favorites.has(worktree.path) })),
          };
        },
      },
      ```

- [ ] 7. Add lock/unlock routes right after the existing `DELETE
      /^\/api\/projects\/([^/]+)\/worktrees$/` route (around line 454):
      ```ts
      {
        method: "POST",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/lock$/,
        handler: async ({ params, request }) => {
          const project = requireProject(params[0]!);
          const body = await readBody(request);
          const target = path.resolve(requireString(body, "path"));
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) throw new HttpError(400, "Project is not a git repository");
          await git.lockWorktree({
            root: info.root,
            path: target,
            reason: typeof body.reason === "string" ? body.reason : undefined,
          });
          publish({ type: "projects.changed" });
          return { ok: true };
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/unlock$/,
        handler: async ({ params, request }) => {
          const project = requireProject(params[0]!);
          const body = await readBody(request);
          const target = path.resolve(requireString(body, "path"));
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) throw new HttpError(400, "Project is not a git repository");
          await git.unlockWorktree({ root: info.root, path: target });
          publish({ type: "projects.changed" });
          return { ok: true };
        },
      },
      ```

- [ ] 8. Add the move route, guarded the same way the existing DELETE
      worktrees route guards against active sessions, then retargeting
      every affected thread's `cwd` after a successful move:
      ```ts
      {
        method: "POST",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/move$/,
        handler: async ({ params, request }) => {
          const project = requireProject(params[0]!);
          const body = await readBody(request);
          const target = path.resolve(requireString(body, "path"));
          const to = path.resolve(requireString(body, "to"));
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) throw new HttpError(400, "Project is not a git repository");
          const usesTarget = (cwd: string) =>
            path.resolve(cwd) === target || path.resolve(cwd).startsWith(`${target}${path.sep}`);
          const ids = threads
            .list()
            .filter((thread) => thread.projectId === project.id && usesTarget(thread.cwd))
            .map((thread) => thread.id);
          return withThreadOperations(ids, async () => {
            const affected = threads
              .list()
              .filter((thread) => thread.projectId === project.id && usesTarget(thread.cwd));
            if (affected.some((thread) => thread.status === "running" || !agents.canOperate(thread.id))) {
              throw new HttpError(409, "The worktree is in use by an active session");
            }
            await git.moveWorktree({ root: info.root!, path: target, to });
            for (const thread of affected) {
              threads.setCwd(thread.id, to + thread.cwd.slice(target.length));
            }
            publish({ type: "projects.changed" });
            return { ok: true, path: to };
          });
        },
      },
      ```

- [ ] 9. Add fetch/pull/push routes (no thread guard — they change
      neither the worktree's path nor its session's validity):
      ```ts
      {
        method: "POST",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/fetch$/,
        handler: async ({ params, request }) => {
          requireProject(params[0]!);
          const body = await readBody(request);
          const target = path.resolve(requireString(body, "path"));
          return { output: await git.fetchWorktree(target) };
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/pull$/,
        handler: async ({ params, request }) => {
          requireProject(params[0]!);
          const body = await readBody(request);
          const target = path.resolve(requireString(body, "path"));
          return { output: await git.pullWorktree(target) };
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/push$/,
        handler: async ({ params, request }) => {
          requireProject(params[0]!);
          const body = await readBody(request);
          const target = path.resolve(requireString(body, "path"));
          return { output: await git.pushWorktree(target) };
        },
      },
      ```

- [ ] 10. Add the favorite toggle route:
      ```ts
      {
        method: "POST",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/favorite$/,
        handler: async ({ params, request }) => {
          const project = requireProject(params[0]!);
          const body = await readBody(request);
          const target = path.resolve(requireString(body, "path"));
          if (body.favorite === false) {
            worktreeFavorites.remove(project.id, target);
          } else {
            worktreeFavorites.add(project.id, target);
          }
          return { ok: true };
        },
      },
      ```

- [ ] 11. Add the merged-candidates and remove-merged routes:
      ```ts
      {
        method: "GET",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/merged-candidates$/,
        handler: async ({ params }) => {
          const project = requireProject(params[0]!);
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) return { candidates: [] };
          const worktrees = await git.listWorktrees(info.root);
          const main = worktrees.find((worktree) => worktree.isMain);
          if (!main?.branch) return { candidates: [] };
          const merged = await git.mergedBranches(info.root, main.branch);
          const candidates = worktrees.filter(
            (worktree) => !worktree.isMain && !worktree.locked && worktree.branch && merged.has(worktree.branch),
          );
          return { candidates };
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/projects\/([^/]+)\/worktrees\/remove-merged$/,
        handler: async ({ params, request }) => {
          const project = requireProject(params[0]!);
          const body = await readBody(request);
          const paths = Array.isArray(body.paths)
            ? body.paths.filter((entry): entry is string => typeof entry === "string")
            : [];
          if (paths.length === 0) throw new HttpError(400, "`paths` is required");
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) throw new HttpError(400, "Project is not a git repository");
          const worktrees = await git.listWorktrees(info.root);
          const main = worktrees.find((worktree) => worktree.isMain);
          if (!main?.branch) throw new HttpError(400, "The main worktree has no branch checked out");
          const merged = await git.mergedBranches(info.root, main.branch);
          const removed: string[] = [];
          for (const target of paths.map((entry) => path.resolve(entry))) {
            const worktree = worktrees.find((entry) => entry.path === target);
            if (!worktree || worktree.isMain) continue;
            if (worktree.locked) {
              throw new HttpError(400, `${target} is locked${worktree.lockReason ? `: ${worktree.lockReason}` : ""}`);
            }
            if (!worktree.branch || !merged.has(worktree.branch)) continue; // no longer merged; skip, don't fail the batch
            const usesTarget = (cwd: string) =>
              path.resolve(cwd) === target || path.resolve(cwd).startsWith(`${target}${path.sep}`);
            const ids = threads
              .list()
              .filter((thread) => thread.projectId === project.id && usesTarget(thread.cwd))
              .map((thread) => thread.id);
            await withThreadOperations(ids, async () => {
              const affected = threads
                .list()
                .filter((thread) => thread.projectId === project.id && usesTarget(thread.cwd));
              if (affected.some((thread) => thread.status === "running" || !agents.canOperate(thread.id))) {
                throw new HttpError(409, `${target} is in use by an active session`);
              }
              const reserved: Array<{ id: string; status: (typeof affected)[number]["status"] }> = [];
              try {
                for (const thread of affected) {
                  if (!agents.reserveThread(thread.id)) throw new HttpError(409, "A worktree session is busy");
                  reserved.push({ id: thread.id, status: thread.status });
                  agents.closeSession(thread.id);
                }
                await git.removeWorktree({ root: info.root!, path: target, force: false });
                removed.push(target);
              } finally {
                for (const thread of reserved) agents.releaseThreadReservation(thread.id, thread.status);
              }
            });
          }
          await git.pruneWorktrees(info.root);
          publish({ type: "projects.changed" });
          return { removed };
        },
      },
      ```
      This duplicates the reserve/close/release dance from the existing
      DELETE worktrees route rather than extracting a shared helper —
      deliberate, to avoid touching that route's already-covered
      behavior in this task.

- [ ] 12. In `web/src/lib/types.ts`, update the existing `Worktree`
      interface (around line 220):
      ```ts
      export interface Worktree {
        path: string;
        branch: string | null;
        isMain: boolean;
        locked: boolean;
        lockReason: string | null;
        favorite: boolean;
      }
      ```

- [ ] 13. Run `pnpm -C server typecheck` and `pnpm -C web typecheck`.
      Expect: both clean.

- [ ] 14. Manual verification against a scratch repo:
      ```bash
      mkdir -p /tmp/sr03-wt && cd /tmp/sr03-wt && git init -q -b main \
        && echo one > a.txt && git add . && git commit -qm init
      ```
      Start the server, add the project, create a worktree through the
      running app, then from a shell:
      ```bash
      curl -s -X POST http://localhost:3399/api/projects/<id>/worktrees/lock \
        -H 'content-type: application/json' -d '{"path":"<worktree-path>","reason":"testing"}'
      curl -s -X DELETE http://localhost:3399/api/projects/<id>/worktrees \
        -H 'content-type: application/json' -d '{"path":"<worktree-path>","force":true}'
      ```
      Expect: the lock call returns `{"ok":true}`; the delete call
      returns a 400 whose `error` mentions "testing" (git's own lock
      message). Then unlock and repeat the delete — expect `{"ok":true}`.

- [ ] 15. `git add server/src/db.ts server/src/api.ts web/src/lib/types.ts`
      `git commit -m "feat(api): add worktree lock, move, sync, and favorites"`

## Done when

Both typechecks are clean, the manual scenario in step 14 shows the
locked worktree rejecting removal with git's own lock-reason text and
succeeding after unlock, and `worktree_favorites` rows survive a server
restart (`kill` and re-run `pnpm dev`, then `GET
/api/projects/<id>/git` still shows `favorite: true` for a path you
favorited beforehand).
