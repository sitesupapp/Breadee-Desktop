// 1.0.63 — the two native Staging 1.0.62 blockers.
//   D-B: after an OFFLINE split leg the Dine-In bill PANEL kept showing the whole bill (2 items · Bill total ·
//        unpaid) while the floor tile and Pay Full Bill already used the remaining balance.
//   D-A: the Current Order panel's manual Print always read pos_order_items from Breadee, so offline a bill held
//        on this device failed with "TypeError: Failed to fetch".
// Both fixes are display / reprint only: no captured amount, payment, idempotency key or local row changes.

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
import { getOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { openTableOffline, addDraftLine, sendRoundOffline, splitDineDraftOffline, settleTableOffline, reconcileDineDraftsFromOperations } from "@/lib/offline/dineinOffline";
import { getOperationalTableBill } from "@/lib/offline/operationalProjection";
import { offlineDisplayBill } from "@/lib/offline/displayBill";
import { billCollected, billDue, billItemCount, unpaidBillView } from "@/lib/pos/tableBill";
import { reprintLines } from "@/lib/pos/reprintLines";
import type { ReceiptLine } from "@/lib/receipt";

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

const DSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", shiftId: "sh1" };
const PSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" } as never;
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };
// A free table on the map (Staging-shaped: version known).
const ROW = { id: "TBL-1", name: "QA-01", seats: 2, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, collected: null, outstanding: null, currency: "LBP", mixed_currency: false, merged_sources: [], pos_entity_version: 37, pos_entity_version_known: true } as never;

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(), localdb.posOfflineTxns.clear(), localdb.receipts.clear()]);
  __resetDrainLockForTests();
});

/** The native 1.0.62 case: 2 × QA Test Burger (98,901) on ONE line, one burger paid by an offline split. */
async function nativeCase() {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "QA-01", currency: "LBP", baseOrderVersion: 37, baseVersionKnown: true });
  const d = await addDraftLine(draft.local_session_id, { menu_item_id: "burger", name: "QA Test Burger", base_price: 98901, quantity: 2, modifiers: [], kitchen_note: null });
  const lineId = d.lines[d.lines.length - 1].line_id;
  await sendRoundOffline(draft.local_session_id);
  return { sid: draft.local_session_id, lineId };
}

test("D-B BEFORE: the projection's own bill shows the full line and no collected (the 1.0.62 panel input)", async () => {
  const { sid, lineId } = await nativeCase();
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: lineId, quantity: 1 }], method: "cash" });
  const p = await getOperationalTableBill(PSCOPE, ROW);
  assert.equal(p.gross, 197802);
  assert.equal(p.paidPending, 98901);
  assert.equal(p.outstanding, 98901, "Pay Full Bill / tile: 98,901");
  // what TableBillPanel received through 1.0.62
  assert.equal(billItemCount(unpaidBillView(p.bill)), 2, "1.0.62: the panel still listed 2 items");
  assert.equal(billCollected(p.bill), 0, "1.0.62: no Paid-by-split row, no Due");
});

test("D-B AFTER: the panel's display bill shows the remaining item and Due = Pay Full Bill's amount; the projection is untouched", async () => {
  const { sid, lineId } = await nativeCase();
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: lineId, quantity: 1 }], method: "cash" });
  const p = await getOperationalTableBill(PSCOPE, ROW);
  const before = JSON.stringify(p.bill);
  const shown = offlineDisplayBill(p);
  const view = unpaidBillView(shown);
  assert.equal(billItemCount(view), 1, "1 burger still to pay");
  assert.equal(view.orders[0].lines[0].quantity, 1);
  assert.equal(view.orders[0].lines[0].line_total, 98901);
  assert.equal(shown.total, 197802, "the original total stays the gross");
  assert.equal(billCollected(shown), 98901, "Paid by split");
  assert.equal(billDue(shown), p.outstanding, "panel Due == Pay Full Bill / tile outstanding");
  assert.equal(JSON.stringify(p.bill), before, "the projection's bill (payment / split / print input) is never mutated");
  assert.equal(p.bill.collectedKnown, undefined);
});

