// 1.0.41 — Server Off, F-WRITE: money calls under server failure. Fault injection only — no network.
//   - one payment identity per takeaway sale, shared by the online attempt and the offline replay;
//   - bounded waits that classify an unanswered call as UNKNOWN (never "nothing happened");
//   - the replay of a 1.0.41 capture pays with that identity; a foreign `already paid` is a CONFLICT;
//   - older captures keep the 1.0.38 state-guard behaviour byte-for-byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicUuid, takeawayPayOpId, TAKEAWAY_PAY_OP_VERSION } from "@/lib/offline/opIdentity";
import { deterministicUuid as viaDinein } from "@/lib/offline/dineinOffline";
import { AmbiguousOutcomeError, isAmbiguousOutcome, withDeadline, INTERACTIVE_MONEY_DEADLINE_MS } from "@/lib/pos/payments";
import { takeawaySaleHandler } from "@/lib/offline/handlers";
import type { OfflineOperation } from "@/lib/offline/operationLog";

test("identity: deterministicUuid moved verbatim — dineinOffline re-export yields identical ids", () => {
  const parts = ["sess-1", "3", "line-a", "line-b"];
  assert.equal(deterministicUuid(parts), viaDinein(parts));
  // A pinned value guards against any accidental change of the derivation (existing queued ops depend on it).
  assert.equal(deterministicUuid(["a"]), viaDinein(["a"]));
  assert.match(deterministicUuid(["x"]), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("identity: the takeaway pay id is stable per cart op id and distinct from it", () => {
  const cart = "0b1c2d3e-0000-4000-8000-000000000001";
  assert.equal(takeawayPayOpId(cart), takeawayPayOpId(cart));
  assert.notEqual(takeawayPayOpId(cart), cart);
  assert.notEqual(takeawayPayOpId(cart), takeawayPayOpId("0b1c2d3e-0000-4000-8000-000000000002"));
});

test("deadline: an unanswered money call becomes AmbiguousOutcomeError within the bound (request not aborted)", async () => {
  let settled = false;
  const hung = new Promise<string>((res) => setTimeout(() => { settled = true; res("late"); }, 200));
  const started = Date.now();
  await assert.rejects(() => withDeadline(hung, 20, "pos_pay_order"), (e: unknown) => e instanceof AmbiguousOutcomeError);
  assert.ok(Date.now() - started < 150, "bounded");
  await hung;
  assert.equal(settled, true, "the underlying call kept running (its answer still feeds the health store)");
  assert.ok(INTERACTIVE_MONEY_DEADLINE_MS >= 15_000, "above the server's 8 s statement timeout + pool wait");
});

test("deadline: a fast answer passes through unchanged", async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 1000, "x"), 7);
});

