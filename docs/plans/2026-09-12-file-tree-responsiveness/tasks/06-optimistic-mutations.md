# Task 6: Create, rename and delete paint before the server answers

**Depends on:** Task 1
**Files:**
- Modify: `web/src/components/FileTree.tsx`

**Interfaces:**
- Consumes from `web/src/lib/filetree.ts`: `insertEntry`, `removeEntry`, `replaceEntry`, `parentOf`
- Produces: no new exports; the `onRenamed` / `onDeleted` prop contracts are unchanged

## The problem being fixed

`commitCreate` (`FileTree.tsx:504`), `commitRename` (`:520`) and `confirmDelete` (`:532`) each
await the server and *then* call `load(parent)` — two sequential round trips before anything moves
on screen.

## How to snapshot, and how not to

Read the previous entries **from the `dirs` value already in scope**:

```ts
const previous = dirs[parent];
```

These three functions are defined in render scope, so `dirs` is the committed state. Do **not**
try to capture the previous value from inside a `setDirs` updater and return it — React does not
run state updaters synchronously from an event handler, so the captured value would be `undefined`
most of the time and every mutation would silently fall back to the non-optimistic path.

A directory that is not loaded (`previous === undefined`) has nothing on screen to be optimistic
about: await the server and `load(parent)` as today.

## The rollback contract

Every mutation follows the same three phases:

1. Snapshot `dirs[parent]` and apply the change to `dirs` immediately, clearing the inline input.
2. Await the server.
3. On success, nothing more is needed: the server does **not** normalise names.
   `createWorkspaceEntry` returns `path: rel` verbatim (`server/src/fsbrowse.ts:268`) and
   `renameWorkspaceEntry` returns `path.join(dirname(rel), name)` (`:279`, `:288`), which for the
   slash-free name it already enforces (`:276`) always equals the path the client computed. On
   failure, restore the snapshot and set the panel-level `error` naming the operation and the
   server's message.

Do not write a "reconcile if the returned path differs" branch — it cannot execute, and dead
error-handling is worse than none because the next reader will trust it.

## Steps

- [ ] 1. Replace the component-local `const parentOf` (`FileTree.tsx:518`) with the import from
      `web/src/lib/filetree.ts`. It shadows the import otherwise, and leaving both trips
      `noUnusedLocals` (`web/tsconfig.json:10`). Its two callers (`commitRename`, `confirmDelete`)
      need no change — the signature is identical.

- [ ] 2. Add one helper to `FileTree` for applying a change to a single directory:
      ```ts
      const applyToDir = (dir: string, change: (entries: readonly TreeEntry[]) => TreeEntry[]) =>
        setDirs((current) =>
          current[dir] === undefined ? current : { ...current, [dir]: change(current[dir]!) },
        );
      ```
      It does not return a snapshot — callers read `dirs[dir]` directly, per the section above.

- [ ] 3. Rewrite `commitCreate`'s optimistic write. Bind `const parent = creating.parent` and
      `const previous = dirs[parent]` **before** clearing `creating` — step 3 clears it, and steps
      4-5 still need both. Then
      `applyToDir(parent, (entries) => insertEntry(entries, { name, path: target, isDir: creating.kind === "dir", ignored: false }))`
      and clear `creating`.

- [ ] 4. Add `commitCreate`'s success handling: expand the new entry if it is a directory, or open
      it if it is a file, exactly as today. No path reconcile — see the section above.

- [ ] 5. Add `commitCreate`'s failure rollback: restore with
      `applyToDir(parent, () => [...previous!])` and set `error`.

- [ ] 6. Rewrite `commitRename`'s optimistic write:
      `applyToDir(parentOf(entry.path), (entries) => replaceEntry(entries, entry.path, { ...entry, name, path: next }))`
      where `next` is the sibling path with the new name. Clear `renaming` immediately.

- [ ] 7. Call `onRenamed(entry.path, next)` **only after** the server confirms. That
      prop retargets open editor tabs; retargeting to a path that does not exist would leave the
      editor showing an error for a file that was never created.

- [ ] 8. Add `commitRename`'s failure rollback: restore the snapshot and set `error`.
      A rename that moves an entry between directories is out of scope — `api.renameEntry` takes a
      name, not a path, so the parent cannot change.

- [ ] 9. Rewrite `confirmDelete`. Keep the existing confirmation dialog in front of it — this is
      the one destructive mutation and the dialog is the user's real decision point. After
      confirmation, `applyToDir(parentOf(path), (entries) => removeEntry(entries, path))`, close the
      dialog, then await. On success call `onDeleted(path)`.

- [ ] 10. Add `confirmDelete`'s failure rollback: restore the snapshot, set `error`, leave the
      entry where it was. Add a one-line comment noting that rollback restores a row, not a file —
      by the time a failure can be reported for anything but the request itself, the file is already
      in the Trash.

- [ ] 11. Delete the `load(parent)` call that follows each of the three mutations. They are now
      redundant — the optimistic write plus the reconcile leave `dirs` correct, and the next refresh
      re-reads anyway. Leaving them reintroduces the second round trip this task removes.

- [ ] 12. Narrow `busy`. Keep it bound to the delete dialog's buttons; drop it from the create and
      rename paths, which now complete visually before the request finishes — a disabled state there
      would be feedback for something the user has already seen happen.

- [ ] 13. Run `pnpm -C web typecheck`. Expect: no output, exit 0. An unused-local error naming
      `parentOf` means step 1 was not completed.

- [ ] 14. Verify the happy path on `/tmp/sr03-repo`: create a file, create a folder, rename, and
      delete. Each moves the tree immediately. Then hit the panel's Refresh and confirm no
      duplicated rows, no ghosts, and sort order intact.

- [ ] 15. Verify create rollback: create a file whose name already exists in that folder. Expect:
      the row appears, then disappears, and the panel shows an error naming the operation.

- [ ] 16. Verify rename rollback: rename a file to a name that already exists. Expect: the name
      changes, then reverts, with an error.

- [ ] 17. Verify delete rollback:
      ```bash
      mkdir -p /tmp/sr03-repo/ro && touch /tmp/sr03-repo/ro/f.txt && chmod a-w /tmp/sr03-repo/ro
      ```
      Delete `f.txt` from the panel. Expect: the row disappears, then returns, with an error.
      Restore with `chmod u+w /tmp/sr03-repo/ro`.

- [ ] 18. Verify the editor-tab contract: open a file in the editor, rename it, and confirm the tab
      retargets only after the rename succeeds. Then force a rename failure with the file open and
      confirm the tab still points at the original path.

- [ ] 19. Commit:
      `git add web/src/components/FileTree.tsx`
      `git commit -m "feat(files): apply create, rename and delete optimistically"`

## Done when

All three mutations move the tree before the server answers, each of the three forced failures
restores the previous state with a named error, open editor tabs retarget only on confirmed
renames, a refresh after each operation shows no drift, and `pnpm -C web typecheck` is clean.
