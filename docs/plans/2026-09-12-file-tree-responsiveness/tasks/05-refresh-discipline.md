# Task 5: Capped concurrency, one ignore lookup, bounded auto-expand

**Depends on:** Task 1, Task 2, Task 4
Task 2 provides the `rows` projection this task's ignore effect keys on. Task 4 provides
`EMPTY_DIRS`, `loadingDirs`, and the token-guarded `load()` that step 8 routes the refresh through.
Executing this before either of them fails `pnpm -C web typecheck` on undefined identifiers.

**Files:**
- Modify: `server/src/api.ts` (tree route at `:812`; new route after it)
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/components/FileTree.tsx`

**Interfaces:**
- Consumes from `web/src/lib/filetree.ts`: `forEachWithConcurrency`, `REFRESH_CONCURRENCY`,
  `autoExpandFor`, `createDirLoadTracker`
- Produces, server: `POST /api/threads/:id/ignored`, body `{ paths: string[] }`,
  response `{ ignored: string[] }`
- Produces, client: `api.ignored(id: string, paths: string[]): Promise<{ ignored: string[] }>`

## The three problems being fixed

1. `FileTree.tsx:449` fires `api.tree` for **every** expanded directory at once with no cap, and
   bypasses `load()` entirely — so Task 4's token guarding does not protect it.
2. Each of those calls spawns its own `git check-ignore` subprocess (`server/src/api.ts:818-821`),
   so a thirty-folder refresh means thirty concurrent git spawns.
3. `FileTree.tsx:477` auto-expands the ancestors of every changed file unconditionally. After a
   branch switch with hundreds of changed files that expands hundreds of directories at once, each
   triggering its own load, on top of the uncapped refresh above.

This task ships as **three commits**, one per problem. They are independently reviewable and only
the first has a server half that must land atomically with its client half.

---

## Part A — one ignore lookup per refresh

- [ ] 1. Add the batch route to `server/src/api.ts` immediately after the tree route's closing
      `},` at `:827`, following the shape of the `POST /api/threads/:id/fs` route at `:829`:
      ```ts
      {
        method: "POST",
        pattern: /^\/api\/threads\/([^/]+)\/ignored$/,
        handler: async ({ params, request }) => {
          const thread = requireThread(params[0]!);
          const body = await readBody(request);
          const paths = Array.isArray(body.paths)
            ? body.paths.filter((entry): entry is string => typeof entry === "string")
            : [];
          return { ignored: [...(await git.ignoredPaths(thread.cwd, paths))] };
        },
      },
      ```
      `git.ignoredPaths` (`server/src/git.ts:616`) already returns an empty set for an empty list,
      so no further guard is needed.

- [ ] 2. Strip the ignore computation out of the tree route. Delete `server/src/api.ts:818-821`
      (the `const ignored = await git.ignoredPaths(…)` call) and replace the return at `:822-825`
      with `return { path: rel, entries };`. Do **not** write a `.map` that sets `ignored: false` —
      `listWorkspaceDir` already sets it (`server/src/fsbrowse.ts:231`), so a map would be dead work.

- [ ] 3. There is no comment above the tree route to update (`server/src/api.ts:810-813` is route
      boilerplate). Add a one-line comment above the new batch route saying that ignore status is
      answered for the whole visible tree at once, because one `check-ignore` per directory was the
      cost being removed. Nothing else in `api.ts` needs a comment change.

- [ ] 4. Add the client method to `web/src/lib/api.ts` beside `tree` at `:184`:
      ```ts
      ignored: (id: string, paths: string[]) =>
        post<{ ignored: string[] }>(`/api/threads/${id}/ignored`, { paths }),
      ```

- [ ] 5. Hold the ignore answer in `FileTree` as its own state:
      `const [ignoredSet, setIgnoredSet] = useState<ReadonlySet<string>>(EMPTY_DIRS);`
      (`EMPTY_DIRS` comes from Task 4 step 1.)

- [ ] 6. Key the request on content, not identity. The projection is rebuilt whenever `dirs`
      commits, so an effect keyed on the array would re-issue the whole lookup per refresh wave:
      ```ts
      const visiblePaths = useMemo(() => rows.map((row) => row.entry.path), [rows]);
      const ignoreKey = useMemo(() => visiblePaths.join("\n"), [visiblePaths]);
      ```
      `\n` is safe as a separator: it cannot appear in a path segment on any platform this runs on.
      The effect below depends on `ignoreKey`, not `visiblePaths`.

- [ ] 7. Write the effect, keyed on `[ignoreKey, fsTick, tick]` and **debounced by 150ms**. Both
      parts are load-bearing:
      - `fsTick` / `tick` because `ignoreKey` alone is a primitive string that does not change when
        the tree is unchanged — so editing `.gitignore` and hitting Refresh would never re-issue the
        lookup, and step 11 below would fail;
      - the debounce because Task 5 Part B routes each directory through `load()`, which commits its
        own `setDirs`. A 40-folder refresh therefore produces up to 40 distinct `ignoreKey` values
        in quick succession, and without a debounce that is 40 POSTs — the opposite of criterion 7.
      Guard it with its own tracker instance — a second `createDirLoadTracker()` held in a ref, using
      the fixed key `"ignored"` — so a late answer cannot overwrite a newer one. On resolve, replace
      `ignoredSet`.
      **Do not clear `ignoredSet` while a new answer is in flight.** Keeping the previous answer
      means rows already known to be ignored stay dimmed instead of flashing to normal text and
      back. Newly appeared rows render un-ignored for one round trip; that is the accepted trade
      and is what Orca does.

- [ ] 8. Switch `Row`'s ignore source. `entry.ignored` from the server is now always `false`; pass
      `ignored={ignoredSet.has(entry.path)}` into `Row` and use it for the tint and the muted
      icons. Leave `TreeEntry.ignored` in `web/src/lib/types.ts` — the field still exists on the
      wire — but stop reading it in the component.

- [ ] 9. Run `pnpm typecheck` and `pnpm test`. Expect: no output / no new failures.

- [ ] 10. Verify the spawn count deterministically — a `pgrep` poll would miss a ~10ms subprocess
      and read zero whether or not the fix landed. Instead, temporarily add
      `console.log("[check-ignore]", paths.length)` as the first line of `ignoredPaths` in
      `server/src/git.ts:616`, restart `pnpm dev`, open `/tmp/sr03-big` with at least 20 folders
      expanded, and click the panel's Refresh button.
      Expect: **one** `[check-ignore]` line per refresh — the 150ms debounce collapses the wave of
      per-directory commits into a single lookup — with a `paths.length` in the hundreds. Before the
      change it was one line per expanded folder, each with a handful of paths.
      A refresh over a tree whose contents did not change may legitimately log nothing, because the
      listings are identical and no state settles differently; touch a file under one of the
      expanded folders first so the refresh has something to commit.
      Remove the log and confirm `git diff server/src/git.ts` prints nothing.

- [ ] 11. Verify decoration is unchanged: on `/tmp/sr03-big`, `pkg39` and `pkg40` render dimmed
      (they are in its `.gitignore`). Then `printf '' > /tmp/sr03-big/.gitignore` and hit Refresh.
      Expect: both un-dim. This exercises the `fsTick`/`tick` dependency from step 7 — with the
      effect keyed on `ignoreKey` alone the visible path set is unchanged, no POST is issued, and
      they stay dimmed. Restore with `printf 'pkg39/\npkg40/\n' > /tmp/sr03-big/.gitignore`.

- [ ] 12. Commit both halves together — splitting them ships a client that renders nothing as
      ignored:
      `git add server/src/api.ts web/src/lib/api.ts web/src/components/FileTree.tsx`
      `git commit -m "perf(files): answer git ignore for the whole tree in one call"`

---

## Part B — cap the refresh fan-out

- [ ] 13. Rewrite the refresh effect at `FileTree.tsx:444-470`. It currently runs
      `Promise.all([api.changes(…), Promise.all(open.map((path) => api.tree(…)))])`. Split those two
      concerns inside an async IIFE (an effect body cannot be `async`):
      ```ts
      useEffect(() => {
        let cancelled = false;
        void (async () => {
          try {
            const next = await api.changes(thread.id);
            if (cancelled) return;
            setChanges(new Map(next.files.map((f) => [f.path, f.status])));
            setBranch(next.branch);
            setError(null);
          } catch (cause) {
            if (!cancelled) setError((cause as Error).message);
          }
          await forEachWithConcurrency(open, REFRESH_CONCURRENCY, (path) => load(path, { force: true }));
        })();
        return () => { cancelled = true; };
      }, [...]);
      ```
      Keep the existing `setError(null)` / `setError(cause.message)` handling that
      `FileTree.tsx:462-466` has today — dropping it leaves a failed change-set read silent.

- [ ] 14. Route every directory read through `load()`. This is what brings the refresh path under
      Task 4's token guarding — spec criterion 4 says "a newer read of the same directory" must win,
      and today a manual folder reload landing mid-refresh is unguarded because the refresh calls
      `api.tree` directly. `load`'s `{ force?: boolean }` option already exists (Task 4 step 4): it
      bypasses the "already cached" early return and suppresses the spinner delay. Nothing further
      is needed here — do not add a second early-return to `load`.

- [ ] 15. Keep the `cancelled` flag for the `api.changes` half only. The directory half no longer
      needs it — `load`'s per-directory tokens supersede a stale read, and a session change unmounts
      the whole panel (`App.tsx:83` keys `ChatView` by thread), taking every in-flight closure with
      it.

- [ ] 16. Run `pnpm typecheck`. Expect: no output, exit 0.

- [ ] 17. Verify the cap. Temporarily add a module-level counter in `web/src/lib/api.ts` around the
      `tree` method — increment on call, decrement on settle, and
      `console.log("[tree] in flight", n)` — then refresh `/tmp/sr03-big` with all 40 folders
      expanded.
      Expect: the logged maximum is 16 (`REFRESH_CONCURRENCY`), never 40. Remove the counter and
      confirm `git diff web/src/lib/api.ts` prints nothing.

- [ ] 18. Commit:
      `git add web/src/components/FileTree.tsx`
      `git commit -m "perf(files): cap directory reads during a tree refresh"`

---

## Part C — bound the auto-expand

- [ ] 19. Replace the body of the auto-expand effect at `FileTree.tsx:473-481`. Call
      `autoExpandFor(new Set(changes.keys()))`. When it returns `null`, return without touching
      `expanded`. When it returns a set, **union** it into the current `expanded` — never replace,
      or expanding a folder by hand would be undone by the next change-set update. Keep the
      existing identity bailout (`next.size === current.size ? current : next`) so an unchanged set
      does not re-render.

- [ ] 20. Confirm the header still reports the count in the skipped case. `FileTree.tsx` renders
      `{changes.size} changed` in its header; verify it is not gated on anything the bailout
      changes, so a user whose tree did not auto-expand still learns why.

- [ ] 21. Run `pnpm typecheck` and `pnpm test`. Expect: no output / no new failures.

- [ ] 22. Verify both sides of the threshold. Build a large change set on the fixture:
      ```bash
      cd /tmp/sr03-big && git checkout -q -b churn && \
        for d in $(seq 1 10); do for f in $(seq 1 30); do echo "// touched" >> "pkg$d/src/m$f.ts"; done; done
      ```
      That is 300 changed files. Expect: the tree does not auto-expand, the header shows
      `300 changed`, and the panel stays responsive.
      Then `git checkout -q -- . && echo x >> pkg1/src/m1.ts` for a single change: expect `pkg1`
      and `pkg1/src` to auto-expand as before.
      Clean up completely — Tasks 2 and 3 reuse this fixture and expect it pristine:
      ```bash
      cd /tmp/sr03-big && git checkout -q -- . && git checkout -q main && git branch -qD churn && git status --short
      ```
      Expect: no output from `git status --short`.

- [ ] 23. Commit:
      `git add web/src/components/FileTree.tsx`
      `git commit -m "perf(files): skip auto-expand for very large change sets"`

## Done when

One `git check-ignore` runs per refresh instead of one per directory; the logged in-flight tree
count peaks at `REFRESH_CONCURRENCY`; every refresh read goes through the token-guarded `load()`;
a 300-file change set does not auto-expand while a 1-file set still does; ignore decoration is
unchanged to the eye; both temporary instrumentation patches are reverted; and `pnpm test` and
`pnpm typecheck` are clean.
