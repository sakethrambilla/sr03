# Task 1: commit log & refs data layer

**Depends on:** none
**Files:**
- Modify: `server/src/git.ts`
- Create: `server/src/git.test.ts`

**Interfaces produced:**
```ts
export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: number; // unix seconds
  message: string;    // subject line only
}

export interface Ref {
  name: string;               // short name, e.g. "main", "origin/main", "v1.0.0"
  kind: "head" | "tag" | "remote";
  commit: string;              // hash it resolves to (tags: the tag's target, peeled)
}

export interface CommitFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  insertions: number;
  deletions: number;
  binary: boolean;
}

export async function commitLog(
  root: string,
  input: { maxCount: number; skip: number; ref?: string },
): Promise<{ commits: Commit[]; hasMore: boolean }>;

export async function listRefs(root: string): Promise<Ref[]>;

export async function commitFiles(cwd: string, hash: string): Promise<CommitFile[]>;

export async function commitFileDiff(cwd: string, hash: string, file: string): Promise<string>;
```

## Steps

- [ ] 1. In `server/src/git.ts`, add the `Commit` and `Ref` interfaces
      above near the existing `Worktree`/`Branch` interfaces (around
      line 80).

- [ ] 2. Add `commitLog`:
      ```ts
      export async function commitLog(
        root: string,
        input: { maxCount: number; skip: number; ref?: string },
      ): Promise<{ commits: Commit[]; hasMore: boolean }> {
        const FIELD = "\x1f";
        const RECORD = "\x1e";
        const format = `%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s${RECORD}`;
        const fetchCount = input.maxCount + 1;
        // a caller-supplied ref narrows history to one branch/tag instead of every ref; validated
        // by the API route before it ever reaches here, but re-checked since this is exported
        if (input.ref !== undefined && !/^[A-Za-z0-9._/-]+$/.test(input.ref)) {
          throw new GitError(`Invalid ref: ${input.ref}`);
        }
        try {
          const output = await git(root, [
            "log",
            "--date-order",
            ...(input.ref ? [input.ref] : ["--all"]),
            `--max-count=${fetchCount}`,
            `--skip=${input.skip}`,
            `--format=${format}`,
          ]);
          const records = output
            .split(RECORD)
            .map((record) => record.trim())
            .filter((record) => record.length > 0);
          const commits = records.slice(0, input.maxCount).map((record) => {
            const [hash, parents, authorName, authorEmail, authorDate, message] = record.split(FIELD);
            return {
              hash: hash ?? "",
              parents: (parents ?? "").split(" ").filter(Boolean),
              authorName: authorName ?? "",
              authorEmail: authorEmail ?? "",
              authorDate: Number(authorDate) || 0,
              message: message ?? "",
            };
          });
          return { commits, hasMore: records.length > input.maxCount };
        } catch {
          // an empty repo ("does not have any commits yet") is an empty page, not a failure
          return { commits: [], hasMore: false };
        }
      }
      ```
      `--all` includes every branch/tag/remote-tracking ref's history,
      matching the spec's "local branches + tags + remotes" ref scope.

- [ ] 3. Add `listRefs`:
      ```ts
      export async function listRefs(root: string): Promise<Ref[]> {
        const output = await git(root, [
          "for-each-ref",
          "--format=%(refname)\x1f%(objectname)\x1f%(*objectname)",
          "refs/heads",
          "refs/tags",
          "refs/remotes",
        ]);
        const refs: Ref[] = [];
        for (const line of output.split("\n")) {
          if (!line.trim()) continue;
          const [refname, objectname, peeled] = line.split("\x1f");
          if (!refname || !objectname) continue;
          if (refname.startsWith("refs/heads/")) {
            refs.push({ name: refname.slice("refs/heads/".length), kind: "head", commit: objectname });
          } else if (refname.startsWith("refs/tags/")) {
            const target = peeled && peeled.length > 0 ? peeled : objectname;
            refs.push({ name: refname.slice("refs/tags/".length), kind: "tag", commit: target });
          } else if (refname.startsWith("refs/remotes/")) {
            refs.push({ name: refname.slice("refs/remotes/".length), kind: "remote", commit: objectname });
          }
        }
        return refs;
      }
      ```
      `%(*objectname)` is empty for a lightweight tag or a non-tag ref;
      that's the `peeled.length > 0` check above (an annotated tag's own
      object hash isn't the commit it points at — the peeled value is).

