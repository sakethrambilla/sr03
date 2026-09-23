# Progress — App wallpaper

**Plan:** ./plan.md
**Status:** complete
**Current:** —

## Log
- 2026-09-23 Task 1 — done, commit f6d14cd. Server suite 82/82, smoke test printed all 6 expected lines, typecheck green.
- 2026-09-23 Task 2 — done, commit 9831438. Web 88/88, server 82/82, typecheck exit 0.
- 2026-09-23 Task 3 — done, commit 32b8349. Typecheck exit 0. Browser checks:
  - step 8 (crit 1): no-wallpaper computed styles identical to baseline.
  - step 9 (crit 2, 3): cls true, body transparent, aside ::before `oklch(0.2 0.004 75 / 0.8)` blur(20px), main ::before `oklch(0.235 0.004 75 / 0.8)` blur(20px); gradient visible through sidebar, transcript, file tree, terminal. `.xterm-viewport` first computed `rgb(0,0,0)`, fixed (see Deviations), then `rgba(0,0,0,0)`.
  - step 10 (crit 4): model Select popover, thread options menu, "Maximize" tooltip (`oklch(0.95 0.003 75)`, opacity 1) all solid. No surface is a stacking context (isolation/z/transform/opacity/filter/backdrop all default). Both resize sashes hit on both sides. Composer image lightbox covers the whole window incl. file tree. Drag ghost not dragged by hand; same fixed z-50-inside-main case as the lightbox.
  - step 11 (crit 9): Nord + Light kept the wallpaper; aside tint `oklch(0.99 0.004 250 / 0.8)`, dim is white at 0.2.
  - step 12 (perf): NOT measured — the Browser pane was hidden, so rAF frame timing couldn't run. Needs a by-eye check from the user.
  - step 13 (crit 13): after deleting wallpaper.png and reloading, no .wallpaper class, opaque aside, `wallpaper` "" in both localStorage and the server setting.

- 2026-09-23 Task 4 — done, commit 8fbf662. Generator added only slider.tsx (no new deps). Typecheck + tests exit 0. Walkthrough:
  - crit 1: no wallpaper → section shows only "Choose image…", app opaque.
  - crit 2: picked gradient → .wallpaper on in 118 ms, thumbnail + Replace + Remove + 3 sliders.
  - crit 5: opacity dragged to 100 → aside tint has no alpha.
  - crit 6: blur 40 → `blur(40px)`, 0 → `blur(0px)`.
  - crit 7: dim 80 in light → white / 0.8; 0 → transparent; dark → black / 0.4.
  - crit 8: reload keeps all values; with localStorage wiped, all values come back from the server.
  - crit 11: PDF → type error, 21 MB PNG → size error, no new PUT, wallpaper unchanged.
  - crit 12: replaced with a JPEG → new `?v=`, only wallpaper.jpg on disk.
  - crit 10: Remove → .wallpaper off, vars cleared, section back to "Choose image…", no wallpaper.* on disk, GET 404.
- 2026-09-23 Finish — `pnpm test` exit 0, `pnpm typecheck` exit 0. Dev stack stopped; /tmp data, scratch repo and the temporary .claude/launch.json removed.

## Task 3 baseline
Isolated stack (SR03_DATA_DIR=/tmp/sr03-wallpaper-data, :3499/:5399), 1400x860, dark sr03 theme, thread open with terminal + file tree:
```
BODY oklch(0.235 0.004 75) none
ASIDE oklch(0.2 0.004 75) none
SECTION rgba(0, 0, 0, 0) none
MAIN rgba(0, 0, 0, 0) none
SECTION oklch(0.2 0.004 75) none
ASIDE oklch(0.2 0.004 75) none
SECTION rgba(0, 0, 0, 0) none
```

## Deviations
- Task 2: split the store.ts appearance import across lines; rewrote appearance.test.ts's header comment, which the new tests made false.
- Task 3: browser verification runs in the coordinating session, since the subagent may lack the browser pane. A temporary untracked `.claude/launch.json` starts the isolated stack; delete it at the end.
- Task 3: added one CSS rule the plan lacked, `html.wallpaper [data-see-through] .xterm-viewport { background-color: transparent; }`. xterm 6 paints the theme background on `.xterm-scrollable-element`, and xterm.css's `#000` on `.xterm-viewport` behind it showed through once that went transparent.
- Task 4: one unexplained page reload happened mid-walkthrough (navigation type `reload`, no Vite reload in the logs, no reload call in the app). Real key presses on the slider didn't reproduce it; put down to the browser pane.
- Task 3 note: the file view (FileView) paints its own opaque background, so an open file doesn't show the wallpaper. This matches the spec's open-question assumption.

## Blocked / needs a decision
- (none)
