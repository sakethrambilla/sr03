// The shape guard for a thread's editor layout. Everything crossing the API boundary comes through
// here, so a malformed or stale layout becomes null rather than something the client has to survive.
import type { EditorGroup, EditorLayout } from "./types.ts";

export const CHAT_TAB = "chat";

// three groups on one axis is the whole model — see docs/plans/2026-09-05-editor-split-groups
export const MAX_GROUPS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseGroup(value: unknown): EditorGroup | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.id)) return null;
  if (!Array.isArray(value.tabs) || value.tabs.length === 0) return null;
  if (!value.tabs.every(nonEmptyString)) return null;
  if (new Set(value.tabs).size !== value.tabs.length) return null;
  const active = value.active ?? null;
  if (active !== null && !(nonEmptyString(active) && value.tabs.includes(active))) return null;
  return { id: value.id, tabs: [...value.tabs], active };
}

export function parseLayout(value: unknown): EditorLayout | null {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!isRecord(source)) return null;
  if (source.axis !== "horizontal" && source.axis !== "vertical") return null;
  if (!Array.isArray(source.groups)) return null;
  if (source.groups.length === 0 || source.groups.length > MAX_GROUPS) return null;

  const groups: EditorGroup[] = [];
  for (const entry of source.groups) {
    const group = parseGroup(entry);
    if (!group) return null;
    groups.push(group);
  }

  const tabs = groups.flatMap((group) => group.tabs);
  if (new Set(tabs).size !== tabs.length) return null;
  if (tabs.filter((tab) => tab === CHAT_TAB).length !== 1) return null;

  if (!Array.isArray(source.sizes) || source.sizes.length !== groups.length) return null;
  if (!source.sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)) {
    return null;
  }

  return { axis: source.axis, groups, sizes: [...source.sizes] };
}
