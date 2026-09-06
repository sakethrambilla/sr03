# Task 2: Light half for all 13 themes and the editor-semantic tokens

**Depends on:** none (reviewable and testable independently of Task 1 — toggle the `.dark` class
by hand in devtools to see it work before Task 1 wires that up automatically)
**Files:**
- Modify: `web/src/index.css`

**Interfaces:**
- Produces: a `.dark` class contract every other task relies on — when present on `<html>`, every
  theme's dark tokens apply; when absent, its light tokens apply.
- Consumes: nothing new; `--background`, `--card`, etc. keep the exact names every component
  already references via Tailwind's `bg-background` etc. classes.

## Background: where every value below comes from

The 12 non-`sr03` themes' **dark** values already in the file are Tailwind's own oklch color
scale, at fixed steps per token (verified by comparing every existing dark block against
`web/node_modules/tailwindcss/theme.css`): `background`=950, `card`/`popover`=900,
`secondary`/`muted`/`accent`/`border`=800, `input`=700, `muted-foreground`/`ring`=400, `faint`=500,
`foreground`=50. The **light** values below follow the mirror of that same recipe:
`background`/`card`/`popover`=pure white, `foreground`=950, `primary`=900, `primary-foreground`=50,
`secondary`/`muted`/`accent`=100, `muted-foreground`=500, `border`/`input`=200, `ring`/`faint`=400.
`destructive` is a fixed `red-600` (`oklch(57.7% 0.245 27.325)`) in light mode, same as
`destructive` is a fixed `red-400` in dark, across every theme. `destructive-foreground` is the
same value in both modes for a given theme — its base color's -50 shade (e.g. `zinc-50` for `zinc`
and every accent theme, `slate-50` for `slate`, and so on) — which is also why it happens to equal
dark mode's `foreground` (also that same -50 shade) without needing to change between modes.

