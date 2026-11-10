// 1.0.41 (S-CAPTURE) — offline capture evidence: when a sale/payment/shift was captured and at which rate.
//   - stamped once at creation from the till's currency; never overwritten;
//   - sent as `capture` on replay of the shift, sale, round, payment, split, on-account and end-shift calls;
//   - an operation captured before 1.0.41 (no stamp) replays BYTE-IDENTICALLY (no `capture` key anywhere);
//   - the server validates the evidence (Staging harness: cross-midnight, price change, FX change, replay,
//     forged price/rate, clock in the future / too old / before the shift, old client) — see RUNBOOK §S-CAPTURE.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureEvidenceFor, captureArg, captureOf, withCapture, CAPTURE_EVIDENCE_VERSION, type CaptureEvidence } from "@/lib/offline/captureEvidence";
import { applyCaptureStamp, setCaptureCurrencyProvider, type OfflineOperation } from "@/lib/offline/operationLog";
import { takeawaySaleHandler, endShiftHandler, openShiftHandler } from "@/lib/offline/handlers";
import { TAKEAWAY_PAY_OP_VERSION, takeawayPayOpId } from "@/lib/offline/opIdentity";
import { payOrder } from "@/lib/pos/payments";
import { openShiftWithOp } from "@/lib/pos/shifts";

const AT = "2026-11-09T21:50:00.000Z"; // 23:50 Beirut — the sale crosses midnight before it is replayed
const EVIDENCE: CaptureEvidence = { v: 1, captured_at: AT, usd_to_lbp_rate: 89500, primary_currency: "LBP" };

function op(type: string, payload: unknown, extra: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: "op-1",
    operation_type: type,
    schema_version: 1,
    scope: { tenant_id: "t", branch_id: "b", device_id: "d", terminal_id: "term", cashier_user_id: "u" },
    created_at: AT,
    client_op_id: "11111111-1111-4111-8111-111111111111",
    local_entity_id: "local-1",
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload,
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    ...extra,
  } as unknown as OfflineOperation;
}

function ctxWith(deps: Record<string, unknown>) {
  return {
    deps: { isTransport: (e: unknown) => e instanceof TypeError, ...deps },
    update: async () => undefined,
    canonicalFor: async () => null,
  } as unknown as Parameters<typeof takeawaySaleHandler.replay>[1];
}

// --- the evidence ------------------------------------------------------------------------------------------------

test("evidence = the op's capture time + the till's rate at that moment (bad rate → null, bad time → none)", () => {
  assert.deepEqual(captureEvidenceFor(AT, { primary: "LBP", rate: 89500 }), EVIDENCE);
  assert.equal(captureEvidenceFor(AT, { primary: "USD", rate: 0 })?.usd_to_lbp_rate, null);
  assert.equal(captureEvidenceFor(AT, { primary: "USD", rate: Number.NaN })?.usd_to_lbp_rate, null);
  assert.equal(captureEvidenceFor(AT, null)?.usd_to_lbp_rate, null);
  assert.equal(captureEvidenceFor("not a date", { primary: "USD", rate: 1 }), null);
  assert.equal(captureEvidenceFor("", { primary: "USD", rate: 1 }), null);
  assert.equal(CAPTURE_EVIDENCE_VERSION, 1);
});

test("stamped once at creation from the till's currency; an existing stamp is never overwritten", () => {
  setCaptureCurrencyProvider(() => ({ primary: "LBP", rate: 89500 }));
  try {
    const o = op("takeaway_sale", {});
    applyCaptureStamp(o);
    assert.deepEqual(o.capture, EVIDENCE);
    setCaptureCurrencyProvider(() => ({ primary: "LBP", rate: 95000 })); // the rate changes later
    applyCaptureStamp(o);
    assert.equal(o.capture?.usd_to_lbp_rate, 89500, "the captured rate stays the rate the cash was taken at");
    const throwing = op("takeaway_sale", {});
    setCaptureCurrencyProvider(() => { throw new Error("store gone"); });
    applyCaptureStamp(throwing);
    assert.equal(throwing.capture?.usd_to_lbp_rate, null, "a failing provider still records the time, never blocks the capture");
  } finally {
    setCaptureCurrencyProvider(null);
  }
  const none = op("takeaway_sale", {});
  applyCaptureStamp(none);
  assert.equal(none.capture, undefined, "no provider (tests / early boot) → no stamp, older behaviour");
});

