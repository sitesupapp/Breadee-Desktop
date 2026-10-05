// Part 2 — the item reduction/cancellation RECORD receipt.
//
// A terminal-local, default-OFF switch prints a short record slip to the RECEIPT
// printer when a cashier reduces or cancels an already-sent Dine-In item. These
// pin: the switch (default OFF, per-field round-trip), the builder (cancellation
// vs reduction, removed quantity and value, reason as the line note, a fixed
// render that draws NO totals or payment), the once-per-committed-edit key, and
// the wiring that fires it ONLY on a reduction and never near the cook ticket.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { POS_FEATURE_DEFAULTS, parsePosFeatures, writePosFeatures } from "@/lib/pos/posFeatures";
import { reductionEventKey } from "@/lib/pos/autoPrint";
import {
  buildReductionReceipt,
  REDUCTION_RECEIPT_SECTIONS,
} from "@/lib/pos/reductionReceipt";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

const baseInput = {
  businessName: "Franks",
  branchName: "Main",
  staffName: "Sam",
  orderNumber: "260911-0007",
  tableName: "Table 5",
  currency: "USD" as const,
  at: "2026-10-04 14:30",
  itemName: "Cheeseburger",
  unitPrice: 5,
};

test("the switch is OFF by default and round-trips per field", () => {
  assert.equal(POS_FEATURE_DEFAULTS.printReductionReceipt, false);
  const store = memoryStorage();
  writePosFeatures({ ...POS_FEATURE_DEFAULTS, printReductionReceipt: true }, store);
  assert.equal(parsePosFeatures(store.getItem("breadee.desktop.posFeatures")).printReductionReceipt, true);
  // A blob written by an older build (no such key) still resolves to the default.
  assert.equal(parsePosFeatures(JSON.stringify({ ingredientCustomization: true })).printReductionReceipt, false);
});

test("a cancellation (to zero) removes the whole line at its value", () => {
  const { receipt } = buildReductionReceipt({ ...baseInput, previousQuantity: 3, newQuantity: 0, reason: "comped" });
  assert.equal(receipt.orderType, "Item cancelled");
  assert.equal(receipt.lines.length, 1);
  assert.equal(receipt.lines[0].qty, 3);
  assert.equal(receipt.lines[0].lineTotal, 15);
  assert.match(receipt.lines[0].note ?? "", /From 3 to 0/);
  assert.match(receipt.lines[0].note ?? "", /Reason: comped/);
  assert.equal(receipt.tableName, "Table 5");
});

test("a partial reduction removes only the delta at its value", () => {
  const { receipt } = buildReductionReceipt({ ...baseInput, previousQuantity: 5, newQuantity: 2, reason: "wrong item" });
  assert.equal(receipt.orderType, "Item reduced");
  assert.equal(receipt.lines[0].qty, 3);
  assert.equal(receipt.lines[0].lineTotal, 15);
  assert.match(receipt.lines[0].note ?? "", /From 5 to 2 · Reason: wrong item/);
});

test("a missing reason shows the quantity change alone, never a fabricated reason", () => {
  const { receipt } = buildReductionReceipt({ ...baseInput, previousQuantity: 2, newQuantity: 1, reason: null });
  assert.match(receipt.lines[0].note ?? "", /From 2 to 1/);
  assert.doesNotMatch(receipt.lines[0].note ?? "", /Reason:/);
});

test("the slip draws a header and the line only — never totals or a payment line", () => {
  const { render } = buildReductionReceipt({ ...baseInput, previousQuantity: 2, newQuantity: 0, reason: "x" });
  assert.ok(render.sections, "the slip pins an explicit section list, not the tenant design");
  const s = render.sections as string[];
  for (const shown of ["business_name", "branch_name", "order_type", "order_number", "table_info", "staff", "items"]) {
    assert.ok(s.includes(shown), `${shown} must be drawn`);
  }
  for (const hidden of ["total", "discount", "payment_method"]) {
    assert.ok(!s.includes(hidden), `${hidden} must NOT be drawn on a reduction record`);
  }
  assert.deepEqual(render.sections, REDUCTION_RECEIPT_SECTIONS);
});

test("the slip routes to the receipt printer, not the kitchen", () => {
  const { receipt } = buildReductionReceipt({ ...baseInput, previousQuantity: 2, newQuantity: 0, reason: "x" });
  assert.equal(receipt.orderSource, "dine_in"); // resolves the 'receipt' route for dine-in
  // Never presented as a sale: no cash default can apply (paid=false, method=null).
  assert.equal(receipt.paid, false);
  assert.equal(receipt.method, null);
});

test("the event key is stable per committed edit and distinct across versions", () => {
  const a = reductionEventKey({ orderId: "o1", targetItemId: "l1", posEntityVersion: 7 });
  const again = reductionEventKey({ orderId: "o1", targetItemId: "l1", posEntityVersion: 7 });
  const next = reductionEventKey({ orderId: "o1", targetItemId: "l1", posEntityVersion: 8 });
  assert.equal(a, again, "the same committed edit keys identically — printed at most once");
  assert.notEqual(a, next, "a new edit (new version) keys differently and prints its own slip");
});

test("the switch is surfaced in POS Settings, per terminal", () => {
  const src = read("src/screens/settings/PosSettings.tsx");
  assert.match(src, /checked=\{features\.printReductionReceipt\}/);
  assert.match(src, /setFeature\("printReductionReceipt", next\)/);
});

test("it fires ONLY on a reduction and is never coupled to the kitchen ticket", () => {
  const src = read("src/screens/pos/DineInWorkspace.tsx");
  // Gated on a genuine reduction, and routed through the record-receipt path.
  assert.match(src, /if \(newQuantity < line\.quantity\) \{/);
  assert.match(src, /autoPrintReductionReceipt\(/);
  // The reduction path must not reach into kitchen printing.
  assert.equal(src.includes("autoPrintKitchenTicket"), false, "a reduction slip must never touch the cook ticket");
});
