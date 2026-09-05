// The editor area as a flat row or column of one to three groups, and every rule about how tabs
// move between them. Pure — no React, no DOM — so it runs under `node --test` and so the split
// rules live in one place instead of being re-derived by each component that draws a drop target.
import type { EditorGroup, EditorLayout, EditorTab, LayoutAxis } from "./types.ts";

export const CHAT: EditorTab = { kind: "chat" };
export const MAX_GROUPS = 3;

// a group may not be squeezed below this share of the split axis, or its tab strip stops being
// readable; enforced on resize and again on read, so a layout stored on a wide screen still opens
export const MIN_FRACTION = 0.15;

// the fraction of a group's width and height that counts as its edge; inside that inset a drop is
// a merge. VS Code uses the same 10% — see editorDropTarget.ts, positionOverlay
const EDGE = 0.1;

export type DropZone = "left" | "right" | "up" | "down" | "center";

export interface DropAllow {
  split: boolean;
  // the session's settled axis, or null while it has none and either direction is still open
  axis: LayoutAxis | null;
}

export function tabKey(tab: EditorTab): string {
  return tab.kind === "chat" ? "chat:" : `file:${tab.path}`;
}

export function sameTab(a: EditorTab, b: EditorTab): boolean {
  return tabKey(a) === tabKey(b);
}

export function activeTab(group: EditorGroup): EditorTab {
  return group.tabs[group.active] ?? group.tabs[0]!;
}

export function allTabs(layout: EditorLayout): EditorTab[] {
  return layout.groups.flatMap((group) => group.tabs);
}

export function groupOf(layout: EditorLayout, tab: EditorTab): number {
  return layout.groups.findIndex((group) => group.tabs.some((entry) => sameTab(entry, tab)));
}

function newGroup(tabs: EditorTab[], active = 0): EditorGroup {
  return { id: crypto.randomUUID(), tabs, active };
}

export function singleGroup(tabs: EditorTab[] = [CHAT]): EditorLayout {
  return { axis: "horizontal", groups: [newGroup(tabs)], sizes: [1] };
}

// Returns shares that sum to 1, keeping the given fractions proportional to each other and lifting
// any group that would sit under the minimum. Raising one changes the total, so the rest are
// rescaled into what is left over — clamping in place would leave the raised group short again.
function fit(sizes: number[], count: number): number[] {
  const raw = sizes.length === count ? sizes : new Array<number>(count).fill(1);
  const usable = raw.map((size) => (Number.isFinite(size) && size > 0 ? size : 1));
  const total = usable.reduce((sum, size) => sum + size, 0);
  const shares = usable.map((size) => size / total);

  // MAX_GROUPS * MIN_FRACTION is well under 1, so pinning the offenders each pass always settles
  const pinned = new Set<number>();
  for (;;) {
    const under = shares
      .map((share, index) => index)
      .filter((index) => !pinned.has(index) && shares[index]! < MIN_FRACTION - 1e-12);
    if (under.length === 0) return shares;
    for (const index of under) {
      shares[index] = MIN_FRACTION;
      pinned.add(index);
    }
    const rest = shares.map((_, index) => index).filter((index) => !pinned.has(index));
    if (rest.length === 0) return shares;
    const room = Math.max(1 - pinned.size * MIN_FRACTION, 0);
    const restTotal = rest.reduce((sum, index) => sum + shares[index]!, 0);
    for (const index of rest) {
      shares[index] = restTotal > 0 ? (shares[index]! / restTotal) * room : room / rest.length;
    }
  }
}

