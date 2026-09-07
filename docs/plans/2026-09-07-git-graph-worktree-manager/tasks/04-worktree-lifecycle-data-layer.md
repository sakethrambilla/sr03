# Task 4: worktree lifecycle data layer

**Depends on:** none (independent of Tasks 1-3)
**Files:**
- Modify: `server/src/git.ts`
- Modify: `server/src/git.test.ts`

**Interfaces produced:**
```ts
export interface Worktree {
  path: string;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
  lockReason: string | null;
}

export async function lockWorktree(input: { root: string; path: string; reason?: string }): Promise<void>;
export async function unlockWorktree(input: { root: string; path: string }): Promise<void>;
export async function moveWorktree(input: { root: string; path: string; to: string }): Promise<void>;
export async function fetchWorktree(cwd: string): Promise<string>;
export async function pullWorktree(cwd: string): Promise<string>;
export async function pushWorktree(cwd: string): Promise<string>;
export async function mergedBranches(root: string, target: string): Promise<Set<string>>;
```

## Steps

- [ ] 1. In `server/src/git.ts`, extend the existing `Worktree` interface
      (around line 47-51) with the two new fields:
      ```ts
      export interface Worktree {
        path: string;
        branch: string | null;
        isMain: boolean;
        locked: boolean;
        lockReason: string | null;
      }
      ```

- [ ] 2. Update `listWorktrees` (around lines 53-79) to parse the
      `locked`/`locked <reason>` porcelain lines that `git worktree list
      --porcelain` already emits (untouched today):
      ```ts
      export async function listWorktrees(root: string): Promise<Worktree[]> {
        const output = await git(root, ["worktree", "list", "--porcelain"]);
        const worktrees: Worktree[] = [];
        let current: {
          path?: string;
          branch?: string | null;
          locked?: boolean;
          lockReason?: string | null;
        } = {};
        const flush = () => {
          if (current.path) {
            worktrees.push({
              path: path.resolve(current.path),
              branch: current.branch ?? null,
              isMain: worktrees.length === 0,
              locked: current.locked ?? false,
              lockReason: current.lockReason ?? null,
            });
          }
          current = {};
        };
        for (const line of output.split("\n")) {
          if (line.startsWith("worktree ")) {
            flush();
            current.path = line.slice("worktree ".length).trim();
          } else if (line.startsWith("branch ")) {
            current.branch = line.slice("branch refs/heads/".length).trim();
          } else if (line.trim() === "detached") {
            current.branch = null;
          } else if (line === "locked" || line.startsWith("locked ")) {
            current.locked = true;
            current.lockReason = line === "locked" ? null : line.slice("locked ".length).trim();
          }
        }
        flush();
        return worktrees;
      }
      ```

- [ ] 3. Add the lock/unlock/move functions right after `pruneWorktrees`
      (around line 188):
      ```ts
      export async function lockWorktree(input: { root: string; path: string; reason?: string }): Promise<void> {
        const args = ["worktree", "lock", input.path];
        if (input.reason?.trim()) args.push("--reason", input.reason.trim());
        await git(input.root, args);
      }

      export async function unlockWorktree(input: { root: string; path: string }): Promise<void> {
        await git(input.root, ["worktree", "unlock", input.path]);
      }

      export async function moveWorktree(input: { root: string; path: string; to: string }): Promise<void> {
        await git(input.root, ["worktree", "move", input.path, input.to]);
      }
      ```

