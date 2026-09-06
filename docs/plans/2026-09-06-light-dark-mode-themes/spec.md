# Light / dark mode for themes

## Problem

sr03's appearance panel offers 13 color themes (the custom `sr03` theme plus the 12 shadcn
palettes — Zinc, Slate, Stone, Gray, Neutral, Red, Rose, Orange, Green, Blue, Yellow, Violet), but
every one of them is defined dark-only. The shipped page even forces `class="dark"` on `<html>`
regardless of the OS setting. A user working in a bright room, presenting on a projector, or whose
OS is set to light has no way to get a light UI — the app is dark no matter what.

## Goal

A user can pick Light, Dark, or System, independently of which color theme they've chosen, and
every one of the 13 themes renders correctly — legibly and with the same accent identity — in
both modes.

## Non-goals

- No new color themes beyond the 13 already offered.
- No per-project or per-thread mode override. Mode is one machine-wide setting, stored alongside
  today's theme/font choice, exactly like the existing appearance setting.
- No changes to any other Settings section (session defaults, providers, editor).
- The Electron window's paint-flash `backgroundColor` (`desktop/main.js`, used only to avoid a
  white flash before the page's own CSS loads) stays fixed; it is not wired to the chosen mode.
- No native OS chrome changes (e.g. Windows title-bar overlay color) beyond what the existing
  CSS-driven header already picks up automatically from the token change.

## Behaviour

The Appearance settings panel gains a Light/Dark/System control next to the existing theme grid.
Picking Light or Dark applies immediately, the same way picking a theme does today. Picking System
follows the OS's `prefers-color-scheme` and updates live if the OS setting changes while sr03 is
open, without needing a reload.

Whichever of the 13 themes is selected keeps its identity (its accent hue, its relative feel)
across both modes — picking "Zinc" and toggling Light shows a light Zinc, not a fallback to some
other palette.

Beyond the core UI chrome (background, card, border, text, accent tokens), two file preview panes
also switch with mode:

- Mermaid diagram previews re-render with a light color set when the app is in light mode.
- Excalidraw file previews open in Excalidraw's own light theme when the app is in light mode.

The terminal panel needs no dedicated work: it already reads its palette live from the CSS custom
properties (`--color-card`, `--color-foreground`, `--color-primary`, `--color-accent`), so it
inherits whatever mode is active the same way it already inherits theme changes.

The editor-semantic colors — git decorations (added/modified/deleted/untracked/ignored), syntax
token hues (comment/string/keyword/control/number/type/function/property), and file-type icon
colors — currently fixed to VS Code's Dark+ values in every theme, get a second, light-mode set
(in the spirit of VS Code's Light+ / Seti equivalents) so code, diffs, and the file tree stay
legible on a light background. These stay constant across all 13 themes in a given mode, exactly
as they're constant across themes today in dark mode — only the mode changes them, not the theme.

The `sr03` theme's light-mode colors don't exist anywhere yet (unlike the 12 shadcn themes, which
each have a published light variant from shadcn's own theme generator). The plan will propose a
light oklch set for `sr03` that keeps its identity — same orange primary hue, same relative
contrast — inverted for a light background, for approval at plan review.

## Acceptance criteria

1. When a user opens Settings → Appearance, a Light/Dark/System control is visible next to the
   theme grid, showing the currently active mode as selected.
2. When a user picks Dark (or the app starts with Dark already selected), the UI renders using
   each theme's existing dark values, unchanged from current behavior.
3. When a user picks Light, the UI immediately re-renders using light values for the
   currently-selected theme — background, text, and accent all sourced from that theme's light
   tokens — without a page reload.
4. When a user picks System, the UI matches the OS's current light/dark setting, and updates live
   (no reload) if the OS setting changes while sr03 is open.
5. When a user switches between any of the 13 themes while in Light mode, each theme's light
   variant is shown; the app does not fall back to dark or to a different theme's colors.
6. When a user opens a `.mmd` file's preview in Light mode, the diagram renders with light-mode
   colors; the same file in Dark mode renders with the current dark colors.
7. When a user opens a `.excalidraw` file's preview in Light mode, the canvas opens in Excalidraw's
   light theme; in Dark mode it opens in Excalidraw's dark theme as it does today.
8. When the app is restarted, the previously chosen mode (Light, Dark, or System) persists, the
   same way the previously chosen theme persists today.
9. When a user has never set a preference (fresh `localStorage`), the app starts in Dark mode,
   preserving today's appearance for anyone upgrading — it does not silently switch existing users
   to System or Light.
10. When the terminal panel is open and the user changes mode, the terminal's background,
    foreground, cursor, and selection colors update to match, the same way they already update on
    a theme change.

## Constraints

- Must not regress the no-flash-of-wrong-theme behavior: today's appearance (theme + fonts) is
  applied at module load, before first paint (`store.ts`'s `startingAppearance` /
  `applyAppearance`). Mode must be applied through the same path, not from a post-mount effect.
- The 12 shadcn-derived themes' light values should come from shadcn's own published light
  palettes for those theme names, not be invented, so they match the ecosystem users may already
  recognize.
- Existing shadcn-generated components under `components/ui/*` use Tailwind's `dark:` variant
  convention. Whatever mechanism marks a mode active (attribute or class on `<html>`) must line up
  with how Tailwind resolves `dark:` in this project, so those component-level dark: styles track
  sr03's own mode choice rather than (as today) the OS's `prefers-color-scheme`, independent of
  sr03's own setting.

## Open questions

- Default mode for a fresh install with no stored preference — proceeding on the assumption that
  it's Dark (matching today's forced-dark appearance), not System, so upgrading users and fresh
  installs see identical results until they explicitly opt into Light or System.
- Exact `sr03` light-mode oklch values — proceeding on the assumption that the plan proposes a
  specific palette (same orange primary hue, background/foreground inverted) for approval at plan
  review, since there's no existing source to copy from.
