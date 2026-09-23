// Phase 3D-B — STRUCTURE / OBJECT catalog + the structure label edit. These pin
// the two contract-critical properties: the palette offers EXACTLY the element
// types the server accepts (and nothing it does not — a "bar" is a table shape,
// not a structure), and a structure is a DRAFT layout object with no table
// identity (no temp_id, table_id, seats or shape). The label edit round-trips
// losslessly and clears cleanly.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultStructureGeom,
  isRotatable,
  isStructureType,
  makeStructureElement,
  structureLabel,
  structureSpec,
  STRUCTURE_CATALOG,
  STRUCTURE_GROUPS,
  STRUCTURE_LABEL_MAX,
  STRUCTURE_TYPE_SET,
  type StructureType,
} from "@/lib/pos/floorObjects";
import { emptyDraftEdits, parseDraftDoc, serializeDraftDoc } from "@/lib/pos/floorDesigner";
import { STRUCTURE_TYPES } from "@/lib/pos/floor";

// The element types the CURRENT server contract (`_floor_validate_doc`) allows,
// minus `table`. Recertified 2026-09-21.
const SERVER_STRUCTURE_TYPES = [
  "wall", "divider", "door", "window", "counter", "kitchen", "host", "entrance", "stairs", "wc", "text", "plant",
];

test("the catalog offers EXACTLY the server-allowed structure types — no more, no less", () => {
  const catalog = STRUCTURE_CATALOG.map((s) => s.type).sort();
  assert.deepEqual(catalog, [...SERVER_STRUCTURE_TYPES].sort(), "catalog matches the server allow-list");
  // And it matches the client reader's own structure list.
  assert.deepEqual(catalog, [...STRUCTURE_TYPES].sort(), "catalog matches floor.ts STRUCTURE_TYPES");
});

test("“bar” is a table SHAPE, never a structure type", () => {
  assert.ok(!STRUCTURE_TYPE_SET.has("bar" as StructureType), "no bar structure");
  assert.equal(isStructureType("bar"), false);
  assert.equal(structureSpec("bar"), null);
});

test("isStructureType accepts every catalog type and rejects table / junk", () => {
  for (const t of SERVER_STRUCTURE_TYPES) assert.equal(isStructureType(t), true, `${t} is a structure`);
  assert.equal(isStructureType("table"), false);
  assert.equal(isStructureType("nonsense"), false);
});

test("every spec has a friendly label, a group and a positive default footprint", () => {
  for (const s of STRUCTURE_CATALOG) {
    assert.ok(s.label && s.label !== s.type, `${s.type} has a friendly label`);
    assert.ok(["building", "service", "decor"].includes(s.group));
    assert.ok(s.w > 0 && s.h > 0 && s.w <= 20000 && s.h <= 20000, `${s.type} default within contract`);
  }
  // Groups cover the whole catalog with no duplicates.
  const grouped = STRUCTURE_GROUPS.flatMap((g) => g.items.map((i) => i.type)).sort();
  assert.deepEqual(grouped, STRUCTURE_CATALOG.map((s) => s.type).sort());
});

test("defaults are deterministic (same type → same geometry at the same anchor)", () => {
  assert.deepEqual(defaultStructureGeom("wall", 10, 20), defaultStructureGeom("wall", 10, 20));
  const g = defaultStructureGeom("counter", 5, 7);
  assert.deepEqual(g, { x: 5, y: 7, w: 170, h: 40, rotation: 0 });
});

test("a plant is the one non-rotatable object; everything else rotates", () => {
  assert.equal(isRotatable("plant"), false);
  for (const s of STRUCTURE_CATALOG) {
    if (s.type !== "plant") assert.equal(isRotatable(s.type), true, `${s.type} rotates`);
  }
});

test("structureLabel is friendly, and falls back gracefully for an unknown type", () => {
  assert.equal(structureLabel("wc"), "WC");
  assert.equal(structureLabel("host"), "Host stand");
  assert.equal(structureLabel("mystery"), "Mystery");
});

test("makeStructureElement is a DRAFT layout object — an e- id, no table identity", () => {
  const rec = makeStructureElement("counter", "s1", { x: 10, y: 20, w: 170, h: 40, rotation: 0 }, "Bar");
  assert.match(String(rec.id), /^e-/, "ordinary draft element id, not temp:");
  assert.equal(rec.type, "counter");
  assert.equal(rec.section_id, "s1");
  assert.equal(rec.label, "Bar");
  // A structure carries NONE of the table-only fields.
  for (const forbidden of ["temp_id", "table_id", "new_name", "seats", "shape", "rename_to"]) {
    assert.equal(forbidden in rec, false, `structure must not carry ${forbidden}`);
  }
});

test("makeStructureElement omits an empty label and caps a long one", () => {
  const bare = makeStructureElement("wall", "s1", { x: 0, y: 0, w: 300, h: 8, rotation: 0 }, null);
  assert.equal("label" in bare, false, "no empty label field");
  const long = makeStructureElement("text", "s1", { x: 0, y: 0, w: 160, h: 28, rotation: 0 }, "z".repeat(300));
  assert.ok(String(long.label).length <= STRUCTURE_LABEL_MAX, "label capped to the server max");
});

test("the structure label edit round-trips through the serializer and clears cleanly", () => {
  const draft = parseDraftDoc({
    v: "1",
    sections: [{ id: "s1", name: "Main", sort: 1 }],
    elements: [{ id: "w1", type: "wall", section_id: "s1", x: 0, y: 0, w: 300, h: 8, custom: "keep" }],
  });
  const edits = emptyDraftEdits();
  edits.labels.set("w1", "North wall");
  let out = serializeDraftDoc(draft, edits) as { elements: Record<string, unknown>[] };
  const w = out.elements.find((e) => e.id === "w1")!;
  assert.equal(w.label, "North wall", "label applied");
  assert.equal(w.custom, "keep", "unrelated fields preserved (lossless)");

  edits.labels.set("w1", "");
  out = serializeDraftDoc(draft, edits) as { elements: Record<string, unknown>[] };
  assert.equal("label" in out.elements.find((e) => e.id === "w1")!, false, "an empty label leaves no stray field");
});
