# Task 2: API routes + web types for graph data

**Depends on:** Task 1
**Files:**
- Modify: `server/src/api.ts`
- Modify: `web/src/lib/types.ts`

**Interfaces consumed:** `git.commitLog`, `git.listRefs`, `git.commitFiles`,
`git.commitFileDiff`, `git.repoInfo`, `git.changedFiles`, `git.fileDiff`,
`git.GitError` (all from Task 1 / existing `git.ts`), `requireProject`,
`HttpError`, `readBody` (all existing in `server/src/api.ts`).

**Interfaces produced:** six new REST routes (paths below) and matching
`Commit`/`Ref`/`CommitFile` types in `web/src/lib/types.ts`.

## Steps

- [ ] 1. In `server/src/api.ts`, find `handleApiRequest`'s catch block
      (around line 1123):
      ```ts
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error("[api]", error);
        json(response, status, { error: (error as Error).message });
      }
      ```
      Change the status line to also treat `git.GitError` as a client
      error:
      ```ts
      const status = error instanceof HttpError ? error.status : error instanceof git.GitError ? 400 : 500;
      ```

- [ ] 2. Immediately after the existing `GET
      /^\/api\/projects\/([^/]+)\/git$/` route (ends around line 351 —
      search for `"branches, worktrees };"` to find it), insert two new
      routes:
      ```ts
      {
        method: "GET",
        pattern: /^\/api\/projects\/([^/]+)\/refs$/,
        handler: async ({ params }) => {
          const project = requireProject(params[0]!);
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) return { refs: [] };
          return { refs: await git.listRefs(info.root) };
        },
      },
      {
        method: "GET",
        pattern: /^\/api\/projects\/([^/]+)\/log$/,
        handler: async ({ params, url }) => {
          const project = requireProject(params[0]!);
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) return { commits: [], hasMore: false };
          const maxCount = Math.min(Math.max(Number(url.searchParams.get("maxCount")) || 200, 1), 500);
          const skip = Math.max(Number(url.searchParams.get("skip")) || 0, 0);
          const ref = url.searchParams.get("ref")?.trim() || undefined;
          if (ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(ref)) {
            throw new HttpError(400, "Invalid ref");
          }
          return git.commitLog(info.root, { maxCount, skip, ref });
        },
      },
      ```

- [ ] 3. Add two more routes for a single commit's files and a single
      file's diff within that commit, right after the two above:
      ```ts
      {
        method: "GET",
        pattern: /^\/api\/projects\/([^/]+)\/commits\/([0-9a-f]{40})\/files$/,
        handler: async ({ params }) => {
          const project = requireProject(params[0]!);
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) throw new HttpError(400, "Project is not a git repository");
          return { files: await git.commitFiles(info.root, params[1]!) };
        },
      },
      {
        method: "GET",
        pattern: /^\/api\/projects\/([^/]+)\/commits\/([0-9a-f]{40})\/diff$/,
        handler: async ({ params, url }) => {
          const project = requireProject(params[0]!);
          const info = await git.repoInfo(project.path);
          if (!info.isGit || !info.root) throw new HttpError(400, "Project is not a git repository");
          const file = url.searchParams.get("path")?.trim() ?? "";
          if (!file || file.startsWith("-") || file.split("/").includes("..")) {
            throw new HttpError(400, "`path` is required");
          }
          return { path: file, diff: await git.commitFileDiff(info.root, params[1]!, file) };
        },
      },
      ```

- [ ] 4. Add two project-scoped mirrors of the existing thread-scoped
      `changes`/`diff` routes (compare `GET /^\/api\/threads\/([^/]+)\/changes$/`
      around line 747 and `GET /^\/api\/threads\/([^/]+)\/diff$/` around
      line 756) — these back the graph panel's "uncommitted changes"
      synthetic row, which has no thread to key off of:
      ```ts
      {
        method: "GET",
        pattern: /^\/api\/projects\/([^/]+)\/changes$/,
        handler: async ({ params }) => {
          const project = requireProject(params[0]!);
          const [info, files] = await Promise.all([
            git.repoInfo(project.path),
            git.changedFiles(project.path),
          ]);
          return { isGit: info.isGit, branch: info.branch, files };
        },
      },
      {
        method: "GET",
        pattern: /^\/api\/projects\/([^/]+)\/diff$/,
        handler: async ({ params, url }) => {
          const project = requireProject(params[0]!);
          const file = url.searchParams.get("file")?.trim() ?? "";
          if (!file || file.startsWith("-") || file.split("/").includes("..")) {
            throw new HttpError(400, "`file` is required");
          }
          const untracked = url.searchParams.get("untracked") === "1";
          return { file, diff: await git.fileDiff(project.path, file, untracked) };
        },
      },
      ```

- [ ] 5. In `web/src/lib/types.ts`, add the client-facing types next to
      the existing `Branch`/`Worktree`/`ChangedFile` interfaces (around
      line 214):
      ```ts
      export interface Commit {
        hash: string;
        parents: string[];
        authorName: string;
        authorEmail: string;
        authorDate: number;
        message: string;
      }

      export interface Ref {
        name: string;
        kind: "head" | "tag" | "remote";
        commit: string;
      }

      export interface CommitFile {
        path: string;
        status: "added" | "modified" | "deleted" | "renamed";
        insertions: number;
        deletions: number;
        binary: boolean;
      }
      ```

- [ ] 6. Run `pnpm -C server typecheck` and `pnpm -C web typecheck`.
      Expect: both clean — `git.ts`'s exports match the shapes used in
      the new routes, and `web/src/lib/types.ts` compiles standalone.

- [ ] 7. Manual smoke test against a scratch repo (per the repo's
      Testing section):
      ```bash
      mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
        && echo hello > README.md && git add . && git commit -qm init
      ```
      Start the server (`pnpm dev` from the repo root), add
      `/tmp/sr03-repo` as a project through the running app, note its
      project id from `GET /api/state`, then:
      ```bash
      curl -s http://localhost:3399/api/projects/<id>/log | head -c 300
      curl -s http://localhost:3399/api/projects/<id>/refs
      ```
      Expect: `log` returns one commit with `"parents":[]` and
      `"message":"init"`; `refs` returns one `head` ref named `main`.

- [ ] 8. `git add server/src/api.ts web/src/lib/types.ts`
      `git commit -m "feat(api): expose commit log, refs, and commit diffs"`

## Done when

Both typechecks pass, the curl smoke test in step 7 returns the expected
shapes, and a deliberately malformed request (e.g. a `path` query
param of `../etc/passwd` on the commit-diff route) returns 400, not 500.
