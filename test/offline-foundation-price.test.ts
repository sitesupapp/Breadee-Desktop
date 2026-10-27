// Final Foundation (PRICE) — client classification of the server's line price check.
//
// The server (foundation_price_integrity) refuses a submit / round / line edit whose captured price is no
// longer the menu price (PRICE_CHANGED), whose quantity / price is not positive (INVALID_LINE_QUANTITY /
// INVALID_LINE_PRICE) or that sets a custom price without pos.price_override (PRICE_OVERRIDE_NOT_PERMITTED).
// The whole transaction rolls back and the client_op_id is NOT recorded. The desktop must park it as a
// visible CONFLICT for review — never a retry, never "validation"/"permission", never a silent reprice.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { priceRefusalCode, dineinSendRoundHandler, takeawaySaleHandler, type HandlerContext } from "@/lib/offline/handlers";
import { classifyOperation, dispositionOf, PRICE_CONFLICT_REASON, STALE_BILL_ROUND_REASON } from "@/lib/offline/queueForensics";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";

/** A PostgREST error as supabase-js surfaces a pos_op_error refusal (P0001 + details.pos_error_code). */
function posOpError(code: string, message: string) {
  return Object.assign(new Error(message), { code: "P0001", details: JSON.stringify({ pos_error_code: code }), hint: null });
}

const MSG = {
  PRICE_CHANGED: 'The price of "Burger" changed since this order was taken (sent 720000). Review the order and send it again at the current menu price.',
  OPTION_CHANGED: 'The price of option "Add Turkey" on "Burger" changed since this order was taken (sent 1). Review the order and send it again at the current menu price.',
  OVERRIDE: '"Custom cake" is a custom-priced item and you do not have permission to set item prices.',
  OVERRIDE_OPTION: 'Option "Extra love" on "Burger" has a custom price and you do not have permission to set item prices.',
  QTY: "Line 1 (Burger): the quantity must be greater than zero.",
  OPT_QTY: 'Line 2 (Burger): option "Add Turkey" must have a quantity greater than zero.',
  PRICE: "Line 1 (Burger): the price cannot be negative.",
  OPT_PRICE: 'Line 1 (Burger): option "Add Turkey" cannot have a negative price.',
};

function ctxThrowing(err: unknown, calls: string[]): HandlerContext {
  const fail = async () => {
    calls.push("server");
    throw err;
  };
  const deps = {
    isTransport: () => false,
    submit: fail,
    submitRound: fail,
    pay: async () => {
      calls.push("pay");
    },
  } as unknown as PosTxnSyncDeps;
  return {
    deps,
    canonicalFor: async () => null,
    update: async () => {},
  };
}

function op(over: Partial<OfflineOperation>): OfflineOperation {
  return {
    operation_id: "op-price-1",
    client_op_id: "11111111-1111-4111-8111-111111111111",
    operation_type: "takeaway_sale",
    schema_version: 1,
    status: "needs_attention",
    payload: {},
    dependency_ids: [],
    depends_on_local_entities: [],
    local_entity_id: null,
    canonical_entity_id: null,
    result_meta: null,
    retry_count: 0,
    last_error_code: null,
    last_error_message: null,
    created_at: "2026-10-27T00:00:00.000Z",
    scope: { tenant_id: "t", branch_id: "b", cashier_user_id: "u", device_id: "d", terminal_id: "T1" },
    ...over,
  } as unknown as OfflineOperation;
}

const ITEMS = [{ menu_item_id: "35d2d011-06e6-4190-bbc0-e40ed4566611", name: "Burger", base_price: 720000, quantity: 1, modifiers: [] }];

test("P1 structured pos_error_code wins: the four price codes map to their lower-case op code", () => {
  assert.equal(priceRefusalCode(MSG.PRICE_CHANGED, posOpError("PRICE_CHANGED", MSG.PRICE_CHANGED)), "price_changed");
  assert.equal(priceRefusalCode(MSG.OVERRIDE, posOpError("PRICE_OVERRIDE_NOT_PERMITTED", MSG.OVERRIDE)), "price_override_not_permitted");
  assert.equal(priceRefusalCode(MSG.QTY, posOpError("INVALID_LINE_QUANTITY", MSG.QTY)), "invalid_line_quantity");
  assert.equal(priceRefusalCode(MSG.PRICE, posOpError("INVALID_LINE_PRICE", MSG.PRICE)), "invalid_line_price");
});

