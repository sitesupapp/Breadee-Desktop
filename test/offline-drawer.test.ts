// Phase D — LOCAL DRAWER PROJECTION (operational continuity only). Pure core + the best-effort
// extraction from the operation log. NOT accounting; the server drawer stays authoritative after
// sync. Proves: cash in/out math + sign rule, per-method totals, an offline CASH refund reduces
// the projection immediately, scope exactness, and unknown-amount ops are counted not guessed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDrawerProjection, extractDrawerMovements, type DrawerMovement } from "@/lib/offline/drawerProjection";
import type { OfflineOperation } from "@/lib/offline/operationLog";

const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
const opScope = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };

function op(type: string, payload: Record<string, unknown>, over: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: over.operation_id ?? ("op-" + Math.random().toString(36).slice(2)),
    operation_type: type,
    schema_version: 1,
    scope: over.scope ?? opScope,
    created_at: new Date().toISOString(),
    client_op_id: "c-" + Math.random().toString(36).slice(2),
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload,
    status: over.status ?? "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    ...over,
  };
}

test("pure core: opening float + cash sales − cash refunds − cash payouts; per-method net", () => {
  const movements: DrawerMovement[] = [
    { kind: "sale", method: "cash", amountUsd: 10, operationId: "a" },
    { kind: "sale", method: "cash", amountUsd: 5.5, operationId: "b" },
    { kind: "refund", method: "cash", amountUsd: 2, operationId: "c" },
    { kind: "payout", method: "cash", amountUsd: 3, operationId: "d" },
    { kind: "sale", method: "visa", amountUsd: 20, operationId: "e" },
  ];
  const d = computeDrawerProjection(50, movements);
  assert.equal(d.openingFloatUsd, 50);
  assert.equal(d.cashInUsd, 15.5);
  assert.equal(d.cashOutUsd, 5);
  assert.equal(d.expectedCashUsd, 60.5); // 50 + 15.5 − 5
  assert.equal(d.byMethod.cash, 10.5); // 10 + 5.5 − 2 − 3
  assert.equal(d.byMethod.visa, 20);
  assert.equal(d.pending, true);
});

test("pure core: empty drawer is just the float, not pending", () => {
  const d = computeDrawerProjection(25, []);
  assert.equal(d.expectedCashUsd, 25);
  assert.equal(d.pending, false);
  assert.equal(d.movementCount, 0);
});

test("extract: a cash settle is a sale IN; an offline CASH refund reduces the drawer immediately", () => {
  const ops = [
    op("pay_table", { table_id: "T1", method: "cash", currency: "USD", cash_amount_usd: 12 }),
    op("void_refund", { order_id: "O1", refund: true, tender: "cash", expected_refund_usd: 4 }),
  ];
  const { movements, unknownAmountCount } = extractDrawerMovements(ops, SCOPE);
  assert.equal(unknownAmountCount, 0);
  const d = computeDrawerProjection(0, movements);
  assert.equal(d.cashInUsd, 12);
  assert.equal(d.cashOutUsd, 4);
  assert.equal(d.expectedCashUsd, 8); // refund reduced it
});

test("extract: a non-cash settle contributes to its method total, not to cash", () => {
  const ops = [op("pay_table", { table_id: "T1", method: "visa", currency: "USD", cash_amount_usd: 30 })];
  const { movements } = extractDrawerMovements(ops, SCOPE);
  const d = computeDrawerProjection(10, movements);
  assert.equal(d.cashInUsd, 0);
  assert.equal(d.expectedCashUsd, 10);
  assert.equal(d.byMethod.visa, 30);
});

test("extract: on_account is a RECEIVABLE, never a drawer movement", () => {
  const ops = [op("on_account_table", { table_id: "T1", customer_id: "C1", amount: 15, method: "cash" })];
  const { movements } = extractDrawerMovements(ops, SCOPE);
  assert.equal(movements.length, 0);
});

test("extract: an op with NO locally-known USD amount is counted as unknown, never guessed", () => {
  const ops = [op("pay_table", { table_id: "T1", method: "cash", currency: "LBP" })]; // no cash_amount_usd
  const { movements, unknownAmountCount } = extractDrawerMovements(ops, SCOPE);
  assert.equal(movements.length, 0);
  assert.equal(unknownAmountCount, 1);
  const d = computeDrawerProjection(0, movements, { unknownAmountCount });
  assert.equal(d.pending, true); // unreconcilable offline → explicitly pending
});

test("extract: a cancelled op never contributes", () => {
  const ops = [op("pay_table", { table_id: "T1", method: "cash", currency: "USD", cash_amount_usd: 12 }, { status: "cancelled" })];
  const { movements } = extractDrawerMovements(ops, SCOPE);
  assert.equal(movements.length, 0);
});

test("extract: scope-exact — another terminal's cash ops are NOT in this drawer", () => {
  const ops = [
    op("pay_table", { table_id: "T1", method: "cash", currency: "USD", cash_amount_usd: 12 }, { scope: { ...opScope, terminal_id: "OTHER" } }),
    op("pay_table", { table_id: "T2", method: "cash", currency: "USD", cash_amount_usd: 7 }),
  ];
  const { movements } = extractDrawerMovements(ops, SCOPE);
  assert.equal(movements.length, 1);
  assert.equal(movements[0].amountUsd, 7);
});
