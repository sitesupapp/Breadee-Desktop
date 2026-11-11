// 1.0.41 (Staging 1.0.52/1.0.53 native QA, D-5). A refused offline Takeaway / Delivery cash sale had no way out: no
// server order (Cancel said "Order not found"), and the shift close waited behind it for ever. It can now be
// withdrawn — explicitly, only after Breadee confirms it holds no receipt of the sale nor of its payment, and only by
// the cashier who captured it. Real Dexie (fake-indexeddb); the server receipt check is injected.

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

import { localdb, addPosOfflineTxn, pendingPosTxnCount, SALE_WITHDRAWN, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation } from "@/lib/offline/operationLog";
import { migrateLegacyToOperations } from "@/lib/offline/migration";
import { takeawayPayOpId } from "@/lib/offline/opIdentity";
import {
  isWithdrawableRefusedSale,
  withdrawRefusedSale,
  WITHDRAW_NEEDS_CONNECTION,
  WITHDRAW_NOT_AUTHORIZED,
  WITHDRAW_NOT_YOURS,
  WITHDRAW_RECEIPT_FOUND,
  WITHDRAW_SALE_NOT_REFUSED,
} from "@/lib/offline/refusedSessions";

const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "d1", terminalId: "term1" };
const ID = "a3fc827e-45ba-45c1-8d59-4f46bcc856d1"; // native: #OFF-A3FC82, refused PRICE_CHANGED
const COP = "0b6c255d-0b56-4235-9e87-fc206c54f5a8";

function txn(extra: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  return {
    local_txn_id: ID,
    client_op_id: COP,
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "d1",
    terminal_id: "term1",
    cashier_user_id: "u1",
    cashier_user_name: "QA",
    shift_id: "s1",
    created_at: "2026-11-11T08:39:07.461Z",
    order_payload: { branch_id: "b1", order_type: "takeaway", shift_id: "s1", client_op_id: COP, items: [{ menu_item_id: "m1", base_price: 100000, quantity: 1, modifiers: [] }] },
    payment_intent: { method: "cash", currency: "LBP", pay_op_v: 1 },
    sent_to_kitchen: true,
    currency: "LBP",
    total: 100000,
    status: "needs_attention",
    attempts: 1,
    review_reason: "price_changed",
    ...extra,
  };
}

/** The refused sale as the native run left it: staged, refused PRICE_CHANGED, never recorded by Breadee. */
async function refusedSale(): Promise<string> {
  await addPosOfflineTxn(txn());
  await migrateLegacyToOperations();
  const opId = `mig:txn:${ID}`;
  await localdb.operations.update(opId, {
    status: "needs_attention",
    last_error_code: "price_changed",
    last_error_message: 'The price of "QA Test Burger" changed since this order was taken (sent 100000).',
    retry_count: 1,
  });
  return opId;
}

type Asked = { openClientOpIds: string[]; roundClientOpIds: string[]; actorUserId: string; tenantId: string; branchIds: string[] };

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.posOfflineTxns.clear(), localdb.syncHistory.clear(), localdb.entityMap.clear()]);
});

