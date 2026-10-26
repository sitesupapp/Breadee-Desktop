// Desktop 1.0.38 (Bug 4) — merged-source history. pos_merge_tables_v3 voids a CLEAN source with merge
// provenance (merged_into_order_id / merged_into_merge_id), re-parents its items to the primary (ids kept)
// and records them in pos_table_merges.sources[].items[]. The reads must say "Merged into #X" / "No balance —
// moved to #X" (never Voided / Unpaid), keep merged sources out of void totals, read the source's items from
// the merge record, and navigate to the destination. A REAL void still shows Voided. Reads only.

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import {
  isMergedSource,
  orderLifecycleLabel,
  orderLifecycleTone,
  orderStatusKey,
  parseOrderRow,
  resolveMergeTargets,
  type ShiftOpenOrder,
} from "@/lib/pos/shiftOrderSummary";
import { canEditOrder, canSettleOrder, paymentLabel, paymentTone, reversalActionFor } from "@/lib/pos/orderActions";
import { reversalTotals } from "@/lib/pos/shiftReport";
import { mergedSourceItemRefs, readMergedSourceLines, readOrderDisplayLines, type MergedLinesIo } from "@/lib/pos/deliverySettlement";
import { useShiftOrders } from "@/state/shiftOrders";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(resolve(here, "..", p), "utf8");

// Staging evidence (tranche 2 §1.1/§1.2): 0003 (78c9824d) merged into 0004 (c02aba79), merge dbd234a4.
const SOURCE_ID = "78c9824d-0000-4000-8000-000000000003";
const PRIMARY_ID = "c02aba79-0000-4000-8000-000000000004";
const MERGE_ID = "dbd234a4-c268-4ef8-a2d2-ab24a15a39c6";
const ITEM_ID = "bb12f8f5-0000-4000-8000-0000000000aa";

function order(over: Partial<ShiftOpenOrder> = {}): ShiftOpenOrder {
  return {
    id: "o", order_number: "261026-0001", order_type: "dine_in", status: "completed", payment_status: "paid", payment_method: "cash",
    subtotal: 1, discount_amount: 0, total_amount: 1, currency: "LBP", table_id: "T", customer_id: null, customer_name: null,
    customer_phone: null, cashier_user_id: "u1", staff_name: null, notes: null, created_at: "2026-10-26T15:40:00Z", ...over,
  };
}
const merged = () =>
  order({
    id: SOURCE_ID, order_number: "261026-0003", status: "voided", payment_status: "unpaid", payment_method: null,
    total_amount: 3_390_000, subtotal: 3_390_000, notes: "[merged into 261026-0004]",
    merged_into_order_id: PRIMARY_ID, merged_into_merge_id: MERGE_ID, merged_into_order_number: "261026-0004",
  });
const primary = () => order({ id: PRIMARY_ID, order_number: "261026-0004", total_amount: 4_070_000 });
const realVoid = () => order({ id: "v", order_number: "261026-0009", status: "voided", payment_status: "unpaid", payment_method: null, total_amount: 500 });

const MERGE_ROW = {
  id: MERGE_ID,
  primary_order_id: PRIMARY_ID,
  sources: [
    { mode: "clean_folded", source_order_id: SOURCE_ID, source_order_number: "261026-0003", folded_batch_no: 2, pre_merge_version: 0, items: [{ order_item_id: ITEM_ID, original_batch_no: 1, line_total: 3_390_000 }] },
    { mode: "clean_folded", source_order_id: "someone-else", items: [{ order_item_id: "not-ours", original_batch_no: 1, line_total: 9 }] },
  ],
};

function io(over: Partial<MergedLinesIo> = {}): MergedLinesIo & { reads: string[][] } {
  const reads: string[][] = [];
  return {
    reads,
    readMerge: async (id) => (id === MERGE_ID ? MERGE_ROW : null),
    readItems: async (ids) => { reads.push(ids); return ids.includes(ITEM_ID) ? [{ id: ITEM_ID, name_snapshot: "BREADED SHRIMP KG", quantity: 1, line_total: 3_390_000, kitchen_note: null }] : []; },
    readModifiers: async () => [{ order_item_id: ITEM_ID, name_snapshot: "Lemon", price_delta: 0, quantity: 1 }],
    ...over,
  };
}

// ================================================================ K — merged ≠ voided

test("K a merged clean source reads 'Merged into #X' / 'No balance — moved to #X', never Voided / Unpaid", () => {
  const o = merged();
  assert.equal(isMergedSource(o), true);
  assert.equal(orderLifecycleLabel(o), "Merged into #261026-0004");
  assert.equal(orderLifecycleTone(o), "slate");
  assert.equal(paymentLabel(o), "No balance — moved to #261026-0004");
  assert.equal(paymentTone(o), "slate");
  assert.equal(orderStatusKey(o), "merged", "the Orders filter files it under Merged, not Voided");
  // nothing can be done to it (terminal), and no settle / reversal is offered
  assert.equal(reversalActionFor(o), null);
  assert.equal(canSettleOrder(o), false);
  assert.equal(canEditOrder(o), false);
  // the destination number falls back to a short id — never a wrong number
  assert.equal(orderLifecycleLabel({ ...o, merged_into_order_number: null }), `Merged into #${PRIMARY_ID.slice(0, 8)}`);
});

test("K2 merged sources are excluded from void totals (as pos_end_shift_core counts voids)", () => {
  const t = reversalTotals([merged(), primary(), realVoid()]);
  assert.equal(t.voided, 1, "only the real void");
  assert.equal(t.amount, 500, "the merged bill's amount lives on the primary — not a reversal");
});

