// First-floor NATIVE BOOTSTRAP (production-discovered gap) — the rules the fix
// must hold so a fresh branch can create its FIRST floor natively.
//
// A branch with `pos.floor_map` enabled and canonical Dine-In tables but NO
// draft and NO published revision used to dead-end the Designer in phase "empty"
// ("Publishing a first floor is coming in a later step"): no toolbar, no tray,
// no way to place tables or publish. The server already supported a first floor
// (autosave/publish accept `base_revision_id = null`; the validator needs >=1
// section). The blocker was purely client-side: the store never synthesised an
// editable initial draft. These tests pin the minimal fix — a one-section
// `makeInitialDraft()` that enters the ordinary ready path — and guard the
// existing (already-drafted) path against regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  emptyDraftEdits,
  makeInitialDraft,
  makePlacedElement,
  parseDraftDoc,
  serializeDraftDoc,
  type ElementGeom,
} from "@/lib/pos/floorDesigner";
import { stripComments } from "./source-helpers.ts";

// --- the bootstrap draft is a real, valid, minimal document ------------------

test("makeInitialDraft seeds EXACTLY one default section and no elements, at version 1", () => {
  const d = makeInitialDraft();
  assert.equal(d.version, "1", "the document version is 1");
  assert.equal(d.sections.length, 1, "exactly one default section — the smallest the validator accepts");
  assert.equal(d.elements.length, 0, "no elements: the operator places existing tables from the tray");
  assert.ok(typeof d.sections[0].id === "string" && d.sections[0].id.length > 0, "the default section has a real id");
});

test("the first-floor draft SERIALIZES to a document with >=1 section (the server-validator floor)", () => {
  // The server's autosave/publish validator refuses a zero-section document, so
  // EMPTY_DOC ({sections:[]}) would be rejected — makeInitialDraft() must not be.
  const doc = serializeDraftDoc(makeInitialDraft(), emptyDraftEdits()) as {
    v: string;
    sections: unknown[];
    elements: unknown[];
  };
  assert.equal(doc.v, "1");
  assert.ok(Array.isArray(doc.sections) && doc.sections.length === 1, "the saved document carries the section");
  assert.ok(Array.isArray(doc.elements) && doc.elements.length === 0, "and no elements until the operator places one");
});

test("placing an EXISTING table onto the first-floor draft keeps the section and adds one element", () => {
  const d = makeInitialDraft();
  const sectionId = d.sections[0].id;
  const geom: ElementGeom = { x: 120, y: 140, w: 100, h: 100, rotation: 0 };

  const edits = emptyDraftEdits();
  edits.added.push(makePlacedElement("T1", sectionId, geom));

  const out = serializeDraftDoc(d, edits);
  const reparsed = parseDraftDoc(out);
  assert.equal(reparsed.sections.length, 1, "the default section survives the first placement");
  assert.equal(reparsed.elements.length, 1, "the placed existing table renders");
  assert.equal(reparsed.elements[0].tableId, "T1", "it is the canonical table, by its own id (no temp intent)");
  assert.equal(reparsed.elements[0].tempId, null, "placing an existing table never stages a new-table intent");
});

// --- the store wiring, asserted against the source ---------------------------

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const ts = (rel: string) => stripComments(read(rel));

const STORE = "src/state/floorDesigner.ts";
const LIB = "src/lib/pos/floorDesigner.ts";
const SHELL = "src/components/pos/floor/designer/FloorDesigner.tsx";

test("enter() BOOTSTRAPS a first floor instead of dead-ending in phase:empty", () => {
  const store = ts(STORE);
  assert.ok(!store.includes('phase: "empty"'), "enter() no longer sets the dead 'empty' phase");
  assert.match(store, /load\.draft \?\? makeInitialDraft\(\)/, "the null-draft path synthesises an editable first-floor draft");
  assert.match(store, /\bmakeInitialDraft\b/, "the store imports/uses the bootstrap helper");
});

test("first-floor editing still ACQUIRES THE LEASE and echoes base=null through autosave", () => {
  const store = ts(STORE);
  // The resolved draft (real OR bootstrapped) takes the single editor lease
  // before any edit — first-floor editing is never lease-less.
  assert.match(store, /currentDraft = draft;[\s\S]{0,200}floorAcquireLease\(/, "the lease is acquired after the draft is resolved");
  // The CAS key every autosave/publish echoes is the published revision — null
  // for a first-time branch, which the server accepts.
  assert.match(store, /baseRevisionId: load\.publishedRevisionId/, "the base revision (null for a first floor) is carried");
  assert.match(store, /floorAutosaveDraft\(s\.ctx\.branchId, doc, s\.baseRevisionId\)/, "every autosave echoes the base revision");
});

test("the ALREADY-DRAFTED path is preserved — the ordinary ready lifecycle is intact", () => {
  const store = ts(STORE);
  assert.match(store, /phase: "ready"/, "the ready phase still drives editing");
  assert.match(store, /canPublish: load\.canPublish/, "the ready set is unchanged (publish gate carried)");
  // The single resolved-draft path serves BOTH an existing draft and a first
  // floor; a real draft is used verbatim (`load.draft ?? …` keeps it).
  assert.match(store, /const draft = load\.draft \?\? makeInitialDraft\(\)/, "an existing draft is used as-is; only a null draft is synthesised");
});

test("the LIB exposes the pure, minimal bootstrap helper the fix depends on", () => {
  const lib = ts(LIB);
  assert.match(lib, /export function makeInitialDraft\(\): ParsedDraft/, "makeInitialDraft is exported and typed");
  assert.match(lib, /parseDraftDoc\(\{ v: "1", sections: \[makeSection\(FIRST_FLOOR_SECTION_NAME, 0\)\], elements: \[\] \}\)/, "it reuses the canonical parser + section factory (no hand-rolled server JSON)");
});

test("the shell no longer shows the 'coming in a later step' first-floor dead-end", () => {
  const shellRaw = read(SHELL);
  assert.ok(!shellRaw.includes("coming in a later step"), "the placeholder copy is gone");
  assert.ok(!/d\.phase === "empty"/.test(shellRaw), "no dead empty-phase branch remains in the shell");
});
