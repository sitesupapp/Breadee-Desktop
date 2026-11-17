// 1.0.42 (P0 2026-11-17) — OFFLINE VOID of a Takeaway sale this device NEVER sent (voidLocalSale.ts).
// Real Dexie (fake-indexeddb), the REAL orchestrator + migration + drawer projection; server injected. Synthetic only.

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

import { localdb, pendingPosTxnCount, SALE_VOIDED_BEFORE_SYNC, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, OPERATION_SCHEMA_VERSION, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests, withDrainExcluded } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import {
  voidUnsyncedLocalSale, VOID_LOCAL_ALREADY_SENT, VOID_LOCAL_BUSY, VOID_LOCAL_HAS_DEPENDENTS, VOID_LOCAL_NOT_ALLOWED, VOID_LOCAL_NOT_YOURS, VOID_LOCAL_REASON_REQUIRED,
} from "@/lib/offline/voidLocalSale";
import { readOrdersHistoryLocal } from "@/lib/offline/ordersHistoryOffline";
import { buildOfflineDrawerView } from "@/lib/pos/offlineDrawer";
import { useShift, shiftNet } from "@/state/shift";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import type { ActiveShift } from "@/types/pos";

const SCOPE = { tenantId: "t1", branchId: "b1", deviceId: "dev1", cashierUserId: "u1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };
const SHIFT: ActiveShift = { id: "SHIFT-1", status: "open", opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 0, branch_id: "b1" } as ActiveShift;

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.posOfflineTxns.clear(), localdb.syncHistory.clear(), localdb.entityMap.clear(), localdb.pendingShifts.clear(), localdb.dineDrafts.clear(), localdb.snapshots.clear()]);
  __resetDrainLockForTests();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  shiftNet.findOpenShift = async () => SHIFT;
  shiftNet.reachable = async () => true;
});

async function sale(over: Partial<PosOfflineTxn> = {}): Promise<PosOfflineTxn> {
  const t = {
    local_txn_id: "LTX-1", client_op_id: "11111111-2222-4333-8444-555555555555", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1",
    cashier_user_id: "u1", cashier_user_name: "Ali", shift_id: "SHIFT-1", created_at: new Date().toISOString(),
    order_payload: { branch_id: "b1", order_type: "takeaway", status: "sent_to_kitchen", shift_id: "SHIFT-1", client_op_id: "11111111-2222-4333-8444-555555555555", notes: null, items: [] },
    payment_intent: { method: "cash", currency: "USD", pay_op_v: 1 }, sent_to_kitchen: true, currency: "USD", total: 12, status: "queued", attempts: 0,
    pending_shift_local_id: null, ...over,
  } as unknown as PosOfflineTxn;
  await localdb.posOfflineTxns.put(t);
  return t;
}
const VOID = { localTxnId: "LTX-1", scope: SCOPE, actorUserId: "u1", authorized: true, reason: "customer cancelled" };
type Call = { name: string };
const server = (calls: Call[]) => ({
  submit: async () => { calls.push({ name: "submit" }); return { order_id: "SRV-ORD", order_number: "N" }; },
  pay: async () => { calls.push({ name: "pay" }); return {}; },
  isTransport: (e: unknown) => e instanceof TypeError,
  hasSession: async () => true,
}) as unknown as PosTxnSyncDeps;

test("V1 a never-sent cash sale is voided on this device: op cancelled with the void record, row kept, NOTHING ever sent — also after a drain and a restart", async () => {
  await sale();
  const r = await voidUnsyncedLocalSale(VOID);
  assert.deepEqual(r, { ok: true, operationId: "mig:txn:LTX-1", cashReturned: 12, currency: "USD" });
  const op = (await getOperation("mig:txn:LTX-1"))!;
  assert.equal(op.status, "cancelled");
  assert.equal(op.withdrawal?.reason, "voided_before_sync");
  assert.equal(op.withdrawal?.void_reason, "customer cancelled");
  assert.equal(op.withdrawal?.cash_returned, 12);
  assert.deepEqual(op.withdrawal?.verified_against, ["local:never_attempted", "local:drain_excluded", "local:no_dependents", "authority:pos.cancel_orders"]);
  assert.equal((await localdb.posOfflineTxns.get("LTX-1"))?.review_reason, SALE_VOIDED_BEFORE_SYNC, "the sale row is kept as evidence");
  assert.equal(await pendingPosTxnCount(), 0, "no longer counted as unsynced work");
  const hist = await localdb.syncHistory.toArray();
  assert.match(hist.at(-1)!.error_summary ?? "", /voided on this terminal before it was ever sent — reason: customer cancelled · cash handed back: 12 USD/);
  // a drain (which migrates legacy rows) never resurrects or sends it
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", server(calls));
  assert.equal(calls.length, 0, "the voided sale never reaches Breadee");
  localdb.close(); await localdb.open(); __resetDrainLockForTests();
  await drainOffline(CTX, "reconnect", server(calls));
  assert.equal(calls.length, 0, "…not after a restart either");
  assert.equal((await getOperation("mig:txn:LTX-1"))!.status, "cancelled");
});