test("K3 the list reads carry the provenance (both queries) and parse it; the destination number resolves", async () => {
  const s = src("src/lib/pos/shiftOrderSummary.ts");
  assert.match(s, /merged_into_order_id, merged_into_merge_id/);
  assert.equal((s.match(/\.select\(ORDER_COLUMNS\)/g) ?? []).length, 2, "loadShiftOrders AND loadOrdersForDay");
  const row = parseOrderRow({ id: SOURCE_ID, order_number: "261026-0003", order_type: "dine_in", status: "voided", payment_status: "unpaid", merged_into_order_id: PRIMARY_ID, merged_into_merge_id: MERGE_ID });
  assert.equal(row?.merged_into_order_id, PRIMARY_ID);
  assert.equal(row?.merged_into_merge_id, MERGE_ID);
  // same page → from the page; otherwise one read
  const page = [{ ...merged(), merged_into_order_number: null }, primary()];
  await resolveMergeTargets(page, async () => { throw new Error("must not read: the primary is on the page"); });
  assert.equal(page[0].merged_into_order_number, "261026-0004");
  const alone = [{ ...merged(), merged_into_order_number: null }];
  await resolveMergeTargets(alone, async (ids) => ids.map((id) => ({ id, order_number: "261026-0004" })));
  assert.equal(alone[0].merged_into_order_number, "261026-0004");
  const failing = [{ ...merged(), merged_into_order_number: null }];
  await resolveMergeTargets(failing, async () => { throw new Error("offline"); });
  assert.equal(failing[0].merged_into_order_number, null, "unresolved stays null (short-id label), never a guess");
});

// ================================================================ L — source items readable

test("L the source's items are read from the merge record by item id (wherever they now live), with their round", async () => {
  assert.deepEqual(mergedSourceItemRefs(MERGE_ROW, SOURCE_ID), [{ order_item_id: ITEM_ID, original_batch_no: 1, line_total: 3_390_000 }]);
  assert.deepEqual(mergedSourceItemRefs(MERGE_ROW, "unknown"), []);
  assert.deepEqual(mergedSourceItemRefs({ sources: "garbage" }, SOURCE_ID), []);
  const fake = io();
  const lines = await readMergedSourceLines(merged(), fake);
  assert.deepEqual(fake.reads, [[ITEM_ID]], "only THIS source's item ids — never another source's");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, "BREADED SHRIMP KG");
  assert.equal(lines[0].lineTotal, 3_390_000);
  assert.equal(lines[0].qty, 1);
  assert.deepEqual(lines[0].modifiers, [{ name: "Lemon", price_delta: 0, quantity: 1 }]);
  assert.equal(lines[0].note, "moved to #261026-0004 (round 1)");
  // the display reader routes a merged source through the record
  const viaDisplay = await readOrderDisplayLines(merged(), io());
  assert.equal(viaDisplay[0].name, "BREADED SHRIMP KG");
  // the panel uses it for the lines and for a reprint; the plain path stays for every other order
  const panel = src("src/components/pos/CurrentOrderPanel.tsx");
  assert.match(panel, /readOrderDisplayLines\(\{ id, status, merged_into_order_id, merged_into_merge_id, merged_into_order_number \}\)/);
  assert.match(panel, /isMergedSource\(order\) \? await readOrderDisplayLines\(order\) : await readOrderReceiptLines\(order\.id\)/);
  assert.match(panel, /Moved to #\$\{mergedTargetLabel\(order\)\}/);
});

// ================================================================ M — destination navigation

test("M destination navigation: the Orders row and the order panel both select the primary", () => {
  useShiftOrders.setState({ orders: [merged(), primary()], index: 0, shiftId: "S" });
  useShiftOrders.getState().select(merged().merged_into_order_id as string);
  assert.equal(useShiftOrders.getState().orders[useShiftOrders.getState().index].id, PRIMARY_ID);
  const modal = src("src/components/pos/OrdersModal.tsx");
  assert.match(modal, /props\.onSelectOrder\(o\.merged_into_order_id as string\)/);
  assert.match(modal, /\{ key: "merged", label: "Merged" \}/);
  assert.match(modal, /orderStatusKey\(o\) === status/);
  const panel = src("src/components/pos/CurrentOrderPanel.tsx");
  assert.match(panel, /props\.onOpenOrder\?\.\(order\.merged_into_order_id as string\)/);
  const ws = src("src/screens/pos/PosWorkspace.tsx");
  assert.equal((ws.match(/onOpenOrder=\{showSavedOrder\}/g) ?? []).length, 2, "both panel mounts navigate");
});

// ================================================================ N — a true void is still Voided

test("N a REAL void (no provenance) still shows Voided / unpaid and counts as a void", async () => {
  const v = realVoid();
  assert.equal(isMergedSource(v), false);
  assert.equal(orderLifecycleLabel(v), "Voided");
  assert.equal(orderLifecycleTone(v), "red");
  assert.equal(paymentLabel(v), "unpaid");
  assert.equal(orderStatusKey(v), "voided");
  assert.equal(reversalTotals([v]).voided, 1);
  // a part-paid source the merge COMPLETED keeps its own paid lifecycle (provenance present, not "moved")
  const partPaid = order({ status: "completed", payment_status: "paid", merged_into_order_id: PRIMARY_ID, merged_into_merge_id: MERGE_ID });
  assert.equal(isMergedSource(partPaid), false);
  assert.equal(orderLifecycleLabel(partPaid), "Paid");
  assert.equal(paymentLabel(partPaid), "paid · cash");
  // a real void never consults a merge record (it has none): its display path is the plain item read
  assert.match(src("src/lib/pos/deliverySettlement.ts"), /if \(isMergedSource\(order\) && order\.merged_into_merge_id\) \{/);
});