- [ ] 4. Add fetch/pull/push, run inside the worktree's own directory
      (not the repo root — each worktree can track a different
      upstream):
      ```ts
      export async function fetchWorktree(cwd: string): Promise<string> {
        return git(cwd, ["fetch"]);
      }

      export async function pullWorktree(cwd: string): Promise<string> {
        return git(cwd, ["pull"]);
      }

      export async function pushWorktree(cwd: string): Promise<string> {
        return git(cwd, ["push"]);
      }
      ```
      All three throw `GitError` on failure via the shared `git()`
      helper — a missing upstream comes back as whatever git's own
      stderr says (e.g. "fatal: The current branch <name> has no
      upstream branch."), which is exactly the text the caller should
      surface per the spec.

- [ ] 5. Add `mergedBranches`, used by the "remove merged worktrees"
      feature to decide which branches qualify:
      ```ts
      export async function mergedBranches(root: string, target: string): Promise<Set<string>> {
        const output = await git(root, ["branch", "--merged", target, "--format=%(refname:short)"]);
        return new Set(output.split("\n").map((line) => line.trim()).filter(Boolean));
      }
      ```

- [ ] 6. In `server/src/git.test.ts` (created in Task 1), add these
      cases at the end of the file, reusing the `makeRepo`/`sh` helpers
      already defined there:
      ```ts
      test("listWorktrees reports lock state and reason", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr03-git-wt-"));
        fs.rmdirSync(wtDir);
        sh(dir, ["worktree", "add", "-b", "feature", wtDir]);
        return lockWorktree({ root: dir, path: wtDir, reason: "in use" })
          .then(() => listWorktrees(dir))
          .then((worktrees) => {
            const locked = worktrees.find((worktree) => worktree.path === fs.realpathSync(wtDir));
            assert.equal(locked?.locked, true);
            assert.equal(locked?.lockReason, "in use");
          });
      });

      test("unlockWorktree clears the lock", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr03-git-wt-"));
        fs.rmdirSync(wtDir);
        sh(dir, ["worktree", "add", "-b", "feature", wtDir]);
        return lockWorktree({ root: dir, path: wtDir })
          .then(() => unlockWorktree({ root: dir, path: wtDir }))
          .then(() => listWorktrees(dir))
          .then((worktrees) => {
            const worktree = worktrees.find((entry) => entry.path === fs.realpathSync(wtDir));
            assert.equal(worktree?.locked, false);
          });
      });

      test("removeWorktree on a locked worktree throws", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr03-git-wt-"));
        fs.rmdirSync(wtDir);
        sh(dir, ["worktree", "add", "-b", "feature", wtDir]);
        return lockWorktree({ root: dir, path: wtDir, reason: "busy" }).then(() =>
          assert.rejects(() => removeWorktree({ root: dir, path: wtDir, force: false }), /busy/),
        );
      });

      test("mergedBranches includes a branch with no new commits, excludes one with unmerged commits", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        sh(dir, ["branch", "merged-branch"]);
        sh(dir, ["checkout", "-q", "-b", "ahead-branch"]);
        fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "second"]);
        sh(dir, ["checkout", "-q", "main"]);
        return mergedBranches(dir, "main").then((merged) => {
          assert.equal(merged.has("merged-branch"), true);
          assert.equal(merged.has("ahead-branch"), false);
        });
      });

      test("fetchWorktree on a worktree with no remote throws with git's own message", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        return assert.rejects(() => fetchWorktree(dir), /No remote/);
      });
      ```
      Update the top-of-file import line to also pull in
      `lockWorktree`, `unlockWorktree`, `listWorktrees`, `removeWorktree`,
      `mergedBranches`, `fetchWorktree` from `./git.ts`.

- [ ] 7. Run `pnpm -C server test`.
      Expect: all 5 new cases pass. If the "no remote" assertion's regex
      doesn't match your git version's exact wording, run
      `git fetch` by hand in a fresh repo with no remote configured and
      match the real message it prints instead of guessing.

- [ ] 8. Run `pnpm -C server typecheck`. Expect: no errors.

- [ ] 9. `git add server/src/git.ts server/src/git.test.ts`
      `git commit -m "feat(git): add worktree lock, move, and remote sync"`

## Done when

`pnpm -C server test` and `pnpm -C server typecheck` are both clean, and
`git.ts` exports every function in this task's interface list with the
exact signatures shown.
