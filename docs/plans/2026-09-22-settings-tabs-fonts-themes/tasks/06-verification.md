# Task 06 — Verification pass

No new behaviour. This task walks the spec's 22 acceptance criteria against the running app and
confirms nothing regressed, then records the result.

`CLAUDE.md` is explicit: *"A change to provider sessions or worktree code isn't done until a real
turn has been through it."* Tasks 01 and 02 changed provider session code, so a real turn through
**each** provider is mandatory here, not optional.

## Steps

1. From the repo root:
   ```bash
   pnpm typecheck && pnpm test
   ```
   `typecheck` must exit 0 with no output. `pnpm test` prints **two** summaries, server then web;
   both must read `fail 0`. Expected counts at this point: server 62 (60 baseline + 2 from Task
   01), web 51 + however many cases Task 04 step 10 added. Stop and fix if not.
2. Build once, to confirm the font assets do not break a production build and to see the cost:
   ```bash
   pnpm build && du -sh web/dist
   ```
   Compare against the baseline Task 04 step 0 recorded in `progress.md`. If the delta is
   disproportionate to 24 latin-subset families, revisit Task 04 step 6.
3. Create a scratch repo — never a real project:
   ```bash
   mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
     && echo hello > README.md && git add . && git commit -qm init
   ```
4. From the repo root, `pnpm dev`, and open `http://localhost:5399`. Add `/tmp/sr03-repo` as a
   project and create a worktree.
5. **Run a real turn through each of the three providers** in that worktree — Claude, Cursor, Codex.
   For each: send a prompt, confirm the reply streams and persists across a reload, confirm an
   interrupt works mid-turn, and confirm a tool approval prompt appears and can be answered.
6. **Codex specifically** — re-run the Task 01 live check: a prompt producing two separate
   assistant messages, then reload and confirm both survive.
7. Walk the spec's acceptance criteria in order, 1 through 22, recording pass or fail for each in
   `progress.md`. Criteria 1–8 are Task 03, 9–14 Task 04, 15–18 Task 05, 19–22 Tasks 01–02.
8. Regression sweep on things none of the tasks touched but all of them sit near:
   - Settings left nav still switches Providers / Appearance, and the choice persists.
   - `Escape` still closes Settings.
   - The Providers refresh button in the header still re-checks.
   - The Editor panel's "Open diagrams in preview" toggle still works.
   - Open a `.mmd` and an `.excalidraw` file — both still render.
   - Open the terminal panel — it still renders, and picks up the chosen code font.
   - Split the editor into groups and drag a tab between them.
9. Check the docs the repo requires to move with the code:
   - `SHORTCUTS.md` — Task 03 adds arrow-key navigation **within** a Radix tab strip, which is
     component-level behaviour rather than an app shortcut. Decide whether it warrants a row; if
     yes, add it in this change.
   - `CLAUDE.md` — the Appearance and provider descriptions in the Layout/Conventions sections.
     Confirm nothing there is now false. In particular the "Colors are the shadcn token set"
     paragraph lists the tokens and should still be accurate, and there is now a self-hosted font
     dependency that the "dependency budget" convention paragraph does not mention. Add a short
     line if warranted — the convention lists node-pty, mermaid and excalidraw as the standing
     exceptions, and bundled fonts are now a fourth.
10. Re-read every comment in every file this plan touched and fix any the changes made false.
11. Record the final state in `progress.md`: criteria passed, anything deferred, anything found and
    not fixed.

## Verification

```bash
pnpm typecheck && pnpm test && pnpm build
```

Expected: all three succeed; both of `test`'s summaries report `fail 0`.

`progress.md` contains a line per acceptance criterion with a pass/fail mark, and a real turn has
been recorded for each of Claude, Cursor and Codex.

## Do not

- Do not run provider turns against a real project in `~/Documents/personal/projects` — worktree
  and edit operations mutate them. Use `/tmp/sr03-repo`.
- Do not mark a criterion passed without observing it. "Should work" is not a result.
- Do not fix newly discovered unrelated bugs here — record them in `progress.md` instead.
