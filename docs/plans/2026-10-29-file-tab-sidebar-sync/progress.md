# Progress — file tab ↔ explorer sync, chat file links

**Plan:** ./plan.md
**Status:** complete
**Current:** —

## Log
- 2026-10-29 Task 1 — done, commit 613fb2c. `pnpm typecheck` green. Manual in `pnpm dev` on
  /tmp/sr03-repo: ⌘P → a/b/c.ts expanded `a`, `a/b` and highlighted `c.ts`; switching README →
  c.ts kept both folders open with only c.ts selected; chat tab → 0 rows selected.
- 2026-10-29 Task 2 — done, commit 0364aad. New tests failed first (4), then web 125/125. Manual:
  a links.md preview rendered `<a b.ts>`, `a%20b.ts#L1`, `file:///…/README.md:1` and
  `a/b/c.ts:1-2` as file buttons; clicking the encoded one opened `a b.ts` on line 1.
- 2026-10-29 Task 3 — done, commit b1ff15c. New test failed first, then server 118/118. Manual on
  a real worktree thread: locate `/tmp/sr03-repo/secret.txt` (gitignored) → `{ path: "secret.txt" }`;
  `/tmp/sr03-repo/missing.txt` → 404 `File not found: /tmp/sr03-repo/missing.txt`.
- Final: `pnpm test` 118 + 125 pass, `pnpm typecheck` clean.

## Deviations
- Task 1 step 6: scroll-into-view not exercised on a tree taller than the panel (three-row repo).
- Task 2 step 8: links checked through a `.md` preview (same Markdown renderer) instead of an agent
  reply, to avoid running a paid turn.
- Task 3 step 6: the outside-root → Finder case wasn't clicked (unchanged code; would open Finder
  on the user's machine).

## Blocked / needs a decision
- (none)
