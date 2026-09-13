// Floor search: by table name or open order number, across sections, deduped.

import { test } from "node:test";
import assert from "node:assert/strict";

import { searchFloor, sectionOfTable } from "@/lib/pos/floorSearch";
import { parseFloorLayout } from "@/lib/pos/floor";
import { parseTableMap } from "@/lib/pos/tables";

const layout = parseFloorLayout({
  has_published: true,
  doc: {
    v: "1",
    sections: [{ id: "s1", name: "Main" }, { id: "s2", name: "Terrace" }],
    elements: [
      { id: "e1", section_id: "s1", type: "table", x: 0, y: 0, w: 60, h: 60, table_id: "t1" },
      { id: "e2", section_id: "s2", type: "table", x: 0, y: 0, w: 60, h: 60, table_id: "t2" },
      { id: "e3", section_id: "s1", type: "wall", x: 0, y: 0, w: 100, h: 4 },
    ],
  },
});

const tables = parseTableMap({
  tables: [
    { id: "t1", name: "Table 5", status: "available" },
    { id: "t2", name: "Terrace 1", status: "occupied", occupied: true, orders: 1, order_number: "A-42" },
  ],
}).tables;

test("a blank query returns no matches", () => {
  assert.equal(searchFloor(layout, tables, "").length, 0);
  assert.equal(searchFloor(layout, tables, "   ").length, 0);
});

test("matches by table name, carrying the section for navigation", () => {
  const m = searchFloor(layout, tables, "table 5");
  assert.equal(m.length, 1);
  assert.equal(m[0].tableId, "t1");
  assert.equal(m[0].sectionId, "s1");
});

test("matches by open order number", () => {
  const m = searchFloor(layout, tables, "a-42");
  assert.equal(m.length, 1);
  assert.equal(m[0].tableId, "t2");
  assert.equal(m[0].sectionId, "s2");
});

test("a cross-section query still resolves the right section", () => {
  const m = searchFloor(layout, tables, "terrace");
  assert.equal(m.length, 1);
  assert.equal(m[0].sectionId, "s2");
});

test("no match yields an empty list", () => {
  assert.equal(searchFloor(layout, tables, "nope").length, 0);
});

test("sectionOfTable finds a placed table's section", () => {
  assert.equal(sectionOfTable(layout, "t2"), "s2");
  assert.equal(sectionOfTable(layout, "missing"), null);
});