test("D-5: Breadee holds no receipt → the refused sale is withdrawn (op cancelled + audit, row marked, history kept)", async () => {
  const opId = await refusedSale();
  assert.equal(await pendingPosTxnCount(), 1);
  const asked: Asked[] = [];
  const r = await withdrawRefusedSale({ operationId: opId, scope: SCOPE, actorUserId: "u1", checkReceipts: async (q) => { asked.push(q as Asked); return { kind: "none" }; } });
  assert.deepEqual(r, { ok: true, withdrawn: [opId] });
  assert.deepEqual(asked[0].roundClientOpIds, [COP], "the sale's submit receipt (pos_order_submissions)");
  assert.deepEqual(asked[0].openClientOpIds, [takeawayPayOpId(COP)], "the payment's receipt (pos_op_submissions)");
  assert.equal(asked[0].actorUserId, "u1");
  assert.deepEqual(asked[0].branchIds, ["b1"]);
  const op = await getOperation(opId);
  assert.equal(op?.status, "cancelled", "never sent; a cancelled prerequisite no longer holds the shift close");
  assert.equal(op?.withdrawal?.reason, "refused_never_applied");
  assert.equal(op?.last_error_code, "price_changed", "the refusal itself is kept");
  const row = await localdb.posOfflineTxns.get(ID);
  assert.equal(row?.review_reason, SALE_WITHDRAWN);
  assert.equal(row?.payment_intent?.method, "cash", "the cash it recorded stays on record");
  assert.equal(await pendingPosTxnCount(), 0, "no longer counted as unsynced work");
  const hist = await localdb.syncHistory.toArray();
  assert.ok(hist.some((h) => h.operation_id === opId && h.status === "cancelled" && /cash collected offline/.test(h.action_label)));
  await migrateLegacyToOperations();
  assert.equal((await getOperation(opId))?.status, "cancelled", "the next drain never resurrects it");
});

test("D-5: any receipt, no connection or no authority → nothing changes", async () => {
  const opId = await refusedSale();
  for (const [kind, reason] of [["found", WITHDRAW_RECEIPT_FOUND], ["offline", WITHDRAW_NEEDS_CONNECTION], ["unauthorized", WITHDRAW_NOT_AUTHORIZED]] as const) {
    const r = await withdrawRefusedSale({
      operationId: opId,
      scope: SCOPE,
      actorUserId: "u1",
      checkReceipts: async () => (kind === "found" ? { kind, clientOpIds: [COP] } : { kind, detail: "x" }) as never,
    });
    assert.deepEqual(r, { ok: false, reason });
    assert.equal((await getOperation(opId))?.status, "needs_attention");
    assert.equal((await localdb.posOfflineTxns.get(ID))?.review_reason, "price_changed");
  }
});

test("D-5: only the capturing cashier, and only a refusal of THIS sale, can be withdrawn", async () => {
  const opId = await refusedSale();
  const never = async () => { throw new Error("the server must not be asked"); };
  assert.deepEqual(await withdrawRefusedSale({ operationId: opId, scope: { ...SCOPE, cashierUserId: "u2" }, actorUserId: "u2", checkReceipts: never }), { ok: false, reason: WITHDRAW_NOT_YOURS });
  assert.deepEqual(await withdrawRefusedSale({ operationId: opId, scope: { ...SCOPE, branchId: "b2" }, actorUserId: "u1", checkReceipts: never }), { ok: false, reason: WITHDRAW_NOT_YOURS });
  await localdb.operations.update(opId, { last_error_code: "awaiting_parked_prerequisite" });
  assert.deepEqual(await withdrawRefusedSale({ operationId: opId, scope: SCOPE, actorUserId: "u1", checkReceipts: never }), { ok: false, reason: WITHDRAW_SALE_NOT_REFUSED });
  await localdb.operations.update(opId, { status: "pending", last_error_code: null });
  assert.deepEqual(await withdrawRefusedSale({ operationId: opId, scope: SCOPE, actorUserId: "u1", checkReceipts: never }), { ok: false, reason: WITHDRAW_SALE_NOT_REFUSED });
  assert.equal(isWithdrawableRefusedSale({ operation_type: "takeaway_sale", status: "needs_attention", canonical_entity_id: "order-1", last_error_code: "x" }), false, "a sale Breadee recorded is never withdrawn");
  assert.equal(isWithdrawableRefusedSale({ operation_type: "pay_order", status: "needs_attention", canonical_entity_id: null, last_error_code: "x" }), false);
});

test("D-5: the state changing during the server check withdraws nothing", async () => {
  const opId = await refusedSale();
  const r = await withdrawRefusedSale({
    operationId: opId,
    scope: SCOPE,
    actorUserId: "u1",
    checkReceipts: async () => {
      await localdb.operations.update(opId, { retry_count: 2 });
      return { kind: "none" };
    },
  });
  assert.equal(r.ok, false);
  assert.equal((await getOperation(opId))?.status, "needs_attention");
});
