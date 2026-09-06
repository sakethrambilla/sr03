# Task 3: The Light/Dark/System control

**Depends on:** Task 1 (needs `Appearance.mode` and `setAppearance`), Task 2 (needs both halves of
every theme's CSS to actually see the effect)
**Files:**
- Modify: `web/src/components/SettingsView.tsx`

**Interfaces:**
- Consumes: `state.appearance.mode` (`ThemeMode`), `state.setAppearance` (already
  `(patch: Partial<Appearance>) => void`, unchanged signature).
- Produces: nothing new exported; this is the last piece that lets a user reach `mode` at all.

## Steps

- [ ] 1. Open `web/src/components/SettingsView.tsx`. Add `ThemeMode` to the existing import from
      `../lib/appearance.ts`:

      ```ts
      import { THEMES, availableFonts } from "../lib/appearance.ts";
      ```
      becomes
      ```ts
      import { THEMES, availableFonts } from "../lib/appearance.ts";
      import type { ThemeMode } from "../lib/appearance.ts";
      ```

- [ ] 2. In `AppearancePanel` (the function that starts `function AppearancePanel() {`), the Theme
      `<section>`'s header currently ends with:

      ```tsx
        <header className="border-b border-border/60 px-4 py-3">
          <h2 className="text-[14px] font-medium">Theme</h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            The shadcn palettes. Diff, syntax and file-icon colors keep their editor meaning in
            every one.
          </p>
        </header>
        <div className="grid grid-cols-4 gap-2.5 px-4 py-4">
      ```

      Insert a Mode row between the `</header>` and the grid `<div>`:

      ```tsx
        </header>
        <div className="flex items-center gap-4 border-b border-border/60 px-4 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-foreground">Mode</p>
            <p className="text-[11.5px] text-faint">Light, dark, or match the system setting</p>
          </div>
          <Select
            value={appearance.mode}
            onValueChange={(next) => setAppearance({ mode: next as ThemeMode })}
          >
            <SelectTrigger className="w-56 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-4 gap-2.5 px-4 py-4">
      ```

      (`Select`/`SelectContent`/`SelectItem`/`SelectTrigger`/`SelectValue` are already imported at
      the top of this file for the permission-mode and font pickers — no new import needed beyond
      the `ThemeMode` type added in step 1.)

- [ ] 3. Run `pnpm -C web typecheck`.
      Expect: exits 0. If `next as ThemeMode` errors as an unused cast or mismatched type, confirm
      `Appearance.mode`'s type from Task 1 is exactly `"light" | "dark" | "system"` and that the
      `ThemeMode` import in step 1 resolved (check the relative path matches the existing
      `THEMES`/`availableFonts` import line just above it).

- [ ] 4. Run `pnpm -C web dev`, open the app, open Settings → Appearance.
      Expect: a "Mode" row above the theme swatch grid, showing a dropdown with the current mode
      selected (default: "Dark").
      Pick "Light". Expect: the entire app — this settings panel included — switches to the light
      appearance immediately, no reload.
      Pick "Dark". Expect: it switches back to today's dark appearance.
      Pick "System". Expect: it matches whatever your OS is currently set to (check your OS's
      appearance setting to know which to expect).
      Reload the page (⌘R). Expect: the mode you left it on is still selected and still applied —
      confirms `saveAppearance`/`restoreAppearance` round-trip `mode` with no code change needed
      there (it already persists the whole `Appearance` object as one JSON blob).

- [ ] 5. `git add web/src/components/SettingsView.tsx`
      `git commit -m "feat(web): add a Light/Dark/System control to the appearance panel"`

## Done when

A user can pick Light, Dark, or System from Settings → Appearance, the whole app updates
immediately without a reload, and the choice survives a reload. Every one of the 13 theme swatches,
clicked while in Light mode, shows that theme's light colors (spot-check at least 3 — `zinc`,
`sr03`, and one accent color like `blue` — full 13×2 coverage is Task 4).
