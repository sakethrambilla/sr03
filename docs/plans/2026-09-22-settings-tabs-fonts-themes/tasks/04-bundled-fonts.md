# Task 04 — Bundled fonts

Fixes spec criteria 9–14.

## Background

`web/src/lib/appearance.ts` holds two hardcoded name lists, `UI_FONTS` (`:51-68`) and `CODE_FONTS`
(`:70-92`), and filters both through `installed()` (`:110-114`), which measures a candidate against
three generics with a canvas and rejects anything that measures identically. `availableFonts()`
(`:118-121`) caches the result:

```ts
export function availableFonts(): { ui: string[]; code: string[] } {
  cache ??= { ui: UI_FONTS.filter(installed), code: CODE_FONTS.filter(installed) };
  return cache;
}
```

`applyAppearance` (`:123-134`) writes the pick as an inline `--font-sans` / `--font-mono` on
`<html>`, appending `SANS_TAIL` / `MONO_TAIL` (`:95-96`) so an unavailable face degrades.

There are currently **no self-hosted fonts**: `web/src/index.css` has no `@font-face` and
`web/index.html` has no font `<link>`. The `Assistant-*.woff2` files in `web/dist` come from
`@excalidraw/excalidraw`, not from this system.

**The probe must not gate bundled faces.** A bundled face that has not finished loading measures
identically to its generic and would be filtered out. Bundled families are listed unconditionally.

## The set

Twenty use `@fontsource-variable/*`. Four have **no variable build** and must use `@fontsource/*`:
`ibm-plex-mono`, `iosevka`, `space-mono`, `commit-mono`. All 24 resolve at `5.3.0`, verified
against the npm registry on 2026-09-22.

| | Family | Package |
|---|---|---|
| UI | Inter | `@fontsource-variable/inter` |
| UI | Geist | `@fontsource-variable/geist` |
| UI | IBM Plex Sans | `@fontsource-variable/ibm-plex-sans` |
| UI | Source Sans 3 | `@fontsource-variable/source-sans-3` |
| UI | Public Sans | `@fontsource-variable/public-sans` |
| UI | Outfit | `@fontsource-variable/outfit` |
| UI | Bricolage Grotesque | `@fontsource-variable/bricolage-grotesque` |
| UI | Instrument Sans | `@fontsource-variable/instrument-sans` |
| UI | Space Grotesk | `@fontsource-variable/space-grotesk` |
| UI | Sora | `@fontsource-variable/sora` |
| UI | Fraunces | `@fontsource-variable/fraunces` |
| UI | Lora | `@fontsource-variable/lora` |
| Code | JetBrains Mono | `@fontsource-variable/jetbrains-mono` |
| Code | Fira Code | `@fontsource-variable/fira-code` |
| Code | IBM Plex Mono | `@fontsource/ibm-plex-mono` |
| Code | Source Code Pro | `@fontsource-variable/source-code-pro` |
| Code | Geist Mono | `@fontsource-variable/geist-mono` |
| Code | Iosevka | `@fontsource/iosevka` |
| Code | Space Mono | `@fontsource/space-mono` |
| Code | Commit Mono | `@fontsource/commit-mono` |
| Code | Martian Mono | `@fontsource-variable/martian-mono` |
| Code | Red Hat Mono | `@fontsource-variable/red-hat-mono` |
| Code | Azeret Mono | `@fontsource-variable/azeret-mono` |
| Code | Recursive | `@fontsource-variable/recursive` |

The CSS family name a package declares is the human name in column two (e.g. `"Inter Variable"` for
some variable packages — **check**, see step 3).

## Steps

0. **Record the baseline bundle size before installing anything** — Task 06 compares against it and
   there is no way to recover it afterwards:
   ```bash
   pnpm -C web build 2>&1 | tail -20
   du -sh web/dist
   ```
   Write both numbers into `progress.md` under a "font baseline" heading.
1. Install, from `web/`:
   ```bash
   cd web && pnpm add @fontsource-variable/inter @fontsource-variable/geist @fontsource-variable/ibm-plex-sans @fontsource-variable/source-sans-3 @fontsource-variable/public-sans @fontsource-variable/outfit @fontsource-variable/bricolage-grotesque @fontsource-variable/instrument-sans @fontsource-variable/space-grotesk @fontsource-variable/sora @fontsource-variable/fraunces @fontsource-variable/lora @fontsource-variable/jetbrains-mono @fontsource-variable/fira-code @fontsource-variable/source-code-pro @fontsource-variable/geist-mono @fontsource-variable/martian-mono @fontsource-variable/red-hat-mono @fontsource-variable/azeret-mono @fontsource-variable/recursive @fontsource/ibm-plex-mono @fontsource/iosevka @fontsource/space-mono @fontsource/commit-mono
   ```
2. Confirm the install succeeded and 24 entries landed in `web/package.json` dependencies.
3. **Determine each package's declared CSS family name** — do not guess. For each package, read the
   `font-family` in its emitted CSS:
   ```bash
   cd web && for p in node_modules/@fontsource-variable/* node_modules/@fontsource/*; do printf '%-45s %s\n' "$p" "$(grep -ho 'font-family: *[^;]*' "$p"/index.css 2>/dev/null | head -1)"; done
   ```
   Variable packages commonly declare `"<Name> Variable"` rather than `"<Name>"`. Record the exact
   string for each — it is what must go in the font list and in `applyAppearance`'s quoted family.
