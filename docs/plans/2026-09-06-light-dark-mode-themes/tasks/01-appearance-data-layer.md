# Task 1: Appearance data layer — mode field, resolution, live system tracking

**Depends on:** none
**Files:**
- Modify: `web/src/lib/appearance.ts`
- Create: `web/src/lib/appearance.test.ts`
- Modify: `web/src/store.ts`

**Interfaces:**
- Produces: `export type ThemeMode = "light" | "dark" | "system";`
- Produces: `export function resolveDark(mode: ThemeMode, systemPrefersDark: boolean): boolean` —
  pure, no DOM access, unit-testable directly.
- Produces: `export function systemPrefersDark(): boolean` — the one call site that touches
  `window.matchMedia`.
- Produces: `export function watchSystemMode(onChange: () => void): void` — registers `onChange`
  on the OS preference's `change` event. Does not itself decide whether to react; the caller (Task
  1's `store.ts` change) checks the current mode before acting.
- Modifies: `Appearance` gains `mode: ThemeMode`; `DEFAULTS.mode` is `"dark"`.
- Modifies: `applyAppearance` additionally toggles the `.dark` class on `document.documentElement`.

## Steps

- [ ] 1. Open `web/src/lib/appearance.ts`. Add the `ThemeMode` type and extend the `Appearance`
      interface, right after the existing interface:

      ```ts
      export type ThemeMode = "light" | "dark" | "system";

      export interface Appearance {
        theme: string;
        uiFont: string;
        codeFont: string;
        mode: ThemeMode;
      }
      ```

- [ ] 2. Directly below `THEMES` (after its closing `];`), add the pure resolution function and
      the two DOM-touching helpers:

      ```ts
      // pure: takes the OS preference as a value rather than reading matchMedia itself, so it's
      // unit-testable without a DOM
      export function resolveDark(mode: ThemeMode, systemPrefersDark: boolean): boolean {
        if (mode === "system") return systemPrefersDark;
        return mode === "dark";
      }

      export function systemPrefersDark(): boolean {
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
      }

      // fires on every OS light/dark flip, regardless of sr03's own mode — the caller decides
      // whether that flip is worth reacting to
      export function watchSystemMode(onChange: () => void): void {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onChange);
      }
      ```

- [ ] 3. In `applyAppearance`, add the `mode` param and the class toggle. Replace:

      ```ts
      export function applyAppearance({ theme, uiFont, codeFont }: Appearance): void {
        const root = document.documentElement;
        if (theme && theme !== "sr03") root.setAttribute("data-theme", theme);
        else root.removeAttribute("data-theme");
      ```

      with:

      ```ts
      export function applyAppearance({ theme, uiFont, codeFont, mode }: Appearance): void {
        const root = document.documentElement;
        if (theme && theme !== "sr03") root.setAttribute("data-theme", theme);
        else root.removeAttribute("data-theme");
        root.classList.toggle("dark", resolveDark(mode, systemPrefersDark()));
      ```

      Leave the rest of the function (the font `style.setProperty` calls) unchanged.

- [ ] 4. Update `DEFAULTS` to include the new field, preserving today's appearance for anyone with
      no stored preference (spec acceptance criterion 9):

      ```ts
      const DEFAULTS: Appearance = { theme: "sr03", uiFont: "", codeFont: "", mode: "dark" };
      ```

- [ ] 5. Create `web/src/lib/appearance.test.ts`, following `web/src/lib/layout.test.ts`'s style
      (`node:assert/strict` + `node:test`, no DOM):

      ```ts
      // resolveDark is the one piece of mode logic with no DOM dependency, so it's the one piece
      // tested directly — applyAppearance and the system-preference wiring are exercised by hand
      // (see docs/plans/2026-09-06-light-dark-mode-themes/tasks/04-preview-panes-and-qa.md)
      import assert from "node:assert/strict";
      import test from "node:test";

      import { resolveDark } from "./appearance.ts";

      test("resolveDark: explicit light and dark ignore the OS preference", () => {
        assert.strictEqual(resolveDark("light", true), false);
        assert.strictEqual(resolveDark("light", false), false);
        assert.strictEqual(resolveDark("dark", true), true);
        assert.strictEqual(resolveDark("dark", false), true);
      });

      test("resolveDark: system follows the OS preference", () => {
        assert.strictEqual(resolveDark("system", true), true);
        assert.strictEqual(resolveDark("system", false), false);
      });
      ```

- [ ] 6. Run `pnpm -C web test`.
      Expect: Node's test runner prints `ℹ tests 45`, `ℹ pass 45`, `ℹ fail 0` (43 existing cases
      in `layout.test.ts` plus the 2 new `resolveDark` cases above — each `test(...)` block counts
      as one, not each assertion).
      If `resolveDark` is not found, check the export was added at module scope in step 2, not
      nested inside another function.

- [ ] 7. In `web/src/store.ts`, find the two lines right above `export const useStore = create<Store>(...)`:

      ```ts
      const startingAppearance = loadAppearance();
      applyAppearance(startingAppearance);
      ```

      Update the `appearance.ts` import line just above them to also bring in `watchSystemMode`:

      ```ts
      import { applyAppearance, loadAppearance, saveAppearance, watchSystemMode } from "./lib/appearance.ts";
      ```

- [ ] 8. Immediately after the closing `}));` of the `create<Store>(...)` call (the line that ends
      the whole store definition), register the live system-preference listener:

      ```ts
      // System mode has to react to the OS flipping underneath it with no user action of its own —
      // this is the one path that changes what's rendered without a setAppearance call. Re-running
      // applyAppearance recomputes the .dark class; re-setting `appearance` to a fresh reference is
      // what makes every component reading it (Mermaid, Excalidraw, the terminal) re-render, since
      // the persisted `mode` string itself never changes
      watchSystemMode(() => {
        const { appearance } = useStore.getState();
        if (appearance.mode !== "system") return;
        applyAppearance(appearance);
        useStore.setState({ appearance: { ...appearance } });
      });
      ```

- [ ] 9. Run `pnpm -C web typecheck`.
      Expect: exits 0, no new errors. If `Appearance` is reported as missing `mode` anywhere,
      that call site needs `{ ...DEFAULTS, mode: ... }` or similar — there should be none outside
      `appearance.ts`/`store.ts` at this point, since `SettingsView.tsx` isn't touched until Task 3.

- [ ] 10. `git add web/src/lib/appearance.ts web/src/lib/appearance.test.ts web/src/store.ts`
      `git commit -m "feat(web): add light/dark/system mode to the appearance model"`

## Done when

`pnpm -C web test` passes including the two new `resolveDark` cases, `pnpm -C web typecheck`
exits clean, and `useStore.getState().appearance.mode` is `"dark"` by default with no stored
preference. There is no visible behavior change yet — the `.dark` class is now toggled correctly,
but every theme's CSS still only defines dark values (Task 2), and nothing in the UI can change
`mode` yet (Task 3).
