// 1.0.42 (P0 incident 2026-11-17, #2123) — an offline Takeaway that carried a CASH payment intent AND an
// on-account receivable chained behind it. The takeaway replay paid it in cash on Breadee first, so every
// on-account send was refused "This order is already fully paid" (16 refusals, operator retries included)
// and the Sync Center told the operator to "Retry". Now the receivable is parked ONCE, never sent, with the
// reconciliation fact: Breadee booked the sale as cash.
//
// Real Dexie (fake-indexeddb), the REAL orchestrator and handlers; server RPCs injected. Synthetic only.

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

import { localdb } from "@/lib/offline/db";
import { getOperation, type OfflineOperation, OPERATION_SCHEMA_VERSION } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { orderOnAccountOffline, takeawaySaleOpId } from "@/lib/offline/orderOnAccountOffline";
import { onAccountPaidCashMessage } from "@/lib/offline/handlers";
import { useShift, shiftNet } from "@/state/shift";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { getDeviceIdentity } from "@/lib/device";
import type { ActiveShift } from "@/types/pos";

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const CTX = { ...SCOPE, online: true };
const SHIFT: ActiveShift = { id: "SRV-SHIFT", status: "open", opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 0, branch_id: "b1" } as ActiveShift;

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear()]);
  __resetDrainLockForTests();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  shiftNet.findOpenShift = async () => SHIFT;
  shiftNet.getCashBox = async () => null as never;
  shiftNet.reachable = async () => true;
});

type Call = { name: string; arg: unknown };
function server(calls: Call[]): PosTxnSyncDeps {
  let paid = false;
  return {
    submit: async () => { calls.push({ name: "submit", arg: null }); return { order_id: "SRV-ORD-2", order_number: "261117-0002" }; },
    pay: async () => { calls.push({ name: "pay_cash", arg: null }); paid = true; return {}; },
    onAccountOrder: async () => { calls.push({ name: "on_account", arg: null }); if (paid) throw Object.assign(new Error("This order is already fully paid"), { code: "P0001" }); return { ok: true, idempotent: false }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
  } as unknown as PosTxnSyncDeps;
}

/** The incident capture: a takeaway op WITH a cash intent (Pay pressed) + an on-account chained behind it. */
async function capture() {
  const localTxn = "LTX-5b8088b5";
  const sale: OfflineOperation = {
    operation_id: takeawaySaleOpId(localTxn), operation_type: "takeaway_sale", schema_version: OPERATION_SCHEMA_VERSION,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "", cashier_user_id: "u1" },
    created_at: new Date().toISOString(), client_op_id: "11111111-1111-4111-8111-111111111111", local_entity_id: localTxn, canonical_entity_id: null,
    dependency_ids: [], depends_on_local_entities: [],
    payload: { order_payload: { shift_id: "SRV-SHIFT", order_type: "takeaway", items: [] }, payment_intent: { method: "cash", currency: "USD" }, paid: false },
    status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
  } as unknown as OfflineOperation;
  await localdb.operations.add(sale);
  const oa = await orderOnAccountOffline({ scope: SCOPE, orderId: null, orderLocal: localTxn, migOpId: sale.operation_id, customerId: "CUST-1", amount: 15, method: "on_account" });
  return { sale, oaId: oa.operationId };
}

test("P0-OA-1 on-account behind a CASH-paid offline takeaway: never sent; parked once with the reconciliation fact", async () => {
  const { oaId } = await capture();
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", server(calls));
  assert.deepEqual(calls.map((c) => c.name), ["submit", "pay_cash"], "the on-account is not sent to be refused");
  const oa = (await getOperation(oaId))!;
  assert.equal(oa.status, "needs_attention");
  assert.equal(oa.last_error_code, "paid_cash_on_server");
  assert.equal(oa.last_error_message, onAccountPaidCashMessage("261117-0002", 15));
  assert.match(oa.last_error_message ?? "", /PAID IN CASH/);
  assert.match(oa.last_error_message ?? "", /drawer is short/);
  assert.match(oa.last_error_message ?? "", /do not retry/i);
  // a second drain sends nothing more
  __resetDrainLockForTests();
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", server(again));
  assert.equal(again.filter((c) => c.name === "on_account").length, 0);
});

test("P0-OA-2 a takeaway WITHOUT a cash intent still settles on account normally (unchanged path)", async () => {
  const { sale, oaId } = await capture();
  await localdb.operations.update(sale.operation_id, { payload: { ...(sale.payload as object), payment_intent: null } });
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", server(calls));
  assert.deepEqual(calls.map((c) => c.name), ["submit", "on_account"]);
  assert.equal((await getOperation(oaId))!.status, "synced");
});
