// Final Foundation, Track 13 residual R-1 — the ONLINE table settle carries the bill pin.
//
// Proven on staging: ONLINE Pay Table and ONLINE table On Account sent no expected_order_ids /
// expected_amount / client_op_id. Only the pre-charge re-read protected them, so a round from another
// terminal landing between that read and the RPC was charged (135,000 booked, 90,000 presented).
//
// The 1.0.38 server (staging, read-only confirmed): `pos_pay_table` / `pos_complete_table_on_account` wrap
// the core in `pos_op_replay` keyed on p_payload.client_op_id (uuid; recorded ONLY after the core
// succeeds), and the cores refuse a drifted bill with PAY_BILL_CHANGED / PAY_AMOUNT_CHANGED /
// ON_ACCOUNT_BILL_CHANGED / ON_ACCOUNT_AMOUNT_CHANGED (pos_op_error → details.pos_error_code). The fakes
// below model exactly that, so each test proves an end-to-end property, not a payload shape.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  BillChangedElsewhereError,
  PaymentAmbiguousError,
  createPaymentLatch,
  performTablePayment,
  setServerDeductsPriorPayments,
  tableSettlePins,
  type TablePaymentPayload,
  type TablePaymentResult,
} from "@/lib/pos/tablePayment";
import {
  OnAccountAmbiguousError,
  completeTableOnAccount,
  createOnAccountLatch,
  performOnAccount,
  type TableOnAccountPayload,
} from "@/lib/pos/onAccount";
import { PosRpcError } from "@/lib/pos/rpc";
import { classifyError } from "@/lib/pos/errors";
import type { BillOrder, TableBill, TableSummary } from "@/types/tables";

afterEach(() => setServerDeductsPriorPayments(null));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- fixtures (an LBP bill of 90,000 on screen) ------------------------------

const order = (id: string, amount: number, over: Partial<BillOrder> = {}): BillOrder => ({
  id,
  order_number: `A-${id}`,
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  pos_entity_version: 1,
  shift_id: "s1",
  branch_id: "b1",
  tenant_id: "t1",
  subtotal: amount,
  discount_amount: 0,
  total_amount: amount,
  currency: "LBP",
  exchange_rate: 89500,
  created_at: "2026-10-27T10:00:00Z",
  lines: [],
  ...over,
});

const billOf = (orders: BillOrder[], tableId = "tbl1"): TableBill => ({
  tableId,
  orders,
  subtotal: orders.reduce((s, o) => s + o.subtotal, 0),
  total: orders.reduce((s, o) => s + o.total_amount, 0),
  currency: "LBP",
  mixedCurrency: false,
  splitShift: false,
  batches: [1],
});

const tableRow = (over: Partial<TableSummary> = {}): TableSummary => ({
  id: "tbl1",
  name: "Table 5",
  seats: 4,
  occupied: true,
  status: "occupied",
  canonical: true,
  configured: true,
  sort_order: 5,
  orders: 1,
  order_number: "A-o1",
  opened_at: null,
  total: 90000,
  collected: 0,
  outstanding: 90000,
  currency: "LBP",
  mixed_currency: false,
  pos_entity_version: 1,
  ...over,
});

const freeRow = () => tableRow({ occupied: false, status: "available", orders: 0, order_number: null, total: null, collected: null, outstanding: null });

const refusal = (rpc: "pos_pay_table" | "pos_complete_table_on_account", code: string) =>
  new PosRpcError(rpc, "The bill on this table changed since the payment was captured. Reconnect and review before settling.", {
    status: 400,
    code: "P0001",
    details: JSON.stringify({ pos_error_code: code }),
  });

// --- a faithful fake of the 1.0.38 staging server ----------------------------