test("withCapture/captureArg: absent evidence leaves the request byte-identical (the SAME object)", () => {
  const payload = { a: 1 };
  assert.equal(withCapture(payload, null), payload);
  assert.deepEqual(captureArg(op("x", {})), {});
  assert.deepEqual(withCapture(payload, EVIDENCE), { a: 1, capture: EVIDENCE });
  assert.deepEqual(captureArg(op("x", {}, { capture: EVIDENCE })), { capture: EVIDENCE });
  assert.equal(captureOf(op("x", {}, { capture: { ...EVIDENCE, v: 2 } as unknown as CaptureEvidence })), null, "unknown evidence version is not sent");
});

// --- replay carries it --------------------------------------------------------------------------------------------

const SALE = { order_payload: { branch_id: "b", shift_id: "s1", order_type: "takeaway", items: [{ menu_item_id: "m", base_price: 45000, quantity: 1, modifiers: [] }] } };

test("takeaway sale: the order AND its cash payment are sent with the capture evidence", async () => {
  const submits: Record<string, unknown>[] = [];
  const pays: Record<string, unknown>[] = [];
  const o = op("takeaway_sale", { ...SALE, payment_intent: { method: "cash", currency: "LBP", pay_op_v: TAKEAWAY_PAY_OP_VERSION }, paid: false }, { capture: EVIDENCE });
  const r = await takeawaySaleHandler.replay(o, ctxWith({
    submit: async (p: Record<string, unknown>) => { submits.push(p); return { order_id: "order-1", order_number: "N-1" }; },
    pay: async (a: Record<string, unknown>) => { pays.push(a); return { paid: true }; },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(submits[0].capture, EVIDENCE);
  assert.deepEqual((submits[0] as { items: unknown }).items, SALE.order_payload.items, "the captured prices are sent unchanged");
  assert.deepEqual(pays[0].capture, EVIDENCE);
  assert.equal(pays[0].clientOpId, takeawayPayOpId(o.client_op_id));
});

test("OLD-CLIENT COMPAT: an op captured before 1.0.41 replays exactly as before (no capture key anywhere)", async () => {
  const submits: Record<string, unknown>[] = [];
  const pays: Record<string, unknown>[] = [];
  const legacy = op("takeaway_sale", { ...SALE, payment_intent: { method: "cash", currency: "USD", pay_op_v: TAKEAWAY_PAY_OP_VERSION }, paid: false });
  await takeawaySaleHandler.replay(legacy, ctxWith({
    submit: async (p: Record<string, unknown>) => { submits.push(p); return { order_id: "order-1", order_number: "N-1" }; },
    pay: async (a: Record<string, unknown>) => { pays.push(a); return { paid: true }; },
  }));
  assert.equal(submits[0], SALE.order_payload, "the stored payload object itself, unmodified");
  assert.equal("capture" in pays[0], false);
});

test("a pre-1.0.41 pay intent (no pay op id) never sends evidence: the server only reads it on the client_op_id path", async () => {
  const pays: Record<string, unknown>[] = [];
  const o = op("takeaway_sale", { ...SALE, payment_intent: { method: "cash", currency: "USD" }, paid: false }, { capture: EVIDENCE });
  await takeawaySaleHandler.replay(o, ctxWith({
    submit: async () => ({ order_id: "order-1", order_number: "N-1" }),
    pay: async (a: Record<string, unknown>) => { pays.push(a); return { paid: true }; },
  }));
  assert.equal("capture" in pays[0], false);
});

test("open shift and end shift carry the evidence (shift opened/closed at its real time)", async () => {
  const opens: Record<string, unknown>[] = [];
  await openShiftHandler.replay(op("open_shift", { branchId: "b", openingCash: 0 }, { capture: EVIDENCE }), ctxWith({
    openShift: async (a: Record<string, unknown>) => { opens.push(a); return { shiftId: "s1", reused: false }; },
  }));
  assert.deepEqual(opens[0].capture, EVIDENCE);
  const ends: Record<string, unknown>[] = [];
  await endShiftHandler.replay(op("end_shift", { shift_id: "s1", shift_local: null, actual_cash_counted: 10, notes: null }, { capture: EVIDENCE }), ctxWith({
    endShiftOp: async (a: Record<string, unknown>) => { ends.push(a); return { shift_id: "s1", idempotent: false }; },
  }));
  assert.deepEqual(ends[0].capture, EVIDENCE);
  const legacyEnds: Record<string, unknown>[] = [];
  await endShiftHandler.replay(op("end_shift", { shift_id: "s1", shift_local: null, actual_cash_counted: 10, notes: null }), ctxWith({
    endShiftOp: async (a: Record<string, unknown>) => { legacyEnds.push(a); return { shift_id: "s1", idempotent: false }; },
  }));
  assert.equal("capture" in legacyEnds[0], false);
});

// --- the wire ---------------------------------------------------------------------------------------------------

function recordingClient(row: Record<string, unknown>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: { rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return { data: row, error: null, status: 200 }; } },
  };
}

test("wire: pos_pay_order / pos_open_shift p_payload gain `capture` only when given", async () => {
  const a = recordingClient({ order_id: "o1", paid: true, currency_code: "LBP" });
  await payOrder({ orderId: "o1", method: "cash", currency: "LBP", clientOpId: "c1", capture: EVIDENCE }, a.client as never);
  assert.deepEqual((a.calls[0].args.p_payload as Record<string, unknown>).capture, EVIDENCE);
  const b = recordingClient({ order_id: "o1", paid: true, currency_code: "USD" });
  await payOrder({ orderId: "o1", method: "cash", currency: "USD", clientOpId: "c1" }, b.client as never);
  assert.deepEqual(b.calls[0].args.p_payload, { order_id: "o1", method: "cash", currency_code: "USD", client_op_id: "c1" }, "online payload unchanged");
  const c = recordingClient({ shift_id: "s1", reused: false });
  await openShiftWithOp({ branchId: "b", openingCash: 0, clientOpId: "c2", capture: EVIDENCE }, c.client as never);
  assert.deepEqual((c.calls[0].args.p_payload as Record<string, unknown>).capture, EVIDENCE);
  const d = recordingClient({ shift_id: "s1", reused: false });
  await openShiftWithOp({ branchId: "b", openingCash: 0, clientOpId: "c2" }, d.client as never);
  assert.deepEqual(d.calls[0].args.p_payload, { branch_id: "b", opening_cash_amount: 0, client_op_id: "c2" });
});

test("every capture-capable replay dep forwards `capture` into its p_payload (pay table, pay order, split, on-account, end shift)", () => {
  const src = readFileSync(join(process.cwd(), "src", "lib", "offline", "posTxnSync.ts"), "utf8");
  for (const rpc of ["pos_pay_table", "pos_complete_table_on_account", "pos_complete_on_account"]) {
    assert.match(src, new RegExp(`if \\(args\\.capture\\) payload\\.capture = args\\.capture; // 1\\.0\\.41 \\(S-CAPTURE\\)\\r?\\n\\s+const row = \\(await callPosRpc\\("${rpc}"`), rpc);
  }
  assert.equal((src.match(/\.\.\.\(args\.capture \? \{ capture: args\.capture \} : \{\}\)/g) ?? []).length, 4, "pay (takeaway), pay order, end shift, split");
  const h = readFileSync(join(process.cwd(), "src", "lib", "offline", "handlers.ts"), "utf8");
  assert.equal((h.match(/captureArg\(op\)/g) ?? []).length, 8, "open shift, takeaway pay, pay table, pay order, on-account table/order, end shift, split");
  assert.equal((h.match(/withCapture\(payload, captureOf\(op\)\)/g) ?? []).length, 2, "takeaway submit + dine-in round");
  const main = readFileSync(join(process.cwd(), "src", "main.tsx"), "utf8");
  assert.match(main, /setCaptureCurrencyProvider\(\(\) => useSession\.getState\(\)\.currency\)/);
});
