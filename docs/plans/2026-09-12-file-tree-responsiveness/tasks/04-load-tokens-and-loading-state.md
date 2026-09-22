# Task 4: Stale-read guarding and visible loading state

**Depends on:** Task 1, Task 2, Task 3
Task 2 supplies the memoized `Row` that step 11 adds a prop to. Task 3 supplies the virtualizer,
which constrains how errors may be rendered — see step 8.

**Files:**
- Modify: `web/src/components/FileTree.tsx`
- Modify: `web/src/components/ui.tsx` (spinner icon alias, if absent)

**Interfaces:**
- Consumes from `web/src/lib/filetree.ts`: `createDirLoadTracker`, and the `DirLoadTracker` type
- Produces, for Task 5: the module-level `EMPTY_DIRS` constant, the `loadingDirs` state, and
  `load(path, options?: { force?: boolean })`

## The problem being fixed

`load()` (`FileTree.tsx:434`) writes into `dirs` unconditionally when its request resolves, so two
reads of the same directory can land out of order. Separately, expanding a folder shows nothing at
all until the round trip completes — the chevron turns and the row stays empty, which is the
"sudden" feel this whole plan exists to remove.

**No session reset is needed.** `App.tsx:83` renders `<ChatView key={thread.id}>`, so the whole
panel unmounts and remounts when the session changes. The tracker, the caches and every in-flight
closure go with it. Do not add a reset effect; it would be dead code.

## Steps

- [ ] 1. Add a module-level constant: `const EMPTY_DIRS: ReadonlySet<string> = new Set();`
      It exists so the two loading sets have a stable empty identity across renders and so Task 5
      can reuse it — not for `memo`, which compares the derived booleans, not the sets.

- [ ] 2. Add the tracker. Use a nullable ref with an explicit lazy init rather than `??=` on a
      non-nullable ref, which TypeScript 5.7 (`web/package.json` pins `^5.7.0`) can reject as an
      unreachable right operand:
      ```ts
      const trackerRef = useRef<DirLoadTracker | null>(null);
      if (trackerRef.current === null) trackerRef.current = createDirLoadTracker();
      ```

- [ ] 3. Add the two loading sets:
      ```ts
      const [loadingDirs, setLoadingDirs] = useState<ReadonlySet<string>>(EMPTY_DIRS);
      const [slowDirs, setSlowDirs] = useState<ReadonlySet<string>>(EMPTY_DIRS);
      ```
      `loadingDirs` is the truth — step 9 guards the expansion effect with it and Task 5 reads it.
      `slowDirs` is the subset that has been loading long enough to show a spinner.

- [ ] 4. Give `load` a `force` option: `load(path: string, options?: { force?: boolean })`. Without
      `force` it returns early when `dirs[path]` already has entries; with it, it always re-reads.
      Task 5's refresh passes `force: true`.

- [ ] 5. Take a token before the request — `const token = trackerRef.current!.begin(path)` — and add
      `path` to `loadingDirs`.

- [ ] 6. In the resolve handler, check currency **before** anything else:
      `if (!trackerRef.current!.isCurrent(token)) return;`
      Only then write the entries, clear any `dirErrors[path]`, and drop `path` from both sets. The
      check must guard the loading-flag clear as well as the data write — a superseded read clearing
      the flag would drop the spinner while the read that replaced it is still in flight. That is
      the specific bug the check exists to prevent.

- [ ] 7. In the reject handler, apply the same currency check, then record the message in
      `dirErrors` (step 8) and drop `path` from both sets.

- [ ] 8. Add per-directory errors as **panel state, not list rows**:
      `const [dirErrors, setDirErrors] = useState<Record<string, string>>({})`.
      Render them as a single strip in the panel header — "Could not read `<path>`" for the most
      recent one — never as entries in the virtualized list. Task 3's indexing rule
      (`count`/`getItemKey`/`rowAt`) admits exactly one entry-less list position, the create row;
      adding a second class of phantom row would need its own rule and would break that one.
      Keep the existing panel-level `error` for mutation failures and for a failed **root** read, so
      root failure stays distinguishable from an empty root — criterion 10.

