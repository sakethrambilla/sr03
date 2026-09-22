# Progress — settings tabs, fonts, themes, Codex fixes

**Plan:** ./plan.md
**Spec:** ./spec.md
**Status:** complete
**Current:** all six tasks done
**Execution:** fresh subagent per task, review between tasks
**Commits:** none taken during execution — changes are left in the working tree for review.

## Baseline (2026-09-22, before any task)

| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0, no output |
| `pnpm test` — server | tests 60, pass 60, fail 0 |
| `pnpm test` — web | tests 51, pass 51, fail 0 |

## Log

- 2026-09-22 Task 01 — **done**, uncommitted. server `tests 62 / pass 62 / fail 0`, web
  `tests 51 / pass 51 / fail 0`, typecheck exit 0. Diff reviewed and matches the report.
  Extracted `completeMessage` in `codex.ts:539`; `handleItemCompleted` now completes each message
  without latching `turn.finished`; `handleTurnCompleted` emits an error for any failed turn.
  2 new tests in `codex.test.ts`. Live browser check deferred to Task 06.
- 2026-09-22 Task 02 — **done**, uncommitted. server `tests 62 / pass 62 / fail 0`, web
  `tests 51 / pass 51 / fail 0`, typecheck exit 0. Diff reviewed and matches the report.
  `lastUsage` global → `usageByThread` Map keyed by `session.threadId`; `readUsage(threadId)` now
  honours its argument and falls back to `EMPTY_USAGE`; `forgetThread` registered on
  `codexProvider`. `CursorCard` → `NoTranscriptCard` with a `label` prop fed from
  `provider.label`. Live browser check deferred to Task 06.
- 2026-09-22 Task 03 — **done**, uncommitted. server `tests 62 / pass 62 / fail 0`, web
  `tests 51 / pass 51 / fail 0`, typecheck exit 0. Diff reviewed. `web/src/components/ui/tabs.tsx`
  generated and unedited, importing `{ Tabs as TabsPrimitive } from "radix-ui"` exactly as
  `select.tsx` does; `web/package.json` untouched, no `@radix-ui/react-tabs` entry added.
  `SettingsView.tsx` now renders a `Tabs` strip with `ProviderLogo` + label + `STATE_STYLE` dot per
  trigger, `usePersistedState("settings-provider")` for the selection, and a two-step fallback for
  a stale id. Default-provider card and Checking… line untouched above the strip.
  Live browser walkthrough deferred to Task 06.
- 2026-09-22 Task 04 — **done**, uncommitted. server `tests 62 / pass 62 / fail 0`, web
  `tests 53 / pass 53 / fail 0` (51 + 2), typecheck exit 0, `pnpm -C web build` succeeded.
  Diff reviewed. 24 `@fontsource*` deps added; `web/src/fonts.ts` holds the side-effect imports,
  pulled in from `main.tsx:4`. `appearance.ts` gained `BUNDLED_UI_FONTS`/`BUNDLED_CODE_FONTS`,
  a pure exported `groupFonts`, and `availableFonts()` returning `{bundled, installed}` groups
  with bundled faces never probed. `FontPicker` renders two labelled `SelectGroup`s.
  Bundle 25M → 30M; `.woff2` assets total 3.0M across 98 files. No subsetting needed.
  Live browser walkthrough deferred to Task 06.
- 2026-09-22 Task 05 — **done**, uncommitted. server `tests 62 / pass 62 / fail 0`, web
  `tests 53 / pass 53 / fail 0`, typecheck exit 0. Twelve blocks appended to `index.css:738-1017`
  (neon, bloom, terminal, dune, nord, mono — light + dark each); six entries appended to `THEMES`.
  Independently verified in the coordinating session: every block carries exactly 20 properties,
  the leakage grep returns 12, and no block redefines a git/syntax/file-icon/`--added` token.
  Contrast gates met by arithmetic on the authored oklch lightness — smallest gaps are nord dark
  (fg/bg 69pp, muted/card 45pp), both well over the 40/30 thresholds.
  Live browser walkthrough deferred to Task 06.
- 2026-09-22 Task 06 — **done**. Final gate: typecheck exit 0, server `tests 62 / pass 62 / fail 0`,
  web `tests 53 / pass 53 / fail 0`, `pnpm build` succeeded, `web/dist` 30M.
  Live pass run against an isolated instance (`SR03_DATA_DIR=/tmp/sr03-verify`, `SR03_PORT=3400`)
  so the real `~/.sr03` database was never touched — the user's own server on :3399 was left
  running throughout. Real turns completed through all three providers. Verification server
  stopped afterwards; :3399 confirmed still alive.

## Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | One strip, one card | pass | Strip with 3 entries, single card below |
| 2 | Mark + name + state | pass | `ProviderLogo` + label + `STATE_STYLE` dot; state in `title` |
| 3 | Switching leaves default-provider control | pass | Clicked Cursor; control unchanged and operable |
| 4 | Selection survives close/reopen + reload | pass | `data-state` stayed on Codex; `localStorage=codex` |
| 5 | Stale id falls back | pass | Set id to `nonesuch` → Claude Code active, 3 panels, no empty state |
| 6 | Checking… before load, no empty strip | pass | Observed "Checking…" with no strip, then the full strip |
| 7 | Refresh doesn't switch tabs | pass | Header re-check with Codex selected; stayed on Codex |
| 8 | Keyboard navigation | pass | `ArrowRight` moved selection Cursor → Codex, focus followed |
| 9 | Bundled listed on every machine | pass | 12 + 12 present, never passed through the probe |
| 10 | Bundled / installed separated | pass | "Bundled" and "Installed on this Mac" groups |
| 11 | Each entry in its own face, applies live | pass | Serifs visibly serif; Fraunces applied with no reload |
| 12 | System default clears the override | pass | Item present at top, outside both groups |
| 13 | Bundled font works offline | pass | 0 external font requests; all served from origin |
| 14 | Missing font degrades | pass | `No Such Face` → fallback stack, no blank text, no console error |
| 15 | Existing themes + six new, own swatches | pass | 19 entries, each swatch drawn from its own tokens |
| 16 | Legible in light and dark | pass | Arithmetic on all 12 blocks; worst gaps 69pp / 45pp vs 40/30 required |
| 17 | Editor colors unchanged | pass | Code preview identical under neon; no block redefines them |
| 18 | Theme survives reload; System follows OS | pass | `theme=bloom dark=false` after reload |
| 19 | Codex multi-message survives reload | pass | ALPHA + BRAVO both persisted as separate rows and shown after reload |
| 20 | Failed turn with no message surfaces | pass (test) | `codex.test.ts` blank-failure case asserts `error === "Codex turn failed"` |
| 21 | Codex card doesn't say Cursor | pass (structural) | Card takes `provider.label`; Codex label is "Codex CLI". Not observed live — see below |
| 22 | Usage is per-thread | pass | Real thread returns its windows; unknown thread returns empty, no leak |

**Criterion 21 caveat.** Verified by construction rather than observation: the hardcoded string is
gone and the card renders `provider.label`, which the API confirms is "Codex CLI". Producing a real
Codex collab task card needs a prompt that reliably delegates, which did not seem worth the API
spend. Worth an eyeball next time one appears naturally.

## Regression sweep

Escape closes Settings; left nav switches sections and persists; header re-check works; all three
providers completed real turns (Codex ALPHA/BRAVO, Claude PONG, Cursor PONG); no console errors at
any point.

## Deviations

- Task 01 step 6 was a no-op: all four turn-end paths already called `finishAssistant`
  (`handleTurnCompleted:719`, `handleConnectionClose:930`, `runTurn` catch at `:1051`/`:1054`).
  The plan said to "add the call where it is absent"; nothing was absent. The latch was the only bug.
- Task 01 step 14: the `// completed payload is the full message` comment at `codex.ts:686`
  describes the payload, not the latch, so it stayed true after the guard change and was left as
  written.

- Task 03 step 9: the plan said to reuse `EditorTabs`' vocabulary. The generated `TabsList`'s
  `line` variant marks the selected tab with a bottom `after` line in `bg-foreground`, which
  conflicts with the inset primary top-line the plan specified. Kept the `default` variant,
  overrode `bg-muted` → `bg-transparent`, and put `EditorGroups.tsx:104-106`'s exact active classes
  on the trigger. Triggers also need `flex-none`, since the generated default `flex-1` would
  stretch three tabs across the full width.
- Task 06: found and fixed a defect the plan did not anticipate. `store.ts:918` **appends** each
  newly-probed provider to `providerStatuses`, so the strip was ordered by probe-completion and
  reshuffled as statuses landed — the selected tab visibly jumped during load, and `providers[0]`
  (criterion 5's fallback) was nondeterministic. Fixed in `SettingsView.tsx` by sorting the
  statuses into the catalog's stable order before rendering. Pre-existing store behaviour that the
  vertical stack merely hid; contained to the file Task 03 already owned.
- Task 06: `CLAUDE.md` updated — the dependency-budget paragraph now names `@fontsource*` as a
  third standing exception, the layout map gained `lib/appearance.ts` and `fonts.ts`, and the
  `SubagentView.tsx` line no longer says "Cursor card", which Task 02 made false.
- Task 03: no `SHORTCUTS.md` row added. `←`/`→` inside the strip is Radix roving-focus behaviour
  that ships with the generated component; nothing in this repo registers it, and `SHORTCUTS.md`
  lists app-level bindings only.

## Noticed, out of scope — not fixed

- Codex usage is memory-only. Unlike Claude it is not written to `usageStore`, so a server restart
  drops every thread's rate-limit snapshot. Found during Task 02.
- `codex.test.ts`'s file-header comment lists what the suite covers and does not mention the new
  turn-lifecycle cases. Incomplete rather than false. Found during Task 01.

## Blocked / needs a decision

- **Picker shows fontsource's internal family names.** The 20 variable packages declare
  `"Inter Variable"`, `"Geist Variable"` and so on, and that string is both the value written to
  `--font-sans` (correct — it is the real family name) and the label shown in the picker (awkward
  to read). `baseName()` in `appearance.ts` already strips the suffix for de-duplication, so
  showing `baseName(font)` as the label while keeping the full name as the value is a two-line
  change. Not done: the plan did not call for it and it is cosmetic. Decide after seeing it.

## Font baseline

Measured before installing any `@fontsource*` package (task 04, step 0).

- `pnpm -C web build`: succeeded, `built in 6.79s`
- `du -sh web/dist`: **25M**

### After bundling the 24 faces

- `du -sh web/dist`: **30M** (delta **+5M**; the emitted `.woff2` files total 3.0M, the rest is
  filesystem block rounding over 98 small files)
- emitted `.woff2` assets: **98**
- No subsetting needed. The four static packages' default entries are already a single latin-400
  face each, and the variable ones ship latin + latin-ext only. Iosevka is the one outlier at 984K,
  which is its latin-400 face — there is no smaller entry to switch to.
