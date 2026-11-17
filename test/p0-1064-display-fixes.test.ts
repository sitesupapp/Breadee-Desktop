// 1.0.64 — two display-only corrections after Staging 1.0.63:
//   S-1: after an offline split the Dine-In bill panel badge read the raw "unpaid" (Breadee keeps a part-paid order
//        unpaid until its final settle) → it now reads "Partially Paid" while money is collected.
//   S-2: a Dine-In bill held on this device reprinted "Paid" with no method → it now names the method(s) its OWN
//        captured settle (and split legs) recorded, and nothing when that evidence is missing. The method is a
//        separate display-only field; `payment_method` (read by a reversal's tender) stays null.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb } from "@/lib/offline/db";
import { openTableOffline, addDraftLine, sendRoundOffline, splitDineDraftOffline, settleTableOffline } from "@/lib/offline/dineinOffline";
import { getOperationalTableBill } from "@/lib/offline/operationalProjection";
import { offlineDisplayBill } from "@/lib/offline/displayBill";
import { billCollected, billStatusLabel } from "@/lib/pos/tableBill";
import { readOrdersHistoryLocal } from "@/lib/offline/ordersHistoryOffline";
import { settledMethodFrom } from "@/lib/offline/settledMethod";
import { paymentLabel } from "@/lib/pos/orderActions";
import type { OfflineOperation } from "@/lib/offline/operationLog";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

const DSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", shiftId: "sh1" };
const PSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" } as never;
const SHIFT_SCOPE = { kind: "shift" as const, tenantId: "t1", branchId: "b1", shiftId: "sh1" };
const ROW = { id: "TBL-1", name: "QA-01", seats: 2, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, merged_sources: [], pos_entity_version: 37, pos_entity_version_known: true } as never;

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(), localdb.posOfflineTxns.clear(), localdb.receipts.clear()]);
});

async function nativeCase() {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "QA-01", currency: "LBP", baseOrderVersion: 37, baseVersionKnown: true });
  const d = await addDraftLine(draft.local_session_id, { menu_item_id: "burger", name: "QA Test Burger", base_price: 98901, quantity: 2, modifiers: [], kitchen_note: null });
  const lineId = d.lines[d.lines.length - 1].line_id;
  await sendRoundOffline(draft.local_session_id);
  return { sid: draft.local_session_id, lineId };
}

const op = (type: string, method: unknown, at = "2026-11-18T10:00:00Z", deps: string[] = []): OfflineOperation =>
  ({ operation_id: `${type}-${String(method)}-${at}`, operation_type: type, created_at: at, dependency_ids: deps, payload: { method } }) as unknown as OfflineOperation;

// --- S-1 -------------------------------------------------------------------------------------------------------

test("S-1 label: unpaid + collected → Partially Paid; nothing collected / paid / refunded unchanged", () => {
  assert.equal(billStatusLabel("unpaid", 98901), "Partially Paid");
  assert.equal(billStatusLabel("partial", 10), "Partially Paid");
  assert.equal(billStatusLabel("unpaid", 0), "unpaid");
  assert.equal(billStatusLabel(null, 0), "unpaid");
  assert.equal(billStatusLabel("paid", 98901), "paid");
  assert.equal(billStatusLabel("refunded", 5), "refunded");
});

test("S-1 native case: after an offline split the panel input carries collected 98,901 → Partially Paid; figures unchanged", async () => {
  const { sid, lineId } = await nativeCase();
  const before = await getOperationalTableBill(PSCOPE, ROW);
  assert.equal(billStatusLabel(before.bill.orders[0].payment_status, billCollected(offlineDisplayBill(before))), "unpaid");
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: lineId, quantity: 1 }], method: "cash" });
  const p = await getOperationalTableBill(PSCOPE, ROW);
  const shown = offlineDisplayBill(p);
  assert.equal(billCollected(shown), 98901);
  assert.equal(billStatusLabel(shown.orders[0].payment_status, billCollected(shown)), "Partially Paid");
  assert.equal(p.outstanding, 98901, "Pay Full Bill amount unchanged");
  assert.equal(p.bill.orders[0].payment_status, "unpaid", "the projection's own status is not rewritten");
});

test("S-1 wiring: the panel badge renders billStatusLabel with the bill's collected amount", () => {
  const panel = src("src/components/pos/TableBillPanel.tsx");
  assert.match(panel, /billStatusLabel\(bill\.orders\[0\]\.payment_status, paidBySplit\)/);
  assert.doesNotMatch(panel, />\s*\{bill\.orders\[0\]\.payment_status\}\s*</);
});

// --- S-2 -------------------------------------------------------------------------------------------------------

