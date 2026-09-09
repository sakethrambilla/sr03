# Plan — per-provider default permission mode

Spec: `docs/plans/2026-09-09-per-provider-permission-defaults/spec.md`

## Approach

The saved default stops being a separate machine-wide value and becomes part of each provider's own
catalog: `ProviderCatalog.defaults.permissionMode` returns the *stored* mode rather than the
built-in one. That collapses the whole feature onto machinery that already exists —
`provider.changed` is already published to every socket and already folded into the client store,
and `startDraft`/`patchDraft` already read `provider.defaults.permissionMode`. The separate
`defaults` field on `/api/state`, the `defaults.changed` event, and `PUT /api/defaults` all go away.

## Constraints

- Server TS is type-stripped (`erasableSyntaxOnly`): no enums, no parameter properties, `.ts`
  extensions on imports.
- Wire types live in `server/src/types.ts` and are mirrored in `web/src/lib/types.ts` — change both
  in the same edit.
- UI comes from shadcn (`Select` is already imported in `SettingsView.tsx`); no hand-rolled controls.
- Zustand selectors must not return a fresh object/array.
- Existing installs have `defaultPermissionMode` in the sqlite settings table; it must carry over.

## File map

| File | Change |
|---|---|
| `server/src/db.ts` | Add `settings.delete(key)` so the legacy key can be retired after migration |
| `server/src/models.ts` | Per-provider stored mode + one-shot legacy migration; `makeCatalog` returns it; `setDefaultPermissionMode(providerId, mode)`; `currentDefaults` deleted; `isPermissionMode` no longer routes through `makeCatalog` |
| `server/src/types.ts` | Drop the `defaults.changed` event variant |
| `server/src/api.ts` | `/api/state` loses `defaults`; `PUT /api/defaults` becomes `PUT /api/providers/:id/defaults`; thread creation reads `provider.defaults` |
| `web/src/lib/types.ts` | Mirror both type changes (`AppState.defaults`, `defaults.changed`) |
| `web/src/lib/api.ts` | `saveDefaults` → `saveProviderDefaults(providerId, patch)` |
| `web/src/store.ts` | Drop `defaults` state, the `defaults.changed` case and `setDefaultPermissionMode`; add `setProviderPermissionMode`; simplify `startDraft` |
| `web/src/components/SettingsView.tsx` | Permission-mode row on `ProviderCard`; delete `GeneralPanel`; `EditorPanel` moves under Appearance; `SECTIONS` loses General |

## Task 1 — server owns a per-provider default, client store follows

Files: `server/src/models.ts`, `server/src/types.ts`, `server/src/api.ts`,
`web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/store.ts`

1. In `server/src/db.ts`, add a delete statement and expose it: alongside
   `settingsAll`/`settingsSet` (around line 282) add
   `settingsDelete: db.prepare("DELETE FROM settings WHERE key = ?"),`, and add to the exported
   `settings` object (around line 358):
   ```ts
   delete(key: string): void {
     sql.settingsDelete.run(key);
   },
   ```
2. In `server/src/models.ts`, add a modes lookup **immediately after `CURSOR_MODES`**
   (i.e. above `FALLBACKS`, and necessarily above the `permissionModeDefaults` const added in the
   next step — these are `const`s, so a later placement is a load-time TDZ `ReferenceError` and the
   server will not boot):
   ```ts
   const MODES: Record<ProviderId, PermissionModeOption[]> = { claude: CLAUDE_MODES, cursor: CURSOR_MODES };
   const BUILTIN_PERMISSION_MODE: Record<ProviderId, PermissionMode> = { claude: "default", cursor: "default" };
   ```
   Rewrite `isPermissionMode` (currently at the bottom of the file) to read
   `MODES[providerId].some((mode) => mode.value === value)` — it must **not** call `makeCatalog`,
   because `makeCatalog` is about to read the stored defaults and that would be a load-time cycle.