test("V2 Orders list shows it Voided (not payable); the offline drawer no longer expects its cash", async () => {
  await sale();
  await voidUnsyncedLocalSale(VOID);
  const { orders } = await readOrdersHistoryLocal({ kind: "shift", tenantId: "t1", branchId: "b1", shiftId: "SHIFT-1" });
  const o = orders.find((x) => x.id === "LTX-1")!;
  assert.equal(o.status, "voided");
  assert.equal(o.payment_status, "unpaid");
  const ops = await localdb.operations.toArray();
  const view = buildOfflineDrawerView({ ops, scope: { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1" } as never, server: null, openingFloatUsd: 0, shiftOpenedAtMs: Date.parse(SHIFT.opened_at as string), usdRate: 90000 });
  assert.equal(JSON.stringify(view).includes('"LTX-1"'), false, "the voided cash sale is not a drawer movement");
});

test("V3 fail closed: no permission, empty reason, another cashier, an attempted send, a server id — nothing changes", async () => {
  await sale();
  const before = JSON.stringify([await localdb.posOfflineTxns.toArray(), await localdb.operations.toArray()]);
  assert.deepEqual(await voidUnsyncedLocalSale({ ...VOID, authorized: false }), { ok: false, reason: VOID_LOCAL_NOT_ALLOWED });
  assert.deepEqual(await voidUnsyncedLocalSale({ ...VOID, reason: "  " }), { ok: false, reason: VOID_LOCAL_REASON_REQUIRED });
  assert.deepEqual(await voidUnsyncedLocalSale({ ...VOID, actorUserId: "u2", scope: { ...SCOPE, cashierUserId: "u2" } }), { ok: false, reason: VOID_LOCAL_NOT_YOURS });
  assert.equal(JSON.stringify([await localdb.posOfflineTxns.toArray(), await localdb.operations.toArray()]), before);
  await localdb.posOfflineTxns.update("LTX-1", { attempts: 1, last_attempt_at: new Date().toISOString() } as never);
  assert.deepEqual(await voidUnsyncedLocalSale(VOID), { ok: false, reason: VOID_LOCAL_ALREADY_SENT }, "a send was attempted: its fate on Breadee is unknown");
  await localdb.posOfflineTxns.update("LTX-1", { attempts: 0, last_attempt_at: null, server_order_id: "SRV-1" } as never);
  assert.deepEqual(await voidUnsyncedLocalSale(VOID), { ok: false, reason: VOID_LOCAL_ALREADY_SENT });
});

test("V4 a staged op that was already handed to the handler (retry_count > 0) is never voided locally", async () => {
  await sale();
  await localdb.operations.add({
    operation_id: "mig:txn:LTX-1", operation_type: "takeaway_sale", schema_version: OPERATION_SCHEMA_VERSION,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" }, created_at: new Date().toISOString(),
    client_op_id: "11111111-2222-4333-8444-555555555555", local_entity_id: "LTX-1", canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [],
    payload: {}, status: "retryable", retry_count: 1, last_attempt_at: new Date().toISOString(), last_error_code: "transport", last_error_message: "Failed to fetch", result_meta: null, synced_at: null,
  } as unknown as OfflineOperation);
  assert.deepEqual(await voidUnsyncedLocalSale(VOID), { ok: false, reason: VOID_LOCAL_ALREADY_SENT });
  assert.equal((await getOperation("mig:txn:LTX-1"))!.status, "retryable");
});

test("V5 a sale with a dependent step (on-account behind it) is not voided locally", async () => {
  await sale();
  await localdb.operations.add({
    operation_id: "onaccountorder:x", operation_type: "on_account_order", schema_version: OPERATION_SCHEMA_VERSION,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" }, created_at: new Date().toISOString(),
    client_op_id: "c-oa", local_entity_id: null, canonical_entity_id: null, dependency_ids: ["mig:txn:LTX-1"], depends_on_local_entities: ["LTX-1"],
    payload: {}, status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
  } as unknown as OfflineOperation);
  assert.deepEqual(await voidUnsyncedLocalSale(VOID), { ok: false, reason: VOID_LOCAL_HAS_DEPENDENTS });
});

test("V6 never races a drain: while a drain holds the lock the void refuses (busy) and changes nothing; while the void holds it no drain runs", async () => {
  await sale();
  let inner: unknown = null;
  const outer = await withDrainExcluded(async () => {
    inner = await voidUnsyncedLocalSale(VOID);
    return "held";
  });
  assert.equal(outer, "held");
  assert.deepEqual(inner, { ok: false, reason: VOID_LOCAL_BUSY });
  assert.equal(await getOperation("mig:txn:LTX-1"), undefined);
  // the drain refuses to overlap a held lock (empty report), so a void in progress can never be raced
  const calls: Call[] = [];
  const r = await withDrainExcluded(async () => drainOffline(CTX, "reconnect", server(calls)));
  assert.notEqual(r, "busy");
  assert.equal(calls.length, 0);
});
