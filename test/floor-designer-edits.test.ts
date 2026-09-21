// Floor DESIGNER Phase 3B — the EDITS model: staged renames, placements,
// removals, staged new-table intents, sections and shapes, all applied through
// ONE serializer onto ONE draft. These pin the server contract recertified from
// `_floor_validate_doc` / `_floor_apply_create` (temp identity regex, name and
// seats limits) and the lossless guarantee: an edit touches exactly what the
// operator changed and nothing else, and NOTHING canonical happens before a
// future Publish — a rename stays `rename_to`, a new table stays `temp:*`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  effectiveDraft,
  emptyDraftEdits,
  makePlacedElement,
  makeSection,
  makeTempTableElement,
  newTempId,
  parseDraftDoc,
  SEATS_MAX,
  SEATS_MIN,
  SECTION_NAME_MAX,
  serializeDraftDoc,
  TABLE_NAME_MAX,
  validateSeats,
  validateSectionName,
  validateTableName,
} from "@/lib/pos/floorDesigner";

/** The server's own temp identity rule, verbatim from `_floor_validate_doc`. */
const SERVER_TEMP_RE = /^temp:[0-9a-zA-Z_-]{1,64}$/;

function baseDraft() {
  return parseDraftDoc({
    v: "1",
    sections: [
      { id: "s1", name: "Main", sort: 1, custom: "keep-me" },
      { id: "s2", name: "Terrace", sort: 2 },
    ],
    elements: [
      { id: "a", type: "table", section_id: "s1", x: 10, y: 10, w: 40, h: 40, table_id: "T1", extra: "keep" },
      { id: "b", type: "table", section_id: "s2", x: 60, y: 10, w: 40, h: 40, table_id: "T2" },
      { id: "w", type: "wall", section_id: "s1", x: 0, y: 0, w: 200, h: 4 },
    ],
  });
}

// --- staged rename -----------------------------------------------------------

test("a rename is STAGED as rename_to — and typing the old name back clears it", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  edits.renames.set("a", "VIP 9");
  let out = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[] };
  const a = out.elements.find((e) => e.id === "a")!;
  assert.equal(a.rename_to, "VIP 9", "the rename is a draft field, not a canonical write");
  assert.equal(a.table_id, "T1", "the canonical identity is untouched");
  assert.equal(a.extra, "keep", "unrelated fields survive");

  // Clearing: the staged rename is REMOVED, not stored as an empty string.
  edits.renames.set("a", null);
  out = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[] };
  assert.ok(!("rename_to" in out.elements.find((e) => e.id === "a")!), "a cleared rename leaves no residue");
});

test("the editor RENDERS the staged rename while the doc keeps the canonical id", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  edits.renames.set("a", "VIP 9");
  const eff = effectiveDraft(d, edits);
  const a = eff.elements.find((e) => e.id === "a")!;
  assert.equal(a.renameTo, "VIP 9");
  assert.equal(a.tableId, "T1");
});

// --- staged NEW table --------------------------------------------------------

test("a new table is a temp intent matching the server's identity rule — never a canonical row", () => {
  for (let i = 0; i < 25; i++) assert.match(newTempId(), SERVER_TEMP_RE);

  const rec = makeTempTableElement("Garden 5", 6, "s1", { x: 1, y: 2, w: 100, h: 100, rotation: 0 });
  assert.match(String(rec.temp_id), SERVER_TEMP_RE);
  assert.equal(rec.new_name, "Garden 5");
  assert.equal(rec.seats, 6);
  assert.equal(rec.section_id, "s1");
  assert.ok(!("table_id" in rec), "exactly one of table_id/temp_id — a temp table has NO canonical id");
});

test("a staged new table serializes into the draft and renders with its name", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  const rec = makeTempTableElement("Garden 5", 6, "s1", { x: 1, y: 2, w: 100, h: 100, rotation: 0 });
  edits.added.push(rec);
  const out = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[] };
  assert.equal(out.elements.length, 4);
  const eff = effectiveDraft(d, edits);
  const staged = eff.elements.find((e) => e.tempId !== null)!;
  assert.equal(staged.newName, "Garden 5");
  assert.equal(staged.seats, 6);
});