- [ ] 4. Add the empty-tree constant, a parent lookup, and the status
      classifier, just above `commitFiles`:
      ```ts
      // the canonical empty tree — diffing a root commit against it is how you list "everything
      // this commit added" without diff-tree's separate --root flag and its different output shape
      const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

      async function firstParentOrEmptyTree(cwd: string, hash: string): Promise<string> {
        try {
          return (await git(cwd, ["rev-parse", `${hash}^`])).trim();
        } catch {
          return EMPTY_TREE; // root commit has no parent
        }
      }

      function classifyCommitStatus(code: string): CommitFile["status"] {
        const letter = code[0] ?? "M";
        if (letter === "A") return "added";
        if (letter === "D") return "deleted";
        if (letter === "R" || letter === "C") return "renamed";
        return "modified";
      }
      ```

- [ ] 5. Add `commitFiles`:
      ```ts
      // Two diffs of the same base..hash pair, walked in lockstep: --name-status for the status
      // letter, --numstat for line counts. Git walks the tree in the same order for both formats
      // given identical base/hash/pathspec, so the Nth record of one is the Nth of the other. A
      // rename/copy's record in both formats is [old path, new path] — the new path is what the
      // user acts on, so that one is kept.
      export async function commitFiles(cwd: string, hash: string): Promise<CommitFile[]> {
        const base = await firstParentOrEmptyTree(cwd, hash);
        const [statusRaw, numstatRaw] = await Promise.all([
          git(cwd, ["-c", "core.quotepath=false", "diff", "--name-status", "-z", base, hash]),
          git(cwd, ["-c", "core.quotepath=false", "diff", "--numstat", "-z", base, hash]),
        ]);
        const statusParts = statusRaw.split("\0").filter((part) => part.length > 0);
        const statuses: Array<{ code: string; path: string }> = [];
        for (let index = 0; index < statusParts.length; index += 1) {
          const code = statusParts[index]!;
          const isRenameOrCopy = code[0] === "R" || code[0] === "C";
          const oldPath = statusParts[index + 1];
          if (oldPath === undefined) break;
          if (isRenameOrCopy) {
            const newPath = statusParts[index + 2];
            statuses.push({ code, path: newPath ?? oldPath });
            index += 2;
          } else {
            statuses.push({ code, path: oldPath });
            index += 1;
          }
        }
        const numstatParts = numstatRaw.split("\0").filter((part) => part.length > 0);
        const counts: Array<{ insertions: number; deletions: number; binary: boolean }> = [];
        for (let index = 0; index < numstatParts.length; index += 1) {
          const record = numstatParts[index]!;
          const [insertions, deletions, name] = record.split("\t");
          if (insertions === undefined || deletions === undefined) continue;
          if (!name) index += 2; // rename/copy: name is empty, old and new paths follow as separate records
          counts.push({
            insertions: Number(insertions) || 0,
            deletions: Number(deletions) || 0,
            binary: insertions === "-",
          });
        }
        return statuses.map((entry, index) => ({
          path: entry.path,
          status: classifyCommitStatus(entry.code),
          insertions: counts[index]?.insertions ?? 0,
          deletions: counts[index]?.deletions ?? 0,
          binary: counts[index]?.binary ?? false,
        }));
      }
      ```

- [ ] 6. Add `commitFileDiff`:
      ```ts
      export async function commitFileDiff(cwd: string, hash: string, file: string): Promise<string> {
        const base = await firstParentOrEmptyTree(cwd, hash);
        return diffText(cwd, ["-c", "core.quotepath=false", "diff", base, hash, "--", file]);
      }
      ```