4. Create `web/src/fonts.ts` containing the 24 side-effect imports and nothing else, one per line,
   e.g. `import "@fontsource-variable/inter";`. Head it with a one-line comment saying these are the
   bundled faces the appearance picker offers. Use each package's default entry (`index.css`),
   which pulls the full weight range for variable packages; for the four static packages check
   whether the default entry is acceptable or a specific weight import is needed to keep size down.
5. Import it once, at the top of `web/src/main.tsx`: `import "./fonts.ts";`
6. Run `pnpm -C web build`, then `du -sh web/dist`, and compare against the step 0 baseline. Record
   the delta and the number of emitted `.woff2` assets in `progress.md`. A fontsource package's
   default entry pulls every subset it ships, which for some families (Iosevka especially) is far
   more than the latin subset this app needs. If the delta looks disproportionate, switch the
   offenders to a specific subset entry — e.g. `@fontsource/iosevka/latin-400.css` — and
   re-measure. Judge by the measurement, not by a guessed threshold.
7. In `web/src/lib/appearance.ts`, add two exported constants above the existing lists:
   `BUNDLED_UI_FONTS` and `BUNDLED_CODE_FONTS`, each an array of the exact CSS family names
   recorded in step 3, in the table's order.
8. Change `availableFonts()` to return groups rather than flat arrays. Target shape:
   ```ts
   export interface FontGroups {
     bundled: string[];
     installed: string[];
   }
   export function availableFonts(): { ui: FontGroups; code: FontGroups } {
     cache ??= {
       ui: { bundled: BUNDLED_UI_FONTS, installed: UI_FONTS.filter(installed) },
       code: { bundled: BUNDLED_CODE_FONTS, installed: CODE_FONTS.filter(installed) },
     };
     return cache;
   }
   ```
   Bundled families are **not** passed through `installed()` (criterion 9, 13).
9. De-duplicate: a family present in both the bundled list and the probed list must appear once,
   under Bundled. Inter, Geist, IBM Plex Sans, Source Sans 3, Public Sans, JetBrains Mono, Fira
   Code, IBM Plex Mono, Source Code Pro, Iosevka and Geist Mono all appear in both lists today, so
   this is not a hypothetical. Filter the probed list against the bundled one.
   - Note the name mismatch risk from step 3: if a bundled package declares `"Inter Variable"` and
     the probe list has `"Inter"`, they will not dedupe by string equality and the picker will show
     both. Decide deliberately — either normalise names for comparison, or keep both and accept it.
     Whichever you choose, say why in one line of comment.
10. Update `web/src/lib/appearance.test.ts` following its existing style (`node:test` +
    `node:assert/strict`, importing with an explicit `.ts` extension). Note its header comment says
    DOM-dependent pieces are tested by hand — `availableFonts` touches the canvas, so extract the
    pure grouping/de-duplication logic into a small exported pure function and test **that**, not
    `availableFonts` itself. Add cases: a family in both lists appears once; a bundled family is
    returned even when the probe would reject it.
11. Run `pnpm test` — the **web** count rises from 51 by the number of cases added; server stays at
    62. `fail 0` in both summaries.
12. In `web/src/components/SettingsView.tsx`, update `FontPicker` (`:255-283`) to take
    `FontGroups` instead of `string[]` and render two labelled groups inside the `SelectContent`
    (criterion 10). `web/src/components/ui/select.tsx` already exports `SelectGroup` (`:179`) and
    `SelectLabel` (`:181`) — import and use them; do not regenerate the component. Label the groups
    "Bundled" and "Installed on this Mac". Omit a group entirely when it is empty, rather than
    rendering an empty labelled section.
13. Keep the `System default` item at the top, outside both groups (criterion 12). Keep the
    per-item `style={{ fontFamily: ... }}` so each entry renders in its own face (criterion 11).
14. Update the two call sites at `:365-379` to pass `fonts.ui` / `fonts.code` as groups.
15. Update the Fonts section's description at `:360-362`, which currently reads "Only faces
    installed on this machine are listed." — it is now false.
16. Run `pnpm typecheck` and `pnpm test`.

## Verification

```bash
pnpm typecheck && pnpm test && pnpm -C web build
```

Expected: `typecheck` exits 0 with no output. `pnpm test` prints two summaries — server
`tests 62 / fail 0`, web `tests 51+n / fail 0` where n is the number of cases added in step 10.
`build` succeeds and emits the font assets, with the size delta recorded in `progress.md`.

Then `pnpm dev` → Settings → Appearance:

| Check | Expected |
|---|---|
| Open the Interface picker | A "Bundled" group with all 12, and an "Installed on this Mac" group |
| Open the Code picker | A "Bundled" group with all 12, and an installed group |
| Each entry | Renders in its own face, not the default |
| No family appears twice | Across both groups |
| Pick a bundled font | App restyles immediately, no reload |
| Pick "System default" | Override clears, app returns to the base stack |
| Reload | The pick persists |
| Devtools → Network → Offline, then reload and pick a bundled font | Still renders in that face |
| Devtools → set `localStorage["sr03:appearance"]`'s `uiFont` to `"No Such Face"`, reload | App renders in the fallback stack, no blank text, no console error |

## Do not

- Do not commit `.woff2` binaries by hand — they come from the packages via Vite.
- Do not run bundled families through `installed()`.
- Do not add font-size, line-height or density controls.
- Do not edit `web/src/components/ui/select.tsx` by hand.
