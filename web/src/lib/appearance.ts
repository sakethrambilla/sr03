// The theme, font and wallpaper choice behind the appearance panel: the faces sr03 bundles, a
// canvas probe for which further faces the machine already has, and applying the pick to the
// document root.
export type ThemeMode = "light" | "dark" | "system";

export interface Appearance {
  theme: string;
  uiFont: string;
  codeFont: string;
  mode: ThemeMode;
  wallpaper: string;
  panelOpacity: number; // percent, 30–100
  wallpaperBlur: number; // px, 0–40
  wallpaperDim: number; // percent, 0–80
}

export interface Theme {
  id: string;
  label: string;
}

// sr03's own palette is what :root carries; the rest — the shadcn set, then six of ours — are
// keyed by data-theme
export const THEMES: Theme[] = [
  { id: "sr03", label: "sr03" },
  { id: "zinc", label: "Zinc" },
  { id: "slate", label: "Slate" },
  { id: "stone", label: "Stone" },
  { id: "gray", label: "Gray" },
  { id: "neutral", label: "Neutral" },
  { id: "red", label: "Red" },
  { id: "rose", label: "Rose" },
  { id: "orange", label: "Orange" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "yellow", label: "Yellow" },
  { id: "violet", label: "Violet" },
  { id: "neon", label: "Neon" },
  { id: "bloom", label: "Bloom" },
  { id: "terminal", label: "Terminal" },
  { id: "dune", label: "Dune" },
  { id: "nord", label: "Nord" },
  { id: "mono", label: "Mono" },
];

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

// the exact CSS family names web/src/fonts.ts pulls in — fontsource's variable builds declare
// "<Name> Variable", its static ones the plain name
export const BUNDLED_UI_FONTS = [
  "Inter Variable",
  "Geist Variable",
  "IBM Plex Sans Variable",
  "Source Sans 3 Variable",
  "Public Sans Variable",
  "Outfit Variable",
  "Bricolage Grotesque Variable",
  "Instrument Sans Variable",
  "Space Grotesk Variable",
  "Sora Variable",
  "Fraunces Variable",
  "Lora Variable",
];

export const BUNDLED_CODE_FONTS = [
  "JetBrains Mono Variable",
  "Fira Code Variable",
  "IBM Plex Mono",
  "Source Code Pro Variable",
  "Geist Mono Variable",
  "Iosevka",
  "Space Mono",
  "Commit Mono",
  "Martian Mono Variable",
  "Red Hat Mono Variable",
  "Azeret Mono Variable",
  "Recursive Variable",
];

const UI_FONTS = [
  "Inter",
  "SF Pro Text",
  "SF Pro Display",
  "Helvetica Neue",
  "Avenir Next",
  "Optima",
  "Lucida Grande",
  "Verdana",
  "Georgia",
  "Charter",
  "Segoe UI",
  "Roboto",
  "IBM Plex Sans",
  "Source Sans 3",
  "Public Sans",
  "Geist",
];

const CODE_FONTS = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Andale Mono",
  "PT Mono",
  "Courier New",
  "JetBrains Mono",
  "Fira Code",
  "Fira Mono",
  "IBM Plex Mono",
  "Source Code Pro",
  "Cascadia Code",
  "Cascadia Mono",
  "Hack",
  "Iosevka",
  "Inconsolata",
  "Roboto Mono",
  "Ubuntu Mono",
  "Berkeley Mono",
  "Geist Mono",
  "Departure Mono",
];

// the tails the picker appends, so a chosen face still degrades to something sane
const SANS_TAIL = 'system-ui, -apple-system, "Helvetica Neue", sans-serif';
const MONO_TAIL = 'ui-monospace, "SF Mono", Menlo, monospace';

const PROBE = "mmmmmmmmwwwwwwwwiiiiiiiil0O";
const GENERICS = ["monospace", "serif", "sans-serif"];

function width(family: string, generic: string): number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return 0;
  context.font = `72px ${family}, ${generic}`;
  return context.measureText(PROBE).width;
}