- [ ] 9. Guard the expansion effect at `FileTree.tsx:482-484`. It currently reads
      `for (const path of expanded) if (!dirs[path]) void load(path)` with deps
      `[expanded, dirs, load]`. Change the condition to
      `if (!dirs[path] && !loadingDirs.has(path) && !dirErrors[path])` and add both to the deps.
      Both new clauses are load-bearing:
      - without `loadingDirs`, a directory in flight but not yet in `dirs` is re-loaded every time
        any *other* directory resolves, bumping its revision and invalidating its own token forever;
      - without `dirErrors`, a directory whose read **failed** retries without limit — the reject
        handler removes it from `loadingDirs`, which re-fires the effect, which calls `load` again.
        That loop would fire on the very case step 17 tests.
      A later successful read clears `dirErrors[path]` (step 6), so recovery still works.

- [ ] 10. Add the spinner delay, and **skip it for forced reads**. When adding `path` to
      `loadingDirs`, start a `window.setTimeout` of `150` that adds `path` to `slowDirs` — unless
      `options.force` is set. Clear the timer in both handlers. Hold timers in
      `useRef<Map<string, number>>`; `window.setTimeout` returns `number`, whereas a bare
      `setTimeout` resolves to the Node overload under this repo's `"types": ["vite/client", "node"]`
      (`web/tsconfig.json:14`) and returns `NodeJS.Timeout`. Every one of the repo's existing timer
      call sites uses `window.setTimeout` for this reason.
      Skipping the delay for forced reads is what keeps a routine refresh from flashing a spinner on
      every open folder — the spec's "rows whose content did not change do not visibly change".

- [ ] 11. Show the spinner **in the icon slot, not the chevron slot**. Pass
      `isLoading={entry.isDir && slowDirs.has(entry.path)}` into `Row`; when true, replace the
      folder icon with a spinner and leave the chevron turned. Criterion 2 wants the turned chevron
      *and* an indicator, so replacing the chevron would lose the state the user just changed.
      Use the `lucide-react` loader through the alias convention in `web/src/components/ui.tsx`;
      add the alias there if missing. Do not hand-draw an SVG or use a text character.

- [ ] 12. Run `pnpm -C web typecheck`. Expect: no output, exit 0.

- [ ] 13. Patch in an artificial delay for the next three steps: in `web/src/lib/api.ts`, wrap the
      `tree` method's promise in a random 0–2000ms delay. Note in `progress.md` that the patch is
      live, so a crash mid-task does not leave it committed.

- [ ] 14. Verify stale-read guarding on `/tmp/sr03-big`: expand three folders in quick succession,
      then collapse and re-expand one of them repeatedly.
      Expect: no folder ever shows another folder's children, and no spinner is left stuck on a row
      after its read lands.

- [ ] 15. Verify the delayed spinner both ways. With the patch live, expanding a folder shows a
      spinner beside a turned chevron. Remove the patch, restart, and expand a folder on
      `/tmp/sr03-repo`: no spinner appears at all.

- [ ] 16. Confirm the patch is gone: `git diff web/src/lib/api.ts` must print nothing.

- [ ] 17. Verify the failure path, which nothing else in this plan covers. Note that `chmod a-x`
      does **not** fail `readdir` on macOS — APFS supplies `d_type`, so no `stat` is needed. Use
      `a-r`:
      ```bash
      mkdir -p /tmp/sr03-repo/locked && touch /tmp/sr03-repo/locked/f.txt && chmod a-r /tmp/sr03-repo/locked
      ```
      Expand `locked`. Expect: the header strip names it, every other row stays clickable, the panel
      is not blanked, and — critically — the request is issued **once**, not in a loop. Watch the
      Network tab to confirm. Restore with `chmod u+r /tmp/sr03-repo/locked`, collapse and re-expand,
      and confirm the error clears.

- [ ] 18. Commit:
      `git add web/src/components/FileTree.tsx web/src/components/ui.tsx`
      `git commit -m "fix(files): discard superseded directory reads and show load state"`

## Done when

A late or superseded read cannot change the tree; no spinner survives its read; a sub-150ms read
and every forced refresh read show no spinner; an unreadable directory reports once, does not
retry, and leaves the rest of the tree usable; `git diff web/src/lib/api.ts` is empty.