test("D-B: a bill with nothing paid is returned AS IS (identical object, every release before)", async () => {
  await nativeCase();
  const p = await getOperationalTableBill(PSCOPE, ROW);
  assert.equal(offlineDisplayBill(p), p.bill);
});

test("D-B: two lines, the whole first line paid → it disappears; the second stays; Due = outstanding", async () => {
  const draft = await openTableOffline({ scope: DSCOPE, tableId: "TBL-1", tableName: "QA-01", currency: "LBP", baseOrderVersion: 37, baseVersionKnown: true });
  const a = await addDraftLine(draft.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 10, quantity: 1, modifiers: [], kitchen_note: null });
  const lineA = a.lines[a.lines.length - 1].line_id;
  await addDraftLine(draft.local_session_id, { menu_item_id: "m2", name: "Fries", base_price: 4, quantity: 2, modifiers: [], kitchen_note: null });
  await sendRoundOffline(draft.local_session_id);
  await splitDineDraftOffline({ sessionId: draft.local_session_id, allocations: [{ line_id: lineA, quantity: 1 }], method: "cash" });
  const p = await getOperationalTableBill(PSCOPE, ROW);
  const view = unpaidBillView(offlineDisplayBill(p));
  assert.deepEqual(view.orders[0].lines.map((l) => [l.name, l.quantity]), [["Fries", 2]]);
  assert.equal(billDue(offlineDisplayBill(p)), 8);
  assert.equal(p.outstanding, 8);
});