The 7 accent themes (`red`, `rose`, `orange`, `green`, `blue`, `yellow`, `violet`) share `zinc`'s
chrome in both modes (already true of the existing dark blocks — compare `red`'s `background`,
`card`, `secondary`, `border` to `zinc`'s in the current file, they're identical) and differ only
in `primary`/`primary-foreground`/`ring`. In light mode, `primary`/`ring` move from that color's
500 step to its 600 step (mirroring `destructive`'s 400→600 shift); `primary-foreground` keeps
whatever the existing dark block already chose (`oklch(98.5% 0 0)` for `red`/`rose`/`blue`/`violet`,
that color's own 950 step for `orange`/`green`/`yellow` — those three are light enough at both
steps that white text wouldn't have enough contrast).

`sr03`'s light palette and the git/syntax editor-semantic light colors have no such source to copy
— they're concrete proposed values below, called out with `/* proposed */` so they're easy to find
if you want to adjust them after seeing them rendered. The file-type icon colors (`--file-*`) are
intentionally the *same* hex in both modes — Seti (the icon theme they're inspired by) has no
official light variant, and at their current lightness they already read fine on white.

Every dark half is selected with `[data-theme="x"]:is(.dark, .dark *)`, not the simpler
`[data-theme="x"].dark`. The two differ on exactly one element: `SettingsView.tsx`'s theme swatch
buttons each render as `<button data-theme={id}>` so a swatch previews its own colors regardless of
which theme is globally active (see that file's `ThemeSwatch` and its comment) — but the `.dark`
class only ever lives on `<html>`, never on a swatch button itself. `[data-theme="x"].dark` requires
both on the *same* element, so it would never match a swatch button (only `<html>` carries `.dark`,
and `<html>` only ever carries one theme's `data-theme` at a time) — every swatch other than
whichever matched the bare, unqualified rule would silently show its light colors even while the
app is in Dark mode. `:is(.dark, .dark *)` matches either the element itself being `.dark`
(`<html>`, when its own theme is what's rendering) or being a descendant of one (every swatch
button, always, since they're all inside `<html>`) — the same descendant-or-self shape this file's
own `@custom-variant dark (&:is(.dark *));` line already uses for Tailwind's `dark:` utility.

## Steps

- [ ] 1. Open `web/src/index.css`. Replace everything from the start of the file through the end
      of the `[data-theme="violet"]` block (i.e. everything before the `html,` / `body` / `#root`
      rule) with the block below. This is a full replacement of that range, not an edit within it
      — the selectors change shape throughout (every `[data-theme="x"]` block splits into a light
      half and an `[data-theme="x"]:is(.dark, .dark *)` half), so trying to patch it in place is
      more error-prone than replacing the whole range at once.

      ```css
      @import "tailwindcss";
      @import "tw-animate-css";

      /* Tailwind v4's default `dark:` variant is `prefers-color-scheme`; sr03 has its own
         Light/Dark/System picker instead (web/src/lib/appearance.ts), so `dark:` needs to track
         the `.dark` class that picker toggles on <html>, not the OS setting directly */
      @custom-variant dark (&:is(.dark *));

      /* shadcn's semantic tokens, carrying sr03's palette. the attribute selector is what lets the
         theme picker preview sr03 itself while another theme is the one in force. this is the
         light half — proposed, see this task's file for the rationale */
      :root,
      [data-theme="sr03"] {
        /* proposed */
        --background: oklch(0.98 0.004 75);
        --foreground: oklch(0.23 0.006 75);
        --card: oklch(0.955 0.005 75);
        --card-foreground: oklch(0.23 0.006 75);
        --popover: oklch(0.955 0.005 75);
        --popover-foreground: oklch(0.23 0.006 75);
        --primary: oklch(0.6 0.14 41);
        --primary-foreground: oklch(0.99 0.008 60);
        --secondary: oklch(0.91 0.006 75);
        --secondary-foreground: oklch(0.23 0.006 75);
        --muted: oklch(0.91 0.006 75);
        --muted-foreground: oklch(0.48 0.006 75);
        --accent: oklch(0.91 0.006 75);
        --accent-foreground: oklch(0.23 0.006 75);
        --destructive: oklch(0.55 0.2 22);
        --destructive-foreground: oklch(0.99 0.008 60);
        --border: oklch(0.86 0.006 75);
        --input: oklch(0.86 0.006 75);
        --ring: oklch(0.6 0.14 41);
        --faint: oklch(0.63 0.006 75);
        --radius: 0.375rem;
      }

      /* sr03's original palette, unchanged from before mode existed */
      :root.dark,
      [data-theme="sr03"]:is(.dark, .dark *) {
        --background: oklch(0.235 0.004 75);
        --foreground: oklch(0.95 0.003 75);
        --card: oklch(0.2 0.004 75);
        --card-foreground: oklch(0.95 0.003 75);
        --popover: oklch(0.2 0.004 75);
        --popover-foreground: oklch(0.95 0.003 75);
        --primary: oklch(0.66 0.12 41);
        --primary-foreground: oklch(0.99 0.008 60);
        --secondary: oklch(0.29 0.005 75);
        --secondary-foreground: oklch(0.95 0.003 75);
        --muted: oklch(0.29 0.005 75);
        --muted-foreground: oklch(0.73 0.005 75);
        --accent: oklch(0.29 0.005 75);
        --accent-foreground: oklch(0.95 0.003 75);
        --destructive: oklch(0.65 0.19 22);
        --destructive-foreground: oklch(0.99 0.008 60);
        --border: oklch(0.33 0.005 75);
        --input: oklch(0.33 0.005 75);
        --ring: oklch(0.66 0.12 41);
        --faint: oklch(0.57 0.006 75);
      }

      @theme inline {
        --color-background: var(--background);
        --color-foreground: var(--foreground);
        --color-card: var(--card);
        --color-card-foreground: var(--card-foreground);
        --color-popover: var(--popover);
        --color-popover-foreground: var(--popover-foreground);
        --color-primary: var(--primary);
        --color-primary-foreground: var(--primary-foreground);
        --color-secondary: var(--secondary);
        --color-secondary-foreground: var(--secondary-foreground);
        --color-muted: var(--muted);
        --color-muted-foreground: var(--muted-foreground);
        --color-accent: var(--accent);
        --color-accent-foreground: var(--accent-foreground);
        --color-destructive: var(--destructive);
        --color-destructive-foreground: var(--destructive-foreground);
        --color-border: var(--border);
        --color-input: var(--input);
        --color-ring: var(--ring);
        --color-faint: var(--faint);
        --color-status-done: var(--status-done);
        --color-git-added: var(--git-added);
        --color-git-modified: var(--git-modified);
        --color-git-deleted: var(--git-deleted);
        --color-git-untracked: var(--git-untracked);
        --color-git-ignored: var(--git-ignored);
        --color-code-comment: var(--code-comment);
        --color-code-string: var(--code-string);
        --color-code-keyword: var(--code-keyword);
        --color-code-control: var(--code-control);
        --color-code-number: var(--code-number);
        --color-code-type: var(--code-type);
        --color-code-function: var(--code-function);
        --color-code-property: var(--code-property);
        --color-code-inline: var(--code-inline);
        --color-file-code: var(--file-code);
        --color-file-data: var(--file-data);
        --color-file-style: var(--file-style);
        --color-file-shell: var(--file-shell);
        --color-file-doc: var(--file-doc);
        --radius-sm: calc(var(--radius) - 2px);
        --radius-md: var(--radius);
        --radius-lg: calc(var(--radius) + 2px);
        --radius-xl: calc(var(--radius) + 4px);
      }

      /* deliberately not `inline`: an inlined family is baked into every utility, and the appearance
         picker needs `font-sans` and `font-mono` to keep reading the variable */
      @theme {
        --font-sans:
          -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, "Helvetica Neue",
          sans-serif;
        --font-mono: ui-monospace, "SF Mono", Menlo, "JetBrains Mono", monospace;
      }

      /* editor semantics: git decorations, syntax hues, prose-code chip, file-type icon colors.
         constant across all 13 themes in a given mode — only mode changes them, not theme. this is
         the light half; git and syntax colors are VS Code's own Light+ defaults, --code-inline is
         proposed (see this task's file), --file-* are deliberately identical to the dark half */
      :root {
        --status-done: oklch(0.82 0.11 85);
        --git-added: #587c0c;
        --git-modified: #895503;
        --git-deleted: #ad0707;
        --git-untracked: #007100;
        --git-ignored: #a1a1a1;
        --code-comment: #008000;
        --code-string: #a31515;
        --code-keyword: #0000ff;
        --code-control: #af00db;
        --code-number: #098658;
        --code-type: #267f99;
        --code-function: #795e26;
        --code-property: #001080;
        /* proposed */
        --code-inline: oklch(0.5 0.16 28);
        --file-code: #519aba;
        --file-data: #cbcb41;
        --file-style: #a074c4;
        --file-shell: #8dc149;
        --file-doc: #6d8086;
      }

      /* VS Code's own gitDecoration.* and token.* Dark+ defaults, so the file tree and code blocks
         read the way the editor does */
      :root.dark {
        --git-added: #81b88b;
        --git-modified: #e2c08d;
        --git-deleted: #c74e39;
        --git-untracked: #73c991;
        --git-ignored: #8c8c8c;
        --code-comment: #6a9955;
        --code-string: #ce9178;
        --code-keyword: #569cd6;
        --code-control: #c586c0;
        --code-number: #b5cea8;
        --code-type: #4ec9b0;
        --code-function: #dcdcaa;
        --code-property: #9cdcfe;
        --code-inline: oklch(0.74 0.12 28);
      }

      /* the shadcn theme set, built on Tailwind's own palette. only the chrome moves — the git,
         syntax and file-icon hues above are editor semantics and stay put across every theme.
         light half first, then its .dark override, per theme */

      [data-theme="zinc"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.1% 0.005 285.823);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.1% 0.005 285.823);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.1% 0.005 285.823);
        --primary: oklch(21% 0.006 285.885);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(96.7% 0.001 286.375);
        --secondary-foreground: oklch(21% 0.006 285.885);
        --muted: oklch(96.7% 0.001 286.375);
        --muted-foreground: oklch(55.2% 0.016 285.938);
        --accent: oklch(96.7% 0.001 286.375);
        --accent-foreground: oklch(21% 0.006 285.885);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92% 0.004 286.32);
        --input: oklch(92% 0.004 286.32);
        --ring: oklch(70.5% 0.015 286.067);
        --faint: oklch(70.5% 0.015 286.067);
      }

      [data-theme="zinc"]:is(.dark, .dark *) {
        --background: oklch(14.1% 0.005 285.823);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(21% 0.006 285.885);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(21% 0.006 285.885);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(92% 0.004 286.32);
        --primary-foreground: oklch(21% 0.006 285.885);
        --secondary: oklch(27.4% 0.006 286.033);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(27.4% 0.006 286.033);
        --muted-foreground: oklch(70.5% 0.015 286.067);
        --accent: oklch(27.4% 0.006 286.033);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(27.4% 0.006 286.033);
        --input: oklch(37% 0.013 285.805);
        --ring: oklch(70.5% 0.015 286.067);
        --faint: oklch(55.2% 0.016 285.938);
      }

      [data-theme="slate"] {
        --background: oklch(1 0 0);
        --foreground: oklch(12.9% 0.042 264.695);
        --card: oklch(1 0 0);
        --card-foreground: oklch(12.9% 0.042 264.695);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(12.9% 0.042 264.695);
        --primary: oklch(20.8% 0.042 265.755);
        --primary-foreground: oklch(98.4% 0.003 247.858);
        --secondary: oklch(96.8% 0.007 247.896);
        --secondary-foreground: oklch(20.8% 0.042 265.755);
        --muted: oklch(96.8% 0.007 247.896);
        --muted-foreground: oklch(55.4% 0.046 257.417);
        --accent: oklch(96.8% 0.007 247.896);
        --accent-foreground: oklch(20.8% 0.042 265.755);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.4% 0.003 247.858);
        --border: oklch(92.9% 0.013 255.508);
        --input: oklch(92.9% 0.013 255.508);
        --ring: oklch(70.4% 0.04 256.788);
        --faint: oklch(70.4% 0.04 256.788);
      }

      [data-theme="slate"]:is(.dark, .dark *) {
        --background: oklch(12.9% 0.042 264.695);
        --foreground: oklch(98.4% 0.003 247.858);
        --card: oklch(20.8% 0.042 265.755);
        --card-foreground: oklch(98.4% 0.003 247.858);
        --popover: oklch(20.8% 0.042 265.755);
        --popover-foreground: oklch(98.4% 0.003 247.858);
        --primary: oklch(92.9% 0.013 255.508);
        --primary-foreground: oklch(20.8% 0.042 265.755);
        --secondary: oklch(27.9% 0.041 260.031);
        --secondary-foreground: oklch(98.4% 0.003 247.858);
        --muted: oklch(27.9% 0.041 260.031);
        --muted-foreground: oklch(70.4% 0.04 256.788);
        --accent: oklch(27.9% 0.041 260.031);
        --accent-foreground: oklch(98.4% 0.003 247.858);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.4% 0.003 247.858);
        --border: oklch(27.9% 0.041 260.031);
        --input: oklch(37.2% 0.044 257.287);
        --ring: oklch(70.4% 0.04 256.788);
        --faint: oklch(55.4% 0.046 257.417);
      }

      [data-theme="stone"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.7% 0.004 49.25);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.7% 0.004 49.25);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.7% 0.004 49.25);
        --primary: oklch(21.6% 0.006 56.043);
        --primary-foreground: oklch(98.5% 0.001 106.423);
        --secondary: oklch(97% 0.001 106.424);
        --secondary-foreground: oklch(21.6% 0.006 56.043);
        --muted: oklch(97% 0.001 106.424);
        --muted-foreground: oklch(55.3% 0.013 58.071);
        --accent: oklch(97% 0.001 106.424);
        --accent-foreground: oklch(21.6% 0.006 56.043);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0.001 106.423);
        --border: oklch(92.3% 0.003 48.717);
        --input: oklch(92.3% 0.003 48.717);
        --ring: oklch(70.9% 0.01 56.259);
        --faint: oklch(70.9% 0.01 56.259);
      }

      [data-theme="stone"]:is(.dark, .dark *) {
        --background: oklch(14.7% 0.004 49.25);
        --foreground: oklch(98.5% 0.001 106.423);
        --card: oklch(21.6% 0.006 56.043);
        --card-foreground: oklch(98.5% 0.001 106.423);
        --popover: oklch(21.6% 0.006 56.043);
        --popover-foreground: oklch(98.5% 0.001 106.423);
        --primary: oklch(92.3% 0.003 48.717);
        --primary-foreground: oklch(21.6% 0.006 56.043);
        --secondary: oklch(26.8% 0.007 34.298);
        --secondary-foreground: oklch(98.5% 0.001 106.423);
        --muted: oklch(26.8% 0.007 34.298);
        --muted-foreground: oklch(70.9% 0.01 56.259);
        --accent: oklch(26.8% 0.007 34.298);
        --accent-foreground: oklch(98.5% 0.001 106.423);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0.001 106.423);
        --border: oklch(26.8% 0.007 34.298);
        --input: oklch(37.4% 0.01 67.558);
        --ring: oklch(70.9% 0.01 56.259);
        --faint: oklch(55.3% 0.013 58.071);
      }

      [data-theme="gray"] {
        --background: oklch(1 0 0);
        --foreground: oklch(13% 0.028 261.692);
        --card: oklch(1 0 0);
        --card-foreground: oklch(13% 0.028 261.692);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(13% 0.028 261.692);
        --primary: oklch(21% 0.034 264.665);
        --primary-foreground: oklch(98.5% 0.002 247.839);
        --secondary: oklch(96.7% 0.003 264.542);
        --secondary-foreground: oklch(21% 0.034 264.665);
        --muted: oklch(96.7% 0.003 264.542);
        --muted-foreground: oklch(55.1% 0.027 264.364);
        --accent: oklch(96.7% 0.003 264.542);
        --accent-foreground: oklch(21% 0.034 264.665);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0.002 247.839);
        --border: oklch(92.8% 0.006 264.531);
        --input: oklch(92.8% 0.006 264.531);
        --ring: oklch(70.7% 0.022 261.325);
        --faint: oklch(70.7% 0.022 261.325);
      }

      [data-theme="gray"]:is(.dark, .dark *) {
        --background: oklch(13% 0.028 261.692);
        --foreground: oklch(98.5% 0.002 247.839);
        --card: oklch(21% 0.034 264.665);
        --card-foreground: oklch(98.5% 0.002 247.839);
        --popover: oklch(21% 0.034 264.665);
        --popover-foreground: oklch(98.5% 0.002 247.839);
        --primary: oklch(92.8% 0.006 264.531);
        --primary-foreground: oklch(21% 0.034 264.665);
        --secondary: oklch(27.8% 0.033 256.848);
        --secondary-foreground: oklch(98.5% 0.002 247.839);
        --muted: oklch(27.8% 0.033 256.848);
        --muted-foreground: oklch(70.7% 0.022 261.325);
        --accent: oklch(27.8% 0.033 256.848);
        --accent-foreground: oklch(98.5% 0.002 247.839);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0.002 247.839);
        --border: oklch(27.8% 0.033 256.848);
        --input: oklch(37.3% 0.034 259.733);
        --ring: oklch(70.7% 0.022 261.325);
        --faint: oklch(55.1% 0.027 264.364);
      }

      [data-theme="neutral"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.5% 0 0);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.5% 0 0);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.5% 0 0);
        --primary: oklch(20.5% 0 0);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(97% 0 0);
        --secondary-foreground: oklch(20.5% 0 0);
        --muted: oklch(97% 0 0);
        --muted-foreground: oklch(55.6% 0 0);
        --accent: oklch(97% 0 0);
        --accent-foreground: oklch(20.5% 0 0);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92.2% 0 0);
        --input: oklch(92.2% 0 0);
        --ring: oklch(70.8% 0 0);
        --faint: oklch(70.8% 0 0);
      }

      [data-theme="neutral"]:is(.dark, .dark *) {
        --background: oklch(14.5% 0 0);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(20.5% 0 0);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(20.5% 0 0);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(92.2% 0 0);
        --primary-foreground: oklch(20.5% 0 0);
        --secondary: oklch(26.9% 0 0);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(26.9% 0 0);
        --muted-foreground: oklch(70.8% 0 0);
        --accent: oklch(26.9% 0 0);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(26.9% 0 0);
        --input: oklch(37.1% 0 0);
        --ring: oklch(70.8% 0 0);
        --faint: oklch(55.6% 0 0);
      }

      [data-theme="red"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.1% 0.005 285.823);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.1% 0.005 285.823);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.1% 0.005 285.823);
        --primary: oklch(57.7% 0.245 27.325);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(96.7% 0.001 286.375);
        --secondary-foreground: oklch(14.1% 0.005 285.823);
        --muted: oklch(96.7% 0.001 286.375);
        --muted-foreground: oklch(55.2% 0.016 285.938);
        --accent: oklch(96.7% 0.001 286.375);
        --accent-foreground: oklch(14.1% 0.005 285.823);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92% 0.004 286.32);
        --input: oklch(92% 0.004 286.32);
        --ring: oklch(57.7% 0.245 27.325);
        --faint: oklch(70.5% 0.015 286.067);
      }

      [data-theme="red"]:is(.dark, .dark *) {
        --background: oklch(14.1% 0.005 285.823);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(21% 0.006 285.885);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(21% 0.006 285.885);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(63.7% 0.237 25.331);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(27.4% 0.006 286.033);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(27.4% 0.006 286.033);
        --muted-foreground: oklch(70.5% 0.015 286.067);
        --accent: oklch(27.4% 0.006 286.033);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(27.4% 0.006 286.033);
        --input: oklch(37% 0.013 285.805);
        --ring: oklch(63.7% 0.237 25.331);
        --faint: oklch(55.2% 0.016 285.938);
      }

      [data-theme="rose"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.1% 0.005 285.823);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.1% 0.005 285.823);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.1% 0.005 285.823);
        --primary: oklch(58.6% 0.253 17.585);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(96.7% 0.001 286.375);
        --secondary-foreground: oklch(14.1% 0.005 285.823);
        --muted: oklch(96.7% 0.001 286.375);
        --muted-foreground: oklch(55.2% 0.016 285.938);
        --accent: oklch(96.7% 0.001 286.375);
        --accent-foreground: oklch(14.1% 0.005 285.823);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92% 0.004 286.32);
        --input: oklch(92% 0.004 286.32);
        --ring: oklch(58.6% 0.253 17.585);
        --faint: oklch(70.5% 0.015 286.067);
      }

      [data-theme="rose"]:is(.dark, .dark *) {
        --background: oklch(14.1% 0.005 285.823);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(21% 0.006 285.885);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(21% 0.006 285.885);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(64.5% 0.246 16.439);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(27.4% 0.006 286.033);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(27.4% 0.006 286.033);
        --muted-foreground: oklch(70.5% 0.015 286.067);
        --accent: oklch(27.4% 0.006 286.033);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(27.4% 0.006 286.033);
        --input: oklch(37% 0.013 285.805);
        --ring: oklch(64.5% 0.246 16.439);
        --faint: oklch(55.2% 0.016 285.938);
      }

      [data-theme="orange"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.1% 0.005 285.823);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.1% 0.005 285.823);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.1% 0.005 285.823);
        --primary: oklch(64.6% 0.222 41.116);
        --primary-foreground: oklch(26.6% 0.079 36.259);
        --secondary: oklch(96.7% 0.001 286.375);
        --secondary-foreground: oklch(14.1% 0.005 285.823);
        --muted: oklch(96.7% 0.001 286.375);
        --muted-foreground: oklch(55.2% 0.016 285.938);
        --accent: oklch(96.7% 0.001 286.375);
        --accent-foreground: oklch(14.1% 0.005 285.823);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92% 0.004 286.32);
        --input: oklch(92% 0.004 286.32);
        --ring: oklch(64.6% 0.222 41.116);
        --faint: oklch(70.5% 0.015 286.067);
      }

      [data-theme="orange"]:is(.dark, .dark *) {
        --background: oklch(14.1% 0.005 285.823);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(21% 0.006 285.885);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(21% 0.006 285.885);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(70.5% 0.213 47.604);
        --primary-foreground: oklch(26.6% 0.079 36.259);
        --secondary: oklch(27.4% 0.006 286.033);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(27.4% 0.006 286.033);
        --muted-foreground: oklch(70.5% 0.015 286.067);
        --accent: oklch(27.4% 0.006 286.033);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(27.4% 0.006 286.033);
        --input: oklch(37% 0.013 285.805);
        --ring: oklch(70.5% 0.213 47.604);
        --faint: oklch(55.2% 0.016 285.938);
      }

      [data-theme="green"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.1% 0.005 285.823);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.1% 0.005 285.823);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.1% 0.005 285.823);
        --primary: oklch(62.7% 0.194 149.214);
        --primary-foreground: oklch(26.6% 0.065 152.934);
        --secondary: oklch(96.7% 0.001 286.375);
        --secondary-foreground: oklch(14.1% 0.005 285.823);
        --muted: oklch(96.7% 0.001 286.375);
        --muted-foreground: oklch(55.2% 0.016 285.938);
        --accent: oklch(96.7% 0.001 286.375);
        --accent-foreground: oklch(14.1% 0.005 285.823);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92% 0.004 286.32);
        --input: oklch(92% 0.004 286.32);
        --ring: oklch(62.7% 0.194 149.214);
        --faint: oklch(70.5% 0.015 286.067);
      }

      [data-theme="green"]:is(.dark, .dark *) {
        --background: oklch(14.1% 0.005 285.823);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(21% 0.006 285.885);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(21% 0.006 285.885);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(72.3% 0.219 149.579);
        --primary-foreground: oklch(26.6% 0.065 152.934);
        --secondary: oklch(27.4% 0.006 286.033);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(27.4% 0.006 286.033);
        --muted-foreground: oklch(70.5% 0.015 286.067);
        --accent: oklch(27.4% 0.006 286.033);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(27.4% 0.006 286.033);
        --input: oklch(37% 0.013 285.805);
        --ring: oklch(72.3% 0.219 149.579);
        --faint: oklch(55.2% 0.016 285.938);
      }

      [data-theme="blue"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.1% 0.005 285.823);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.1% 0.005 285.823);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.1% 0.005 285.823);
        --primary: oklch(54.6% 0.245 262.881);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(96.7% 0.001 286.375);
        --secondary-foreground: oklch(14.1% 0.005 285.823);
        --muted: oklch(96.7% 0.001 286.375);
        --muted-foreground: oklch(55.2% 0.016 285.938);
        --accent: oklch(96.7% 0.001 286.375);
        --accent-foreground: oklch(14.1% 0.005 285.823);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92% 0.004 286.32);
        --input: oklch(92% 0.004 286.32);
        --ring: oklch(54.6% 0.245 262.881);
        --faint: oklch(70.5% 0.015 286.067);
      }

      [data-theme="blue"]:is(.dark, .dark *) {
        --background: oklch(14.1% 0.005 285.823);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(21% 0.006 285.885);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(21% 0.006 285.885);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(62.3% 0.214 259.815);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(27.4% 0.006 286.033);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(27.4% 0.006 286.033);
        --muted-foreground: oklch(70.5% 0.015 286.067);
        --accent: oklch(27.4% 0.006 286.033);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(27.4% 0.006 286.033);
        --input: oklch(37% 0.013 285.805);
        --ring: oklch(62.3% 0.214 259.815);
        --faint: oklch(55.2% 0.016 285.938);
      }

      [data-theme="yellow"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.1% 0.005 285.823);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.1% 0.005 285.823);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.1% 0.005 285.823);
        --primary: oklch(68.1% 0.162 75.834);
        --primary-foreground: oklch(28.6% 0.066 53.813);
        --secondary: oklch(96.7% 0.001 286.375);
        --secondary-foreground: oklch(14.1% 0.005 285.823);
        --muted: oklch(96.7% 0.001 286.375);
        --muted-foreground: oklch(55.2% 0.016 285.938);
        --accent: oklch(96.7% 0.001 286.375);
        --accent-foreground: oklch(14.1% 0.005 285.823);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92% 0.004 286.32);
        --input: oklch(92% 0.004 286.32);
        --ring: oklch(68.1% 0.162 75.834);
        --faint: oklch(70.5% 0.015 286.067);
      }

      [data-theme="yellow"]:is(.dark, .dark *) {
        --background: oklch(14.1% 0.005 285.823);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(21% 0.006 285.885);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(21% 0.006 285.885);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(79.5% 0.184 86.047);
        --primary-foreground: oklch(28.6% 0.066 53.813);
        --secondary: oklch(27.4% 0.006 286.033);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(27.4% 0.006 286.033);
        --muted-foreground: oklch(70.5% 0.015 286.067);
        --accent: oklch(27.4% 0.006 286.033);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(27.4% 0.006 286.033);
        --input: oklch(37% 0.013 285.805);
        --ring: oklch(79.5% 0.184 86.047);
        --faint: oklch(55.2% 0.016 285.938);
      }

      [data-theme="violet"] {
        --background: oklch(1 0 0);
        --foreground: oklch(14.1% 0.005 285.823);
        --card: oklch(1 0 0);
        --card-foreground: oklch(14.1% 0.005 285.823);
        --popover: oklch(1 0 0);
        --popover-foreground: oklch(14.1% 0.005 285.823);
        --primary: oklch(54.1% 0.281 293.009);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(96.7% 0.001 286.375);
        --secondary-foreground: oklch(14.1% 0.005 285.823);
        --muted: oklch(96.7% 0.001 286.375);
        --muted-foreground: oklch(55.2% 0.016 285.938);
        --accent: oklch(96.7% 0.001 286.375);
        --accent-foreground: oklch(14.1% 0.005 285.823);
        --destructive: oklch(57.7% 0.245 27.325);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(92% 0.004 286.32);
        --input: oklch(92% 0.004 286.32);
        --ring: oklch(54.1% 0.281 293.009);
        --faint: oklch(70.5% 0.015 286.067);
      }

      [data-theme="violet"]:is(.dark, .dark *) {
        --background: oklch(14.1% 0.005 285.823);
        --foreground: oklch(98.5% 0 0);
        --card: oklch(21% 0.006 285.885);
        --card-foreground: oklch(98.5% 0 0);
        --popover: oklch(21% 0.006 285.885);
        --popover-foreground: oklch(98.5% 0 0);
        --primary: oklch(60.6% 0.25 292.717);
        --primary-foreground: oklch(98.5% 0 0);
        --secondary: oklch(27.4% 0.006 286.033);
        --secondary-foreground: oklch(98.5% 0 0);
        --muted: oklch(27.4% 0.006 286.033);
        --muted-foreground: oklch(70.5% 0.015 286.067);
        --accent: oklch(27.4% 0.006 286.033);
        --accent-foreground: oklch(98.5% 0 0);
        --destructive: oklch(70.4% 0.191 22.216);
        --destructive-foreground: oklch(98.5% 0 0);
        --border: oklch(27.4% 0.006 286.033);
        --input: oklch(37% 0.013 285.805);
        --ring: oklch(60.6% 0.25 292.717);
        --faint: oklch(55.2% 0.016 285.938);
      }
      ```

      Leave the `html, body, #root { ... }` rule and everything after it (scrollbar styles,
      `select option`, the Electron title-bar rules) exactly as it is.

- [ ] 2. Run `pnpm -C web build`.
      Expect: build succeeds with no PostCSS/Tailwind error. A stray brace or duplicate selector
      from the replacement above is the most likely failure mode — if it fails, count the
      top-level rule blocks between `@custom-variant` and `html,`: 24 shadcn theme blocks (12
      themes × light + dark) + 2 `sr03` blocks (light + dark) + 2 editor-semantic blocks (light +
      dark) + the 2 existing `@theme`/`@theme inline` blocks = 30 total.

- [ ] 3. Run `pnpm -C web dev` and open `http://localhost:5399` (or whatever port it prints).
      In the browser devtools console, run:
      ```js
      document.documentElement.classList.remove("dark")
      ```
      Expect: the whole app immediately turns light — white-ish background, dark text, no visual
      trace of the previous dark surface. This works even before Task 1/3 ship, since the class is
      being toggled by hand.
      Then run:
      ```js
      document.documentElement.classList.add("dark")
      ```
      Expect: the app returns exactly to today's dark appearance, pixel-for-pixel what `pnpm dev`
      showed before this task (sr03's dark orange-on-charcoal look).
      Stop the dev server after (`Ctrl+C`) — Task 3 needs its own manual pass with the picker wired
      up, this step is only confirming the CSS structure works before that exists.

- [ ] 4. `git add web/src/index.css`
      `git commit -m "feat(web): add a light half to every theme and the editor-semantic tokens"`

## Done when

`pnpm -C web build` succeeds, and toggling the `.dark` class by hand in devtools flips the whole
app between a light and a dark appearance with no theme falling back to unstyled/default browser
colors. The picker itself still can't reach this yet — that's Task 3.
