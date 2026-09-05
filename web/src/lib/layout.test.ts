// The layout model is the only place the split rules live — the three-group cap, the axis lock and
// the minimum share are all enforced here rather than in the components, so they are all tested here.
import assert from "node:assert/strict";
import test from "node:test";

import type { EditorLayout } from "./types.ts";
import {
  CHAT,
  MIN_FRACTION,
  activeTab,
  allTabs,
  closeTab,
  dropTargetAt,
  groupOf,
  moveTab,
  normalize,
  openTab,
  resize,
  sameTab,
  selectTab,
  singleGroup,
  tabKey,
  trackOf,
  trackTemplate,
} from "./layout.ts";

const file = (path: string) => ({ kind: "file" as const, path });
const README = file("README.md");
const MAIN = file("main.ts");
const NOTES = file("notes.md");

// chat left, one file right — the layout most of these cases start from
function split(): EditorLayout {
  return moveTab(singleGroup([CHAT, README]), README, { group: 0, zone: "right" });
}

const paths = (layout: EditorLayout, group: number) =>
  layout.groups[group]!.tabs.map((tab) => (tab.kind === "chat" ? "chat" : tab.path));

// --- identity and construction -------------------------------------------------------------

test("a chat tab and a file named chat are different tabs", () => {
  assert.notEqual(tabKey(CHAT), tabKey(file("chat")));
  assert.equal(sameTab(CHAT, file("chat")), false);
  assert.equal(sameTab(file("a.ts"), file("a.ts")), true);
});

test("singleGroup holds only chat", () => {
  const layout = singleGroup();
  assert.equal(layout.groups.length, 1);
  assert.deepEqual(layout.groups[0]!.tabs, [CHAT]);
  assert.equal(layout.groups[0]!.active, 0);
  assert.deepEqual(layout.sizes, [1]);
});

// --- opening, selecting, closing ------------------------------------------------------------

test("openTab appends into the requested group and activates it", () => {
  const next = openTab(split(), MAIN, 1);
  assert.deepEqual(paths(next, 1), ["README.md", "main.ts"]);
  assert.deepEqual(activeTab(next.groups[1]!), MAIN);
});

test("openTab on a tab that is already open activates it where it lives", () => {
  const next = openTab(split(), README, 0);
  assert.equal(next.groups.length, 2);
  assert.deepEqual(paths(next, 0), ["chat"]);
  assert.deepEqual(paths(next, 1), ["README.md"]);
  assert.equal(groupOf(next, README), 1);
});

test("selectTab changes only its own group", () => {
  const two = openTab(split(), MAIN, 1);
  const next = selectTab(two, 1, README);
  assert.deepEqual(activeTab(next.groups[1]!), README);
  assert.equal(next.groups[0]!.active, two.groups[0]!.active);
});

test("closing a group's last tab removes the group and keeps sizes parallel", () => {
  const next = closeTab(split(), README);
  assert.equal(next.groups.length, 1);
  assert.equal(next.sizes.length, 1);
  assert.deepEqual(paths(next, 0), ["chat"]);
});

test("closing a tab before the active one keeps the same tab active", () => {
  const layout = openTab(openTab(singleGroup(), MAIN, 0), NOTES, 0);
  assert.deepEqual(activeTab(layout.groups[0]!), NOTES);
  const next = closeTab(layout, MAIN);
  assert.deepEqual(activeTab(next.groups[0]!), NOTES);
});

test("three groups keep their proportions to each other when the middle one closes", () => {
  let layout = moveTab(singleGroup([CHAT, README]), README, { group: 0, zone: "right" });
  layout = openTab(layout, MAIN, 1);
  layout = moveTab(layout, MAIN, { group: 1, zone: "right" });
  layout = resize({ ...layout, sizes: [1, 2, 3] }, 0, [1, 2]);
  const next = closeTab({ ...layout, sizes: [1, 2, 3] }, README);
  assert.equal(next.groups.length, 2);
  assert.equal(next.sizes.length, 2);
  assert.ok(Math.abs(next.sizes[1]! / next.sizes[0]! - 3) < 1e-9, "1:3 should survive as 1:3");
});

test("closing the last file leaves one group holding chat", () => {
  const next = closeTab(closeTab(openTab(singleGroup(), MAIN, 0), MAIN), README);
  assert.equal(next.groups.length, 1);
  assert.deepEqual(next.groups[0]!.tabs, [CHAT]);
});

test("chat is never closable", () => {
  const layout = split();
  assert.deepEqual(closeTab(layout, CHAT), layout);
});

// --- moving and splitting ---------------------------------------------------------------------

test("dropping right splits into two horizontal groups with equal sizes", () => {
  const next = split();
  assert.equal(next.groups.length, 2);
  assert.equal(next.axis, "horizontal");
  assert.deepEqual(paths(next, 0), ["chat"]);
  assert.deepEqual(paths(next, 1), ["README.md"]);
  assert.equal(next.sizes[0], next.sizes[1]);
});