test("D-B: restart before sync → the same remaining; sync books the leg ONCE and the remainder for 98,901 only; the panel then shows no bill", async () => {
  const { sid, lineId } = await nativeCase();
  await splitDineDraftOffline({ sessionId: sid, allocations: [{ line_id: lineId, quantity: 1 }], method: "cash" });
  localdb.close();
  await localdb.open();
  await reconcileDineDraftsFromOperations();
  __resetDrainLockForTests();
  const p = await getOperationalTableBill(PSCOPE, ROW);
  assert.equal(billDue(offlineDisplayBill(p)), 98901, "restart-safe panel Due");
  assert.equal(billItemCount(unpaidBillView(offlineDisplayBill(p))), 1);
  const rest = await settleTableOffline({ sessionId: sid, method: "cash", covers: { orderIds: [], summary: false }, expectedAmount: 98901 });
  const log: string[] = [];
  const splitCalls: unknown[] = [];
  const payArgs: unknown[] = [];
  const deps = {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => { log.push("open"); return { table_id: "TBL-1", pos_entity_version: 38 }; },
    submitRound: async () => { log.push("round"); return { order_id: "SRV-ORD", order_number: "261117-0003", batch_no: 1, appended: true, idempotent: false }; },
    orderItemMap: async () => [{ client_line_id: lineId, order_item_id: "IT-1" }],
    voidRefund: async () => ({ order_id: "O", status: "refunded", refunded: true, refund_usd: 0, refund_id: null, idempotent: false }),
    payTable: async (x: unknown) => { log.push("pay_table"); payArgs.push(x); return { ok: true, amount: 98901, idempotent: false, pos_entity_version: 40 }; },
    payOrderOp: async (a: { orderId: string }) => ({ order_id: a.orderId, paid: true, amount: 0, idempotent: false }),
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async () => ({ ok: true, idempotent: false }),
    endShiftOp: async (a: { shiftId: string }) => ({ shift_id: a.shiftId, idempotent: false }),
    splitSettle: async (a: { allocations: unknown }) => { log.push("split"); splitCalls.push(a.allocations); return { ok: true, split_no: 1, parent_completed: false, remaining_qty: 1, idempotent: false }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
  } as unknown as PosTxnSyncDeps;
  await drainOffline(CTX, "reconnect", deps);
  assert.deepEqual(log, ["open", "round", "split", "pay_table"]);
  assert.equal(splitCalls.length, 1, "the leg is booked exactly once");
  assert.deepEqual(splitCalls[0], [{ order_item_id: "IT-1", quantity: 1 }]);
  assert.equal(payArgs.length, 1, "the remainder is booked exactly once");
  const x = payArgs[0] as { expectedAmount?: number; expected_amount?: number };
  assert.equal(x.expectedAmount ?? x.expected_amount, 98901, "the remainder carries the remaining amount, never the gross 197,802");
  assert.equal((await getOperation(rest.operationId))!.status, "synced");
  // a second drain sends nothing again
  await drainOffline(CTX, "reconnect", deps);
  assert.equal(log.length, 4, "nothing replays twice");
});

test("D-B wiring: only the PANEL gets the display bill; payment, split and print keep the projection's bill", () => {
  const ws = src("src/screens/pos/DineInWorkspace.tsx");
  assert.match(ws, /bill=\{offlineCapture \? \(selectedProj \? offlineDisplayBill\(selectedProj\) : null\) : tables\.bill\}/);
  assert.equal((ws.match(/offlineDisplayBill\(/g) ?? []).length, 1, "used in exactly one place");
});

// ---------------------------------------------------------------- D-A

const L = (name: string): ReceiptLine[] => [{ name, qty: 1, unitPrice: 98901, lineTotal: 98901, note: null } as ReceiptLine];

test("D-A: a device-held bill reprints its own durable lines with NO server call", async () => {
  let serverCalls = 0;
  const lines = await reprintLines("OFF-ID", true, { local: async () => L("local"), server: async () => { serverCalls++; return L("server"); }, reachable: () => true });
  assert.equal(lines[0].name, "local");
  assert.equal(serverCalls, 0);
});

test("D-A: Breadee known unreachable → this device's lines, no server call", async () => {
  let serverCalls = 0;
  const lines = await reprintLines("SRV-ID", false, { local: async () => L("local"), server: async () => { serverCalls++; return L("server"); }, reachable: () => false });
  assert.equal(lines[0].name, "local");
  assert.equal(serverCalls, 0);
});

test("D-A: online → the server's rows (unchanged behaviour); a failed read falls back to local; nothing → the original error", async () => {
  assert.equal((await reprintLines("SRV", false, { local: async () => L("local"), server: async () => L("server"), reachable: () => true }))[0].name, "server");
  assert.equal((await reprintLines("SRV", false, { local: async () => L("local"), server: async () => { throw new TypeError("Failed to fetch"); }, reachable: () => null }))[0].name, "local");
  await assert.rejects(reprintLines("SRV", false, { local: async () => null, server: async () => { throw new TypeError("Failed to fetch"); }, reachable: () => null }), /Failed to fetch/);
  assert.equal((await reprintLines("SRV", false, { local: async () => L("local"), server: async () => [], reachable: () => true }))[0].name, "local", "an empty server read falls back");
});

test("D-A real path: an offline Takeaway sale reprints from the persisted provisional receipt (real Dexie)", async () => {
  await localdb.posOfflineTxns.put({ local_txn_id: "431a55bd-f20d-4dff-ba5f-928bf19a5408", status: "queued", attempts: 0, total: 197802 } as never);
  await localdb.receipts.put({ ref: "OFF-431A55", data: { lines: [{ name: "QA Test Burger", qty: 2, unitPrice: 98901, lineTotal: 197802, note: null }] } } as never);
  let serverCalls = 0;
  const lines = await reprintLines("431a55bd-f20d-4dff-ba5f-928bf19a5408", true, { server: async () => { serverCalls++; throw new TypeError("Failed to fetch"); }, reachable: () => false });
  assert.equal(serverCalls, 0);
  assert.deepEqual(lines.map((l) => [l.name, l.qty, l.lineTotal]), [["QA Test Burger", 2, 197802]]);
});

test("D-A wiring: the panel's Print goes through reprintLines (merged sources unchanged) and takes no payment", () => {
  const panel = src("src/components/pos/CurrentOrderPanel.tsx");
  assert.match(panel, /isMergedSource\(order\) \? await readOrderDisplayLines\(order\) : await reprintLines\(order\.id, order\.local_pending === true\)/);
  for (const forbidden of ["payOrder", "submitOrder", "presentReceipt("]) assert.equal(panel.includes(forbidden), false);
});
