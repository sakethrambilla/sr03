# Task 05 — Six creative themes

Fixes spec criteria 15–18.

## Background

Themes are pure CSS plus a registry entry. `web/src/lib/appearance.ts:18-32` lists them:

```ts
export const THEMES: Theme[] = [
  { id: "sr03", label: "sr03" },
  { id: "zinc", label: "Zinc" },
  ...
];
```

`applyAppearance` (`:123-127`) sets `data-theme` on `<html>` for anything but `sr03`, and toggles
`.dark` from `resolveDark(mode, systemPrefersDark())`.

`web/src/index.css` carries one pair of blocks per theme: a light block `[data-theme="x"] { … }`
and its dark override `[data-theme="x"]:is(.dark, .dark *) { … }`. `zinc` is at lines 186 and 209;
the last existing pair is `violet` at 692 and 715. The new pairs append after it.

`ThemeSwatch` (`SettingsView.tsx:226-253`) renders each preview under its own `data-theme`, drawn
from `bg-card`, `bg-accent` and `bg-primary` — so a correct token block produces a correct swatch
with no extra work.

**Editor semantics do not move.** Git, syntax and file-icon hues live at `:root` (index.css:139)
and `:root.dark` (:165) and are deliberately theme-independent. `--added` is one of these. A theme
block must not redefine them (criterion 17).

## The token contract

Each block defines exactly these **20** properties, matching the existing `zinc` block:

```
--background --foreground --card --card-foreground --popover --popover-foreground
--primary --primary-foreground --secondary --secondary-foreground
--muted --muted-foreground --accent --accent-foreground
--destructive --destructive-foreground --border --input --ring --faint
```

Omitting one silently inherits the base palette — a bug, not a shortcut. All values are `oklch`,
as everywhere else in the file.

## The six

| id | label | Direction |
|---|---|---|
| `neon` | Neon | Cyberpunk. Near-black background, magenta primary, cyan ring/accent. High chroma. |
| `bloom` | Bloom | Soft aesthetic. Blush and cream, low chroma, warm. Dark mode is a muted plum, not black. |
| `terminal` | Terminal | Green phosphor on near-black. Primary and ring are the phosphor green. |
| `dune` | Dune | Warm sand and terracotta. Light mode is paper-warm; dark is deep brown. |
| `nord` | Nord | Cool arctic blue-grey, desaturated. The calm one. |
| `mono` | Mono | Pure greyscale chrome with a single accent hue for primary and ring. |

## Steps

1. Read `web/src/index.css` lines 1-60 (the `sr03` base at `:12` and its dark half at `:47`) and
   lines 186-232 (the full `zinc` pair) to internalise the exact property list, ordering and
   formatting. Match that formatting precisely.
2. Read lines 128-180 to see the `@theme` block and the editor-semantic tokens, so you know what
   **not** to touch.
3. Append six light/dark pairs after the `violet` dark block, which ends at `index.css:736` and is
   the last theme block in the file. Keep the file's existing comment convention: one comment
   introduces the group, individual themes are not each commented unless something non-obvious is
   going on.
4. For each theme, derive the palette rather than picking values ad hoc:
   - Pick a background and foreground first, then set `--card` and `--popover` one step off the
     background so raised surfaces read as raised.
   - `--muted-foreground` must stay legible against `--card`, and `--foreground` against
     `--background` (criterion 16). Aim for a lightness gap of at least ~40 percentage points for
     body text and ~30 for muted text.
   - `--border` and `--input` sit between background and card in lightness.
   - `--faint` is dimmer than `--muted-foreground` — check how `zinc` relates the two and follow it.
   - `--destructive` stays recognisably red in every theme, including Terminal and Mono. It is a
     safety signal, not a style choice.
   - `--primary-foreground` must be legible **on** `--primary`.
5. After each theme, run `pnpm dev`, switch to it, and check both light and dark before moving to
   the next. Six themes written blind and checked at the end is how a bad one hides.
6. Add the six entries to `THEMES` in `web/src/lib/appearance.ts`, appended after `violet`, with
   ids and labels exactly as in the table above.
7. Confirm the swatch grid at `SettingsView.tsx:344` (`grid-cols-4`) still reads well at 19
   entries. It becomes five rows; that is acceptable and no restructuring is required. Do not
   change the grid unless it visibly breaks.
8. Update the Theme section's description at `SettingsView.tsx:320-323`, which currently reads
   "The shadcn palettes." — no longer the whole story.
9. Run `pnpm typecheck` and `pnpm test`.

## Verification

```bash
pnpm typecheck && pnpm test
```

Expected: `typecheck` exits 0 with no output; both test summaries unchanged (server 62, web 51+n
from Task 04) with `fail 0`.

Contrast is the one thing here that is easy to wave through, so check it with a number rather than
an impression. For each theme and mode, read the two pairs off the computed styles in devtools and
compare their `oklch` lightness:

```js
// paste in the devtools console with the theme active
const v = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
['--background','--foreground','--card','--muted-foreground','--border','--primary','--primary-foreground'].forEach(n => console.log(n, v(n)));
```

**Pass thresholds:** `--foreground` vs `--background` at least 40 lightness percentage points
apart; `--muted-foreground` vs `--card` at least 30. Below that, retune before moving on.

Then `pnpm dev` → Settings → Appearance, and for **each** of the six new themes, in **both** light
and dark mode (12 passes):

| Check | Expected |
|---|---|
| Swatch in the grid | Shows that theme's own card / accent / primary, not the previous theme's |
| Body text on background | Readable, and ≥40pp lightness gap by the check above |
| Muted text on a card | Readable, clearly dimmer than body text, ≥30pp gap |
| Borders | Visible against both background and card |
| A destructive control (the provider logout confirm dialog) | Recognisably red |
| Open a file in the editor | Syntax colors identical to the `sr03` theme |
| Open a diff | Added/removed colors identical to the `sr03` theme |
| A focused input | Ring visible |

Then, once:

- Pick a new theme, reload → same theme (criterion 18).
- Pick a new theme, set Mode to System, flip macOS between light and dark → the app follows.
- Grep for leakage: `grep -n 'data-theme="\(neon\|bloom\|terminal\|dune\|nord\|mono\)"' web/src/index.css`
  should return exactly 12 lines — six light, six dark.

## Do not

- Do not redefine git, syntax, file-icon or `--added` tokens inside a theme block.
- Do not remove or restyle any existing theme.
- Do not introduce raw hex or a one-off color outside these blocks.
- Do not skip a property to "let it inherit".