test("dropping down splits vertically", () => {
  const next = moveTab(singleGroup([CHAT, README]), README, { group: 0, zone: "down" });
  assert.equal(next.axis, "vertical");
  assert.equal(next.groups.length, 2);
});

test("a cross-axis drop is refused once the axis is set", () => {
  const layout = openTab(split(), MAIN, 0);
  assert.deepEqual(moveTab(layout, MAIN, { group: 1, zone: "down" }), layout);
});

test("a fourth group is refused", () => {
  let layout = split();
  layout = moveTab(openTab(layout, MAIN, 1), MAIN, { group: 1, zone: "right" });
  assert.equal(layout.groups.length, 3);
  const four = openTab(layout, NOTES, 2);
  assert.deepEqual(moveTab(four, NOTES, { group: 2, zone: "right" }), four);
});

test("a centre drop moves the tab without changing the group count", () => {
  const next = moveTab(split(), README, { group: 0, zone: "center" });
  assert.equal(next.groups.length, 1);
  assert.deepEqual(paths(next, 0), ["chat", "README.md"]);
});

test("dropping a tab on its own group's centre is a no-op", () => {
  const layout = split();
  assert.deepEqual(moveTab(layout, README, { group: 1, zone: "center" }), layout);
});

test("a before target reorders within one strip", () => {
  const layout = openTab(openTab(singleGroup(), MAIN, 0), NOTES, 0);
  const next = moveTab(layout, NOTES, { group: 0, zone: "center", before: MAIN });
  assert.deepEqual(paths(next, 0), ["chat", "notes.md", "main.ts"]);
  assert.equal(next.groups.length, 1);
});

test("moving a group's only tab away removes the emptied group", () => {
  const next = moveTab(split(), README, { group: 0, zone: "center" });
  assert.equal(next.groups.length, 1);
  assert.equal(next.sizes.length, 1);
});

// --- sizing -------------------------------------------------------------------------------------

test("resize sets both adjacent fractions", () => {
  const next = resize(split(), 0, [0.7, 0.3]);
  assert.ok(next.sizes[0]! > next.sizes[1]!);
  assert.equal(next.sizes.length, 2);
});

test("resize clamps below the minimum share", () => {
  const next = resize(split(), 0, [0.99, 0.01]);
  const total = next.sizes.reduce((sum, size) => sum + size, 0);
  assert.ok(next.sizes[1]! / total >= MIN_FRACTION - 1e-9, "the squeezed group keeps its minimum");
});

test("groupOf compares by value and reports an absent tab", () => {
  const layout = split();
  assert.equal(groupOf(layout, file("README.md")), 1);
  assert.equal(groupOf(layout, MAIN), -1);
});

test("allTabs walks every group in order", () => {
  assert.deepEqual(allTabs(split()), [CHAT, README]);
});

// --- repair ---------------------------------------------------------------------------------------

test("normalize(null) is a single chat group", () => {
  const next = normalize(null);
  // group ids are generated, so compare everything except them
  assert.equal(next.groups.length, 1);
  assert.deepEqual(next.groups[0]!.tabs, [CHAT]);
  assert.equal(next.groups[0]!.active, 0);
  assert.deepEqual(next.sizes, [1]);
});

test("normalize reinserts a missing chat tab", () => {
  const next = normalize({
    axis: "horizontal",
    groups: [{ id: "g1", tabs: [README], active: 0 }],
    sizes: [1],
  });
  assert.equal(allTabs(next).filter((tab) => tab.kind === "chat").length, 1);
  assert.equal(groupOf(next, README), 0);
});

test("normalize keeps exactly one chat tab when handed two", () => {
  const next = normalize({
    axis: "horizontal",
    groups: [
      { id: "g1", tabs: [CHAT], active: 0 },
      { id: "g2", tabs: [CHAT, README], active: 0 },
    ],
    sizes: [1, 1],
  });
  assert.equal(allTabs(next).filter((tab) => tab.kind === "chat").length, 1);
});

test("normalize caps at three groups and re-fits sizes", () => {
  const next = normalize({
    axis: "horizontal",
    groups: [
      { id: "a", tabs: [CHAT], active: 0 },
      { id: "b", tabs: [README], active: 0 },
      { id: "c", tabs: [MAIN], active: 0 },
      { id: "d", tabs: [NOTES], active: 0 },
    ],
    sizes: [1, 1, 1, 1],
  });
  assert.equal(next.groups.length, 3);
  assert.equal(next.sizes.length, 3);
});

test("normalize drops an emptied group", () => {
  const next = normalize({
    axis: "horizontal",
    groups: [
      { id: "a", tabs: [CHAT], active: 0 },
      { id: "b", tabs: [], active: 0 },
    ],
    sizes: [1, 1],
  });
  assert.equal(next.groups.length, 1);
  assert.equal(next.sizes.length, 1);
});