// the one place a layout is rebuilt from parts, so every invariant is asserted in a single pass
function rebuild(axis: LayoutAxis, groups: EditorGroup[], sizes: number[]): EditorLayout {
  // sizes are parallel to groups, so an emptied group takes its own fraction with it — slicing the
  // tail instead would shift every surviving group onto its neighbour's share
  const surviving = groups
    .map((group, index) => ({ group, size: sizes[index] ?? 1 }))
    .filter((entry) => entry.group.tabs.length > 0)
    .slice(0, MAX_GROUPS);
  if (surviving.length === 0) return singleGroup();
  const kept = surviving.map(({ group }) => ({
    ...group,
    active: Math.min(Math.max(group.active, 0), group.tabs.length - 1),
  }));
  return { axis, groups: kept, sizes: fit(surviving.map(({ size }) => size), kept.length) };
}

// drops a tab from wherever it currently lives, so a move is always remove-then-insert
function without(groups: EditorGroup[], tab: EditorTab): EditorGroup[] {
  return groups.map((group) => {
    const index = group.tabs.findIndex((entry) => sameTab(entry, tab));
    if (index === -1) return group;
    const tabs = group.tabs.filter((_, at) => at !== index);
    return { ...group, tabs, active: group.active > index ? group.active - 1 : group.active };
  });
}

export function openTab(layout: EditorLayout, tab: EditorTab, groupIndex: number): EditorLayout {
  const existing = groupOf(layout, tab);
  // an already-open tab is activated where it lives rather than dragged to the caller's group
  if (existing !== -1) return selectTab(layout, existing, tab);
  const target = Math.min(Math.max(groupIndex, 0), layout.groups.length - 1);
  const groups = layout.groups.map((group, index) =>
    index === target ? { ...group, tabs: [...group.tabs, tab], active: group.tabs.length } : group,
  );
  return rebuild(layout.axis, groups, layout.sizes);
}

export function selectTab(layout: EditorLayout, groupIndex: number, tab: EditorTab): EditorLayout {
  const groups = layout.groups.map((group, index) => {
    if (index !== groupIndex) return group;
    const at = group.tabs.findIndex((entry) => sameTab(entry, tab));
    return at === -1 ? group : { ...group, active: at };
  });
  return { ...layout, groups };
}

export function closeTab(layout: EditorLayout, tab: EditorTab): EditorLayout {
  if (tab.kind === "chat") return layout;
  if (groupOf(layout, tab) === -1) return layout;
  return rebuild(layout.axis, without(layout.groups, tab), layout.sizes);
}

export function moveTab(
  layout: EditorLayout,
  tab: EditorTab,
  target: { group: number; zone: DropZone; before?: EditorTab },
): EditorLayout {
  const from = groupOf(layout, tab);
  if (from === -1) return layout;
  const splitting = target.zone !== "center";

  if (splitting) {
    if (layout.groups.length >= MAX_GROUPS) return layout;
    const axis: LayoutAxis =
      target.zone === "left" || target.zone === "right" ? "horizontal" : "vertical";
    // the first split settles the axis; afterwards a cross-axis drop is refused outright
    if (layout.groups.length > 1 && axis !== layout.axis) return layout;
    // a lone tab dropped to the side of its own group would only trade one group for another
    if (from === target.group && layout.groups[from]!.tabs.length === 1) return layout;

    const groups = without(layout.groups, tab);
    const at = target.zone === "left" || target.zone === "up" ? target.group : target.group + 1;
    groups.splice(at, 0, newGroup([tab]));
    const share = layout.sizes.reduce((sum, size) => sum + size, 0) / layout.groups.length;
    const sizes = layout.sizes.slice();
    sizes.splice(at, 0, share);
    return rebuild(axis, groups, sizes);
  }

  const already = from === target.group;
  const reordering = target.before !== undefined;
  if (already && !reordering) return layout;

  const groups = without(layout.groups, tab);
  const destination = groups[target.group];
  if (!destination) return layout;
  const before = target.before;
  const at = before
    ? destination.tabs.findIndex((entry) => sameTab(entry, before))
    : destination.tabs.length;
  const insert = at === -1 ? destination.tabs.length : at;
  const tabs = [...destination.tabs.slice(0, insert), tab, ...destination.tabs.slice(insert)];
  groups[target.group] = { ...destination, tabs, active: insert };
  return rebuild(layout.axis, groups, layout.sizes);
}

