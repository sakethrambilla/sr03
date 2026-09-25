// "mod+shift+k": modifiers in order mod, alt, shift; then the lowercased key
export type Stroke = string;
export type Binding = Stroke[];
export type Overrides = Record<string, Binding | null>;
export type CommandId =
  | "newSession"
  | "toggleSidebar"
  | "openInApp"
  | "quickOpen"
  | "quickOpenText"
  | "toggleFileTree"
  | "toggleTerminal"
  | "toggleAgents"
  | "splitGroup"
  | "focusPrevGroup"
  | "focusNextGroup"
  | "closeTab"
  | "closeAllFiles"
  | "save"
  | "toggleComment"
  | "togglePreview";

type KeyEvent = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export const COMMANDS: ReadonlyArray<{ id: CommandId; label: string; group: string; binding: Binding }> = [
  { id: "newSession", label: "New session", group: "Anywhere", binding: ["mod+shift+n"] },
  { id: "toggleSidebar", label: "Toggle sidebar", group: "Anywhere", binding: ["mod+shift+b"] },
  { id: "openInApp", label: "Open in app", group: "Session view", binding: ["mod+o"] },
  { id: "quickOpen", label: "Quick open file", group: "Session view", binding: ["mod+p"] },
  { id: "quickOpenText", label: "Search file contents", group: "Session view", binding: ["mod+shift+f"] },
  { id: "toggleFileTree", label: "Toggle file tree", group: "Session view", binding: ["mod+b"] },
  { id: "toggleTerminal", label: "Toggle terminal", group: "Session view", binding: ["mod+j"] },
  { id: "toggleAgents", label: "Toggle agents panel", group: "Session view", binding: ["mod+shift+a"] },
  { id: "splitGroup", label: "Split editor", group: "Session view", binding: ["mod+\\"] },
  { id: "focusPrevGroup", label: "Focus previous group", group: "Session view", binding: ["mod+k", "arrowleft"] },
  { id: "focusNextGroup", label: "Focus next group", group: "Session view", binding: ["mod+k", "arrowright"] },
  { id: "closeTab", label: "Close tab", group: "Session view", binding: ["mod+w"] },
  { id: "closeAllFiles", label: "Close all files", group: "Session view", binding: ["mod+k", "w"] },
  { id: "save", label: "Save file", group: "File editor", binding: ["mod+s"] },
  { id: "toggleComment", label: "Toggle comment", group: "File editor", binding: ["mod+/"] },
  { id: "togglePreview", label: "Toggle preview", group: "File editor", binding: ["mod+shift+v"] },
];

const MODIFIER_KEYS = new Set(["meta", "control", "alt", "shift"]);

export function strokeFromEvent(e: KeyEvent): Stroke | null {
  const key = e.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push("mod");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  return [...mods, key].join("+");
}

const MAC_MODS: Record<string, string> = { mod: "⌘", alt: "⌥", shift: "⇧" };
const PC_MODS: Record<string, string> = { mod: "Ctrl", alt: "Alt", shift: "Shift" };
const KEY_NAMES: Record<string, string> = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓" };

function splitStroke(stroke: Stroke): { mods: string[]; key: string } {
  // the key itself may be "+", so only leading known modifiers are split off
  const parts = stroke.split("+");
  const mods: string[] = [];
  while (parts.length > 1 && parts[0] in MAC_MODS) mods.push(parts.shift()!);
  return { mods, key: parts.join("+") };
}

export function formatStroke(stroke: Stroke, mac: boolean): string {
  const { mods, key } = splitStroke(stroke);
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  const labels = mods.map((m) => (mac ? MAC_MODS : PC_MODS)[m]);
  return mac ? labels.join("") + name : [...labels, name].join("+");
}

export function formatBinding(binding: Binding | null, mac: boolean): string {
  return binding ? binding.map((s) => formatStroke(s, mac)).join(" then ") : "";
}

function isBinding(v: unknown): v is Binding {
  return Array.isArray(v) && (v.length === 1 || v.length === 2) && v.every((s) => typeof s === "string" && s !== "");
}

export function resolveBindings(overrides: unknown): Record<CommandId, Binding | null> {
  const o = overrides && typeof overrides === "object" && !Array.isArray(overrides) ? (overrides as Record<string, unknown>) : {};
  const out = {} as Record<CommandId, Binding | null>;
  for (const c of COMMANDS) {
    const v = Object.hasOwn(o, c.id) ? o[c.id] : undefined;
    out[c.id] = v === null ? null : isBinding(v) ? v : c.binding;
  }
  return out;
}

export function parseOverrides(raw: string | undefined): Overrides {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Overrides = {};
    for (const [k, b] of Object.entries(v)) if (b === null || isBinding(b)) out[k] = b;
    return out;
  } catch {
    return {};
  }
}

export function findConflicts(bindings: Record<CommandId, Binding | null>): Set<CommandId> {
  const byKey = new Map<string, CommandId[]>();
  for (const [id, b] of Object.entries(bindings) as [CommandId, Binding | null][]) {
    if (!b) continue;
    const k = b.join(" ");
    byKey.set(k, [...(byKey.get(k) ?? []), id]);
  }
  const out = new Set<CommandId>();
  for (const ids of byKey.values()) if (ids.length > 1) for (const id of ids) out.add(id);
  return out;
}

function isBare(stroke: Stroke): boolean {
  const { mods } = splitStroke(stroke);
  return !mods.includes("mod") && !mods.includes("alt");
}

export function matchesStroke(e: KeyEvent, binding: Binding | null): boolean {
  if (!binding || binding.length !== 1) return false;
  const s = strokeFromEvent(e);
  return s !== null && !isBare(s) && s === binding[0];
}

export type ChordStep = { run: CommandId | null; pending: Stroke | null };

export function step(
  pending: Stroke | null,
  stroke: Stroke,
  bindings: Record<CommandId, Binding | null>,
  available: (id: CommandId) => boolean,
): ChordStep {
  const entries = Object.entries(bindings) as [CommandId, Binding | null][];
  if (pending) {
    const hit = entries.find(([id, b]) => b?.length === 2 && b[0] === pending && b[1] === stroke && available(id));
    return { run: hit ? hit[0] : null, pending: null };
  }
  if (isBare(stroke)) return { run: null, pending: null };
  const hit = entries.find(([id, b]) => b?.length === 1 && b[0] === stroke && available(id));
  if (hit) return { run: hit[0], pending: null };
  if (entries.some(([, b]) => b?.length === 2 && b[0] === stroke)) return { run: null, pending: stroke };
  return { run: null, pending: null };
}