3. Replace `DEFAULT_PERMISSION_MODE_KEY`, `loadDefaultPermissionMode`, the
   `let defaultPermissionMode` binding, `currentDefaults` and `setDefaultPermissionMode` with:
   ```ts
   const PERMISSION_MODE_KEY: Record<ProviderId, string> = {
     claude: "defaultPermissionMode:claude",
     cursor: "defaultPermissionMode:cursor",
   };
   // the single machine-wide default this replaced; carried onto the default provider once
   const LEGACY_PERMISSION_MODE_KEY = "defaultPermissionMode";

   // one-shot at import: the legacy value lands on the default provider and is then retired, so a
   // later change of default provider can never migrate it a second time
   function migrateLegacyPermissionMode(): void {
     const stored = settings.all();
     const legacy = stored[LEGACY_PERMISSION_MODE_KEY];
     if (legacy === undefined) return;
     const providerId = defaultProviderId();
     if (
       isPermissionMode(providerId, legacy) &&
       stored[PERMISSION_MODE_KEY[providerId]] === undefined
     ) {
       settings.set(PERMISSION_MODE_KEY[providerId], legacy);
     }
     settings.delete(LEGACY_PERMISSION_MODE_KEY);
   }

   function loadPermissionMode(providerId: ProviderId): PermissionMode {
     const stored = settings.all()[PERMISSION_MODE_KEY[providerId]];
     return isPermissionMode(providerId, stored) ? stored : BUILTIN_PERMISSION_MODE[providerId];
   }

   migrateLegacyPermissionMode();

   const permissionModeDefaults: Record<ProviderId, PermissionMode> = {
     claude: loadPermissionMode("claude"),
     cursor: loadPermissionMode("cursor"),
   };

   export function setDefaultPermissionMode(providerId: ProviderId, mode: PermissionMode): ProviderCatalog {
     permissionModeDefaults[providerId] = mode;
     settings.set(PERMISSION_MODE_KEY[providerId], mode);
     const provider = makeCatalog(providerId);
     publish({ type: "provider.changed", provider });
     return provider;
   }
   ```
   This is the only import-time write to the settings table; it runs once and the legacy row is
   gone afterwards.
4. In both branches of `makeCatalog`, set `defaults.permissionMode: permissionModeDefaults[providerId]`
   (the Claude branch currently hardcodes `DEFAULT_PERMISSION_MODE`, the Cursor branch `"default"`).
   Leave `defaults.model` and `defaults.effort` alone. Nothing outside `models.ts` imports
   `DEFAULT_PERMISSION_MODE`, so delete that export (line 20) and let `BUILTIN_PERMISSION_MODE`
   carry the values.
5. In `server/src/types.ts`, delete the `| { type: "defaults.changed"; ... }` line from `ServerEvent`.
6. In `server/src/api.ts`:
   - Drop `currentDefaults` from the `./models.ts` import list.
   - In the `GET /api/state` handler, delete the `defaults: currentDefaults(),` line.
   - In the `POST /api/threads` handler, replace `const defaults = currentDefaults(providerId);`
     with `const defaults = provider.defaults;` (the `provider` const on the line above already
     holds `currentProvider(providerId)`). Nothing else in that handler changes.
   - Replace the `PUT /^\/api\/defaults$/` route with:
     ```ts
     {
       method: "PUT",
       pattern: /^\/api\/providers\/([^/]+)\/defaults$/,
       handler: async ({ request, params }) => {
         const providerId = params[0]!;
         if (!isProviderId(providerId)) throw new HttpError(404, "Provider not found");
         const body = await readBody(request);
         if (!isPermissionMode(providerId, body.permissionMode)) {
           throw new HttpError(400, "Invalid permissionMode");
         }
         return { provider: setDefaultPermissionMode(providerId, body.permissionMode) };
       },
     },
     ```
     The old handler's `publish({ type: "defaults.changed" ... })` goes away — `setDefaultPermissionMode`
     publishes `provider.changed` itself.
7. In `web/src/lib/types.ts`, delete the `defaults` field from `AppState` and the `defaults.changed`
   variant from `ServerEvent`.
8. In `web/src/lib/api.ts`, replace `saveDefaults` with:
   ```ts
   saveProviderDefaults: (providerId: ProviderId, patch: { permissionMode: PermissionMode }) =>
     call<{ provider: ProviderCatalog }>(`/api/providers/${providerId}/defaults`, {
       method: "PUT",
       headers: { "content-type": "application/json" },
       body: JSON.stringify(patch),
     }),
   ```
   Add `ProviderCatalog` to the type imports if it isn't already there.
