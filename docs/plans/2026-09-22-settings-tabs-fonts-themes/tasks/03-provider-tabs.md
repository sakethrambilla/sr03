# Task 03 — Provider tab strip

Fixes spec criteria 1–8.

## Background

`web/src/components/SettingsView.tsx:524-530` renders every provider's card in a vertical stack:

```tsx
{providers.map((provider) => (
  <ProviderCard
    key={provider.id}
    provider={provider}
    onChanged={() => setTick((current) => current + 1)}
  />
))}
```

`providers` is `store.providerStatuses` (`ProviderStatus[]`, loaded by `loadProviderStatuses()`).
Above the stack sits the "Default provider" card (`:490-519`) and the error / "Checking…" lines
(`:520-523`). All of that stays; only the stack becomes a tab strip.

Useful existing pieces:

- `STATE_STYLE` at `:31` — maps `provider.state` (`ready` / `signed-out` / `missing`) to a dot
  class and label. Reuse it; do not define a second mapping.
- `ProviderLogo` in `web/src/components/ProviderLogo.tsx` — `<ProviderLogo id={...} />`, brand
  marks for all three providers, filled with `currentColor`.
- `usePersistedState` from `./ui.tsx` — already used at `:406` for the settings section.

## Steps

1. From `web/`, add the shadcn tabs component:
   ```bash
   cd web && pnpm dlx shadcn@latest add tabs
   ```
   This writes `web/src/components/ui/tabs.tsx`. Do not hand-edit it.
2. Run `git status` and confirm the only new file is `web/src/components/ui/tabs.tsx`. If the
   generator also modified `web/package.json`, inspect the diff — `radix-ui` ^1.6.7 is already a
   dependency and no new package should be needed. If it added `@radix-ui/react-tabs` as a separate
   entry, revert that hunk and point the generated file's import at `radix-ui` to match how the
   other generated components in `web/src/components/ui/` import Radix. Check one of them first.
3. Run `pnpm typecheck` — exit 0.
4. In `SettingsView.tsx`, add the persisted selection next to the existing section state at `:406`:
   ```tsx
   const [storedProvider, setStoredProvider] = usePersistedState<string>("settings-provider", "");
   ```
5. Derive the active provider with a fallback, so a remembered id that is no longer present does
   not render an empty panel (criterion 5):
   ```tsx
   const activeProvider =
     providers.find((entry) => entry.id === storedProvider)?.id ?? providers[0]?.id ?? "";
   ```
6. Replace the `providers.map(...)` block at `:524-530` with a `Tabs` whose `value` is
   `activeProvider` and whose `onValueChange` is `setStoredProvider`. Render one `TabsTrigger` per
   provider and one `TabsContent` per provider, each containing that provider's existing
   `<ProviderCard>` with its current props unchanged.
7. Guard on `providers.length > 0` so the strip does not render before statuses load — the existing
   "Checking…" line at `:521-523` already covers that state (criterion 6). Leave it where it is.
8. Give each `TabsTrigger` three things, in order: `<ProviderLogo id={provider.id} />`, the
   provider's label, and a state dot. The dot is a `<span>` with `rounded-full`, sized `size-1.5`,
   and the class from `STATE_STYLE[provider.state].dot`. Set the trigger's `title` or `aria-label`
   to include `STATE_STYLE[provider.state].label` so the state is readable, not colour-only
   (criterion 2).
9. Style the strip to match `EditorTabs` in `web/src/components/EditorGroups.tsx:54-140` — the
   app's only existing tab strip. Read it first, then reuse its vocabulary: `text-[12px]`, a
   `border-b border-border/60` strip, `bg-card` plus an inset primary top-line for the selected
   tab, `text-muted-foreground hover:text-foreground` for the rest. Shadcn tokens only — no raw
   hex, no one-off `oklch`. Follow the radii rule: `rounded-md` on the triggers.
10. Verify the "Default provider" card at `:490-519` is still rendered **above** the strip and is
    untouched (criterion 3).
11. Confirm `onChanged` still fires `setTick`, and that bumping `tick` re-runs the status load
    without resetting `storedProvider` — the two states are independent, so this should hold, but
    check it (criterion 7).
12. Run `pnpm typecheck` and `pnpm test`.

## Verification

```bash
pnpm typecheck && pnpm test
```

Expected: `typecheck` exits 0 with no output. `pnpm test` prints two summaries — server and web —
both with `fail 0`, and both counts unchanged by this task (server 62 after Task 01, web 51).

Then `pnpm dev` and `http://localhost:5399` → Settings → Providers, and walk the criteria:

| Check | Expected |
|---|---|
| Section loads | One horizontal strip, three entries, exactly one card below it |
| Each entry | Brand mark + name + a state dot; hovering shows the state label |
| Click another entry | Card below swaps; the Default provider control above is unchanged and still opens |
| Change the selected provider's permission mode | Card refreshes, tab selection does not move |
| Close Settings, reopen | Same provider still selected |
| Reload the page (`Cmd+R`), reopen Settings | Same provider still selected |
| Focus a tab, press `←` / `→` | Selection moves between providers |
| In devtools, set `localStorage["sr03:settings-provider"]` to `"nonesuch"` and reload | First provider selected, no empty panel |

## Do not

- Do not hand-roll the tab strip — it comes from the shadcn generator.
- Do not edit `web/src/components/ui/tabs.tsx` after generating it.
- Do not change what a `ProviderCard` contains, or its props.
- Do not move or restyle the left-hand Providers/Appearance nav, the header, or the Editor panel.