function fakeServer(initial: BillOrder[]) {
  const s = {
    orders: initial,
    paid: false,
    booked: [] as { amount: number; op: string | null }[],
    replays: new Map<string, unknown>(),
    sent: [] as Record<string, unknown>[],
  };
  const total = () => s.orders.reduce((a, o) => a + o.total_amount, 0);
  const ids = () => [...s.orders.map((o) => o.id)].sort();

  /** pos_pay_table: wrapper (pos_op_replay, record on success) + core pins. */
  async function payTable(p: TablePaymentPayload): Promise<TablePaymentResult> {
    s.sent.push({ ...p });
    const op = p.client_op_id ?? null;
    if (op && s.replays.has(op)) return { ...(s.replays.get(op) as TablePaymentResult) };
    if (s.paid || s.orders.length === 0) throw new PosRpcError("pos_pay_table", "No open order on this table to pay");
    if (p.expected_order_ids && JSON.stringify([...p.expected_order_ids].sort()) !== JSON.stringify(ids())) throw refusal("pos_pay_table", "PAY_BILL_CHANGED");
    if (p.expected_amount != null && Math.abs(total() - p.expected_amount) >= 0.005) throw refusal("pos_pay_table", "PAY_AMOUNT_CHANGED");
    s.paid = true;
    s.booked.push({ amount: total(), op });
    const r: TablePaymentResult = { ok: true, orders: s.orders.length, subtotal: total(), discount: 0, amount: total(), currency_code: "LBP", original_amount: total(), exchange_rate: 89500 };
    if (op) s.replays.set(op, r);
    return r;
  }

  /** pos_complete_table_on_account: same wrapper + pins (R before the amount paid now). */
  async function onAccount(p: TableOnAccountPayload): Promise<unknown> {
    s.sent.push({ ...p });
    const op = p.client_op_id ?? null;
    if (op && s.replays.has(op)) return s.replays.get(op);
    if (s.paid || s.orders.length === 0) throw new PosRpcError("pos_complete_table_on_account", "No open order on this table to place on account");
    if (p.expected_order_ids && JSON.stringify([...p.expected_order_ids].sort()) !== JSON.stringify(ids())) throw refusal("pos_complete_table_on_account", "ON_ACCOUNT_BILL_CHANGED");
    if (p.expected_amount != null && Math.abs(total() - p.expected_amount) >= 0.005) throw refusal("pos_complete_table_on_account", "ON_ACCOUNT_AMOUNT_CHANGED");
    s.paid = true;
    s.booked.push({ amount: total(), op });
    const r = { bill_total: total(), paid_usd: 0, outstanding_primary: total() - p.amount, orders: s.orders.length, subtotal: total(), discount: 0, currency_code: "LBP" };
    if (op) s.replays.set(op, r);
    return r;
  }

  /** The authoritative read the workspace would do (map + bill). */
  const read = () => (s.paid ? { bill: billOf([]), table: freeRow() } : { bill: billOf(s.orders), table: tableRow({ total: total() }) });
  return { s, payTable, onAccount, read };
}

function pay(server: ReturnType<typeof fakeServer>, shown: TableBill, over: Partial<Parameters<typeof performTablePayment>[0]> = {}) {
  const calls = { complete: 0 };
  const run = performTablePayment({
    shownBill: shown,
    table: tableRow(),
    payload: { table_id: "tbl1", method: "cash", currency_code: "LBP" },
    latch: createPaymentLatch(),
    reReadBill: async () => ({ bill: shown, table: tableRow() }),
    submit: server.payTable,
    recoverRead: async () => server.read(),
    complete: () => {
      calls.complete++;
    },
    refresh: async () => {},
    ...over,
  });
  return { calls, run };
}

// --- Pay Table ----------------------------------------------------------------

test("Pay: an unchanged bill settles exactly as before — same RPC result, pinned to what was presented", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const shown = billOf([order("o1", 90000)]);
  const { calls, run } = pay(server, shown);
  const outcome = await run;

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.result?.amount, 90000);
  assert.equal(calls.complete, 1);
  assert.deepEqual(server.s.booked.map((b) => b.amount), [90000]);
  const sent = server.s.sent[0] as TablePaymentPayload;
  assert.deepEqual(sent.expected_order_ids, ["o1"]);
  assert.equal(sent.expected_amount, 90000);
  assert.match(String(sent.client_op_id), UUID, "client_op_id must be a uuid (the server casts ::uuid)");
});

test("Pay: an older server that ignores the pin keys returns the identical result (backward compatible)", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const legacy = async (p: TablePaymentPayload) => server.payTable({ table_id: p.table_id, method: p.method, currency_code: p.currency_code });
  const outcome = await pay(server, billOf([order("o1", 90000)]), { submit: legacy }).run;
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.result?.amount, 90000);
});