9. In `web/src/store.ts`:
   - Delete the `defaults:` line from the `EMPTY` const (~line 189). The identical-looking line a
     few lines below belongs to `EMPTY_PROVIDER` and must stay.
   - Delete the `case "defaults.changed":` block in `applyEvent`.
   - Replace the `setDefaultPermissionMode` action (and its signature in the store interface, at the
     line reading `setDefaultPermissionMode: (mode: PermissionMode) => Promise<void>;`) with:
     ```ts
     // machine-wide but provider-scoped — patchActive only ever touches the open thread
     setProviderPermissionMode: async (providerId, permissionMode) => {
       const previous = get().providers;
       set({
         providers: previous.map((provider) =>
           provider.id === providerId
             ? { ...provider, defaults: { ...provider.defaults, permissionMode } }
             : provider,
         ),
       });
       try {
         await api.saveProviderDefaults(providerId, { permissionMode });
       } catch (error) {
         set({ error: (error as Error).message, providers: previous });
       }
     },
     ```
     Interface line: `setProviderPermissionMode: (providerId: ProviderId, mode: PermissionMode) => Promise<void>;`
   - In `startDraft`, delete the `const permissionMode = provider.permissionModes.some(...)` block
     and the `defaults` destructure, and set `permissionMode: provider.defaults.permissionMode` in
     the draft object. `patchDraft`'s provider branch already does the right thing and is untouched.

**Verify**

```bash
pnpm typecheck && pnpm test
```
Both packages typecheck clean and every existing test passes; no reference to `currentDefaults`,
`saveDefaults` or `defaults.changed` remains:
```bash
grep -rn "currentDefaults\|saveDefaults\|defaults.changed" server/src web/src ; echo "exit=$?"
```
prints nothing and `exit=1`.

Then, with the dev server running (`pnpm dev` in another shell):
```bash
curl -s -X PUT localhost:3399/api/providers/cursor/defaults -H 'content-type: application/json' -d '{"permissionMode":"ask"}' | head -c 200
curl -s localhost:3399/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).providers.map(p=>[p.id,p.defaults.permissionMode])))'
```
The first prints a provider object; the second prints `[ [ 'claude', <claude mode> ], [ 'cursor', 'ask' ] ]`.
Rejections behave: `curl -s -o /dev/null -w '%{http_code}\n' -X PUT localhost:3399/api/providers/cursor/defaults -H 'content-type: application/json' -d '{"permissionMode":"acceptEdits"}'` prints `400`, and the same call against `/api/providers/nope/defaults` prints `404`.
Restart the server and re-run the state curl — Cursor still reads `ask`.

Finally exercise the legacy migration (spec AC 6). Stop the server, then seed the old row and a
Claude default provider through the settings route on a running server:
```bash
curl -s -X PUT localhost:3399/api/settings -H 'content-type: application/json' -d '{"key":"defaultProviderId","value":"claude"}'
curl -s -X PUT localhost:3399/api/settings -H 'content-type: application/json' -d '{"key":"defaultPermissionMode","value":"bypassPermissions"}'
sqlite3 ~/.sr03/sr03.db "delete from settings where key='defaultPermissionMode:claude';"
```
Restart the server, then:
```bash
curl -s localhost:3399/api/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).providers.map(p=>[p.id,p.defaults.permissionMode])))'
sqlite3 ~/.sr03/sr03.db "select key,value from settings where key like 'defaultPermissionMode%';"
```
Claude reads `bypassPermissions`, Cursor reads its own stored/built-in value, and the settings dump
shows `defaultPermissionMode:claude` present with the legacy bare `defaultPermissionMode` gone.
(`sqlite3` here reads the same db `SR03_DATA_DIR` points at; adjust the path if you moved it.)

## Task 2 — the picker moves onto the provider cards

Files: `web/src/components/SettingsView.tsx`

