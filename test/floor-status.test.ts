// Joining a floor PLACEMENT to a table's OPERATIONAL state. The placement is only
// geometry; free/active/elapsed all come from `pos_table_map`, joined by id. A
// placement whose table left the map renders as a neutral, non-interactive tile.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFloorNode, indexTables, shapeLabel, shapeRadiusFraction } from "@/lib/pos/floorStatus";
import { parseTableMap } from "@/lib/pos/tables";
import type { FloorElement } from "@/lib/pos/floor";
import type { TableSummary } from "@/types/tables";

const el = (over: Partial<FloorElement> = {}): FloorElement => ({
  id: "e1", sectionId: "s1", type: "table", x: 0, y: 0, w: 60, h: 60,
  rotation: 0, shape: "round", tableId: "t1", label: null, ...over,
});

const tables = (rows: Record<string, unknown>[]): TableSummary[] =>
  parseTableMap({ tables: rows }).tables;

const NOW = Date.parse("2026-09-13T02:00:00Z");

test("a free table maps to the available state with its seats", () => {
  const idx = indexTables(tables([{ id: "t1", name: "Table 5", seats: 4, status: "available" }]));
  const node = buildFloorNode(el(), idx, NOW);
  assert.equal(node.missing, false);
  assert.equal(node.state, "available");
  assert.equal(node.name, "Table 5");
  assert.equal(node.seats, 4);
  assert.equal(node.elapsedLabel, null);
});

test("an open-bill table maps to active_bill with an elapsed label", () => {
  const idx = indexTables(
    tables([
      { id: "t1", name: "Terrace", seats: 2, status: "occupied", occupied: true, orders: 1, order_number: "A-14", opened_at: "2026-09-13T00:30:00Z" },
    ]),
  );
  const node = buildFloorNode(el(), idx, NOW);
  assert.equal(node.state, "active_bill");
  assert.equal(node.orders, 1);
  assert.equal(node.elapsedLabel, "1h 30m");
  // The node never carries the bill total — the panel is the detail surface.
  assert.equal(node.total, null);
});

test("a placement whose table left the map is missing and non-interactive", () => {
  const idx = indexTables(tables([{ id: "other", name: "X" }]));
  const node = buildFloorNode(el({ tableId: "gone", label: "VIP 2" }), idx, NOW);
  assert.equal(node.missing, true);
  assert.equal(node.state, "unknown");
  assert.equal(node.name, "VIP 2");
});

test("shapeRadiusFraction: round/oval are fully round, unknown falls back to a rounded rect", () => {
  assert.equal(shapeRadiusFraction("round"), 0.5);
  assert.equal(shapeRadiusFraction("oval"), 0.5);
  assert.equal(shapeRadiusFraction(null), 0.12);
  assert.ok(shapeRadiusFraction("sq") > 0 && shapeRadiusFraction("sq") < 0.5);
});

test("shapeLabel is safe for an unknown shape", () => {
  assert.equal(shapeLabel("round"), "round");
  assert.equal(shapeLabel(null), "table");
});