test("Pay: another terminal's round between the re-read and the RPC is REFUSED — nothing booked, cashier told, never success", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const shown = billOf([order("o1", 90000)]);
  // The pre-charge re-read sees 90,000; the other terminal's 45,000 round lands right after it.
  const { calls, run } = pay(server, shown, {
    reReadBill: async () => {
      const r = { bill: shown, table: tableRow() };
      server.s.orders = [order("o1", 90000), order("o2", 45000)];
      return r;
    },
  });
  const outcome = await run;

  assert.equal(outcome.ok, false);
  assert.deepEqual(server.s.booked, [], "a bill the cashier never presented was charged");
  assert.equal(calls.complete, 0, "a refused payment ran the completion (receipt / cash box)");
  if (!outcome.ok) {
    assert.ok(outcome.error instanceof BillChangedElsewhereError);
    assert.equal((outcome.error as BillChangedElsewhereError).code, "PAY_BILL_CHANGED");
    assert.equal(outcome.retryable, false, "a refused bill was offered as 'try again'");
    const c = classifyError(outcome.error);
    assert.match(c.message, /^The bill changed before payment: it was changed on another terminal — refresh and check the total before collecting$/);
    assert.equal(c.kind, "stale_bill_total");
  }
});

test("Pay: a round appended to the SAME order (ids unchanged, 90,000 → 135,000) is refused by the amount pin", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const shown = billOf([order("o1", 90000)]);
  const outcome = await pay(server, shown, {
    reReadBill: async () => {
      server.s.orders = [order("o1", 135000)];
      return { bill: shown, table: tableRow() };
    },
  }).run;
  assert.equal(outcome.ok, false);
  assert.deepEqual(server.s.booked, []);
  if (!outcome.ok) assert.equal((outcome.error as BillChangedElsewhereError).code, "PAY_AMOUNT_CHANGED");
});

test("Pay: a retry after a LOST response reuses the same client_op_id — one payment, replayed", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const shown = billOf([order("o1", 90000)]);
  // Attempt 1: the server commits, the response is lost, and the recovery read fails too → ambiguous.
  const lost = async (p: TablePaymentPayload) => {
    await server.payTable(p);
    throw new Error("Failed to fetch");
  };
  const first = await pay(server, shown, {
    submit: lost,
    recoverRead: async () => {
      throw new Error("Failed to fetch");
    },
  }).run;
  assert.equal(first.ok, false);
  if (!first.ok) assert.ok(first.error instanceof PaymentAmbiguousError);

  // Attempt 2: the operator presses Pay again on the same bill (the re-read is still the stale copy).
  const second = await pay(server, shown).run;
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.result?.amount, 90000);

  const ops = server.s.sent.map((p) => (p as TablePaymentPayload).client_op_id);
  assert.equal(ops.length, 2);
  assert.equal(ops[0], ops[1], "the retry of the same attempt minted a new client_op_id");
  assert.equal(server.s.booked.length, 1, "the customer was charged twice");
});

test("Pay: a different choice (method) is a new attempt with a fresh client_op_id; success closes the attempt", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const shown = billOf([order("o1", 90000)]);
  const transport = async (p: TablePaymentPayload) => {
    server.s.sent.push({ ...p });
    throw new Error("Failed to fetch");
  };
  await pay(server, shown, { submit: transport }).run; // unpaid verdict → retryable, nothing booked
  await pay(server, shown, { submit: transport, payload: { table_id: "tbl1", method: "card", currency_code: "LBP" } }).run;
  const [a, b] = server.s.sent.map((p) => (p as TablePaymentPayload).client_op_id);
  assert.notEqual(a, b, "a changed method reused the op id of a different request");

  const ok = await pay(server, shown, { payload: { table_id: "tbl1", method: "card", currency_code: "LBP" } }).run;
  assert.equal(ok.ok, true);
  assert.equal(server.s.sent.at(-1)!.client_op_id, b, "the retry of the card attempt did not reuse its id");
  // A later bill on the same table is a new attempt.
  const next = fakeServer([order("o9", 20000)]);
  await pay(next, billOf([order("o9", 20000)]), { payload: { table_id: "tbl1", method: "card", currency_code: "LBP" } }).run;
  assert.notEqual(next.s.sent[0].client_op_id, b);
});

