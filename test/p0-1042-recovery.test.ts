// 1.0.42 (P0 incident 2026-11-17, #2123) — the operator-visible defects of the incident:
//   R1 a REFUSED offline Dine-In bill was listed "Open · unpaid" (Pay / Void / Edit offered) while its panel said "Paid";
//   R2 every device-only bill said "No items readable for this order";
//   R3 an offline cash sale never auto-printed its receipt (it bypassed presentReceipt → autoPrintReceipt);
//   R4 Force sync: receipt-verified + dependency recovery only — never forces a refusal, never marks Synced itself;
//   R5 an identical warning stacked once per press.
// Real Dexie (fake-indexeddb) + pure functions; synthetic fixtures only. No network, no Staging, no Production.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, type DineDraft } from "@/lib/offline/db";
import { readOrdersHistoryLocal, readLocalOrderLines, LOCAL_REFUSED_STATUS } from "@/lib/offline/ordersHistoryOffline";
import { canSettleOrder, canEditOrder, reversalActionFor, isTerminalOrder } from "@/lib/pos/orderActions";
import { orderLifecycleLabel, orderLifecycleTone, isOpenOrder } from "@/lib/pos/shiftOrderSummary";
import { forceSync, FORCE_SYNC_SERVER_OFF, type ForceSyncDeps } from "@/lib/offline/syncActions";
import type { OfflineOperation } from "@/lib/offline/operationLog";

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.dineDrafts.clear(), localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.entityMap.clear(), localdb.pendingShifts.clear()]);
});

function draft(over: Partial<DineDraft>): DineDraft {
  const now = new Date().toISOString();
  return {
    local_session_id: "LS-b1e8e6aa", shift_id: "SHIFT-1", shift_local: null, tenant_id: "t1", branch_id: "b1", cashier_user_id: "u1", device_id: "dev", terminal_id: "term",
    floor_id: null, section_id: null, table_id: "TBL-R2", table_name: "R2/1", currency: "USD", open_operation_id: "OPEN-1", canonical_order_id: null, origin: "offline",
    base_order_version: null, status: "open",
    lines: [
      { line_id: "L1", menu_item_id: "m1", name: "Cheeseburger", base_price: 5.5, quantity: 1, modifiers: [{ name: "Extra cheese", price_delta: 0.5, quantity: 1 }], kitchen_note: "no onion", sent_round: 1 },
      { line_id: "L2", menu_item_id: "m2", name: "Pepsi", base_price: 1.5, quantity: 2, modifiers: [], kitchen_note: null, sent_round: 1 },
      { line_id: "L3", menu_item_id: "m3", name: "Unsent", base_price: 9, quantity: 1, modifiers: [], kitchen_note: null, sent_round: null },
    ],
    rounds: [{ seq: 1, operation_id: "ROUND-1" }],
    draft_revision: 1, notes: null, created_at: now, updated_at: now,
    ...over,
  } as unknown as DineDraft;
}
const SCOPE = { kind: "shift" as const, tenantId: "t1", branchId: "b1", shiftId: "SHIFT-1" };

// ============================================================ R1 — a refused bill is never "Open" / collectible

test("R1 a REFUSED offline Dine-In bill is listed 'Refused — see Sync Center', red, and is NOT payable / editable / voidable", async () => {
  await localdb.dineDrafts.put(draft({ status: "refused" }));
  const { orders } = await readOrdersHistoryLocal(SCOPE);
  const o = orders.find((x) => x.order_number === "OFF-LS-B1E")!;
  assert.ok(o, "still listed (kept for review)");
  assert.equal(o.status, LOCAL_REFUSED_STATUS);
  assert.equal(o.payment_status, "unpaid", "its payment is on no bill — never 'Paid'");
  assert.equal(orderLifecycleLabel(o), "Refused — see Sync Center");
  assert.equal(orderLifecycleTone(o), "red");
  assert.equal(isOpenOrder(o), false, "not counted as an open order");
  assert.equal(isTerminalOrder(o), true);
  assert.equal(canSettleOrder(o), false, "Pay is never offered: don't collect again");
  assert.equal(canEditOrder(o), false);
  assert.equal(reversalActionFor(o), null, "no Void from the Orders list — withdraw it in the Sync Center");
});

