# Light / dark mode for themes — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch:** `feat/theme-light-dark-mode`
**Test command:** `pnpm -C web test` (server is untouched by this plan)
**Lint / typecheck:** `pnpm -C web typecheck`

## Approach

Mode becomes a fourth field on the existing `Appearance` record (`theme`, `uiFont`, `codeFont`,
now `mode`), applied through the exact same synchronous, before-first-paint path the other three
already use — no new state layer. A pure `resolveDark(mode, systemPrefersDark)` function decides
light vs. dark; `applyAppearance` calls it and toggles a `.dark` class on `<html>`. A
`@custom-variant dark (&:is(.dark *));` line in `index.css` re-points every shadcn-generated
component's `dark:` utility at that class instead of the OS's raw `prefers-color-scheme` (which is
what it silently falls back to today, since nothing declares the variant). Each of the 13 themes'
CSS blocks gains a light half (the existing values become the `.dark`-qualified half, unchanged);
the 12 shadcn-derived themes' light values are Tailwind's own published oklch scale for the same
color names, and the two editor-preview panes (Mermaid, Excalidraw) key off the same resolved
boolean so they stop being permanently dark. This keeps the picker's mental model exactly as it is
today — theme picks the hue, a new independent control picks the mode — and touches no other
Settings section.

## Global constraints

- No new runtime dependencies (no `next-themes`, no jsdom for testing — `resolveDark` takes the OS
  preference as a plain boolean argument specifically so it stays unit-testable without one).
- `desktop/main.js`'s `backgroundColor: "#1f1e1c"` (the pre-paint flash color) is out of scope —
  do not touch it.
- `web/index.html`'s `class="dark"` stays as literal, static markup — it's the safe pre-JS
  default the constraint about no-flash-of-wrong-theme depends on. Do not remove it or make it
  conditional at the HTML level; the toggle happens entirely in JS, over that starting class.
- `components/ui/*` is shadcn-generated. Nothing in this plan hand-edits a file in that directory —
  `Select`/`SelectContent`/`SelectItem`/`SelectTrigger`/`SelectValue` are already imported in
  `SettingsView.tsx` for the existing permission-mode and font pickers and are reused as-is.
- Every oklch value introduced for the 12 shadcn-derived themes' light halves is copied from
  `web/node_modules/tailwindcss/theme.css` (Tailwind's own published color scale) — the task steps
  give the exact source lines. Do not hand-tune or approximate any of them.
- The `sr03` theme's light palette and the editor-semantic light colors (git/syntax) have no such
  source; they're given as concrete proposed values in Task 2, called out for your review rather
  than silently treated as final.

## File map

| File | Create/Modify | Responsibility |
|---|---|---|
| `web/src/lib/appearance.ts` | Modify | `mode` field, `resolveDark`, `systemPrefersDark`, `watchSystemMode`, `applyAppearance` toggles `.dark` |
| `web/src/lib/appearance.test.ts` | Create | Unit tests for `resolveDark` |
| `web/src/store.ts` | Modify | Registers `watchSystemMode` once, so System mode updates live and every mode-reading consumer re-renders |
| `web/src/index.css` | Modify | `@custom-variant dark`; light half for all 13 themes; light half for git/syntax tokens |
| `web/src/components/SettingsView.tsx` | Modify | Mode `Select` in the Appearance panel's Theme section |
| `web/src/components/Mermaid.tsx` | Modify | Diagram colors keyed by resolved mode, not just theme id |
| `web/src/components/ExcalidrawView.tsx` | Modify | `theme` prop reads the resolved mode instead of a hardcoded `"dark"` |

`web/src/components/TerminalPanel.tsx` needs no change: it already re-reads the live CSS custom
properties on every `appearance` object change (`terminalTheme()` off `getComputedStyle`), and
Task 1's `watchSystemMode` wiring makes sure that object changes even when only the OS preference
flips under System mode. Verified by hand in Task 4.

## Tasks

1. [tasks/01-appearance-data-layer.md](tasks/01-appearance-data-layer.md) — mode field, resolution
   logic, persistence, live system-preference tracking
2. [tasks/02-theme-css.md](tasks/02-theme-css.md) — light half of all 13 themes and the editor
   semantic tokens
3. [tasks/03-settings-ui.md](tasks/03-settings-ui.md) — the Light/Dark/System control
4. [tasks/04-preview-panes-and-qa.md](tasks/04-preview-panes-and-qa.md) — Mermaid, Excalidraw, and
   full manual verification across all 13 themes × 2 modes

## Risks

- The 12 shadcn light palettes are mechanically correct (copied from Tailwind's published scale)
  but not independently contrast-checked per pairing beyond what Task 4's manual pass covers —
  if anything reads as low-contrast, it's a values tweak in `index.css`, not a structural redo.
- `sr03`'s light palette and the git/syntax light colors are original proposals with no source to
  diff against (flagged in Task 2); expect to iterate on the exact numbers after seeing them
  rendered, without needing to touch the surrounding structure.
- Forcing a store re-render on every OS `prefers-color-scheme` flip (Task 1) only matters while
  `mode === "system"`; double check it doesn't fire (and isn't observable) in `light`/`dark` mode,
  where the OS can still flip underneath sr03 without anything needing to react.
