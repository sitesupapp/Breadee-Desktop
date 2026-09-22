// Floor PREVIEW + publish-summary model (Phase 4) — pure, no DOM, no network.
//
// Preview projects the DRAFT into the SERVICE renderer's inputs. The invariants:
// a staged new table previews under its new name; an existing table previews under
// its staged rename (else its canonical name); structures pass through; and every
// previewed table is a NEUTRAL, available tile — a draft has no bill to show. The
// publish summary counts exactly what will happen, from the draft alone.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPreviewModel, previewTableName, summarizePendingPublish } from "@/lib/pos/floorPreview";
import type { DesignerElement, TableMeta } from "@/lib/pos/floorDesigner";

function tableEl(over: Partial<DesignerElement>): DesignerElement {
  return {
    id: "e1",
    sectionId: "s1",
    type: "table",
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rotation: 0,
    shape: "sq",
    tableId: null,
    label: null,
    tempId: null,
    newName: null,
    seats: null,
    renameTo: null,
    ...over,
  };
}

function structureEl(over: Partial<DesignerElement>): DesignerElement {
  return { ...tableEl({ type: "wall", shape: null, ...over }) };
}

const meta = (entries: [string, string, number | null][]): Map<string, TableMeta> => {
  const m = new Map<string, TableMeta>();
  for (const [id, name, seats] of entries) m.set(id, { id, name, seats });
  return m;
};

test("previewTableName resolves new name, staged rename, then canonical", () => {
  const m = meta([["T1", "Table 5", 4]]);
  assert.equal(previewTableName(tableEl({ tempId: "temp:x", newName: "New 9" }), m), "New 9");
  assert.equal(previewTableName(tableEl({ tableId: "T1", renameTo: "VIP 2" }), m), "VIP 2");
  assert.equal(previewTableName(tableEl({ tableId: "T1" }), m), "Table 5");
  // Unknown/legacy table with no meta and no rename falls back to its own label.
  assert.equal(previewTableName(tableEl({ tableId: "T9", label: "Old" }), m), "Old");
});

test("buildPreviewModel keys a staged new table to its element id with an available tile", () => {
  const m = meta([]);
  const { elements, tables } = buildPreviewModel(
    [tableEl({ id: "eNew", tempId: "temp:x", newName: "New 9", seats: 6 })],
    m,
  );
  assert.equal(elements.length, 1);
  // A staged table has no canonical id — its render id is the element id.
  assert.equal(elements[0].tableId, "eNew");
  assert.equal(tables.length, 1);
  assert.equal(tables[0].id, "eNew");
  assert.equal(tables[0].name, "New 9");
  assert.equal(tables[0].seats, 6);
  // Neutral / available — a draft has NOTHING operational to show.
  assert.equal(tables[0].status, "available");
  assert.equal(tables[0].occupied, false);
  assert.equal(tables[0].opened_at, null);
  assert.equal(tables[0].orders, 0);
  assert.equal(tables[0].total, null);
});

test("buildPreviewModel keeps an existing table's canonical id and staged rename", () => {
  const m = meta([["T1", "Table 5", 4]]);
  const { elements, tables } = buildPreviewModel([tableEl({ id: "e1", tableId: "T1", renameTo: "VIP 2" })], m);
  assert.equal(elements[0].tableId, "T1");
  assert.equal(tables[0].id, "T1");
  assert.equal(tables[0].name, "VIP 2");
});

test("buildPreviewModel passes structures through and never lists them as tables", () => {
  const m = meta([]);
  const { elements, tables } = buildPreviewModel(
    [structureEl({ id: "w1", type: "wall", label: null }), structureEl({ id: "t1", type: "text", label: "Patio" })],
    m,
  );
  assert.equal(elements.length, 2);
  assert.equal(elements.every((e) => e.tableId === null), true, "structures carry no table id");
  assert.equal(elements.find((e) => e.id === "t1")?.label, "Patio");
  assert.equal(tables.length, 0, "no structure becomes a table tile");
});

test("summarizePendingPublish counts new tables, renames and structures from the draft", () => {
  const m = meta([["T1", "Table 5", 4]]);
  const summary = summarizePendingPublish({
    elements: [
      tableEl({ id: "eNew", tempId: "temp:x", newName: "New 9" }),
      tableEl({ id: "e1", tableId: "T1", renameTo: "VIP 2" }),
      tableEl({ id: "e2", tableId: "T2" }), // unchanged existing table
      structureEl({ id: "w1", type: "wall" }),
      structureEl({ id: "c1", type: "counter" }),
    ],
    meta: m,
    unplacedNames: ["Terrace 1"],
    overlaps: 2,
    tight: 3,
  });
  assert.deepEqual(summary.newTables, ["New 9"]);
  assert.deepEqual(summary.renames, [{ from: "Table 5", to: "VIP 2" }]);
  assert.equal(summary.structureCount, 2);
  assert.deepEqual(summary.unplacedNames, ["Terrace 1"]);
  assert.equal(summary.overlaps, 2);
  assert.equal(summary.tight, 3);
});