test("normalize re-fits sizes of the wrong length to equal shares", () => {
  const next = normalize({ ...split(), sizes: [1] });
  assert.equal(next.sizes.length, 2);
  assert.equal(next.sizes[0], next.sizes[1]);
});

test("normalize raises a size below the minimum", () => {
  const next = normalize({ ...split(), sizes: [100, 0.001] });
  const total = next.sizes.reduce((sum, size) => sum + size, 0);
  assert.ok(next.sizes[1]! / total >= MIN_FRACTION - 1e-9);
});

test("normalize clamps an out-of-range active index", () => {
  const layout = split();
  const next = normalize({
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, active: 9 })),
  });
  for (const group of next.groups) {
    assert.ok(group.active >= 0 && group.active < group.tabs.length);
  }
});

// the regression guard for the gitignore case: normalize has no file list and must never
// invent one, or a gitignored file that is legitimately open would be closed behind the user
test("normalize keeps a file tab it knows nothing about", () => {
  const next = normalize(openTab(singleGroup(), file("ignored/secret.txt"), 0));
  assert.equal(groupOf(next, file("ignored/secret.txt")), 0);
});

// --- grid tracks ----------------------------------------------------------------------------------

test("trackTemplate interleaves sashes between groups", () => {
  assert.equal(trackTemplate([1, 1], "horizontal"), "1fr 1px 1fr");
  assert.equal(trackTemplate([1], "horizontal"), "1fr");
});

// the template and trackOf have to agree, or a view lands under a sash
test("the vertical template gives every group its own strip track", () => {
  assert.equal(trackTemplate([1, 1], "vertical"), "auto 1fr 1px auto 1fr");
  const tracks = trackTemplate([1, 1], "vertical").split(" ").length;
  assert.equal(tracks, 5);
  assert.equal(trackOf(1, "vertical", "view"), tracks);
});

test("every track a group claims exists in its own axis template", () => {
  for (const axis of ["horizontal", "vertical"] as const) {
    for (const count of [1, 2, 3]) {
      const sizes = new Array<number>(count).fill(1);
      const tracks = trackTemplate(sizes, axis).split(" ").length;
      for (let group = 0; group < count; group += 1) {
        for (const part of ["strip", "view"] as const) {
          const track = trackOf(group, axis, part);
          assert.ok(
            track >= 1 && track <= tracks,
            `${axis} group ${group} ${part} wants track ${track} of ${tracks}`,
          );
        }
      }
    }
  }
});

test("horizontal groups occupy odd columns, both parts in the same one", () => {
  assert.equal(trackOf(0, "horizontal", "strip"), 1);
  assert.equal(trackOf(0, "horizontal", "view"), 1);
  assert.equal(trackOf(1, "horizontal", "strip"), 3);
  assert.equal(trackOf(2, "horizontal", "view"), 5);
});

test("vertical groups take a strip row and a view row each", () => {
  assert.equal(trackOf(0, "vertical", "strip"), 1);
  assert.equal(trackOf(0, "vertical", "view"), 2);
  assert.equal(trackOf(1, "vertical", "strip"), 4);
  assert.equal(trackOf(1, "vertical", "view"), 5);
});

// --- drop geometry --------------------------------------------------------------------------------

const R = { width: 1000, height: 1000 };
const FREE = { split: true, axis: null };

test("the middle of a group is a merge, not a split", () => {
  assert.equal(dropTargetAt(R, 500, 500, FREE), "center");
});

test("each edge band resolves to its own half", () => {
  assert.equal(dropTargetAt(R, 20, 500, FREE), "left");
  assert.equal(dropTargetAt(R, 980, 500, FREE), "right");
  assert.equal(dropTargetAt(R, 500, 20, FREE), "up");
  assert.equal(dropTargetAt(R, 500, 980, FREE), "down");
});

test("splitting off gives a merge everywhere", () => {
  assert.equal(dropTargetAt(R, 20, 500, { split: false, axis: null }), "center");
  assert.equal(dropTargetAt(R, 500, 20, { split: false, axis: "horizontal" }), "center");
});

test("a locked axis suppresses the cross-axis zones only", () => {
  assert.equal(dropTargetAt(R, 500, 20, { split: true, axis: "horizontal" }), "center");
  assert.equal(dropTargetAt(R, 500, 980, { split: true, axis: "horizontal" }), "center");
  assert.equal(dropTargetAt(R, 20, 500, { split: true, axis: "horizontal" }), "left");
  assert.equal(dropTargetAt(R, 20, 500, { split: true, axis: "vertical" }), "center");
  assert.equal(dropTargetAt(R, 500, 20, { split: true, axis: "vertical" }), "up");
});
