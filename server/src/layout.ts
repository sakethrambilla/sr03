// The shape guard for a thread's editor layout. Everything crossing the API boundary comes through
// here, so a malformed or stale layout becomes null rather than something the client has to survive.
import type { EditorGroup, EditorLayout, EditorTab } from "./types.ts";

// three groups on one axis is the whole model — see docs/plans/2026-09-05-editor-split-groups
export const MAX_GROUPS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseTab(value: unknown): EditorTab | null {
  if (!isRecord(value)) return null;
  if (value.kind === "chat") return { kind: "chat" };
  if (value.kind === "file" && nonEmptyString(value.path)) return { kind: "file", path: value.path };
  return null;
}

function parseGroup(value: unknown): EditorGroup | null {
  if (!isRecord(value)) return null;
  if (!nonEmptyString(value.id)) return null;
  if (!Array.isArray(value.tabs) || value.tabs.length === 0) return null;

  const tabs: EditorTab[] = [];
  for (const entry of value.tabs) {
    const tab = parseTab(entry);
    if (!tab) return null;
    tabs.push(tab);
  }

  const active = value.active;
  if (!Number.isInteger(active) || (active as number) < 0 || (active as number) >= tabs.length) {
    return null;
  }
  return { id: value.id, tabs, active: active as number };
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

  // one transcript, and at most one tab per file, across the whole layout
  const tabs = groups.flatMap((group) => group.tabs);
  const paths = tabs.flatMap((tab) => (tab.kind === "file" ? [tab.path] : []));
  if (new Set(paths).size !== paths.length) return null;
  if (tabs.filter((tab) => tab.kind === "chat").length !== 1) return null;

  if (!Array.isArray(source.sizes) || source.sizes.length !== groups.length) return null;
  if (!source.sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)) {
    return null;
  }

  return { axis: source.axis, groups, sizes: [...source.sizes] };
}