test("P2 message-only fallback (call sites that keep only the server text) recognises the fixed server wording", () => {
  assert.equal(priceRefusalCode(MSG.PRICE_CHANGED), "price_changed");
  assert.equal(priceRefusalCode(MSG.OPTION_CHANGED), "price_changed");
  assert.equal(priceRefusalCode(MSG.OVERRIDE), "price_override_not_permitted");
  assert.equal(priceRefusalCode(MSG.OVERRIDE_OPTION), "price_override_not_permitted");
  assert.equal(priceRefusalCode(MSG.QTY), "invalid_line_quantity");
  assert.equal(priceRefusalCode(MSG.OPT_QTY), "invalid_line_quantity");
  assert.equal(priceRefusalCode(MSG.PRICE), "invalid_line_price");
  assert.equal(priceRefusalCode(MSG.OPT_PRICE), "invalid_line_price");
  assert.equal(priceRefusalCode("refused: PRICE_CHANGED"), "price_changed");
});

test("P3 unrelated refusals are untouched (no false positives)", () => {
  for (const m of [
    "This table's bill changed since it was opened offline and cannot take this round",
    "This order changed since it was loaded. Reload and retry.",
    "You do not have permission to create orders",
    "Delivery fee cannot be negative",
    "quantity must be > 0",
    "Use your own open shift for this order",
  ]) {
    assert.equal(priceRefusalCode(m), null, m);
    assert.equal(priceRefusalCode(m, posOpError("VERSION_CONFLICT", m)), null, m);
  }
});

test("P4 takeaway sale refused PRICE_CHANGED → CONFLICT price_changed, no payment attempted, no canonical id", async () => {
  const calls: string[] = [];
  const r = await takeawaySaleHandler.replay(
    op({ payload: { order_payload: { order_type: "takeaway", branch_id: "b", shift_id: "s", items: ITEMS }, payment_intent: { method: "cash", currency: "LBP" } } }),
    ctxThrowing(posOpError("PRICE_CHANGED", MSG.PRICE_CHANGED), calls),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.retryClass, "CONFLICT");
  assert.equal(r.code, "price_changed");
  assert.deepEqual(calls, ["server"], "the cash payment must never run after a refused submit");
});

test("P5 dine-in round refused PRICE_OVERRIDE_NOT_PERMITTED → CONFLICT (not AUTHORITY_REFUSED, not expected_order_mismatch)", async () => {
  const calls: string[] = [];
  const r = await dineinSendRoundHandler.replay(
    op({
      operation_type: "dinein_send_round",
      payload: { submit: { order_type: "dine_in", branch_id: "b", shift_id: "s", table_id: "tbl", items: ITEMS }, table_local: null, session_local: null },
    }),
    ctxThrowing(posOpError("PRICE_OVERRIDE_NOT_PERMITTED", MSG.OVERRIDE), calls),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.retryClass, "CONFLICT");
  assert.equal(r.code, "price_override_not_permitted");
});

test("P6 dine-in round refused INVALID_LINE_QUANTITY → CONFLICT invalid_line_quantity (never VALIDATION_TERMINAL)", async () => {
  const r = await dineinSendRoundHandler.replay(
    op({
      operation_type: "dinein_send_round",
      payload: { submit: { order_type: "dine_in", branch_id: "b", shift_id: "s", table_id: "tbl", items: ITEMS }, table_local: null, session_local: null },
    }),
    ctxThrowing(posOpError("INVALID_LINE_QUANTITY", MSG.QTY), []),
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.retryClass, "CONFLICT");
  assert.equal(r.code, "invalid_line_quantity");
});

test("P7 Sync Center: a parked price refusal is a visible PRICE_CONFLICT for manual review", () => {
  const parked = op({ last_error_code: "price_changed", last_error_message: MSG.PRICE_CHANGED });
  const c = classifyOperation(parked);
  assert.equal(c.category, "PRICE_CONFLICT");
  assert.equal(c.reason, PRICE_CONFLICT_REASON);
  assert.equal(PRICE_CONFLICT_REASON, "Price changed since this order was taken offline — needs review");
  assert.equal(dispositionOf(parked, c.category, null), "MANUAL_REVIEW");
  for (const code of ["price_override_not_permitted", "invalid_line_quantity", "invalid_line_price"]) {
    const o = op({ operation_type: "dinein_send_round", last_error_code: code, last_error_message: "x" });
    assert.equal(classifyOperation(o).category, "PRICE_CONFLICT", code);
    assert.equal(dispositionOf(o, "PRICE_CONFLICT", null), "MANUAL_REVIEW");
  }
});

test("P8 regressions: stale-bill rounds, waiting and unrelated validation keep their classes", () => {
  const stale = op({ operation_type: "dinein_send_round", last_error_code: "expected_order_mismatch", last_error_message: "bill changed" });
  assert.deepEqual(classifyOperation(stale), { category: "STALE_BILL_ROUND", reason: STALE_BILL_ROUND_REASON });
  assert.equal(classifyOperation(op({ status: "pending" })).category, "WAITING");
  assert.equal(classifyOperation(op({ last_error_code: "validation", last_error_message: "Invalid order type" })).category, "REAL_REPLAY_BUG");
  assert.equal(classifyOperation(op({ last_error_code: "permission", last_error_message: "You do not have permission to create orders" })).category, "AUTHORITY_REFUSED");
});