test("Pay pins: R = T − P only when the server deducts prior payments; the discount uses the server's math", () => {
  const b = billOf([order("o1", 90000)]);
  assert.deepEqual(tableSettlePins(b, tableRow(), undefined), { ok: true, pins: { expectedOrderIds: ["o1"], expectedAmount: 90000 } });
  setServerDeductsPriorPayments(true);
  assert.equal((tableSettlePins(b, tableRow({ collected: 30000 }), undefined) as { pins: { expectedAmount: number } }).pins.expectedAmount, 60000);
  setServerDeductsPriorPayments(null);
  assert.equal((tableSettlePins(b, tableRow(), { discount_type: "percent", discount_value: 10 }) as { pins: { expectedAmount: number } }).pins.expectedAmount, 81000);
  // A discount on a server part-paid bill is refused before the request (the server refuses it too).
  assert.equal(tableSettlePins(b, tableRow({ collected: 30000 }), { discount_type: "amount", discount_value: 5 }).ok, false);
  // Mixed currencies: no single figure → the order-id pin still applies, no amount pin.
  const mixed = { ...b, mixedCurrency: true, total: null };
  assert.deepEqual(tableSettlePins(mixed, tableRow(), undefined), { ok: true, pins: { expectedOrderIds: ["o1"], expectedAmount: null } });
});

// --- Table On Account ----------------------------------------------------------

function onAccount(server: ReturnType<typeof fakeServer>, shown: TableBill, rpc = server.onAccount, reread = async () => (server.s.paid ? ("committed" as const) : ("open" as const))) {
  return performOnAccount({
    latch: createOnAccountLatch(),
    submit: () => completeTableOnAccount({ tableId: "tbl1", customerId: "c1", amount: 0, method: "cash", shown: { bill: shown, table: tableRow() }, rpc }),
    reread,
  });
}

test("On Account: an unchanged bill books exactly as before, pinned to what was presented", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const outcome = await onAccount(server, billOf([order("o1", 90000)]));
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.result?.bill_total, 90000);
  const sent = server.s.sent[0] as TableOnAccountPayload;
  assert.deepEqual(sent.expected_order_ids, ["o1"]);
  assert.equal(sent.expected_amount, 90000);
  assert.match(String(sent.client_op_id), UUID);
  assert.equal(server.s.booked.length, 1);
});

test("On Account: another terminal's round is REFUSED — no receivable booked, cashier told, not retryable", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const shown = billOf([order("o1", 90000)]);
  server.s.orders = [order("o1", 90000), order("o2", 45000)]; // lands after the dialog was opened
  const outcome = await onAccount(server, shown);
  assert.equal(outcome.ok, false);
  assert.deepEqual(server.s.booked, []);
  if (!outcome.ok) {
    assert.ok(outcome.error instanceof BillChangedElsewhereError);
    assert.equal((outcome.error as BillChangedElsewhereError).code, "ON_ACCOUNT_BILL_CHANGED");
    assert.equal(outcome.retryable, false);
    assert.match(classifyError(outcome.error).message, /another terminal/);
  }
  // Same order, larger amount → the amount pin.
  const s2 = fakeServer([order("o1", 135000)]);
  const o2 = await onAccount(s2, shown);
  assert.equal(o2.ok, false);
  if (!o2.ok) assert.equal((o2.error as BillChangedElsewhereError).code, "ON_ACCOUNT_AMOUNT_CHANGED");
  assert.deepEqual(s2.s.booked, []);
});

test("On Account: a retry after a LOST response reuses the same client_op_id — one receivable", async () => {
  const server = fakeServer([order("o1", 90000)]);
  const shown = billOf([order("o1", 90000)]);
  const lost = async (p: TableOnAccountPayload) => {
    await server.onAccount(p);
    throw new Error("Failed to fetch");
  };
  const first = await onAccount(server, shown, lost, async () => {
    throw new Error("Failed to fetch");
  });
  assert.equal(first.ok, false);
  if (!first.ok) assert.ok(first.error instanceof OnAccountAmbiguousError);

  const second = await onAccount(server, shown);
  assert.equal(second.ok, true);
  const ops = server.s.sent.map((p) => (p as TableOnAccountPayload).client_op_id);
  assert.equal(ops[0], ops[1], "the retry minted a new client_op_id");
  assert.equal(server.s.booked.length, 1, "a second receivable was booked");
});

test("On Account without the bill in hand keeps the pre-1.0.38 payload (no pins, no op id)", async () => {
  const server = fakeServer([order("o1", 90000)]);
  await completeTableOnAccount({ tableId: "tbl1", customerId: "c1", amount: 0, method: "cash", rpc: server.onAccount });
  assert.deepEqual(Object.keys(server.s.sent[0]).sort(), ["amount", "customer_id", "method", "table_id"]);
});
