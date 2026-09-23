// the pure helpers — resolveDark, groupFonts and the wallpaper checks — are tested directly;
// applyAppearance and the system-preference wiring are exercised by hand
// (see docs/plans/2026-09-06-light-dark-mode-themes/tasks/04-preview-panes-and-qa.md)
import assert from "node:assert/strict";
import test from "node:test";

import { groupFonts, resolveDark, wallpaperFileError, wallpaperVars } from "./appearance.ts";

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

test("groupFonts: a family the bundle already covers is dropped from the probed list", () => {
  const groups = groupFonts(["Inter Variable", "Iosevka"], ["Inter", "Iosevka", "Menlo"]);
  assert.deepStrictEqual(groups.bundled, ["Inter Variable", "Iosevka"]);
  assert.deepStrictEqual(groups.installed, ["Menlo"]);
});

test("groupFonts: bundled families are listed whatever the probe returned", () => {
  const groups = groupFonts(["Sora Variable"], []);
  assert.deepStrictEqual(groups.bundled, ["Sora Variable"]);
  assert.deepStrictEqual(groups.installed, []);
});

test("wallpaperFileError: PNG, JPEG and WebP up to 20 MB pass", () => {
  assert.strictEqual(wallpaperFileError({ type: "image/png", size: 1000 }), null);
  assert.strictEqual(wallpaperFileError({ type: "image/webp", size: 20 * 1024 * 1024 }), null);
});

test("wallpaperFileError: other types are refused", () => {
  const message = "Wallpaper must be a PNG, JPEG or WebP image";
  assert.strictEqual(wallpaperFileError({ type: "application/pdf", size: 10 }), message);
  assert.strictEqual(wallpaperFileError({ type: "image/svg+xml", size: 10 }), message);
});

test("wallpaperFileError: a file over 20 MB is refused", () => {
  assert.strictEqual(
    wallpaperFileError({ type: "image/jpeg", size: 20 * 1024 * 1024 + 1 }),
    "Wallpaper must be 20 MB or smaller",
  );
});

const NO_WALLPAPER = {
  theme: "sr03",
  uiFont: "",
  codeFont: "",
  mode: "dark",
  wallpaper: "",
  panelOpacity: 80,
  wallpaperBlur: 0,
  wallpaperDim: 20,
} as const;

test("wallpaperVars: no wallpaper sets no variables", () => {
  assert.strictEqual(wallpaperVars(NO_WALLPAPER), null);
});

test("wallpaperVars: a wallpaper carries its image and slider values", () => {
  const vars = wallpaperVars({
    ...NO_WALLPAPER,
    wallpaper: "/api/wallpaper?v=abc",
    panelOpacity: 65,
    wallpaperBlur: 12,
    wallpaperDim: 0,
  });
  assert.deepStrictEqual(vars, {
    "--wallpaper-image": 'url("/api/wallpaper?v=abc")',
    "--panel-opacity": "65%",
    "--panel-backdrop": "blur(20px)",
    "--wallpaper-blur": "12px",
    "--wallpaper-dim": "0%",
  });
});

test("wallpaperVars: 0% panel opacity drops the panel blur too, leaving them fully clear", () => {
  const vars = wallpaperVars({ ...NO_WALLPAPER, wallpaper: "/api/wallpaper?v=abc", panelOpacity: 0 });
  assert.strictEqual(vars?.["--panel-opacity"], "0%");
  assert.strictEqual(vars?.["--panel-backdrop"], "none");
});
