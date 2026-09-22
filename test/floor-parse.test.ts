// The floor_service_layout reader.
//
// A published document is trusted to be well-formed (the server validated it at
// publish), but the reader is defensive so a document from a NEWER authoring
// build can never break an older desktop: an unknown element type is dropped, an
// unknown table shape is kept (and rendered as a safe rectangle), a table with no
// canonical id is dropped, a non-positive/non-finite geometry is dropped, and an
// element pointing at a section the doc doesn't define is dropped.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_FLOOR_LAYOUT,
  elementsForSection,
  parseFloorElement,
  parseFloorLayout,
  placedTableIds,
  sortSections,
} from "@/lib/pos/floor";

const el = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  section_id: "s1",
  type: "table",
  x: 10,
  y: 20,
  w: 60,
  h: 60,
  shape: "round",
  table_id: "t1",
  ...over,
});

const published = (over: Record<string, unknown> = {}) => ({
  has_published: true,
  revision_id: "rev1",
  revision_no: 3,
  published_at: "2026-09-13T00:00:00Z",
  doc: {
    v: "1",
    sections: [
      { id: "s2", name: "Terrace", sort: 2, w: 800, h: 600 },
      { id: "s1", name: "Main", sort: 1 },
    ],
    elements: [
      el(),
      { id: "e2", section_id: "s1", type: "wall", x: 0, y: 0, w: 200, h: 5 },
      { id: "e3", section_id: "s2", type: "table", x: 5, y: 5, w: 80, h: 50, shape: "rect", table_id: "t2", rotation: 90, label: "A" },
    ],
  },
  ...over,
});

test("a well-formed published document parses with sections in authored order", () => {
  const layout = parseFloorLayout(published());
  assert.equal(layout.hasPublished, true);
  assert.equal(layout.revisionNo, 3);
  assert.equal(layout.revisionId, "rev1");
  assert.equal(layout.sections.length, 2);
  // sort ascending: Main (1) before Terrace (2)
  assert.deepEqual(layout.sections.map((s) => s.id), ["s1", "s2"]);
  assert.equal(layout.elements.length, 3);
  assert.equal(layout.sections[1].w, 800);
});

test("has_published:false yields the empty layout, never a broken canvas", () => {
  const layout = parseFloorLayout({ has_published: false });
  assert.equal(layout.hasPublished, false);
  assert.equal(layout.sections.length, 0);
  assert.equal(layout.elements.length, 0);
  assert.deepEqual(layout, EMPTY_FLOOR_LAYOUT);
});

test("a missing doc is treated as no published floor", () => {
  assert.equal(parseFloorLayout({ has_published: true }).sections.length, 0);
  assert.equal(parseFloorLayout({}).hasPublished, false);
  assert.equal(parseFloorLayout(null).hasPublished, false);
});

test("an unknown element type is dropped", () => {
  assert.equal(parseFloorElement(el({ id: "x", type: "sofa" })), null);
});

test("a table with no canonical id is dropped (nothing to select or join)", () => {
  assert.equal(parseFloorElement(el({ table_id: null })), null);
  assert.equal(parseFloorElement(el({ table_id: "" })), null);
});

test("an unknown/future table shape is KEPT with shape=null (renders as a safe rectangle)", () => {
  const parsed = parseFloorElement(el({ shape: "hexagon" }));
  assert.notEqual(parsed, null);
  assert.equal(parsed!.shape, null);
  assert.equal(parsed!.tableId, "t1");
});

test("non-positive or non-finite geometry is dropped", () => {
  assert.equal(parseFloorElement(el({ w: 0 })), null);
  assert.equal(parseFloorElement(el({ h: -5 })), null);
  assert.equal(parseFloorElement(el({ x: "NaN" })), null);
  assert.equal(parseFloorElement(el({ y: null })), null);
});

test("rotation is normalised into [0,360)", () => {
  assert.equal(parseFloorElement(el({ rotation: 450 }))!.rotation, 90);
  assert.equal(parseFloorElement(el({ rotation: -90 }))!.rotation, 270);
  assert.equal(parseFloorElement(el({ rotation: undefined }))!.rotation, 0);
});

test("an element referencing an undefined section is dropped", () => {
  const layout = parseFloorLayout(
    published({
      doc: {
        v: "1",
        sections: [{ id: "s1", name: "Main" }],
        elements: [el(), { id: "e9", section_id: "ghost", type: "table", x: 1, y: 1, w: 40, h: 40, table_id: "t9" }],
      },
    }),
  );
  assert.equal(layout.elements.length, 1);
  assert.equal(layout.elements[0].id, "e1");
});

test("placedTableIds and elementsForSection reflect the parsed doc", () => {
  const layout = parseFloorLayout(published());
  assert.deepEqual([...placedTableIds(layout)].sort(), ["t1", "t2"]);
  assert.equal(elementsForSection(layout, "s1").length, 2);
  assert.equal(elementsForSection(layout, "s2").length, 1);
});

test("sortSections orders by sort, then name, then id", () => {
  const sorted = sortSections([
    { id: "b", name: "Zeta", sort: null, w: null, h: null },
    { id: "a", name: "Alpha", sort: null, w: null, h: null },
    { id: "c", name: "First", sort: 1, w: null, h: null },
  ]);
  assert.deepEqual(sorted.map((s) => s.id), ["c", "a", "b"]);
});