test("R1b a pending local settle overlay never re-marks a REFUSED bill 'Paid' (the screenshot mismatch)", async () => {
  await localdb.dineDrafts.put(draft({ status: "refused" }));
  // a pay_table captured for that session, still parked (needs attention, dependency_failed)
  await localdb.operations.put({
    operation_id: "PAY-1", operation_type: "pay_table", schema_version: 1, scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev", terminal_id: "term", cashier_user_id: "u1" },
    created_at: new Date().toISOString(), client_op_id: "c-pay", local_entity_id: "TBL-R2", canonical_entity_id: null, dependency_ids: ["OPEN-1"], depends_on_local_entities: [],
    payload: { session_local: "LS-b1e8e6aa", covers: { session_locals: ["LS-b1e8e6aa"] }, method: "cash" }, status: "needs_attention", retry_count: 0, last_attempt_at: null,
    last_error_code: "dependency_failed", last_error_message: "OPEN-1", result_meta: null, synced_at: null,
  } as unknown as OfflineOperation);
  const { orders } = await readOrdersHistoryLocal(SCOPE);
  const o = orders.find((x) => x.order_number === "OFF-LS-B1E")!;
  assert.notEqual(o.payment_status, "paid");
  assert.equal(o.status, LOCAL_REFUSED_STATUS);
});

test("R1c an OPEN offline bill is unchanged (Open · unpaid, payable); a WITHDRAWN one is Voided", async () => {
  await localdb.dineDrafts.put(draft({ status: "open" }));
  await localdb.dineDrafts.put(draft({ local_session_id: "LS-withdrawn", status: "withdrawn" }));
  const { orders } = await readOrdersHistoryLocal(SCOPE);
  const open = orders.find((x) => x.order_number === "OFF-LS-B1E")!;
  assert.equal(open.status, "sent_to_kitchen");
  assert.equal(orderLifecycleLabel(open), "Open");
  assert.equal(canSettleOrder(open), true);
  const w = orders.find((x) => x.order_number === "OFF-LS-WIT")!;
  assert.equal(w.status, "voided");
  assert.equal(canSettleOrder(w), false);
});

// ============================================================ R2 — device-only bills show their items

test("R2 a device-only bill's SENT lines are readable (name, qty, unit incl. modifiers, total, note); unsent lines excluded", async () => {
  await localdb.dineDrafts.put(draft({ status: "refused" }));
  const lines = (await readLocalOrderLines("LS-b1e8e6aa"))!;
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { name: "Cheeseburger", qty: 1, unitPrice: 6, lineTotal: 6, modifiers: [{ name: "Extra cheese", price_delta: 0.5, quantity: 1 }], note: "no onion" });
  assert.deepEqual(lines[1], { name: "Pepsi", qty: 2, unitPrice: 1.5, lineTotal: 3, note: null });
  assert.equal(lines.reduce((s, l) => s + l.lineTotal, 0), 9, "equals the bill total shown ($9.00 in the screenshot)");
});

test("R2b found by its CANONICAL order id once round 1 synced; unknown ids and unsent-only sessions return null (server read is kept)", async () => {
  await localdb.dineDrafts.put(draft({ canonical_order_id: "SRV-ORD-9" }));
  assert.equal((await readLocalOrderLines("SRV-ORD-9"))?.length, 2);
  assert.equal(await readLocalOrderLines("NOPE"), null);
  await localdb.dineDrafts.put(draft({ local_session_id: "LS-empty", lines: [{ line_id: "X", menu_item_id: "m", name: "x", base_price: 1, quantity: 1, modifiers: [], kitchen_note: null, sent_round: null }] as never }));
  assert.equal(await readLocalOrderLines("LS-empty"), null);
});

