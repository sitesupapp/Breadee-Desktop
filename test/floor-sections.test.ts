// Section navigation logic: active resolution and the tabs/overflow split,
// including the rule that the active section is always a visible tab.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveActiveSection, splitSections } from "@/lib/pos/floorSections";
import type { FloorSection } from "@/lib/pos/floor";

const s = (id: string, sort: number): FloorSection => ({ id, name: id.toUpperCase(), sort, w: null, h: null });
const many = [s("a", 1), s("b", 2), s("c", 3), s("d", 4), s("e", 5), s("f", 6)];

test("resolveActiveSection falls back to the first section", () => {
  assert.equal(resolveActiveSection(many, null), "a");
  assert.equal(resolveActiveSection(many, "c"), "c");
  assert.equal(resolveActiveSection(many, "ghost"), "a"); // removed by a republish
  assert.equal(resolveActiveSection([], "x"), null);
});

test("everything fits → no overflow", () => {
  const split = splitSections(many, 10, "a");
  assert.equal(split.visible.length, 6);
  assert.equal(split.overflow.length, 0);
});

test("overflow reserves a slot for More", () => {
  const split = splitSections(many, 4, "a"); // 3 tabs + More
  assert.equal(split.visible.length, 3);
  assert.equal(split.overflow.length, 3);
  assert.deepEqual(split.visible.map((x) => x.id), ["a", "b", "c"]);
});

test("the active section is pulled into the visible tabs when it would overflow", () => {
  const split = splitSections(many, 4, "f"); // f would be in overflow
  assert.ok(split.visible.some((x) => x.id === "f"));
  assert.equal(split.visible.length, 3);
  // The displaced tab moves into overflow; counts stay stable.
  assert.equal(split.visible.length + split.overflow.length, many.length);
});

test("a single section needs no split", () => {
  const split = splitSections([s("only", 1)], 1, "only");
  assert.deepEqual(split.visible.map((x) => x.id), ["only"]);
  assert.equal(split.overflow.length, 0);
});
