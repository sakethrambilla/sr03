# Task 4: Mermaid, Excalidraw, and full manual verification

**Depends on:** Task 1, Task 2, Task 3 (this is the last task — it needs the full picker working)
**Files:**
- Modify: `web/src/components/Mermaid.tsx`
- Modify: `web/src/components/ExcalidrawView.tsx`

**Interfaces:**
- Consumes: `resolveDark`, `systemPrefersDark` from `web/src/lib/appearance.ts` (Task 1).
- Produces: no new exports; both components resolve light/dark themselves at render time.

## Steps

- [ ] 1. Open `web/src/components/Mermaid.tsx`. Update the import to bring in the resolver:

      ```ts
      import { useStore } from "../store.ts";
      ```
      becomes
      ```ts
      import { resolveDark, systemPrefersDark } from "../lib/appearance.ts";
      import { useStore } from "../store.ts";
      ```

- [ ] 2. Replace the stale comment and the theme-only cache key. Find:

      ```ts
      // sr03 has no light theme (see index.html's fixed `class="dark"`), so this only has to track
      // the current accent — read straight off the live tokens rather than hand-maintaining a palette.
      // cached per theme id so retyping a diagram doesn't re-rasterize seven colors on every keystroke
      let cache: { theme: string; variables: Record<string, string> } | null = null;
      function themeVariables(theme: string): Record<string, string> {
        if (cache?.theme === theme) return cache.variables;
      ```

      Replace with:

      ```ts
      // read straight off the live tokens rather than hand-maintaining a palette, so this tracks
      // both the current theme's accent and, now that themes have a light half, the active mode.
      // cached per theme+mode so retyping a diagram doesn't re-rasterize seven colors on every
      // keystroke
      let cache: { key: string; variables: Record<string, string> } | null = null;
      function themeVariables(key: string): Record<string, string> {
        if (cache?.key === key) return cache.variables;
      ```

      A few lines further down, the function still assigns `cache = { theme, variables };` — change
      that to `cache = { key, variables };`.

- [ ] 3. In the `Mermaid` component, find:

      ```ts
        // an already-rendered diagram has no other reason to re-run once its source stops changing,
        // so a theme/accent switch needs to be its own dependency to ever repaint it
        const theme = useStore((state) => state.appearance.theme);
      ```

      Replace with:

      ```ts
        // an already-rendered diagram has no other reason to re-run once its source stops changing,
        // so a theme/mode switch needs to be its own dependency to ever repaint it. selecting the
        // whole appearance object rather than picking .mode out of it is what catches an OS flip
        // under System mode too — store.ts's watchSystemMode wiring re-sets `appearance` to a new
        // object on every such flip without the mode string itself ever changing, and only a
        // whole-object selector (same as TerminalPanel's) observes that
        const appearance = useStore((state) => state.appearance);
        const theme = appearance.theme;
        const dark = resolveDark(appearance.mode, systemPrefersDark());
      ```

- [ ] 4. Update the two call sites that used `theme` as the cache/dependency key. Find:

      ```ts
            themeVariables: themeVariables(theme),
      ```
      replace with:
      ```ts
            themeVariables: themeVariables(`${theme}:${dark}`),
      ```

      And find the effect's dependency array:
      ```ts
      }, [source, theme]);
      ```
      replace with:
      ```ts
      }, [source, theme, dark]);
      ```

- [ ] 5. Open `web/src/components/ExcalidrawView.tsx`. Add the same two imports plus `useStore`
      (not currently imported in this file):

      ```ts
      import { Suspense, lazy, useEffect, useRef } from "react";
      ```
      becomes
      ```ts
      import { Suspense, lazy, useEffect, useRef } from "react";

      import { resolveDark, systemPrefersDark } from "../lib/appearance.ts";
      import { useStore } from "../store.ts";
      ```

      (keep the existing `import type { ExcalidrawImperativeAPI, ... }` block where it is, just
      above or below this new pair — either order is fine, this file doesn't group imports by
      kind elsewhere).

- [ ] 6. Inside the `ExcalidrawView` function body, near the top (right after the existing
      `const api = useRef<ExcalidrawImperativeAPI | null>(null);` line), add:

      ```ts
        // whole-object selector, not just .mode — see the matching comment in Mermaid.tsx for why
        // (an OS flip under System mode changes the object reference but not the mode string)
        const appearance = useStore((state) => state.appearance);
        const dark = resolveDark(appearance.mode, systemPrefersDark());
      ```

- [ ] 7. Replace the hardcoded theme prop. Find:

      ```tsx
                theme="dark"
      ```

      Replace with:

      ```tsx
                theme={dark ? "dark" : "light"}
      ```

- [ ] 8. Run `pnpm -C web typecheck`.
      Expect: exits 0.

- [ ] 9. Run `pnpm -C web test`.
      Expect: same pass count as Task 1 left it — this task adds no new test file, both components
      are exercised manually below (canvas/SVG rendering isn't practical to assert against under
      the plain Node test runner this repo uses).

- [ ] 10. Full manual verification, per this repo's testing convention (`CLAUDE.md` → "Testing
      changes"). Set up a scratch repo if you don't already have one running from an earlier task:

      ```bash
      mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main \
        && echo hello > README.md && git add . && git commit -qm init
      ```

      Then, from the sr03 repo root: `pnpm dev`, add `/tmp/sr03-repo` as a project, open a thread
      in it (any provider), and:

      - In Settings → Appearance, cycle Light → Dark → System across at least these 4 themes:
        `sr03`, `zinc` (a plain neutral), `blue` (an accent theme with white primary text), and
        `orange` (an accent theme with dark primary text). For each: confirm text stays legible
        against its background in both modes (no dark-on-dark or light-on-light), and the primary
        accent color is visibly present and on-brand for that theme.
      - Create a `.mmd` file in the file tree with a couple of nodes (e.g.
        `flowchart TD\nA-->B`), open its preview. Toggle Light/Dark in Settings while the preview
        is open. Expect: the diagram's background, node fill, and text colors swap between the
        light and dark sets — it does not stay stuck dark in Light mode.
      - Create a `.excalidraw` file, open its preview, draw a shape or two. Toggle Light/Dark.
        Expect: the canvas background and toolbar chrome switch between Excalidraw's light and
        dark theme — it does not stay stuck dark in Light mode.
      - Open the terminal panel (⌃\` or whatever this build's shortcut is — check `SHORTCUTS.md`
        if unsure) and toggle Light/Dark while it's open. Expect: the terminal's background,
        foreground, cursor, and selection colors update to match, same as they already do on a
        theme change.
      - Set Mode to System. Change your OS's light/dark setting (macOS: System Settings →
        Appearance; Windows: Settings → Personalization → Colors). Expect: sr03 follows within a
        second or two, with no reload — chrome, any open Mermaid/Excalidraw preview, and the
        terminal all update together.
      - Reload the page. Expect: whatever mode you left it on (including System) is still selected.

- [ ] 11. `git add web/src/components/Mermaid.tsx web/src/components/ExcalidrawView.tsx`
      `git commit -m "feat(web): make mermaid and excalidraw previews mode-aware"`

## Done when

Every acceptance criterion in `../spec.md` holds under manual check: the Mode control is visible
and works (1–4), all 13 themes render correctly in both modes with no fallback (5), Mermaid and
Excalidraw both switch with mode (6–7), the choice persists across a reload (8), a fresh
`localStorage` starts Dark (9), and the terminal updates on a mode change (10). `pnpm test` and
`pnpm typecheck` (the root scripts, covering both `server` and `web`) both stay clean.