test("R2c the order panel reads this device's lines for a local bill and falls back to them when the server read fails", () => {
  const src = readFileSync("src/components/pos/CurrentOrderPanel.tsx", "utf8");
  assert.match(src, /readLocalOrderLines\(id\)/);
  assert.match(src, /if \(local_pending\)/);
  assert.match(src, /catch \{\s*\/\* offline \/ unreachable: fall back/);
  const pos = readFileSync("src/screens/pos/PosWorkspace.tsx", "utf8");
  assert.match(pos, /readLocalOrderLines\(order\.id\)/, "manual reprint of a device-only bill works offline");
});

// ============================================================ R3 — offline receipt goes through the auto-print pipeline

test("R3 the offline cash sale presents its receipt through presentReceipt (→ autoPrintReceipt), not the manual layer", () => {
  const src = readFileSync("src/screens/pos/PosWorkspace.tsx", "utf8");
  const start = src.indexOf("Phase F (GAP 1): present (and durably persist) a PROVISIONAL receipt");
  assert.ok(start > 0);
  const block = src.slice(start, src.indexOf("Saved offline - cash sale queued", start));
  assert.match(block, /presentReceipt\(\s*buildReceipt\(/);
  assert.doesNotMatch(block, /receiptStore\.present\(/);
  // the shared pipeline still auto-prints and persists
  assert.match(src, /const presentReceipt = useCallback\([\s\S]{0,400}receiptStore\.stage\(receipt\)[\s\S]{0,400}autoPrintReceipt\(/);
});

// ============================================================ R4 — Force sync

const op = (id: string, over: Partial<OfflineOperation>): OfflineOperation => ({
  operation_id: id, operation_type: "pay_order", schema_version: 1, scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev", terminal_id: "term", cashier_user_id: "u1" },
  created_at: new Date(Date.parse("2026-11-17T09:00:00Z") + Number(id.replace(/\D/g, "") || 0) * 1000).toISOString(),
  client_op_id: `c-${id}`, local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {},
  status: "needs_attention", retry_count: 1, last_attempt_at: null, last_error_code: "conflict", last_error_message: "This order is already fully paid", result_meta: null, synced_at: null,
  ...over,
}) as OfflineOperation;

function fsDeps(ops: OfflineOperation[], receipts: Set<string>, over: Partial<ForceSyncDeps> = {}) {
  const requeued: string[] = [];
  let drains = 0;
  const byId = new Map(ops.map((o) => [o.operation_id, o]));
  const deps: ForceSyncDeps = {
    hasReceipt: async (_t, c) => receipts.has(c),
    rebaseDeps: { readTable: async () => null, hasReceipt: async () => false, salesSince: async () => [] },
    drain: async () => { drains++; return 1; },
    listParked: async () => ops,
    getOp: async (id) => byId.get(id),
    requeue: async (id) => { requeued.push(id); return true; },
    health: () => "online",
    ...over,
  };
  return { deps, requeued, drains: () => drains };
}

test("R4 Force sync: receipt-verified ops and children of SYNCED parents are re-queued; a genuine refusal is left for review; one drain", async () => {
  const parent = op("op1", { status: "synced", last_error_code: null });
  const applied = op("op2", { last_error_code: "transport", last_error_message: "Failed to fetch" }); // lost ack: Breadee holds it
  const child = op("op3", { last_error_code: "dependency_failed", dependency_ids: ["op1"] });
  const refused = op("op4", { operation_type: "on_account_order", last_error_code: "paid_cash_on_server" });
  const foreign = op("op5", { scope: { tenant_id: "OTHER", branch_id: "b1", device_id: "d", terminal_id: "t", cashier_user_id: "u" } as never, last_error_code: "transport" });
  const { deps, requeued, drains } = fsDeps([parent, applied, child, refused, foreign], new Set(["c-op2"]));
  const r = await forceSync({ tenantId: "t1", branchId: "b1" }, "u1", deps);
  assert.deepEqual(r.receiptVerified, ["op2"]);
  assert.deepEqual(r.dependencyRecovered, ["op3"]);
  assert.deepEqual(r.leftForReview, ["op4"], "a refusal without a receipt is never re-sent");
  assert.deepEqual(requeued.sort(), ["op2", "op3"]);
  assert.equal(drains(), 1);
  assert.match(r.text, /nothing was forced; no payment was re-collected/);
  assert.equal(requeued.includes("op5"), false, "another tenant's work is never touched");
});

test("R4b Force sync fails closed: server off → nothing changes; an unverifiable receipt check → left for review; a child of a still-refused parent stays parked", async () => {
  const parentRefused = op("op1", { last_error_code: "version_conflict", operation_type: "pay_table" });
  const child = op("op2", { last_error_code: "dependency_failed", dependency_ids: ["op1"] });
  const off = fsDeps([parentRefused, child], new Set(), { health: () => "server_off" });
  const r0 = await forceSync({ tenantId: "t1", branchId: "b1" }, "u1", off.deps);
  assert.equal(r0.text, FORCE_SYNC_SERVER_OFF);
  assert.equal(off.requeued.length, 0);
  const broken = fsDeps([parentRefused, child], new Set(), { hasReceipt: async () => { throw new TypeError("Failed to fetch"); } });
  const r1 = await forceSync({ tenantId: "t1", branchId: "b1" }, "u1", broken.deps);
  assert.equal(broken.requeued.length, 0);
  assert.equal(r1.leftForReview.length, 2);
  assert.equal(broken.drains(), 0, "no drain when nothing was released");
  const stuck = fsDeps([parentRefused, child], new Set());
  const r2 = await forceSync({ tenantId: "t1", branchId: "b1" }, "u1", stuck.deps);
  assert.deepEqual(r2.leftForReview.sort(), ["op1", "op2"]);
});

// ============================================================ R5 — one notice, not a stack

test("R5 an identical visible toast is refreshed in place (timer restarted), never stacked", () => {
  const src = readFileSync("src/components/toast.tsx", "utf8");
  assert.match(src, /const same = visible\.current\.find\(/);
  assert.match(src, /t\.tone === toast\.tone && t\.message === toast\.message/);
  assert.match(src, /return same\.id;/);
});