1. In `ProviderCard`, below the existing `Binary path` / `Settings honored` grid and above the
   `Models` block, add a permission-mode row. The card already holds `catalog` (the live
   `ProviderCatalog` from the store) — read the modes and the current value from it, falling back
   to the `provider` prop the same way `models` already does:
   ```tsx
   const permissionModes = catalog?.permissionModes ?? provider.permissionModes;
   const permissionMode = catalog?.defaults.permissionMode ?? provider.defaults.permissionMode;
   const setProviderPermissionMode = useStore((state) => state.setProviderPermissionMode);
   ```
   ```tsx
   <div className="flex items-center gap-4">
     <div className="min-w-0 flex-1">
       <p className="text-[13px] text-foreground">Permission mode</p>
       <p className="text-[11.5px] text-faint">
         What a new {provider.label} session can do without asking
       </p>
     </div>
     <Select
       value={permissionMode}
       onValueChange={(next) => void setProviderPermissionMode(provider.id, next as PermissionMode)}
     >
       <SelectTrigger className="w-56 shrink-0">
         <SelectValue />
       </SelectTrigger>
       <SelectContent>
         {permissionModes.map((mode) => (
           <SelectItem key={mode.value} value={mode.value}>
             {mode.label}
           </SelectItem>
         ))}
       </SelectContent>
     </Select>
   </div>
   ```
   Keep the surrounding `<Separator />` rhythm the card already uses between blocks.
2. Delete the whole `GeneralPanel` function.
3. Change `SECTIONS` to
   ```ts
   const SECTIONS = [
     { id: "providers", label: "Providers" },
     { id: "appearance", label: "Appearance" },
   ] as const;
   ```
   Keep the `as const` — `type Section = (typeof SECTIONS)[number]["id"]` on the next line depends
   on it, and without it `Section` widens to `string`.
4. In `SettingsView`, replace
   `const [section, setSection] = usePersistedState<Section>("settings-section", "general");` with
   ```tsx
   const [storedSection, setSection] = usePersistedState<Section>("settings-section", "providers");
   // an install that remembered the removed General tab lands on Providers
   const section = SECTIONS.some((entry) => entry.id === storedSection) ? storedSection : "providers";
   ```
   Leave `setSection` as the nav's handler — the stale localStorage value is overwritten the first
   time a section is clicked, and is harmless until then.
5. In the render body, delete the `{section === "general" ? (<><GeneralPanel /><EditorPanel /></>) : null}`
   block and render `<EditorPanel />` inside the appearance branch:
   `{section === "appearance" ? (<><AppearancePanel /><EditorPanel /></>) : null}`.
6. After deleting `GeneralPanel`, `useStore` and `PermissionMode` are both still used (by
   `ProviderCard` and by `SettingsView`), so no import should go dead. `pnpm -C web typecheck` has
   `noUnusedLocals` on and will name anything that did.

**Verify**

```bash
pnpm typecheck && pnpm -C web build
```
Both succeed with no unused-import or unused-variable errors.

Then by hand, against a scratch repo (never a real project):
```bash
mkdir -p /tmp/sr03-repo && cd /tmp/sr03-repo && git init -q -b main && echo hello > README.md && git add . && git commit -qm init
```
With `pnpm dev` running, open http://localhost:5399 and check:
- Settings shows exactly two sections, Providers and Appearance, and opens on Providers.
- The Claude card's Permission mode select lists Ask / Accept edits / Plan / Bypass; the Cursor
  card's lists Agent / Auto-review / Plan / Ask / Force.
- Set Claude to Bypass and Cursor to Plan. Add `/tmp/sr03-repo` as a project, start a new session
  with Claude — the permission chip in the new-session composer (the picker row rendered by
  `web/src/components/Composer.tsx`, fed by `DraftView.tsx`) reads Bypass; switch the draft's
  provider to Cursor with the provider picker beside it — the chip reads Plan.
- Restart the server and reopen Settings → Providers: Claude still reads Bypass, Cursor still
  reads Plan.
- Open a second browser tab on Settings → Providers, change Cursor there to Ask, and watch the
  first tab's Cursor card change to Ask without a reload.
- Run one real turn in a Claude thread and one in a Cursor thread in that scratch repo; both
  complete. While one of those turns is still streaming, change that provider's default on the
  Providers page — the running thread's own permission chip does not move.
- "Open diagrams in preview" appears under Appearance and still opens a `.mmd` file rendered.

## Notes

- There are no server tests covering `models.ts` or `api.ts`, so `pnpm test` proves nothing about
  this feature — the curl and UI checks above are the real verification.

- `SHORTCUTS.md` needs no change — no shortcut touches this.
- `CLAUDE.md` needs no change — it does not document the defaults storage.
