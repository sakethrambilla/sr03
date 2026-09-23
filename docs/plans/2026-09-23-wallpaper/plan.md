# App wallpaper — implementation plan

> Execute with the `executing-plans` skill, one task at a time.
> Track state in progress.md, never in this file.

**Spec:** ./spec.md
**Branch / worktree:** `ai/wallpaper-background-feature-3c97ba`, in worktree
`.claude/worktrees/permission-mode-provider-config-fa9b4e`. Run every command from the worktree root.
**Test command:** `pnpm test` (runs `pnpm -C server test && pnpm -C web test`, both `node --test`)
**Lint / typecheck:** `pnpm typecheck` (no linter in this repo)

## Approach
The server stores exactly one image as `<DATA_DIR>/wallpaper.<png|jpg|webp>`, behind three routes:
`PUT`, `GET` and `DELETE /api/wallpaper`. The client treats the wallpaper as four more fields on
the existing `Appearance` object, so it persists through the same localStorage + `settings` row
path the theme already uses. That path is what makes the desktop app, on a fresh port with empty
localStorage, come back with the wallpaper. `applyAppearance` writes CSS variables and puts a
`wallpaper` class on `<html>`, but only after the image has actually loaded. A missing file
therefore leaves the app opaque. All visuals are CSS gated on `html.wallpaper`:
- The image and the dim overlay are `html::before` and `html::after`.
- The top-level panes, marked with a `data-surface` attribute, paint their translucent tint and
  backdrop blur on their own `::before`. That pseudo-element has `z-index: -1` and no
  `isolation`, so it joins the root stacking context just above the wallpaper and below all
  content.

Tokens are left untouched. That keeps portalled menus, popovers and dialogs opaque with no extra
work. The pane itself never gets a backdrop filter and never becomes a stacking context. Either
would trap its fixed and z-indexed descendants:
- the editor's tab-drag ghost (`EditorGroups.tsx:473`)
- the composer's image lightbox (`Composer.tsx:263`, `fixed inset-0 z-50`)
- the overhang of the sidebar's resize sash

## Global constraints
- The server uses Node built-ins only. It is type-stripped TS: explicit `.ts` imports, and no
  enums or parameter properties (`erasableSyntaxOnly`).
- UI controls come from shadcn/ui. Add the missing `slider` with the generator, and never
  hand-edit `web/src/components/ui/*`.
- Colors are token-based (`var(--card)`, `var(--background)`). The one allowed exception is the
  dim overlay's plain `black` or `white`, which the spec allows.
