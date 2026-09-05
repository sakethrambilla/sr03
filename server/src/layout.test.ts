// Shape tests for the editor layout guard. parseLayout is the only thing standing between a
// hand-rolled PATCH body and the client, so every rejection rule gets a case here.
import assert from "node:assert/strict";
import test from "node:test";

import { parseLayout } from "./layout.ts";

const twoGroups = {
  axis: "horizontal",
  groups: [
    { id: "g1", tabs: ["chat"], active: "chat" },
    { id: "g2", tabs: ["README.md"], active: "README.md" },
  ],
  sizes: [1, 1],
};

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(twoGroups));

test("a valid layout round-trips unchanged", () => {
  assert.deepEqual(parseLayout(clone()), twoGroups);
});

test("accepts a json string as well as an object", () => {
  assert.deepEqual(parseLayout(JSON.stringify(twoGroups)), twoGroups);
});

test("accepts a single group and a null active tab", () => {
  const one = { axis: "vertical", groups: [{ id: "g1", tabs: ["chat"], active: null }], sizes: [1] };
  assert.deepEqual(parseLayout(one), one);
});

test("rejects more than three groups", () => {
  const four = clone();
  four.groups = [
    { id: "a", tabs: ["chat"], active: "chat" },
    { id: "b", tabs: ["one.ts"], active: "one.ts" },
    { id: "c", tabs: ["two.ts"], active: "two.ts" },
    { id: "d", tabs: ["three.ts"], active: "three.ts" },
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

test("rejects a tab listed in two groups", () => {
  const bad = clone();
  bad.groups = [
    { id: "g1", tabs: ["chat", "README.md"], active: "chat" },
    { id: "g2", tabs: ["README.md"], active: "README.md" },
  ];
  assert.equal(parseLayout(bad), null);
});

test("rejects a layout with no chat tab", () => {
  const bad = clone();
  bad.groups = [{ id: "g1", tabs: ["README.md"], active: "README.md" }];
  bad.sizes = [1];
  assert.equal(parseLayout(bad), null);
});

test("rejects a layout with two chat tabs", () => {
  const bad = clone();
  bad.groups = [
    { id: "g1", tabs: ["chat"], active: "chat" },
    { id: "g2", tabs: ["chat"], active: "chat" },
  ];
  assert.equal(parseLayout(bad), null);
});

test("rejects an active tab that is not in its own group", () => {
  const bad = clone();
  (bad.groups as Array<Record<string, unknown>>)[1]!.active = "chat";
  assert.equal(parseLayout(bad), null);
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
  (bad.groups as Array<Record<string, unknown>>)[1]!.tabs = [];
  (bad.groups as Array<Record<string, unknown>>)[1]!.active = null;
  assert.equal(parseLayout(bad), null);
});

test("rejects a blank group id and a blank tab", () => {
  const blankId = clone();
  (blankId.groups as Array<Record<string, unknown>>)[0]!.id = "";
  assert.equal(parseLayout(blankId), null);

  const blankTab = clone();
  (blankTab.groups as Array<Record<string, unknown>>)[1]!.tabs = [""];
  (blankTab.groups as Array<Record<string, unknown>>)[1]!.active = null;
  assert.equal(parseLayout(blankTab), null);
});

test("rejects malformed json and non-objects", () => {
  for (const value of ["{not json", null, undefined, 7, [], "chat"]) {
    assert.equal(parseLayout(value), null, `${JSON.stringify(value) ?? "undefined"} should be rejected`);
  }
});
