// Shape tests for the editor layout guard. parseLayout is the only thing standing between a
// hand-rolled PATCH body and the client, so every rejection rule gets a case here.
import assert from "node:assert/strict";
import test from "node:test";

import { parseLayout } from "./layout.ts";

const chat = { kind: "chat" };
const file = (path: string) => ({ kind: "file", path });

const twoGroups = {
  axis: "horizontal",
  groups: [
    { id: "g1", tabs: [chat], active: 0 },
    { id: "g2", tabs: [file("README.md")], active: 0 },
  ],
  sizes: [1, 1],
};

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(twoGroups));
const groupsOf = (layout: Record<string, unknown>) => layout.groups as Array<Record<string, unknown>>;

test("a valid layout round-trips unchanged", () => {
  assert.deepEqual(parseLayout(clone()), twoGroups);
});

test("accepts a json string as well as an object", () => {
  assert.deepEqual(parseLayout(JSON.stringify(twoGroups)), twoGroups);
});

test("accepts a single group holding several tabs", () => {
  const one = {
    axis: "vertical",
    groups: [{ id: "g1", tabs: [chat, file("a.ts"), file("b.ts")], active: 2 }],
    sizes: [1],
  };
  assert.deepEqual(parseLayout(one), one);
});

test("a file literally named chat is a file, not the transcript", () => {
  const collide = {
    axis: "horizontal",
    groups: [{ id: "g1", tabs: [chat, file("chat")], active: 1 }],
    sizes: [1],
  };
  const parsed = parseLayout(collide);
  assert.deepEqual(parsed, collide);
  assert.equal(parsed?.groups[0]?.tabs.filter((tab) => tab.kind === "chat").length, 1);
});

test("rejects more than three groups", () => {
  const four = clone();
  four.groups = [
    { id: "a", tabs: [chat], active: 0 },
    { id: "b", tabs: [file("one.ts")], active: 0 },
    { id: "c", tabs: [file("two.ts")], active: 0 },
    { id: "d", tabs: [file("three.ts")], active: 0 },
  ];
  four.sizes = [1, 1, 1, 1];
  assert.equal(parseLayout(four), null);
});

test("rejects zero groups", () => {
  assert.equal(parseLayout({ axis: "horizontal", groups: [], sizes: [] }), null);
});

test("rejects an unknown axis", () => {
  const bad = clone();
  bad.axis = "sideways";
  assert.equal(parseLayout(bad), null);
});

test("rejects the same file in two groups", () => {
  const bad = clone();
  bad.groups = [
    { id: "g1", tabs: [chat, file("README.md")], active: 0 },
    { id: "g2", tabs: [file("README.md")], active: 0 },
  ];
  assert.equal(parseLayout(bad), null);
});

test("rejects the same file twice in one group", () => {
  const bad = clone();
  groupsOf(bad)[1]!.tabs = [file("README.md"), file("README.md")];
  assert.equal(parseLayout(bad), null);
});

test("rejects a layout with no chat tab", () => {
  const bad = clone();
  bad.groups = [{ id: "g1", tabs: [file("README.md")], active: 0 }];
  bad.sizes = [1];
  assert.equal(parseLayout(bad), null);
});

test("rejects a layout with two chat tabs", () => {
  const bad = clone();
  groupsOf(bad)[1]!.tabs = [chat];
  assert.equal(parseLayout(bad), null);
});

test("rejects an active index out of range", () => {
  for (const active of [1, -1, 2, 1.5, "0", null]) {
    const bad = clone();
    groupsOf(bad)[1]!.active = active;
    assert.equal(parseLayout(bad), null, `active ${JSON.stringify(active)} should be rejected`);
  }
});

test("rejects an unknown tab kind and a malformed file tab", () => {
  for (const tab of [{ kind: "terminal" }, { kind: "file" }, { kind: "file", path: "" }, "README.md", null]) {
    const bad = clone();
    groupsOf(bad)[1]!.tabs = [tab];
    assert.equal(parseLayout(bad), null, `tab ${JSON.stringify(tab)} should be rejected`);
  }
});

test("rejects sizes of the wrong length", () => {
  const bad = clone();
  bad.sizes = [1];
  assert.equal(parseLayout(bad), null);
});

test("rejects a non-positive or non-finite size", () => {
  for (const sizes of [[1, 0], [1, -1], [1, Number.NaN], [1, Number.POSITIVE_INFINITY]]) {
    const bad = clone();
    bad.sizes = sizes;
    assert.equal(parseLayout(bad), null, `sizes ${JSON.stringify(sizes)} should be rejected`);
  }
});

test("rejects an empty tab list", () => {
  const bad = clone();
  groupsOf(bad)[1]!.tabs = [];
  assert.equal(parseLayout(bad), null);
});

test("rejects a blank group id", () => {
  const bad = clone();
  groupsOf(bad)[0]!.id = "";
  assert.equal(parseLayout(bad), null);
});

test("rejects malformed json and non-objects", () => {
  for (const value of ["{not json", null, undefined, 7, [], "chat"]) {
    assert.equal(parseLayout(value), null, `${JSON.stringify(value) ?? "undefined"} should be rejected`);
  }
});
