// Floor DESIGNER foundation (Phase 3A, updated for the 3B edits model) — the
// rules the editor must never break.
//
// No DOM, no network: pure functions over the draft document and the geometry of
// an edit. The invariants pinned here are the ones a later phase, a refactor, or a
// careless "small fix" could silently violate — chiefly that a save NEVER loses
// part of the document it did not edit, that every edit stays in intrinsic LOGICAL
// units, and that a server refusal maps to the right editor state.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyDrag,
  applyResize,
  applyRotate,
  applySize,
  classifyFloorDesignerError,
  draftHasContent,
  emptyDraftEdits,
  geomOf,
  MIN_ELEMENT_LOGICAL,
  normalizeRotation,
  parseDraftDoc,
  parseUnplaced,
  serializeDraftDoc,
  snapRotation,
  type ElementGeom,
} from "@/lib/pos/floorDesigner";

// --- parse -------------------------------------------------------------------

function doc(elements: unknown[], sections: unknown[] = [{ id: "s1", name: "Main" }]) {
  return { v: "1", sections, elements };
}

test("parseDraftDoc renders real tables and structures, and drops orphans", () => {
  const d = parseDraftDoc(
    doc([
      { id: "a", type: "table", section_id: "s1", x: 10, y: 10, w: 40, h: 40, table_id: "T1" },
      { id: "w", type: "wall", section_id: "s1", x: 0, y: 0, w: 200, h: 4 },
      // orphan: references a section that does not exist → dropped from render.
      { id: "z", type: "table", section_id: "ghost", x: 0, y: 0, w: 40, h: 40, table_id: "T9" },
    ]),
  );
  const ids = d.elements.map((e) => e.id).sort();
  assert.deepEqual(ids, ["a", "w"]);
  assert.equal(d.sections.length, 1);
});

test("the DESIGNER renders staged new-table intents the service reader refuses", () => {
  const d = parseDraftDoc(
    doc([
      { id: "a", type: "table", section_id: "s1", x: 10, y: 10, w: 40, h: 40, table_id: "T1", rename_to: "VIP 9" },
      { id: "s", type: "table", section_id: "s1", x: 0, y: 0, w: 40, h: 40, temp_id: "temp:abc", new_name: "New 1", seats: 4 },
    ]),
  );
  assert.equal(d.elements.length, 2, "the staged table renders in the editor");
  assert.equal(d.rawElements.length, 2, "both raw elements are retained");
  const staged = d.elements.find((e) => e.id === "s")!;
  assert.equal(staged.tempId, "temp:abc");
  assert.equal(staged.newName, "New 1");
  assert.equal(staged.seats, 4);
  assert.equal(staged.tableId, null);
  const real = d.elements.find((e) => e.id === "a")!;
  assert.equal(real.renameTo, "VIP 9", "a staged rename is visible to the editor");
});

// --- serialize (the lossless guarantee) --------------------------------------

test("serializeDraftDoc applies edits ONLY to edited elements and preserves the rest verbatim", () => {
  const d = parseDraftDoc(
    doc([
      { id: "a", type: "table", section_id: "s1", x: 10, y: 10, w: 40, h: 40, table_id: "T1", seats: 4, extra: "keep" },
      { id: "s", type: "table", section_id: "s1", x: 0, y: 0, w: 40, h: 40, temp_id: "temp:tmp", new_name: "New" },
    ]),
  );
  const edits = emptyDraftEdits();
  edits.geom.set("a", { x: 111, y: 222, w: 50, h: 60, rotation: 90 });
  const out = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[]; v: string };

  const a = out.elements.find((e) => e.id === "a")!;
  assert.deepEqual([a.x, a.y, a.w, a.h, a.rotation], [111, 222, 50, 60, 90], "edited geometry is written");
  assert.equal(a.seats, 4, "unrelated fields on an edited element survive");
  assert.equal(a.extra, "keep", "an unknown field on an edited element survives");

  const s = out.elements.find((e) => e.id === "s")!;
  assert.equal(s.temp_id, "temp:tmp", "a staged intent is never dropped by a round-trip");
  assert.equal(s.new_name, "New");
  assert.equal(out.v, "1", "the document version is preserved");
});

test("draftHasContent is true only when there is a renderable element", () => {
  assert.equal(draftHasContent(null), false);
  assert.equal(draftHasContent(parseDraftDoc(doc([]))), false);
  assert.equal(
    draftHasContent(parseDraftDoc(doc([{ id: "a", type: "table", section_id: "s1", x: 0, y: 0, w: 40, h: 40, table_id: "T1" }]))),
    true,
  );
});