- Radii: `rounded-md` for interactive elements and small chips, `rounded-lg` for panels.
- Zustand selectors never return a fresh object or array.
- Comments are one-liners, and only where the code can't speak for itself.
- Commits are a **single-line** Conventional Commit with no body and no footer, authored as
  `sakethrambilla@gmail.com` (already the repo's `user.email`).
- Browser checks run against an isolated data dir so the user's `~/.sr03` is untouched. Start
  the stack with
  `SR03_DATA_DIR=/tmp/sr03-wallpaper-data SR03_PORT=3499 pnpm dev` and open
  `http://localhost:5399`. If 5399 is busy, another `pnpm dev` is running; stop and ask.
- No new docs, READMEs or helper files beyond those in the file map.

## File map
| File | Create/Modify | Responsibility |
|---|---|---|
| `server/src/wallpaper.ts` | Create | Magic-byte sniffing; save, read and remove the single wallpaper file in `DATA_DIR` |
| `server/src/wallpaper.test.ts` | Create | Unit tests for sniffing and save/replace/read/remove |
| `server/src/api.ts:84-93` | Modify | `readRaw`'s 413 message derives the MB figure from `limit` instead of hardcoding 25 |
| `server/src/api.ts` (after the `GET /api/uploads/…` route, ~line 286) | Modify | `PUT`, `GET` and `DELETE /api/wallpaper` routes |
| `web/src/lib/appearance.ts` | Modify | The 4 new `Appearance` fields and defaults, `WALLPAPER_TYPES`/`WALLPAPER_LIMIT`, `wallpaperFileError`, `wallpaperVars`, and the load-gated class inside `applyAppearance` |
| `web/src/lib/appearance.test.ts` | Modify | Tests for `wallpaperFileError` and `wallpaperVars` |
| `web/src/lib/api.ts` (inside `export const api`, after `upload`) | Modify | `uploadWallpaper(file)` and `removeWallpaper()` |
| `web/src/store.ts` | Modify | `setWallpaper` / `removeWallpaper` actions; pass the missing-image callback to `applyAppearance` |
| `web/src/index.css` (append at end of file) | Modify | The `html.wallpaper` rules: image, dim, surfaces, see-through tab strip |
| `web/src/components/Sidebar.tsx:422`, `FileTree.tsx:775`, `AgentsPanel.tsx:146` | Modify | `data-surface="card"` on each pane's root |
| `web/src/components/ChatView.tsx:581`, `DraftView.tsx:305`, `SettingsView.tsx:468`, `web/src/App.tsx:85` | Modify | `data-surface="background"` and `relative` on each `<main>` |
| `web/src/components/EditorGroups.tsx:84`, `TerminalPanel.tsx:280-285` (the `<section>`) | Modify | `data-see-through`: both sit inside `<main>`'s surface, so they go transparent instead of stacking a second tint |
| `web/src/components/TerminalPanel.tsx:30-37, ~73, ~130` | Modify | Transparent xterm theme background while a wallpaper is set |
| `web/src/components/ui/slider.tsx` | Create (generated) | shadcn slider |
| `web/src/components/SettingsView.tsx` | Modify | `WallpaperSection` + `WallpaperSlider`, rendered at the end of `AppearancePanel` |

## Tasks

### Task 1: Server storage and routes

**Depends on:** nothing
**Files:** Create `server/src/wallpaper.ts` and `server/src/wallpaper.test.ts`. Modify `server/src/api.ts`.
**Interfaces produced:**
- `PUT /api/wallpaper`: the raw image bytes are the body.
  - `200 { url: string }`, where `url` is `/api/wallpaper?v=<base36 ms timestamp>`.
  - `415 { error: "Wallpaper must be a PNG, JPEG or WebP image" }` when the bytes aren't PNG, JPEG
    or WebP, and also for an empty body.
  - `413 { error: "File is larger than 20MB" }` when the body is over 20 MB.
- `GET /api/wallpaper`: the image bytes with the right `content-type` and
  `cache-control: no-cache`, or `404 { error: "No wallpaper set" }`.
- `DELETE /api/wallpaper`: `200 { ok: true }`, and succeeds even when nothing is stored.

Steps:

- [ ] 1. Create `server/src/wallpaper.test.ts`. At the top level, before importing the module,
      point `process.env.SR03_DATA_DIR` at `await fs.mkdtemp(path.join(os.tmpdir(), "sr03-wallpaper-"))`.
      Then load the module with `const { sniffImage, saveWallpaper, readWallpaper, removeWallpaper } = await import("./wallpaper.ts");`.
      Each test file runs in its own process, so the env var holds for the whole file. Remove the
      temp dir in a top-level `after(...)` from `node:test`. Write these tests:
      - `sniffImage`:
        - PNG signature `89 50 4E 47 0D 0A 1A 0A` + padding returns `"png"`.
        - `FF D8 FF E0` + padding returns `"jpg"`.
        - `Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])` returns `"webp"`.
        - `Buffer.from("%PDF-1.7")` returns `null`.
        - `Buffer.alloc(0)` returns `null`.
      - `saveWallpaper(png, "png")` returns a `url` matching `/^\/api\/wallpaper\?v=[0-9a-z]+$/`.
        `readWallpaper()` then returns the same bytes with `type === "image/png"`.
      - Saving a PNG and then a WebP leaves exactly one `wallpaper.*` entry, `wallpaper.webp`,
        and `readWallpaper()` reports `image/webp`. Check the entry with
        `(await fs.readdir(dir)).filter((name) => name.startsWith("wallpaper."))`, because
        `config.ts` also creates `uploads/` and `worktrees/` in the data dir.
      - `removeWallpaper()` followed by `readWallpaper()` returns `null`, and a second
        `removeWallpaper()` does not throw.

- [ ] 2. Run `pnpm -C server test`.
      Expect FAIL with `ERR_MODULE_NOT_FOUND` naming `wallpaper.ts`. Any other failure means
      stop and reconcile.

- [ ] 3. Create `server/src/wallpaper.ts`:
      ```ts
      // The one app-wide wallpaper, stored as DATA_DIR/wallpaper.<ext>. There is never more than one.
      import fs from "node:fs/promises";
      import path from "node:path";

      import { DATA_DIR } from "./config.ts";

      export const WALLPAPER_LIMIT = 20 * 1024 * 1024;

      const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
      export type WallpaperExt = keyof typeof TYPES;
      const EXTS = Object.keys(TYPES) as WallpaperExt[];
      const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      // the bytes decide, not the filename or the client's content-type
      export function sniffImage(bytes: Buffer): WallpaperExt | null {
        if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return "png";
        if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
        if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
        return null;
      }

      const fileFor = (ext: WallpaperExt) => path.join(DATA_DIR, `wallpaper.${ext}`);

      export async function removeWallpaper(): Promise<void> {
        await Promise.all(EXTS.map((ext) => fs.rm(fileFor(ext), { force: true })));
      }

      // the version in the url is what makes the browser drop the previous image
      export async function saveWallpaper(bytes: Buffer, ext: WallpaperExt): Promise<{ url: string }> {
        await removeWallpaper();
        await fs.writeFile(fileFor(ext), bytes);
        return { url: `/api/wallpaper?v=${Date.now().toString(36)}` };
      }

      export async function readWallpaper(): Promise<{ bytes: Buffer; type: string } | null> {
        for (const ext of EXTS) {
          const bytes = await fs.readFile(fileFor(ext)).catch(() => null);
          if (bytes) return { bytes, type: TYPES[ext] };
        }
        return null;
      }
      ```

- [ ] 4. Run `pnpm -C server test`. Expect every test to pass, including every new wallpaper test.

- [ ] 5. In `server/src/api.ts`, change `readRaw`'s throw (line 89) to
      `throw new HttpError(413, \`File is larger than ${limit / (1024 * 1024)}MB\`);`.
      The existing uploads route passes `25 * 1024 * 1024`, so its message stays "File is larger than 25MB".

- [ ] 6. In `server/src/api.ts`, add
      `import { WALLPAPER_LIMIT, readWallpaper, removeWallpaper, saveWallpaper, sniffImage } from "./wallpaper.ts";`
      beside the other local imports. Then insert three routes directly after the
      `GET /^\/api\/uploads\/([^/]+)$/` route object:
      - `PUT /^\/api\/wallpaper$/`: `const bytes = await readRaw(request, WALLPAPER_LIMIT); const ext = sniffImage(bytes); if (!ext) throw new HttpError(415, "Wallpaper must be a PNG, JPEG or WebP image"); return saveWallpaper(bytes, ext);`
      - `GET /^\/api\/wallpaper$/`: `const file = await readWallpaper(); if (!file) throw new HttpError(404, "No wallpaper set");`
        Then `response.writeHead(200, { "content-type": file.type, "content-length": file.bytes.length, "cache-control": "no-cache" }); response.end(file.bytes);`
        This mirrors the uploads GET. The `?v=` query is ignored, because routes match on `url.pathname`.
      - `DELETE /^\/api\/wallpaper$/`: `await removeWallpaper(); return { ok: true };`

- [ ] 7. Run `pnpm typecheck`. Expect exit 0.

- [ ] 8. Smoke test against a throwaway server. Start it in the background:
      `SR03_DATA_DIR=/tmp/sr03-wallpaper-smoke SR03_PORT=3498 pnpm -C server start`. Then run:
      ```bash
      printf '\x89PNG\r\n\x1a\n0000' > /tmp/sr03-w.png && printf '%%PDF-1.7' > /tmp/sr03-w.pdf
      curl -s -w '\n' -X PUT --data-binary @/tmp/sr03-w.png localhost:3498/api/wallpaper
      curl -s -o /dev/null -w '%{http_code} %{content_type}\n' localhost:3498/api/wallpaper
      curl -s -w '\n' -X PUT --data-binary @/tmp/sr03-w.pdf localhost:3498/api/wallpaper
      head -c 21000000 /dev/zero | curl -s -w '\n' -X PUT --data-binary @- localhost:3498/api/wallpaper
      curl -s -w '\n' -X DELETE localhost:3498/api/wallpaper
      curl -s -o /dev/null -w '%{http_code}\n' localhost:3498/api/wallpaper
      ```
      Expect, in order:
      1. `{"url":"/api/wallpaper?v=…"}`
      2. `200 image/png`
      3. `{"error":"Wallpaper must be a PNG, JPEG or WebP image"}`
      4. `{"error":"File is larger than 20MB"}`
      5. `{"ok":true}`
      6. `404`

      Stop the server and run `rm -rf /tmp/sr03-wallpaper-smoke /tmp/sr03-w.png /tmp/sr03-w.pdf`.

- [ ] 9. `git add server/src/wallpaper.ts server/src/wallpaper.test.ts server/src/api.ts`, then
      `git commit -m "feat(server): store a single app wallpaper behind /api/wallpaper"`

**Done when:** the server suite is green and the smoke test prints exactly the six expected lines.

---

### Task 2: Appearance data layer

**Depends on:** Task 1 (the routes the client calls)
**Files:** Modify `web/src/lib/appearance.ts`, `web/src/lib/appearance.test.ts`, `web/src/lib/api.ts` and `web/src/store.ts`.
**Interfaces produced:**
- `Appearance` gains four fields:
  - `wallpaper: string`: `""` means none, otherwise the `url` from Task 1.
  - `panelOpacity: number`: percent, 30–100.
  - `wallpaperBlur: number`: px, 0–40.
  - `wallpaperDim: number`: percent, 0–80.

  The defaults are `""`, `80`, `0` and `20`.
- `WALLPAPER_TYPES: readonly string[]` is `["image/png", "image/jpeg", "image/webp"]`, and
  `WALLPAPER_LIMIT` is `20 * 1024 * 1024`. Both mirror the server's values.
- `wallpaperFileError(file: { type: string; size: number }): string | null` returns one of two
  messages, or `null`:
  - `"Wallpaper must be a PNG, JPEG or WebP image"`
  - `"Wallpaper must be 20 MB or smaller"`
- `wallpaperVars(appearance): Record<string, string> | null` returns `null` when `wallpaper` is
  `""`. Otherwise it returns exactly these keys:
  - `"--wallpaper-image"`: `url("<wallpaper>")`
  - `"--panel-opacity"`: `"<n>%"`
  - `"--wallpaper-blur"`: `"<n>px"`
  - `"--wallpaper-dim"`: `"<n>%"`
- `applyAppearance(appearance, onWallpaperMissing?: () => void)`.
- `html.wallpaper` is present only once the current wallpaper URL has loaded.
- Store actions:
  - `setWallpaper(file: File): Promise<string | null>` resolves to an error message, or `null` on success.
  - `removeWallpaper(): Promise<void>`.

Steps:

- [ ] 1. In `web/src/lib/appearance.test.ts`, extend the import to
      `import { groupFonts, resolveDark, wallpaperFileError, wallpaperVars } from "./appearance.ts";`
      and add these tests:
      - `wallpaperFileError`:
        - `{ type: "image/png", size: 1000 }` returns `null`.
        - `{ type: "image/webp", size: 20 * 1024 * 1024 }` returns `null`.
        - `{ type: "application/pdf", size: 10 }` and `{ type: "image/svg+xml", size: 10 }`
          return `"Wallpaper must be a PNG, JPEG or WebP image"`.
        - `{ type: "image/jpeg", size: 20 * 1024 * 1024 + 1 }` returns `"Wallpaper must be 20 MB or smaller"`.
      - `wallpaperVars({ theme: "sr03", uiFont: "", codeFont: "", mode: "dark", wallpaper: "", panelOpacity: 80, wallpaperBlur: 0, wallpaperDim: 20 })`
        returns `null`.
      - The same object with `wallpaper: "/api/wallpaper?v=abc", panelOpacity: 65, wallpaperBlur: 12, wallpaperDim: 0`
        deep-equals `{ "--wallpaper-image": 'url("/api/wallpaper?v=abc")', "--panel-opacity": "65%", "--wallpaper-blur": "12px", "--wallpaper-dim": "0%" }`.

- [ ] 2. Run `pnpm -C web test`.
      Expect FAIL with a `SyntaxError` saying the module does not provide an export named
      `wallpaperFileError`.

- [ ] 3. In `web/src/lib/appearance.ts`:
      - Add the four fields to `interface Appearance`. On each numeric field put a unit comment:
        `// percent, 30–100`, `// px, 0–40` and `// percent, 0–80`.
      - Extend `DEFAULTS` to
        `{ theme: "sr03", uiFont: "", codeFont: "", mode: "dark", wallpaper: "", panelOpacity: 80, wallpaperBlur: 0, wallpaperDim: 20 }`.
      - Add the exports `WALLPAPER_TYPES`, `WALLPAPER_LIMIT`, `wallpaperFileError` (check the type
        first, then the size) and `wallpaperVars`, exactly as specified above.
      - Update the file's top comment so it also mentions the wallpaper.

- [ ] 4. Run `pnpm -C web test`. Expect all to pass, including the new tests.

- [ ] 5. Still in `appearance.ts`, add the load-gated class. Near `applyAppearance`:
      ```ts
      const WALLPAPER_VARS = ["--wallpaper-image", "--panel-opacity", "--wallpaper-blur", "--wallpaper-dim"];
      let wantedWallpaper = "";

      // the class, and with it the see-through panels, only lands once the image has loaded, so a
      // wallpaper deleted from disk leaves the app opaque rather than translucent over nothing
      function showWallpaper(url: string, onMissing?: () => void): void {
        const root = document.documentElement;
        if (url === wantedWallpaper) return;
        wantedWallpaper = url;
        if (!url) {
          root.classList.remove("wallpaper");
          return;
        }
        const probe = new Image();
        probe.onload = () => {
          if (wantedWallpaper === url) root.classList.add("wallpaper");
        };
        probe.onerror = () => {
          if (wantedWallpaper !== url) return;
          wantedWallpaper = "";
          root.classList.remove("wallpaper");
          onMissing?.();
        };
        probe.src = url;
      }
      ```
      Change the signature to
      `export function applyAppearance(appearance: Appearance, onWallpaperMissing?: () => void): void`.
      The body currently destructures in the parameter list, so destructure inside the body instead.
      After the font lines, add:
      ```ts
      const vars = wallpaperVars(appearance);
      for (const name of WALLPAPER_VARS) {
        if (vars) root.style.setProperty(name, vars[name]!);
        else root.style.removeProperty(name);
      }
      showWallpaper(appearance.wallpaper, onWallpaperMissing);
      ```

- [ ] 6. In `web/src/lib/api.ts`, add these inside `export const api`, right after `upload`:
      ```ts
      uploadWallpaper: async (file: File) => {
        const response = await fetch("/api/wallpaper", { method: "PUT", body: file });
        const body = (await response.json()) as { url: string; error?: string };
        if (!response.ok) throw new Error(body.error ?? response.statusText);
        return body;
      },
      removeWallpaper: () => call<{ ok: true }>("/api/wallpaper", { method: "DELETE" }),
      ```

- [ ] 7. In `web/src/store.ts`:
      - Import `wallpaperFileError` from `./lib/appearance.ts`.
      - In the `Store` interface, next to `setAppearance` (~line 178), add
        `setWallpaper: (file: File) => Promise<string | null>;` and `removeWallpaper: () => Promise<void>;`.
      - Above `const startingAppearance` (~line 342), add
        `// a stored wallpaper whose file is gone is forgotten, so the picker offers "Choose image…" again`
        `function forgetMissingWallpaper(): void { useStore.getState().setAppearance({ wallpaper: "" }); }`.
        It only runs asynchronously, after `useStore` exists.
      - Pass `forgetMissingWallpaper` as the second argument to all three `applyAppearance(...)`
        calls: line ~343, inside `setAppearance` (~382), and the system-mode handler (~1009).
      - After `setAppearance`, add these actions:
        ```ts
        setWallpaper: async (file) => {
          const invalid = wallpaperFileError(file);
          if (invalid) return invalid;
          try {
            const { url } = await api.uploadWallpaper(file);
            get().setAppearance({ wallpaper: url });
            return null;
          } catch (error) {
            return (error as Error).message;
          }
        },
        removeWallpaper: async () => {
          try {
            await api.removeWallpaper();
            get().setAppearance({ wallpaper: "" });
          } catch (error) {
            set({ error: (error as Error).message });
          }
        },
        ```

- [ ] 8. Run `pnpm typecheck && pnpm test`. Expect both to exit 0.

- [ ] 9. `git add web/src/lib/appearance.ts web/src/lib/appearance.test.ts web/src/lib/api.ts web/src/store.ts`, then
      `git commit -m "feat(web): carry the wallpaper and its sliders in appearance"`

**Done when:** tests and typecheck are green. `wallpaperVars` and `wallpaperFileError` are covered.
`applyAppearance` adds `html.wallpaper` only after the image loads.

---

### Task 3: Wallpaper CSS, surfaces and terminal

**Depends on:** Task 2 (the class and the variables)
**Files:**
- Modify `web/src/index.css`.
- Add `data-surface` to `Sidebar.tsx`, `FileTree.tsx`, `AgentsPanel.tsx`, `ChatView.tsx`,
  `DraftView.tsx`, `SettingsView.tsx` and `App.tsx`.
- Add `data-see-through` to `EditorGroups.tsx` and `TerminalPanel.tsx`.
- Make the xterm theme background transparent in `TerminalPanel.tsx`.

**Interfaces consumed:** the `html.wallpaper` class, and the `--wallpaper-image`,
`--panel-opacity`, `--wallpaper-blur` and `--wallpaper-dim` variables from Task 2.

Steps:

- [ ] 1. Record the baseline for acceptance criterion 1. Start the stack as described in Global
      constraints and open `http://localhost:5399`. With a thread open (create a project on
      `/tmp/sr03-repo` per CLAUDE.md "Testing changes" if the list is empty), open the file tree
      and the terminal. Run this in the browser pane:
      ```js
      [...document.querySelectorAll("body, aside, main, section")].map(e => `${e.tagName} ${getComputedStyle(e).backgroundColor} ${getComputedStyle(e).backdropFilter}`).join("\n")
      ```
      Paste the output into `progress.md` under "Task 3 baseline".

- [ ] 2. Append to the end of `web/src/index.css`:
      ```css
      /* the wallpaper: appearance.ts puts .wallpaper on <html> only once the image has loaded.
         the image and the dim sit on <html> itself, beneath <body> */
      html.wallpaper body {
        background: transparent;
      }
      html.wallpaper::before,
      html.wallpaper::after {
        content: "";
        position: fixed;
        z-index: -1;
        pointer-events: none;
      }
      /* pulled out past the viewport by twice the blur, so the blurred edge never fades in */
      html.wallpaper::before {
        inset: calc(var(--wallpaper-blur) * -2);
        background: var(--wallpaper-image) center / cover no-repeat;
        filter: blur(var(--wallpaper-blur));
      }
      html.wallpaper::after {
        inset: 0;
        background: color-mix(in oklch, black var(--wallpaper-dim), transparent);
      }
      html.wallpaper:not(.dark)::after {
        background: color-mix(in oklch, white var(--wallpaper-dim), transparent);
      }

      /* the tint and blur live on a pseudo-element in the root stacking context. backdrop-filter or
         isolation on the pane itself would trap its fixed and z-indexed descendants (the tab-drag
         ghost, the composer's lightbox) beneath the panes that follow it */
      html.wallpaper [data-surface] {
        background-color: transparent;
      }
      html.wallpaper [data-surface]::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: -1;
        pointer-events: none;
        background: color-mix(in oklch, var(--card) var(--panel-opacity), transparent);
        backdrop-filter: blur(20px);
      }
      html.wallpaper [data-surface="background"]::before {
        background: color-mix(in oklch, var(--background) var(--panel-opacity), transparent);
      }
      html.wallpaper [data-see-through] {
        background-color: transparent;
      }
      ```

- [ ] 3. Add `data-surface="card"` as an attribute (the className stays unchanged) to:
      - the `<aside>` at `Sidebar.tsx:422`
      - the `<aside>` at `FileTree.tsx:775`
      - the `<aside>` at `AgentsPanel.tsx:146`

      All three are already `relative`. Do **not** give them `isolation`, a `z-index` or a
      transform.

- [ ] 4. Add `data-surface="background"` to the `<main>`s at `ChatView.tsx:581`,
      `DraftView.tsx:305`, `SettingsView.tsx:468` and `App.tsx:85`. Add `relative` to the front of
      each one's className, since the surface's `::before` is absolutely positioned. None of these
      files positions anything absolutely against the viewport, but step 8 re-checks this visually.

- [ ] 5. Add `data-see-through` to two elements:
      - the tab-strip `<div>` at `EditorGroups.tsx:84`
      - the terminal `<section>` in `TerminalPanel.tsx` (it opens at line 280, with its
        className at 283)

      Both sit inside `ChatView`'s `<main>` surface. A second tint on top would stack to about
      96% opacity and hide the wallpaper.

- [ ] 6. In `TerminalPanel.tsx`:
      - Change `terminalTheme()` to `terminalTheme(transparent: boolean)`, with
        `background: transparent ? "rgba(0, 0, 0, 0)" : themeColor("--color-card", "#1a1a19")`.
      - Pass `terminalTheme(Boolean(appearance.wallpaper))` in both places the theme is built:
        the `new Terminal({...})` constructor (~line 73) and the `[appearance, …]` effect
        (~line 130).
      - Do not add `allowTransparency`, because xterm 6's core never reads it. What makes the
        terminal transparent is that the DOM renderer paints the viewport inline from
        `theme.background`.
      - The comment above `monoFamily` (oklch tokens drive the terminal) is still true, so leave it.

- [ ] 7. Run `pnpm typecheck`. Expect exit 0.

- [ ] 8. Check criterion 1 with no wallpaper set. Reload the page and re-run the step 1 snippet.
      Expect output identical to the baseline. Take a screenshot and compare it to the app
      before the change: no layout shift and no stray colors.

- [ ] 9. Set a wallpaper without the UI (Task 4 builds the UI). Run in the browser pane:
      ```js
      const c = Object.assign(document.createElement("canvas"), { width: 1600, height: 1000 });
      const g = c.getContext("2d"); const grad = g.createLinearGradient(0, 0, 1600, 1000);
      grad.addColorStop(0, "#ff6a00"); grad.addColorStop(1, "#1e3cff"); g.fillStyle = grad; g.fillRect(0, 0, 1600, 1000);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const { url } = await fetch("/api/wallpaper", { method: "PUT", body: blob }).then((r) => r.json());
      const current = JSON.parse(localStorage.getItem("sr03:appearance") ?? "{}");
      await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "appearance", value: JSON.stringify({ ...current, wallpaper: url, panelOpacity: 80, wallpaperBlur: 0, wallpaperDim: 20 }) }) });
      location.reload();
      ```
      After the reload, run:
      ```js
      const s = (sel) => getComputedStyle(document.querySelector(sel), "::before");
      ({ cls: document.documentElement.classList.contains("wallpaper"),
         body: getComputedStyle(document.body).backgroundColor,
         aside: [s("aside[data-surface]").backgroundColor, s("aside[data-surface]").backdropFilter],
         main: [s("main[data-surface]").backgroundColor, s("main[data-surface]").backdropFilter] })
      ```
      Expect:
      - `cls: true`
      - `body: "rgba(0, 0, 0, 0)"`
      - both `backdropFilter` values are `"blur(20px)"`
      - both `backgroundColor` values carry an alpha of `0.8` (e.g. `oklch(0.2 0.004 75 / 0.8)`)

      With the terminal open, also run
      `getComputedStyle(document.querySelector(".xterm-viewport")).backgroundColor` and expect
      `"rgba(0, 0, 0, 0)"`. xterm.css sets `#000` there, and the inline theme color has to win.

      Screenshot: the orange-to-blue gradient is visible through the sidebar, the transcript, the
      file tree and the terminal (criteria 2 and 3). The terminal text is still legible.

- [ ] 10. Check criterion 4. Open the model picker (or any Select), the thread row's context
      menu, and a tooltip. Screenshot each one. Expect all three solid, with no gradient
      showing through. Then check that nothing got trapped under a pane:
      - Paste an image into the composer and click its thumbnail. The lightbox covers the whole
        window, including the file tree.
      - Drag an editor tab. The ghost stays visible over the file tree.
      - The sidebar's resize handle still grabs from both sides of its border.

- [ ] 11. Check criterion 9. In Settings → Appearance, switch the theme to Nord and the mode to
      Light. Expect the gradient to stay visible, the panel tint to follow Nord light, and the dim
      to lighten rather than darken. Screenshot it.

- [ ] 12. Check the performance constraint. Scroll a long transcript and a large file in the
      editor, and type in the terminal. Expect no visible stutter compared with the wallpaper
      off. If it stutters, record it in `progress.md` and stop. Don't tune it blind.

- [ ] 13. Check criterion 13. Run `rm /tmp/sr03-wallpaper-data/wallpaper.png` in a shell and
      reload. Expect opaque panels and `html.wallpaper` absent. Then run
      `JSON.parse(localStorage.getItem("sr03:appearance")).wallpaper` in the browser pane and
      expect `""`.

- [ ] 14. `git add web/src/index.css web/src/App.tsx web/src/components/{Sidebar,FileTree,AgentsPanel,TerminalPanel,ChatView,DraftView,SettingsView,EditorGroups}.tsx`, then
      `git commit -m "feat(web): paint the wallpaper behind translucent panels"`

**Done when:** steps 8–13 each match their stated expectation, with screenshots recorded in
`progress.md`.

---

### Task 4: Settings UI

**Depends on:** Tasks 2 and 3
**Files:** Create `web/src/components/ui/slider.tsx` (generated). Modify `web/src/components/SettingsView.tsx`.
**Interfaces consumed:**
- `useStore` fields: `appearance`, `setAppearance`, `setWallpaper` and `removeWallpaper`.
- `WALLPAPER_TYPES` from `../lib/appearance.ts`.

Steps:

- [ ] 1. `cd web && pnpm dlx shadcn@latest add slider && cd ..`. Expect `web/src/components/ui/slider.tsx`
      to be created, importing from `radix-ui`. Run `git status`. The only other acceptable change
      is to `web/package.json` / `pnpm-lock.yaml`, if the generator added a dependency. If it
      touched anything else, such as `index.css` or other `components/ui/*` files, run
      `git checkout` on those files.

- [ ] 2. In `SettingsView.tsx`:
      - Change the React import to `import { useEffect, useMemo, useRef, useState } from "react";`.
      - Import `WALLPAPER_TYPES` alongside `THEMES`.
      - Add `import { Slider } from "@/components/ui/slider";`.

- [ ] 3. Add `WallpaperSlider` above `AppearancePanel`. It is one row that follows the Mode row's
      layout (`flex items-center gap-4`):
      - Left side: a label `<p className="text-[13px] text-foreground">`, and a hint
        `<p className="text-[11.5px] text-faint">`.
      - Right side: `<Slider className="w-48" min={min} max={max} step={step} value={[value]} onValueChange={([next]) => onChange(next!)} />`,
        followed by `<span className="w-12 text-right font-mono text-[12px] text-muted-foreground">{value}{unit}</span>`.

      Props: `{ label: string; hint: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }`.

- [ ] 4. Add `WallpaperSection` below `WallpaperSlider`. Structure:
      - A `<section className="rounded-lg border border-border/70 bg-card/40">`.
      - A header copied from the Fonts section's (`SettingsView.tsx:373-378`): title "Wallpaper", subtitle
        "One image behind the whole app. The panels turn translucent over it."
      - A body of `<div className="flex flex-col gap-4 px-4 py-4">` containing:
        - A hidden native picker:
          `<input ref={picker} type="file" accept={WALLPAPER_TYPES.join(",")} className="hidden" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ""; }} />`.
          Resetting `value` lets you re-pick the same file.
        - A row `flex items-center gap-3` containing:
          - When `appearance.wallpaper` is set: `<img src={appearance.wallpaper} alt="" className="h-16 w-28 rounded-md border border-border/70 object-cover" />`.
          - `<Button variant="secondary" disabled={busy} onClick={() => picker.current?.click()}>`,
            labelled "Replace" when a wallpaper is set and "Choose image…" when not.
          - When set: `<Button variant="ghost" disabled={busy} onClick={() => void remove()}>Remove</Button>`.
        - `{error ? <p className="text-[12px] text-destructive">{error}</p> : null}`.
        - When set, three `WallpaperSlider`s separated by `<Separator />`:
          - "Panel opacity", hint "How solid the sidebar, editor and panels are":
            `min 30 max 100 step 5 unit "%"`, bound to `panelOpacity`.
          - "Wallpaper blur", hint "Softens the image itself":
            `min 0 max 40 step 2 unit "px"`, bound to `wallpaperBlur`.
          - "Dim", hint "Darkens the image in dark mode, lightens it in light":
            `min 0 max 80 step 5 unit "%"`, bound to `wallpaperDim`.

          Each `onChange` calls `setAppearance({ <field>: value })`.

      State: `const picker = useRef<HTMLInputElement>(null)`, `const [error, setError] = useState<string | null>(null)`
      and `const [busy, setBusy] = useState(false)`. Define `choose`:
      `async (file?: File) => { if (!file) return; setBusy(true); setError(await setWallpaper(file)); setBusy(false); }`,
      and `remove`:
      `async () => { setError(null); setBusy(true); await removeWallpaper(); setBusy(false); }`.
      A failed remove shows up through the store's existing error toast.
      Select each store field with its own `useStore((state) => state.x)` call. Don't write a
      selector that returns an object.

- [ ] 5. Render `<WallpaperSection />` as the last child of `AppearancePanel`'s fragment, after
      the Fonts `</section>`.

- [ ] 6. Run `pnpm typecheck && pnpm test`. Expect both to exit 0.

- [ ] 7. Walk the spec's acceptance criteria in the browser pane against the isolated stack. If
      one is still set from Task 3, click Remove first. The native file dialog can't be driven
      from the browser tools, so "choose" a file by defining these helpers in the page (again
      after every reload) and calling `pick(file)`:
      ```js
      const pick = (file) => { const input = document.querySelector('input[type="file"]');
        const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true })); };
      const gradient = async () => { const c = Object.assign(document.createElement("canvas"), { width: 1600, height: 1000 });
        const g = c.getContext("2d"); const grad = g.createLinearGradient(0, 0, 1600, 1000);
        grad.addColorStop(0, "#ff6a00"); grad.addColorStop(1, "#1e3cff"); g.fillStyle = grad; g.fillRect(0, 0, 1600, 1000);
        return new File([await new Promise((r) => c.toBlob(r, "image/png"))], "gradient.png", { type: "image/png" }); };
      ```
      Screenshot each step and record the results in `progress.md`:
      - **Criteria 1 and 10.** With no wallpaper, the section shows only "Choose image…" and the
        app is opaque.
      - **Criterion 2.** Run `pick(await gradient())`. Within about 1s the image fills the window
        with no reload, and the thumbnail, Replace, Remove and the three sliders appear.
      - **Criterion 5.** Drag Panel opacity to 100. The panels are solid and the gradient shows
        only where no pane covers the window.
      - **Criterion 6.** Drag Wallpaper blur from 0 to 40. The image blurs live and is sharp at 0.
      - **Criterion 7.** Drag Dim from 0 to 80. In dark mode the image darkens; switch to light
        and it lightens instead. At 0 there is no overlay.
      - **Criterion 8.** Reload, and every value survives. Then run
        `localStorage.removeItem("sr03:appearance"); location.reload()`. The wallpaper and
        values still come back from the server, which is the desktop-relaunch path.
      - **Criterion 11.** Two checks:
        - `pick(new File(["%PDF-1.7"], "doc.pdf", { type: "application/pdf" }))` shows
          "Wallpaper must be a PNG, JPEG or WebP image".
        - `pick(new File([new Uint8Array(21e6)], "big.png", { type: "image/png" }))` shows
          "Wallpaper must be 20 MB or smaller".

        For both, `read_network_requests` with `urlPattern: "/api/wallpaper"` shows no new
        `PUT`, and the current wallpaper is unchanged.
      - **Criterion 12.** Run `pick(await gradient())` a second time. Confirm that
        `JSON.parse(localStorage.getItem("sr03:appearance")).wallpaper` has a new `?v=`, and that
        `ls /tmp/sr03-wallpaper-data/wallpaper.*` lists exactly one file.
      - **Criterion 10.** Click Remove. The app is opaque again, the section is back to "Choose
        image…", and `ls /tmp/sr03-wallpaper-data/wallpaper.*` finds nothing.

- [ ] 8. Stop the dev stack and run `rm -rf /tmp/sr03-wallpaper-data`.

- [ ] 9. `git add web/src/components/ui/slider.tsx web/src/components/SettingsView.tsx`, plus
      `web/package.json pnpm-lock.yaml` if step 1 changed them. Then
      `git commit -m "feat(settings): add the wallpaper picker and sliders"`

**Done when:** every item in step 7 matches, and typecheck and tests are green.

## Acceptance criteria coverage
| Criterion | Task (where verified) |
|---|---|
| 1 | Task 3 step 8, Task 4 step 7 |
| 2 | Task 3 step 9, Task 4 step 7 |
| 3 | Task 3 step 9 |
| 4 | Task 3 step 10 |
| 5 | Task 4 step 7 (Criterion 5 bullet) |
| 6 | Task 4 step 7 (Criterion 6 bullet) |
| 7 | Task 4 step 7 (Criterion 7 bullet) |
| 8 | Task 2 (persistence path), Task 4 step 7 |
| 9 | Task 3 step 11 |
| 10 | Task 1 step 8, Task 4 step 7 |
| 11 | Task 1 step 8 (server 415/413), Task 2 step 1 (client check), Task 4 step 7 |
| 12 | Task 1 step 1, Task 4 step 7 |
| 13 | Task 2 step 5, Task 3 step 13 |

## Risks
- **Scroll or typing stutter from `backdrop-filter`** on up to four full-height panes (sidebar, main, file tree, agents), plus a
  full-window `filter: blur`. If Task 3 step 12 shows it, the first lever is dropping the
  panes' backdrop blur. The tint alone still reads as translucent, and the wallpaper's own blur
  slider covers the softening. That changes spec criterion 3, so ask before doing it.
- **Absolute children that depended on the viewport.** Adding `relative` to the four `<main>`s
  changes the containing block for any absolute descendant that had no positioned ancestor
  inside `main`. A grep of the four files found none. Components rendered inside them, such as
  Composer and Timeline, position against their own wrappers. Task 3 step 8's screenshot
  comparison catches a miss.
- **Slider drags send one settings `PUT` per step,** because `setAppearance` always persists.
  The steps (5, 2, 5) cap this at about 20 requests per full drag against local SQLite, which is
  acceptable. Mermaid diagrams also re-render on every `appearance` change, so dragging with a
  diagram open may feel heavier. That's an existing behaviour, not changed here.
- **The terminal stays opaque.** The transparency comes from the rgba theme background, which
  the DOM renderer paints inline and which overrides xterm.css's `#000` viewport. If Task 3
  step 9's `.xterm-viewport` check isn't `rgba(0, 0, 0, 0)`, the spec's open question applies:
  leave it opaque and report it rather than work around it.
- **A transient image-load failure forgets the wallpaper.** The probe's `onerror` can't tell a
  deleted file from a server that is restarting during a reload, so both clear `wallpaper`. It
  is cleared locally, and on the server once the settings `PUT` gets through. The file itself
  stays on disk, and choosing it again restores it. This is accepted for v1.