- [ ] 7. Create `server/src/git.test.ts` following `server/src/layout.test.ts`'s
      style (`import test from "node:test"`, `import assert from
      "node:assert/strict"`). Build a temp repo once per test file:
      ```ts
      import assert from "node:assert/strict";
      import test from "node:test";
      import { execFileSync } from "node:child_process";
      import fs from "node:fs";
      import os from "node:os";
      import path from "node:path";

      import { commitFileDiff, commitFiles, commitLog, listRefs } from "./git.ts";

      function sh(cwd: string, args: string[]): string {
        return execFileSync("git", args, { cwd, encoding: "utf8" });
      }

      function makeRepo(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sr03-git-test-"));
        sh(dir, ["init", "-q", "-b", "main"]);
        sh(dir, ["config", "user.email", "test@example.com"]);
        sh(dir, ["config", "user.name", "Test"]);
        return dir;
      }

      test("commitLog returns commits newest-first with parent hashes", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "second"]);
        return commitLog(dir, { maxCount: 10, skip: 0 }).then((result) => {
          assert.equal(result.commits.length, 2);
          assert.equal(result.hasMore, false);
          assert.equal(result.commits[0]!.message, "second");
          assert.deepEqual(result.commits[0]!.parents, [result.commits[1]!.hash]);
          assert.deepEqual(result.commits[1]!.parents, []);
        });
      });

      test("commitLog paginates with hasMore", () => {
        const dir = makeRepo();
        for (let i = 0; i < 3; i += 1) {
          fs.writeFileSync(path.join(dir, "a.txt"), String(i));
          sh(dir, ["add", "."]);
          sh(dir, ["commit", "-q", "-m", `commit ${i}`]);
        }
        return commitLog(dir, { maxCount: 2, skip: 0 }).then((result) => {
          assert.equal(result.commits.length, 2);
          assert.equal(result.hasMore, true);
        });
      });

      test("commitLog on a repo with no commits returns an empty page", () => {
        const dir = makeRepo();
        return commitLog(dir, { maxCount: 10, skip: 0 }).then((result) => {
          assert.deepEqual(result, { commits: [], hasMore: false });
        });
      });

      test("commitLog scoped to a ref excludes commits only reachable from other branches", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "on main"]);
        sh(dir, ["checkout", "-q", "-b", "feature"]);
        fs.writeFileSync(path.join(dir, "b.txt"), "two\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "on feature"]);
        return commitLog(dir, { maxCount: 10, skip: 0, ref: "main" }).then((result) => {
          assert.deepEqual(
            result.commits.map((commit) => commit.message),
            ["on main"],
          );
        });
      });

      test("commitLog rejects a ref that isn't a plausible ref name", () => {
        const dir = makeRepo();
        return assert.rejects(() => commitLog(dir, { maxCount: 10, skip: 0, ref: "--upload-pack=x" }));
      });

      test("listRefs classifies heads and tags", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        sh(dir, ["tag", "v1"]);
        sh(dir, ["branch", "feature"]);
        return listRefs(dir).then((refs) => {
          const kinds = refs.map((ref) => `${ref.kind}:${ref.name}`).sort();
          assert.deepEqual(kinds, ["head:feature", "head:main", "tag:v1"]);
        });
      });

      test("commitFiles reports an added file for the root commit", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        const hash = sh(dir, ["rev-parse", "HEAD"]).trim();
        return commitFiles(dir, hash).then((files) => {
          assert.deepEqual(files, [
            { path: "a.txt", status: "added", insertions: 1, deletions: 0, binary: false },
          ]);
        });
      });

      test("commitFiles reports nothing for an empty commit", () => {
        const dir = makeRepo();
        sh(dir, ["commit", "-q", "--allow-empty", "-m", "empty"]);
        const hash = sh(dir, ["rev-parse", "HEAD"]).trim();
        return commitFiles(dir, hash).then((files) => {
          assert.deepEqual(files, []);
        });
      });

      test("commitFileDiff shows the added line for the root commit", () => {
        const dir = makeRepo();
        fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
        sh(dir, ["add", "."]);
        sh(dir, ["commit", "-q", "-m", "first"]);
        const hash = sh(dir, ["rev-parse", "HEAD"]).trim();
        return commitFileDiff(dir, hash, "a.txt").then((diff) => {
          assert.match(diff, /\+one/);
        });
      });
      ```

- [ ] 8. Run `pnpm -C server test`.
      Expect: all 9 new tests pass; no existing test regresses.
      If `commitLog`'s parent assertion fails, print `result.commits` and
      check the `%P` field actually contains a space-separated hash list
      — a single trailing space would make `.split(" ").filter(Boolean)`
      wrong only if it's producing extra empty entries, so assert on the
      array contents, not its raw string form.

- [ ] 9. Run `pnpm -C server typecheck`. Expect: no errors.

- [ ] 10. `git add server/src/git.ts server/src/git.test.ts`
      `git commit -m "feat(git): add commit log, refs, and per-commit diff lookups"`

## Done when

`pnpm -C server test` passes with the 7 new cases green, `pnpm -C server
typecheck` is clean, and `git.ts` exports `commitLog`, `listRefs`,
`commitFiles`, and `commitFileDiff` with the exact signatures declared
above.