// --- placing an existing table -----------------------------------------------

test("placing an existing table reuses the SAME canonical id in exactly one new element", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  edits.added.push(makePlacedElement("T3", "s1", { x: 5, y: 5, w: 100, h: 100, rotation: 0 }));
  const out = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[] };
  const placed = out.elements.filter((e) => e.table_id === "T3");
  assert.equal(placed.length, 1, "one element, same canonical table id");
  assert.ok(!("temp_id" in placed[0]), "placing an existing table stages NO creation intent");
});

// --- remove from floor -------------------------------------------------------

test("removing from the floor is layout-only: the element leaves the doc, the loaded draft is untouched", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  edits.removed.add("a");
  const out = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[] };
  assert.equal(out.elements.some((e) => e.id === "a"), false, "the placement is gone from the draft");
  assert.equal(d.rawElements.some((e) => e.id === "a"), true, "the LOADED draft is not mutated");
  // The canonical table returns to "unplaced" because no element references it
  // any more — nothing here deactivates, archives or deletes pos_tables.
  const eff = effectiveDraft(d, edits);
  assert.equal(eff.elements.some((e) => e.tableId === "T1"), false);
});

test("removing an element ADDED this session removes it too — removal wins over addition", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  const rec = makePlacedElement("T3", "s1", { x: 5, y: 5, w: 100, h: 100, rotation: 0 });
  edits.added.push(rec);
  edits.removed.add(String(rec.id));
  const out = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[] };
  assert.equal(out.elements.some((e) => e.table_id === "T3"), false);
});

// --- sections ----------------------------------------------------------------

test("section add / rename / delete are draft edits that preserve unknown section fields", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  edits.sectionAdds.push(makeSection("VIP", 3));
  edits.sectionRenames.set("s1", "Main Dining");
  edits.sectionRemoves.add("s2");
  const out = serializeDraftDoc(d, edits) as { sections: Record<string, unknown>[] };

  assert.equal(out.sections.length, 2, "s2 removed, VIP added");
  const s1 = out.sections.find((s) => s.id === "s1")!;
  assert.equal(s1.name, "Main Dining");
  assert.equal(s1.custom, "keep-me", "an unknown field on a renamed section survives");
  const vip = out.sections.find((s) => s.name === "VIP")!;
  assert.equal(vip.sort, 3);
  assert.equal(out.sections.some((s) => s.id === "s2"), false);
});

test("elements never silently move sections: a removed section's elements simply stop rendering (the store refuses non-empty deletes)", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  edits.sectionRemoves.add("s2"); // s2 holds element b — the STORE refuses this;
  const eff = effectiveDraft(d, edits); // the model itself never reassigns silently.
  assert.equal(eff.elements.some((e) => e.id === "b"), false, "no orphan is rendered");
  const raw = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[] };
  assert.equal(raw.elements.some((e) => e.id === "b"), true, "and nothing is silently deleted");
});

// --- shape -------------------------------------------------------------------

test("a shape change is a draft field edit that leaves everything else alone", () => {
  const d = baseDraft();
  const edits = emptyDraftEdits();
  edits.shapes.set("a", "round");
  const out = serializeDraftDoc(d, edits) as { elements: Record<string, unknown>[] };
  const a = out.elements.find((e) => e.id === "a")!;
  assert.equal(a.shape, "round");
  assert.equal(a.extra, "keep");
});

// --- validation mirrors the server -------------------------------------------

test("client validation mirrors the recertified server limits", () => {
  assert.equal(validateTableName("999"), null);
  assert.notEqual(validateTableName("   "), null);
  assert.notEqual(validateTableName("x".repeat(TABLE_NAME_MAX + 1)), null);
  assert.equal(validateSeats(SEATS_MIN), null);
  assert.equal(validateSeats(SEATS_MAX), null);
  assert.notEqual(validateSeats(0), null);
  assert.notEqual(validateSeats(51), null);
  assert.notEqual(validateSeats(2.5), null);
  assert.equal(validateSectionName("VIP"), null);
  assert.notEqual(validateSectionName(""), null);
  assert.notEqual(validateSectionName("x".repeat(SECTION_NAME_MAX + 1)), null);
});