// a family the machine does not have measures exactly like the generic behind it. one generic
// isn't enough — a face whose metrics happen to match it would read as missing
function installed(family: string): boolean {
  return GENERICS.some(
    (generic) => width(`"${family}"`, generic) !== width('"sr03 no such font"', generic),
  );
}

export interface FontGroups {
  bundled: string[];
  installed: string[];
}

// dedupe on the family name with fontsource's " Variable" suffix dropped, since the bundled
// "Inter Variable" and the probed "Inter" are the same typeface to anyone reading the picker
function baseName(family: string): string {
  return family.replace(/ Variable$/, "");
}

// pure half of availableFonts, so it can be tested without a canvas
export function groupFonts(bundled: string[], probed: string[]): FontGroups {
  const covered = new Set(bundled.map(baseName));
  return { bundled, installed: probed.filter((family) => !covered.has(baseName(family))) };
}

let cache: { ui: FontGroups; code: FontGroups } | null = null;

export function availableFonts(): { ui: FontGroups; code: FontGroups } {
  // bundled faces are never probed: one that hasn't finished loading measures like its generic
  cache ??= {
    ui: groupFonts(BUNDLED_UI_FONTS, UI_FONTS.filter(installed)),
    code: groupFonts(BUNDLED_CODE_FONTS, CODE_FONTS.filter(installed)),
  };
  return cache;
}

// mirror the server's accepted types and size cap
export const WALLPAPER_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const WALLPAPER_LIMIT = 20 * 1024 * 1024;

export function wallpaperFileError(file: { type: string; size: number }): string | null {
  if (!WALLPAPER_TYPES.includes(file.type)) return "Wallpaper must be a PNG, JPEG or WebP image";
  if (file.size > WALLPAPER_LIMIT) return "Wallpaper must be 20 MB or smaller";
  return null;
}

export function wallpaperVars(appearance: Appearance): Record<string, string> | null {
  if (!appearance.wallpaper) return null;
  return {
    "--wallpaper-image": `url("${appearance.wallpaper}")`,
    "--panel-opacity": `${appearance.panelOpacity}%`,
    "--wallpaper-blur": `${appearance.wallpaperBlur}px`,
    "--wallpaper-dim": `${appearance.wallpaperDim}%`,
  };
}

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

export function applyAppearance(appearance: Appearance, onWallpaperMissing?: () => void): void {
  const { theme, uiFont, codeFont, mode } = appearance;
  const root = document.documentElement;
  if (theme && theme !== "sr03") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  root.classList.toggle("dark", resolveDark(mode, systemPrefersDark()));

  // clearing an override drops back to the stack the stylesheet defines
  if (uiFont) root.style.setProperty("--font-sans", `"${uiFont}", ${SANS_TAIL}`);
  else root.style.removeProperty("--font-sans");
  if (codeFont) root.style.setProperty("--font-mono", `"${codeFont}", ${MONO_TAIL}`);
  else root.style.removeProperty("--font-mono");

  const vars = wallpaperVars(appearance);
  for (const name of WALLPAPER_VARS) {
    if (vars) root.style.setProperty(name, vars[name]!);
    else root.style.removeProperty(name);
  }
  showWallpaper(appearance.wallpaper, onWallpaperMissing);
}

const KEY = "sr03:appearance";
const DEFAULTS: Appearance = {
  theme: "sr03",
  uiFont: "",
  codeFont: "",
  mode: "dark",
  wallpaper: "",
  panelOpacity: 80,
  wallpaperBlur: 0,
  wallpaperDim: 20,
};

export function loadAppearance(): Appearance {
  try {
    const stored = localStorage.getItem(KEY);
    return stored ? { ...DEFAULTS, ...(JSON.parse(stored) as Partial<Appearance>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveAppearance(appearance: Appearance): Appearance {
  try {
    localStorage.setItem(KEY, JSON.stringify(appearance));
  } catch {
    // private browsing, or the quota is gone — the choice just stops persisting
  }
  return appearance;
}