export function resize(
  layout: EditorLayout,
  sashIndex: number,
  fractions: [number, number],
): EditorLayout {
  const sizes = layout.sizes.slice();
  if (sashIndex < 0 || sashIndex + 1 >= sizes.length) return layout;
  const pair = sizes[sashIndex]! + sizes[sashIndex + 1]!;
  const total = fractions[0] + fractions[1];
  if (!(total > 0)) return layout;
  sizes[sashIndex] = (fractions[0] / total) * pair;
  sizes[sashIndex + 1] = (fractions[1] / total) * pair;
  return { ...layout, groups: layout.groups, sizes: fit(sizes, sizes.length) };
}

// Structural repair only. This deliberately has no file list and must never grow one: filesByCwd is
// `git ls-files` output, so pruning against it would silently close a gitignored file that is
// legitimately open. A tab whose file has gone is closed by the view that fails to load it.
export function normalize(layout: EditorLayout | null): EditorLayout {
  if (!layout || !Array.isArray(layout.groups)) return singleGroup();
  const axis: LayoutAxis = layout.axis === "vertical" ? "vertical" : "horizontal";

  const seen = new Set<string>();
  const groups = layout.groups.map((group) => {
    const tabs = (group.tabs ?? []).filter((tab) => {
      const key = tabKey(tab);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...group, id: group.id || crypto.randomUUID(), tabs };
  });

  const repaired = rebuild(axis, groups, layout.sizes ?? []);
  if (repaired.groups.some((group) => group.tabs.some((tab) => tab.kind === "chat"))) {
    return repaired;
  }
  // the transcript is never optional, so a layout that lost it gets it back at the front
  const first = repaired.groups[0]!;
  const restored = repaired.groups.slice();
  restored[0] = { ...first, tabs: [CHAT, ...first.tabs], active: first.active + 1 };
  return rebuild(axis, restored, repaired.sizes);
}

// The template for the split axis. Horizontal groups are one column each, so the cross axis is a
// fixed `auto 1fr` pair of rows; vertical groups carry their own strip row, so each contributes two
// tracks and the template has to spell both out. Sashes are the 1px tracks between groups.
export function trackTemplate(sizes: number[], axis: LayoutAxis): string {
  if (axis === "horizontal") return sizes.map((size) => `${size}fr`).join(" 1px ");
  return sizes.map((size) => `auto ${size}fr`).join(" 1px ");
}

// Horizontal: group i owns column 2i+1, and its strip and view stack in rows 1 and 2 of it.
// Vertical: one column, and group i owns rows 3i+1 (strip) and 3i+2 (view), with a sash between.
export function trackOf(groupIndex: number, axis: LayoutAxis, part: "strip" | "view"): number {
  if (axis === "horizontal") return groupIndex * 2 + 1;
  return groupIndex * 3 + (part === "strip" ? 1 : 2);
}

export function dropTargetAt(
  rect: { width: number; height: number },
  x: number,
  y: number,
  allow: DropAllow,
): DropZone {
  if (!allow.split) return "center";

  const insetX = rect.width * EDGE;
  const insetY = rect.height * EDGE;
  const inside = x > insetX && x < rect.width - insetX && y > insetY && y < rect.height - insetY;
  if (inside) return "center";

  const third = rect.width / 3;
  const zone: DropZone =
    x < third ? "left" : x > third * 2 ? "right" : y < rect.height / 2 ? "up" : "down";

  // once the axis is settled the cross-axis halves stop being offered at all, so a drop can never
  // preview a split that moveTab would then refuse
  const across =
    (allow.axis === "horizontal" && (zone === "up" || zone === "down")) ||
    (allow.axis === "vertical" && (zone === "left" || zone === "right"));
  return across ? "center" : zone;
}
