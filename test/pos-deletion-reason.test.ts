// Phase 2 (Desktop 1.0.31): mandatory reason for a persisted dine-in removal/reduction.
//
// The server (pos_edit_order_line) REQUIRES a non-empty reason when an edit removes
// or reduces persisted quantity/components, and stores it as snapshot text in the
// activity log. The desktop prompts for that reason up front and sends it on the
// SAME edit RPC. These tests cover the client catalogue/validator, the drop-detection
// that mirrors the server predicate, the error classification, and the UI wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  EDIT_REASON_OTHER,
  EDIT_REASON_PRESETS,
  MIN_EDIT_REASON_LENGTH,
  modifierChangeRemovesComponents,
  resolveEditReason,
} from "@/lib/pos/editReason";
import { classifyError } from "@/lib/pos/errors";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

// --- A. the preset catalogue matches the locked product decision ---

test("A the reason presets are exactly the approved list, plus Other", () => {
  assert.deepEqual(
    [...EDIT_REASON_PRESETS],
    [
      "Customer changed their mind",
      "Wrong item / entered by mistake",
      "Item out of stock",
      "Kitchen or preparation error",
      "Duplicate entry",
    ],
  );
  assert.equal(EDIT_REASON_OTHER, "Other");
});

// --- B. resolveEditReason ---

test("B a chosen preset resolves to itself with no error", () => {
  const r = resolveEditReason({ preset: "Item out of stock", otherText: "" });
  assert.deepEqual(r, { reason: "Item out of stock", error: null });
});

test("C Other with empty text is an error, never a silent blank reason", () => {
  const r = resolveEditReason({ preset: EDIT_REASON_OTHER, otherText: "   " });
  assert.equal(r.reason, null);
  assert.ok(r.error);
});

test("D Other with too-short text is refused", () => {
  const r = resolveEditReason({ preset: EDIT_REASON_OTHER, otherText: "x".repeat(MIN_EDIT_REASON_LENGTH - 1) });
  assert.equal(r.reason, null);
  assert.ok(r.error);
});

test("E Other with real text resolves to the trimmed text", () => {
  const r = resolveEditReason({ preset: EDIT_REASON_OTHER, otherText: "  spilled in transit  " });
  assert.deepEqual(r, { reason: "spilled in transit", error: null });
});

test("F nothing chosen is an error", () => {
  const r = resolveEditReason({ preset: null, otherText: "" });
  assert.equal(r.reason, null);
  assert.ok(r.error);
});

// --- G. drop-detection mirrors the server predicate EXACTLY ---

const mk = (g: string, o: string, q = 1) => ({ group_id: g, option_id: o, quantity: q });

test("G1 removing a component is a drop", () => {
  assert.equal(modifierChangeRemovesComponents([mk("g1", "o1"), mk("g1", "o2")], [mk("g1", "o1")]), true);
});
test("G2 adding a component only is NOT a drop", () => {
  assert.equal(modifierChangeRemovesComponents([mk("g1", "o1")], [mk("g1", "o1"), mk("g1", "o2")]), false);
});
test("G3 replacing a component is a drop", () => {
  assert.equal(modifierChangeRemovesComponents([mk("g1", "o1")], [mk("g1", "o2")]), true);
});
test("G4 an identical set is NOT a drop", () => {
  assert.equal(modifierChangeRemovesComponents([mk("g1", "o1", 2)], [mk("g1", "o1", 2)]), false);
});
test("G5 reducing a component's quantity is a drop", () => {
  assert.equal(modifierChangeRemovesComponents([mk("g1", "o1", 2)], [mk("g1", "o1", 1)]), true);
});

// --- H. error classification for the two server refusals ---

test("H1 the REASON_REQUIRED server message classifies as reason_required", () => {
  const c = classifyError(new Error("A reason is required to remove or reduce an item on this order."));
  assert.equal(c.kind, "reason_required");
  assert.ok(c.hint);
});
test("H2 the VERSION_CONFLICT server message classifies as version_conflict", () => {
  const c = classifyError(new Error("This order changed since it was loaded. Reload and retry."));
  assert.equal(c.kind, "version_conflict");
  assert.ok(c.hint);
});

// --- I. the edit payload carries the reason (server reads p_payload->>'reason') ---

test("I buildSetQuantity / buildChangeModifiers expose a reason field", () => {
  const code = stripJsxComments(read("lib", "pos", "orders.ts"));
  assert.match(code, /reason\?: string \| null/);
  assert.match(code, /reason: input\.reason \?\? null/);
});

// --- J. the dine-in UI prompts on removal/reduction/drop, not on increases ---

test("J DineInWorkspace gates removals/reductions/drops through the reason dialog", () => {
  const code = stripJsxComments(read("screens", "pos", "DineInWorkspace.tsx"));
  // The reason dialog is imported and rendered.
  assert.match(code, /from "@\/components\/pos\/EditReasonDialog"/);
  assert.match(code, /<EditReasonDialog/);
  // A full removal always prompts.
  assert.match(code, /onRemoveSentLine[\s\S]{0,120}setReasonPrompt\(\{ kind: "quantity", line, newQuantity: 0 \}\)/);
  // A reduction prompts; an increase applies directly (no prompt).
  assert.match(code, /if \(next < line\.quantity\) setReasonPrompt/);
  assert.match(code, /else void editSentLine\(line, next\)/);
  // A modifier change that drops a component prompts; otherwise it commits.
  assert.match(code, /modifierChangeRemovesComponents\(line\.modifiers, result\.modifiers\)/);
});

// --- K. the dialog is built from the shared catalogue ---

test("K EditReasonDialog renders the shared catalogue and an Audited note", () => {
  const code = stripJsxComments(read("components", "pos", "EditReasonDialog.tsx"));
  assert.match(code, /EDIT_REASON_PRESETS/);
  assert.match(code, /EDIT_REASON_OTHER/);
  assert.match(code, /resolveEditReason/);
  assert.match(code, /Audited/);
});
