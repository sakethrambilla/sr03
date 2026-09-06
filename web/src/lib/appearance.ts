// The theme and font choice behind the appearance panel: the lists it offers, a canvas probe for
// which faces the machine actually has, and applying the pick to the document root.
export type ThemeMode = "light" | "dark" | "system";

export interface Appearance {
  theme: string;
  uiFont: string;
  codeFont: string;
  mode: ThemeMode;
}

export interface Theme {
  id: string;
  label: string;
}

// sr03's own palette is what :root carries; the rest are the shadcn set, keyed by data-theme
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

let cache: { ui: string[]; code: string[] } | null = null;

export function availableFonts(): { ui: string[]; code: string[] } {
  cache ??= { ui: UI_FONTS.filter(installed), code: CODE_FONTS.filter(installed) };
  return cache;
}

export function applyAppearance({ theme, uiFont, codeFont, mode }: Appearance): void {
  const root = document.documentElement;
  if (theme && theme !== "sr03") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  root.classList.toggle("dark", resolveDark(mode, systemPrefersDark()));

  // clearing an override drops back to the stack the stylesheet defines
  if (uiFont) root.style.setProperty("--font-sans", `"${uiFont}", ${SANS_TAIL}`);
  else root.style.removeProperty("--font-sans");
  if (codeFont) root.style.setProperty("--font-mono", `"${codeFont}", ${MONO_TAIL}`);
  else root.style.removeProperty("--font-mono");
}

const KEY = "sr03:appearance";
const DEFAULTS: Appearance = { theme: "sr03", uiFont: "", codeFont: "", mode: "dark" };

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