test("S-2 pure: settle method, legs in capture order, de-duplicated; missing evidence → null (never invented)", () => {
  assert.equal(settledMethodFrom(op("pay_table", "cash"), []), "cash");
  assert.equal(settledMethodFrom(op("pay_table", "cash"), [op("split_settle", "card", "2026-11-18T09:00:00Z")]), "card + cash");
  assert.equal(settledMethodFrom(op("pay_table", "cash"), [op("split_settle", "cash"), undefined, op("dinein_send_round", null)]), "cash");
  assert.equal(settledMethodFrom(op("pay_table", ""), []), null);
  assert.equal(settledMethodFrom(op("pay_table", null), []), null);
  assert.equal(settledMethodFrom(op("pay_table", "cash"), [op("split_settle", null)]), null, "a leg without a method → no method at all");
  assert.equal(settledMethodFrom(op("on_account_table", "cash"), []), null);
  assert.equal(settledMethodFrom(undefined, []), null);
});

test("S-2 history: a device-held settled Dine-In bill carries display_method from its own settle; payment_method stays null", async () => {
  const { sid } = await nativeCase();
  await settleTableOffline({ sessionId: sid, method: "card", covers: { orderIds: [], summary: false }, expectedAmount: 197802 });
  const rows = (await readOrdersHistoryLocal(SHIFT_SCOPE)).orders.filter((o) => o.order_type === "dine_in");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payment_status, "paid");
  assert.equal(rows[0].display_method, "card");
  assert.equal(rows[0].payment_method, null, "the field a reversal's tender reads is unchanged");
  assert.equal(paymentLabel(rows[0]), "paid · card");
});

test("S-2 history: split leg + final settle name both methods", async () => {
  const { sid, lineId } = await nativeCase();
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: lineId, quantity: 1 }], method: "card" });
  await settleTableOffline({ sessionId: sid, method: "cash", covers: { orderIds: [], summary: false }, expectedAmount: 98901 });
  const legs = (await localdb.operations.toArray()).filter((o) => o.operation_type === "split_settle");
  assert.equal(legs.length, 1);
  const row = (await readOrdersHistoryLocal(SHIFT_SCOPE)).orders.find((o) => o.order_type === "dine_in")!;
  assert.equal(row.display_method, "card + cash");
  assert.equal(row.payment_method, null);
});

test("S-2 history: a parked (needs_attention) leg paid nothing and is not named", async () => {
  const { sid, lineId } = await nativeCase();
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: lineId, quantity: 1 }], method: "card" });
  const leg = (await localdb.operations.toArray()).find((o) => o.operation_type === "split_settle")!;
  await localdb.operations.update(leg.operation_id, { status: "needs_attention" });
  await settleTableOffline({ sessionId: sid, method: "cash", covers: { orderIds: [], summary: false }, expectedAmount: 197802 });
  const row = (await readOrdersHistoryLocal(SHIFT_SCOPE)).orders.find((o) => o.order_type === "dine_in")!;
  assert.equal(row.display_method, "cash");
});

test("S-2 history: two sessions never borrow each other's leg methods", async () => {
  const a = await nativeCase();
  await splitDineDraftOffline({ sessionId: a.sid, allocations: [{ line_id: a.lineId, quantity: 1 }], method: "card" });
  await settleTableOffline({ sessionId: a.sid, method: "cash", covers: { orderIds: [], summary: false }, expectedAmount: 98901 });
  const b = await openTableOffline({ scope: DSCOPE, tableId: "TBL-2", tableName: "QA-02", currency: "LBP", baseOrderVersion: 5, baseVersionKnown: true });
  await addDraftLine(b.local_session_id, { menu_item_id: "fries", name: "Fries", base_price: 4, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(b.local_session_id);
  await settleTableOffline({ sessionId: b.local_session_id, method: "online", covers: { orderIds: [], summary: false }, expectedAmount: 4 });
  const rows = (await readOrdersHistoryLocal(SHIFT_SCOPE)).orders.filter((o) => o.order_type === "dine_in");
  const byTable = new Map(rows.map((r) => [r.table_id, r.display_method]));
  assert.equal(byTable.get("TBL-1"), "card + cash");
  assert.equal(byTable.get("TBL-2"), "online");
});

test("S-2 history: an open (unsettled) bill has no method", async () => {
  await nativeCase();
  const row = (await readOrdersHistoryLocal(SHIFT_SCOPE)).orders.find((o) => o.order_type === "dine_in")!;
  assert.notEqual(row.payment_status, "paid");
  assert.equal(row.display_method ?? null, null);
});

test("S-2 wiring: both reprint paths fall back to display_method only after payment_method; reversal tender untouched", () => {
  const re = /method: order\.payment_status === "paid" \? order\.payment_method \?\? order\.display_method \?\? null : null/;
  assert.match(src("src/components/pos/CurrentOrderPanel.tsx"), re);
  assert.match(src("src/screens/pos/PosWorkspace.tsx"), re);
  assert.match(src("src/components/pos/ReverseOrderDialog.tsx"), /tender: order\.payment_method === "cash" \? "cash" : "other"/);
  assert.doesNotMatch(src("src/components/pos/ReverseOrderDialog.tsx"), /display_method/);
});
