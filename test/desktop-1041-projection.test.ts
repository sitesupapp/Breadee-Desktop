// 1.0.41 (BUG 04) — U1: a session moved / merged behind a refused open is recognised as refused; U2: a split leg
// taken after an offline merge the server refused HOLDS the restored bills (never collectible twice); U5: the
// offline drawer counts cash split legs and not-yet-staged takeaway cash sales.
//
// Real Dexie (fake-indexeddb) where a capture guard is exercised; synthetic fixtures only. No network.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, type PosOfflineTxn } from "@/lib/offline/db";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import {
  TABLE_OP_SCHEMA_VERSION,
  refusedRootOf,
  splitLegHeldByRefusedStructural,
  tablesHeldBySplitLegs,
  SPLIT_LEG_HELD_MESSAGE,
} from "@/lib/offline/operationalProjection";
import { splitOperationalBillOffline, settleTableOffline } from "@/lib/offline/dineinOffline";
import { extractDrawerMovements } from "@/lib/offline/drawerProjection";
import { buildOfflineDrawerView, legacySaleAsOp } from "@/lib/pos/offlineDrawer";
import { drawerFields } from "@/lib/offline/migration";

const SCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev-1", terminal_id: "term-1", cashier_user_id: "u1" };
const DSCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev-1", terminalId: "term-1" };
const T0 = Date.now() - 3_600_000;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function op(id: string, over: Partial<OfflineOperation>): OfflineOperation {
  return {
    operation_id: id,
    operation_type: "pay_table",
    schema_version: 1,
    scope: { ...SCOPE },
    created_at: at(0),
    client_op_id: `cop-${id}`,
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: {},
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    ...over,
  };
}

/** An offline merge S1 → P that the SERVER refused on its 1st attempt at minute 10. */
const refusedMerge = (over: Partial<OfflineOperation> = {}) =>
  op("merge", {
    operation_type: "merge_tables",
    schema_version: TABLE_OP_SCHEMA_VERSION,
    canonical_entity_id: "TBL-P", // tableOpOffline stores the primary at capture (a target, not a server id)
    created_at: at(1),
    payload: { primary_table_id: "TBL-P", source_table_ids: ["TBL-S1"], orders: { "TBL-P": { order_id: "ORD-P" }, "TBL-S1": { order_id: "ORD-S1" } } },
    status: "needs_attention",
    retry_count: 1,
    last_attempt_at: at(10),
    last_error_code: "unsupported_state",
    last_error_message: "UNSUPPORTED_STATE: cannot merge (reason: kitchen_active)",
    ...over,
  });

/** A cash split leg taken on the primary AFTER the merge (minute 5), parked behind it, never sent. */
const legAfterMerge = (over: Partial<OfflineOperation> = {}) =>
  op("leg", {
    operation_type: "split_settle",
    created_at: at(5),
    dependency_ids: ["merge"],
    canonical_entity_id: "ORD-P",
    payload: { order_id: "ORD-P", method: "cash", currency: "USD", allocations: [{ order_item_id: "I-S1-1", quantity: 1 }], cash_amount_usd: 12 },
    status: "needs_attention",
    last_error_code: "dependency_failed",
    last_error_message: "merge",
    ...over,
  });

beforeEach(async () => {
  await localdb.operations.clear();
  await localdb.dineDrafts.clear();
  await localdb.posOfflineTxns.clear();
});

test("U2: a split leg captured after a merge the server refused holds EVERY table of that merge", () => {
  const m = refusedMerge();
  const leg = legAfterMerge();
  assert.equal(splitLegHeldByRefusedStructural(leg, m), true);
  assert.deepEqual([...tablesHeldBySplitLegs([m, leg])].sort(), ["TBL-P", "TBL-S1"]);
});

test("U2: nothing is held by a cancelled leg, a leg the server refused on its own, a leg taken after the refusal, or a merge still in flight", () => {
  const m = refusedMerge();
  assert.equal(tablesHeldBySplitLegs([m, legAfterMerge({ status: "cancelled" })]).size, 0);
  assert.equal(tablesHeldBySplitLegs([m, legAfterMerge({ retry_count: 1, last_error_code: "split_conflict", last_error_message: "split refused" })]).size, 0);
  assert.equal(tablesHeldBySplitLegs([m, legAfterMerge({ created_at: at(11) })]).size, 0, "captured after the refusing attempt: the bill was already back");
  assert.equal(tablesHeldBySplitLegs([refusedMerge({ status: "pending", last_error_code: null, last_error_message: null }), legAfterMerge({ status: "blocked_dependency" })]).size, 0);
  assert.equal(tablesHeldBySplitLegs([m, legAfterMerge({ dependency_ids: [] })]).size, 0, "a leg not taken on top of the merge");
});