// --- geometry of an edit (intrinsic logical units) ---------------------------

const G = (o: Partial<ElementGeom> = {}): ElementGeom => ({ x: 100, y: 100, w: 80, h: 60, rotation: 0, ...o });

test("applyDrag converts a SCREEN delta to logical units by the view scale", () => {
  assert.deepEqual(applyDrag(G(), 50, 20, 1), { x: 150, y: 120, w: 80, h: 60, rotation: 0 });
  // At 2x zoom the same 50px on screen is 25 logical units.
  assert.deepEqual(applyDrag(G(), 50, 20, 2), { x: 125, y: 110, w: 80, h: 60, rotation: 0 });
});

test("applyResize keeps the OPPOSITE corner fixed for every handle", () => {
  const se = applyResize(G(), "se", 20, 10, 1);
  assert.deepEqual([se.x, se.y, se.w, se.h], [100, 100, 100, 70], "SE grows; NW anchor fixed");

  const nw = applyResize(G(), "nw", 20, 10, 1);
  // NW moved in; the SE corner (180,160) must not move.
  assert.equal(nw.x + nw.w, 180);
  assert.equal(nw.y + nw.h, 160);
});

test("applyResize clamps to the minimum size without moving the anchor", () => {
  const r = applyResize(G(), "se", -1000, -1000, 1);
  assert.equal(r.w, MIN_ELEMENT_LOGICAL);
  assert.equal(r.h, MIN_ELEMENT_LOGICAL);
  assert.equal(r.x, 100, "NW anchor stays put under clamp");
  assert.equal(r.y, 100);
});

test("applySize clamps explicit dimensions to the same rails", () => {
  assert.deepEqual(applySize(G(), 10, 999999).w, MIN_ELEMENT_LOGICAL);
  assert.equal(applySize(G(), 10, 999999).h, 20000);
  assert.equal(applySize(G(), 120, 90).w, 120);
});

test("rotation normalizes to 0–359 and snaps to a clean angle", () => {
  assert.equal(normalizeRotation(370), 10);
  assert.equal(normalizeRotation(-30), 330);
  assert.equal(normalizeRotation(360), 0);
  assert.equal(snapRotation(20), 15);
  assert.equal(snapRotation(8), 15);
  assert.equal(snapRotation(7), 0);
  assert.equal(applyRotate(G(), 200).rotation, 195);
  assert.equal(applyRotate(G(), 200, false).rotation, 200);
});

test("geomOf reads exactly the five mutable fields", () => {
  assert.deepEqual(geomOf({ id: "a", sectionId: "s1", type: "table", x: 1, y: 2, w: 3, h: 4, rotation: 5, shape: "sq", tableId: "T", label: null }), {
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    rotation: 5,
  });
});

// --- server error mapping ----------------------------------------------------

test("classifyFloorDesignerError maps each server refusal to the right state", () => {
  const cases: [string, string, boolean][] = [
    ["FLOOR_EDITOR_BUSY: x", "busy", true],
    ["FLOOR_STALE_REVISION: x", "stale", true],
    ["FLOOR_PERMISSION_DENIED: x", "permission", true],
    ["FLOOR_PUBLISH_PERMISSION_DENIED: x", "permission", true],
    ["FLOOR_ENTITLEMENT_DISABLED", "entitlement", true],
    ["FLOOR_MALFORMED_DOC: x", "invalid", false],
    ["", "network", false],
    ["something odd", "unknown", false],
  ];
  for (const [msg, kind, readOnly] of cases) {
    const r = classifyFloorDesignerError(new Error(msg));
    assert.equal(r.kind, kind, `${msg} → ${kind}`);
    assert.equal(r.readOnly, readOnly, `${msg} readOnly=${readOnly}`);
  }
});

// --- unplaced ----------------------------------------------------------------

test("parseUnplaced accepts id or table_id and ignores malformed rows", () => {
  const out = parseUnplaced([
    { id: "T1", name: "One", seats: 4 },
    { table_id: "T2", name: "Two" },
    { name: "no id" },
    "garbage",
  ]);
  assert.deepEqual(
    out.map((u) => u.id),
    ["T1", "T2"],
  );
  assert.equal(out[0].seats, 4);
  assert.equal(out[1].seats, null);
});