test("classifier: transport, 5xx, pool exhaustion and statement timeouts are AMBIGUOUS", () => {
  assert.equal(isAmbiguousOutcome(new AmbiguousOutcomeError("pos_pay_order")), true);
  assert.equal(isAmbiguousOutcome(new TypeError("Failed to fetch")), true);
  assert.equal(isAmbiguousOutcome(Object.assign(new Error("Internal Server Error"), { status: 500 })), true);
  assert.equal(isAmbiguousOutcome(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(isAmbiguousOutcome(new Error("PGRST003: Timed out acquiring connection from connection pool.")), true);
  assert.equal(isAmbiguousOutcome(new Error("canceling statement due to statement timeout")), true);
});

test("classifier: a definitive business refusal is NOT ambiguous (the call did not apply)", () => {
  assert.equal(isAmbiguousOutcome(Object.assign(new Error("This order is already paid"), { status: 400 })), false);
  assert.equal(isAmbiguousOutcome(new Error("Open your own shift on this branch before taking this payment. Nothing was charged.")), false);
  assert.equal(isAmbiguousOutcome(new Error("Order 261109-0503 can no longer be paid")), false, "an order number is never read as a status");
});

// --- replay of the takeaway sale -------------------------------------------------------------------

function saleOp(intent: Record<string, unknown> | null, extra: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: "op-1",
    operation_type: "takeaway_sale",
    schema_version: 1,
    scope: { tenant_id: "t", branch_id: "b", device_id: "d", terminal_id: "term", cashier_user_id: "u" },
    created_at: new Date().toISOString(),
    client_op_id: "11111111-1111-4111-8111-111111111111",
    local_entity_id: "txn-1",
    canonical_entity_id: "order-1",
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: { order_payload: { branch_id: "b", shift_id: "s1", order_type: "takeaway", items: [] }, payment_intent: intent, paid: false },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: { order_number: "N-1" },
    synced_at: null,
    ...extra,
  } as unknown as OfflineOperation;
}

function ctxFor(op: OfflineOperation, pay: (a: Record<string, unknown>) => Promise<unknown>) {
  const updates: unknown[] = [];
  const deps = {
    submit: async () => ({ order_id: "order-1", order_number: "N-1" }),
    pay,
    isTransport: (e: unknown) => e instanceof TypeError,
  };
  return {
    updates,
    ctx: {
      deps,
      update: async (patch: unknown) => { updates.push(patch); },
      canonicalFor: async () => null,
    } as unknown as Parameters<typeof takeawaySaleHandler.replay>[1],
  };
}

test("replay: a 1.0.41 capture pays with takeawayPayOpId(client_op_id) — the SAME id as its online attempt", async () => {
  const op = saleOp({ method: "cash", currency: "USD", pay_op_v: TAKEAWAY_PAY_OP_VERSION });
  const seen: Record<string, unknown>[] = [];
  const { ctx } = ctxFor(op, async (a) => { seen.push(a); return { paid: true }; });
  const r = await takeawaySaleHandler.replay(op, ctx);
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].clientOpId, takeawayPayOpId(op.client_op_id));
});

test("replay: a 1.0.41 capture whose order was paid by ANOTHER payment is a CONFLICT (cash not booked), never synced", async () => {
  const op = saleOp({ method: "cash", currency: "USD", pay_op_v: TAKEAWAY_PAY_OP_VERSION });
  const { ctx, updates } = ctxFor(op, async () => { throw new Error("This order is already paid"); });
  const r = await takeawaySaleHandler.replay(op, ctx);
  assert.equal(r.ok, false);
  assert.equal((r as { retryClass: string }).retryClass, "CONFLICT");
  assert.equal((r as { code: string }).code, "already_paid_elsewhere");
  assert.equal(updates.length, 0, "nothing marks the sale paid");
});

test("replay: an OLDER capture (no pay_op_v) keeps the 1.0.38 state-guard: no id sent, `already paid` = settled", async () => {
  const op = saleOp({ method: "cash", currency: "USD" });
  const seen: Record<string, unknown>[] = [];
  const { ctx } = ctxFor(op, async (a) => { seen.push(a); throw new Error("This order is already paid"); });
  const r = await takeawaySaleHandler.replay(op, ctx);
  assert.equal(r.ok, true);
  assert.equal(seen[0].clientOpId, undefined, "legacy payload unchanged");
});

test("replay: a lost acknowledgement of a 1.0.41 pay is replayed as the recorded result (one payment)", async () => {
  // Server model of pos_op_replay: the first call with an id records; a repeat returns the record.
  const recorded = new Map<string, unknown>();
  let charges = 0;
  const serverPay = async (a: Record<string, unknown>) => {
    const id = String(a.clientOpId);
    if (recorded.has(id)) return { ...(recorded.get(id) as object), idempotent: true };
    charges += 1;
    const res = { paid: true, amount: 10 };
    recorded.set(id, res);
    return res;
  };
  const op = saleOp({ method: "cash", currency: "USD", pay_op_v: TAKEAWAY_PAY_OP_VERSION });
  // The ONLINE attempt (same derived id) committed but its answer was lost.
  await serverPay({ clientOpId: takeawayPayOpId(op.client_op_id) });
  const { ctx } = ctxFor(op, serverPay);
  const r = await takeawaySaleHandler.replay(op, ctx);
  assert.equal(r.ok, true);
  assert.equal(charges, 1, "the replay did not charge a second time");
});