test("U2: offline Pay / Split on a table held by such a leg is refused at capture (no second collection)", async () => {
  await localdb.operations.bulkPut([refusedMerge(), legAfterMerge()]);
  await assert.rejects(
    settleTableOffline({ sessionId: null, table: { tableId: "TBL-S1", tableName: "S1", currency: "USD", orderIds: ["ORD-S1"], scope: DSCOPE } as never, method: "cash" }),
    (e: Error) => e.message === SPLIT_LEG_HELD_MESSAGE,
  );
  const r = await splitOperationalBillOffline({
    scope: DSCOPE,
    orderId: "ORD-S1",
    orderLocal: null,
    allocations: [{ order_item_id: "I-S1-2", quantity: 1 }],
    method: "cash",
    currency: "USD",
    tableName: "S1",
    dependencyIds: [],
    tableId: "TBL-S1",
  });
  assert.deepEqual(r, { ok: false, reason: SPLIT_LEG_HELD_MESSAGE });
  assert.equal(await localdb.operations.count(), 2, "nothing captured");
});

test("U1: a merge parked never-sent behind a refused open is part of the refused chain (its target table id is not a server id)", () => {
  const open = op("open", {
    operation_type: "dinein_open_table",
    local_entity_id: "TBL-P",
    status: "needs_attention",
    retry_count: 1,
    last_error_code: "version_conflict",
    last_error_message: "This table changed since it was loaded. Reload and try again.",
  });
  const merge = refusedMerge({ dependency_ids: ["open"], retry_count: 0, last_attempt_at: null, last_error_code: "dependency_failed", last_error_message: "open" });
  const byId = new Map([open, merge].map((o) => [o.operation_id, o] as const));
  assert.equal(refusedRootOf(merge, (id) => byId.get(id)), "open");
  // a merge the server itself refused (attempted) is NOT treated as never-sent
  const attempted = refusedMerge({ dependency_ids: ["open"] });
  assert.equal(refusedRootOf(attempted, (id) => byId.get(id)), null);
});

test("U5: a cash split leg is cash into the offline drawer; one without a known USD amount is counted, never guessed", () => {
  const legs = [
    legAfterMerge({ operation_id: "l1", status: "pending", last_error_code: null }),
    legAfterMerge({ operation_id: "l2", status: "pending", last_error_code: null, payload: { method: "cash", allocations: [] } }),
    legAfterMerge({ operation_id: "l3", status: "pending", last_error_code: null, payload: { method: "card", allocations: [] } }),
  ];
  const r = extractDrawerMovements(legs, DSCOPE);
  assert.deepEqual(r.movements.map((m) => [m.operationId, m.method, m.amountUsd]), [["l1", "cash", 12]]);
  assert.equal(r.unknownAmountCount, 1);
});

test("U5: a takeaway cash sale still in the capture store (not staged — no drain while the server is off) counts in the drawer", () => {
  const row = {
    local_txn_id: "LT-1",
    client_op_id: "cop-LT-1",
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "dev-1",
    terminal_id: "term-1",
    cashier_user_id: "u1",
    cashier_user_name: "Ali",
    shift_id: "SH-1",
    created_at: at(20),
    order_payload: {},
    payment_intent: { method: "cash", currency: "USD" },
    currency: "USD",
    total: 9.5,
    status: "queued",
    attempts: 0,
  } as unknown as PosOfflineTxn;
  const asOp = legacySaleAsOp(row);
  assert.equal(asOp.operation_id, "mig:txn:LT-1", "the same id the drain stages it under (dedup)");
  const v = buildOfflineDrawerView({ ops: [asOp], scope: DSCOPE, server: null, openingFloatUsd: 100, shiftOpenedAtMs: T0, usdRate: null });
  assert.equal(v.cashInUsd, 9.5);
  assert.equal(v.projectedUsd, 109.5);
  assert.deepEqual(drawerFields(row), { total: 9.5, currency: "USD" });
  assert.deepEqual(drawerFields({ total: 0, currency: "USD" }), {});
});
