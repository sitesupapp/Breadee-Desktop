// Delivery order management: the queue, the edit, and the two void actions.
//
// The financial weight in this file is all on one distinction. `pos_void_order`
// takes a `p_refund` boolean, and getting it wrong is not a cosmetic error: on a
// paid order the wrong value is refused outright, and on an unpaid order the
// wrong value would ask the server to reverse money that was never taken. The
// desktop therefore never chooses a flag - it derives the ACTION from the
// order's own payment state, and the flag from the action.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DELIVERY_QUEUE_LIMIT,
  EDIT_PAYLOAD_KEYS,
  FORBIDDEN_EDIT_FIELDS,
  MutationAmbiguousError,
  MutationInProgressError,
  OrderChangedError,
  OrderTerminalError,
  ReasonRequiredError,
  TERMINAL_ORDER_STATUSES,
  buildEditPayload,
  checkOrderContext,
  createMutationLatch,
  editOrderGate,
  isTerminal,
  performEdit,
  performVoid,
  queueCounts,
  recognisedTotal,
  refundFlagFor,
  todayBounds,
  validateVoidReason,
  voidActionFor,
  voidOrderGate,
  voidReached,
  type DeliveryQueueOrder,
  type EditOrderPayload,
  type EditOrderResult,
  type VoidOrderResult,
} from "@/lib/pos/deliveryOrderManagement";
import { stripComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const allow = { allowed: true, reason: null };
const denyEdit = { allowed: false, reason: "You do not have permission to edit orders." };
const denyCancel = { allowed: false, reason: "You do not have permission to cancel orders." };
const denyDiscount = { allowed: false, reason: "You do not have permission to apply discounts." };

const order = (over: Partial<DeliveryQueueOrder> = {}): DeliveryQueueOrder => ({
  id: "o1",
  order_number: "260810-0001",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  payment_method: null,
  subtotal: 7,
  discount_amount: 0,
  total_amount: 7,
  currency: "USD",
  customer_id: "c1",
  address_id: "a1",
  notes: "Desktop Level 3D order management verification",
  shift_id: "s1",
  created_at: "2026-08-10T09:00:00Z",
  ...over,
});

const paid = () => order({ status: "completed", payment_status: "paid", payment_method: "cash" });

// --- the queue ---------------------------------------------------------------

test("the queue reads at most what the web reads", () => {
  assert.equal(DELIVERY_QUEUE_LIMIT, 200);
});

test("terminal statuses are exactly the three the server produces", () => {
  assert.deepEqual([...TERMINAL_ORDER_STATUSES], ["voided", "cancelled", "refunded"]);
  for (const s of TERMINAL_ORDER_STATUSES) assert.equal(isTerminal(s), true);
  assert.equal(isTerminal("sent_to_kitchen"), false);
  assert.equal(isTerminal("completed"), false);
});

test("today's bounds are the operator's local day, not UTC's", () => {
  const { start, end } = todayBounds(new Date(2026, 7, 10, 23, 30));
  const s = new Date(start);
  const e = new Date(end);
  assert.equal(s.getHours(), 0);
  assert.equal(s.getDate(), 10);
  assert.equal(e.getDate(), 11);
  assert.equal(e.getTime() - s.getTime(), 24 * 60 * 60 * 1000);
});

test("the queue summarises only states the server actually produces", () => {
  const c = queueCounts([order(), paid(), order({ status: "voided" }), order({ status: "refunded" })]);
  assert.deepEqual(c, { unpaid: 1, paid: 1, cancelled: 2 });
});

test("a voided order contributes nothing to recognised money", () => {
  assert.equal(recognisedTotal(order()), 7);
  assert.equal(recognisedTotal(paid()), 7);
  assert.equal(recognisedTotal(order({ status: "voided" })), 0);
  assert.equal(recognisedTotal(order({ status: "refunded" })), 0);
});

test("the queue is scoped by tenant, branch, delivery, newest first", () => {
  const code = stripComments(read("lib", "pos", "deliveryOrderManagement.ts"));
  const fn = code.slice(code.indexOf("export async function loadDeliveryQueue"), code.indexOf("export function queueCounts"));
  assert.match(fn, /\.eq\("tenant_id", input\.tenantId\)/);
  assert.match(fn, /\.eq\("branch_id", input\.branchId\)/);
  assert.match(fn, /\.eq\("order_type", "delivery"\)/);
  assert.match(fn, /\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(fn, /\.limit\(DELIVERY_QUEUE_LIMIT\)/);
  // Shift when there is one, today when there is not - the web's own scope.
  assert.match(fn, /if \(input\.shiftId\)[\s\S]{0,120}\.eq\("shift_id", input\.shiftId\)/);
  assert.match(fn, /todayBounds[\s\S]{0,120}\.gte\("created_at", start\)\.lt\("created_at", end\)/);
});

test("the queue and detail reads never write", () => {
  const code = stripComments(read("lib", "pos", "deliveryOrderManagement.ts"));
  const froms = [...code.matchAll(/\.from\("pos_[a-z_]+"\)\s*\.(\w+)/g)].map((m) => m[1]);
  assert.ok(froms.length >= 4);
  assert.deepEqual([...new Set(froms)], ["select"]);
});

// --- the branch check neither RPC performs -----------------------------------

test("an order from another branch is refused before any mutation", () => {
  // Both RPCs assert only the tenant, so this is the only place it happens.
  const ctx = { orderId: "o1", branchOrderIds: new Set(["o1"]) };
  assert.doesNotThrow(() => checkOrderContext(order(), ctx));
  assert.throws(
    () => checkOrderContext(order(), { orderId: "o1", branchOrderIds: new Set<string>() }),
    /does not belong to this branch/,
  );
});

test("a vanished, swapped or terminal order stops the action", () => {
  const ctx = { orderId: "o1", branchOrderIds: new Set(["o1", "o2"]) };
  assert.throws(() => checkOrderContext(null, ctx), OrderChangedError);
  assert.throws(() => checkOrderContext(order({ id: "o2" }), ctx), /different order/);
  assert.throws(() => checkOrderContext(order({ status: "voided" }), ctx), OrderTerminalError);
});

// --- edit --------------------------------------------------------------------

const editGate = (over: Record<string, unknown> = {}) =>
  editOrderGate({ deliveryAccess: allow, canEditOrders: allow, order: order(), online: true, busy: false, ...over });

test("editing needs the edit permission, a live order and a connection", () => {
  assert.equal(editGate().allowed, true);
  assert.equal(editGate({ canEditOrders: denyEdit }).reason, denyEdit.reason);
  assert.match(editGate({ online: false }).reason ?? "", /needs a connection/i);
  assert.match(editGate({ busy: true }).reason ?? "", /already being sent/i);
  assert.equal(editGate({ order: null }).allowed, false);
});

test("a terminal order cannot be edited", () => {
  for (const status of TERMINAL_ORDER_STATUSES) {
    const g = editGate({ order: order({ status }) });
    assert.equal(g.allowed, false, `${status} should refuse editing`);
    assert.match(g.reason ?? "", new RegExp(status));
  }
});

test("a PAID order may still have its note edited - the server allows it", () => {
  assert.equal(editGate({ order: paid() }).allowed, true);
});

test("the edit payload has exactly the keys pos_edit_order reads", () => {
  assert.deepEqual([...EDIT_PAYLOAD_KEYS], ["order_id", "note", "discount_type", "discount_value"]);
});

test("an edit never carries a customer, an address or items", () => {
  for (const f of ["customer_id", "address_id", "items", "shift_id", "table_id", "status", "total_amount"]) {
    assert.ok(FORBIDDEN_EDIT_FIELDS.includes(f as never), `${f} should be forbidden on an edit`);
  }
});

test("a note-only edit sends ONLY the note - the server detects keys by presence", () => {
  // An unnecessary discount pair would be refused on a paid order for an edit
  // that was only ever about the note.
  const p = buildEditPayload({ orderId: "o1", note: "new note", isPaid: false, canDiscount: allow, subtotal: 7 });
  assert.deepEqual(p, { order_id: "o1", note: "new note" });
  for (const key of Object.keys(p)) {
    assert.ok(EDIT_PAYLOAD_KEYS.includes(key as never));
    assert.ok(!FORBIDDEN_EDIT_FIELDS.includes(key as never));
  }
});

test("omitting the note omits the key, so an untouched note is left alone", () => {
  const p = buildEditPayload({ orderId: "o1", isPaid: false, canDiscount: allow, subtotal: 7 });
  assert.deepEqual(p, { order_id: "o1" });
  assert.equal("note" in p, false);
});

test("a discount edit sends the server's own two fields", () => {
  const p = buildEditPayload({
    orderId: "o1",
    discount: { type: "percent", value: "10" },
    isPaid: false,
    canDiscount: allow,
    subtotal: 10,
  });
  assert.equal(p.discount_type, "percent");
  assert.equal(p.discount_value, 10);
});

test("clearing a discount sends explicit nulls", () => {
  const p = buildEditPayload({
    orderId: "o1",
    discount: { type: "none", value: "" },
    isPaid: false,
    canDiscount: allow,
    subtotal: 10,
  });
  assert.equal(p.discount_type, null);
  assert.equal(p.discount_value, null);
});

test("a discount on a PAID order is refused before any request", () => {
  assert.throws(
    () =>
      buildEditPayload({
        orderId: "o1",
        discount: { type: "percent", value: "10" },
        isPaid: true,
        canDiscount: allow,
        subtotal: 7,
      }),
    /paid order/i,
  );
});

test("a discount without permission is refused before any request", () => {
  assert.throws(
    () =>
      buildEditPayload({
        orderId: "o1",
        discount: { type: "percent", value: "10" },
        isPaid: false,
        canDiscount: denyDiscount,
        subtotal: 7,
      }),
    /permission to apply discounts/i,
  );
});

test("an invalid discount is refused before any request", () => {
  for (const d of [{ type: "percent" as const, value: "150" }, { type: "amount" as const, value: "99" }]) {
    assert.throws(
      () => buildEditPayload({ orderId: "o1", discount: d, isPaid: false, canDiscount: allow, subtotal: 7 }),
      /cannot be applied/i,
    );
  }
});

// --- edit recovery -----------------------------------------------------------

const editPayload: EditOrderPayload = { order_id: "o1", note: "edited" };
const editResult: EditOrderResult = { ok: true, order_id: "o1" };
const neverRead = async (): Promise<never> => {
  throw new Error("reread must not run on success");
};

test("a successful edit never re-reads", async () => {
  const out = await performEdit({
    payload: editPayload,
    submit: async () => editResult,
    reread: neverRead,
    matches: () => true,
  });
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.recovered, false);
});

test("two edits in the same tick produce ONE call", async () => {
  const latch = createMutationLatch();
  let calls = 0;
  const submit = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return editResult;
  };
  const [a, b] = await Promise.all([
    performEdit({ payload: editPayload, submit, reread: neverRead, matches: () => true, latch }),
    performEdit({ payload: editPayload, submit, reread: neverRead, matches: () => true, latch }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.ok, true);
  assert.ok(!b.ok && b.error instanceof MutationInProgressError);
});

test("a lost response whose edit LANDED is recovered", async () => {
  const out = await performEdit({
    payload: editPayload,
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    reread: async () => order({ notes: "edited" }),
    matches: (o) => o.notes === "edited",
  });
  assert.deepEqual(out, { ok: true, result: null, recovered: true });
});

test("a lost response whose edit did NOT land is retryable - the payload is a SET", async () => {
  const cause = new Error("network");
  const out = await performEdit({
    payload: editPayload,
    submit: async () => {
      throw cause;
    },
    reread: async () => order({ notes: "original" }),
    matches: (o) => o.notes === "edited",
  });
  assert.deepEqual(out, { ok: false, error: cause, retryable: true });
});

test("an unreadable order after a failed edit is ambiguous, never retryable", async () => {
  const out = await performEdit({
    payload: editPayload,
    submit: async () => {
      throw new Error("network");
    },
    reread: async () => {
      throw new Error("offline too");
    },
    matches: () => true,
  });
  assert.ok(!out.ok && out.error instanceof MutationAmbiguousError);
  assert.equal(!out.ok && out.retryable, false);
});

// --- cancel vs refund: the P0 distinction ------------------------------------

test("the ACTION comes from the order's payment state, never from a checkbox", () => {
  assert.equal(voidActionFor(order()), "cancel");
  assert.equal(voidActionFor(paid()), "refund");
});

test("the refund flag is derived from the action and cannot disagree with it", () => {
  assert.equal(refundFlagFor("cancel"), false);
  assert.equal(refundFlagFor("refund"), true);
  // The pairing that matters: a paid order can never produce p_refund = false,
  // which the server refuses outright.
  assert.equal(refundFlagFor(voidActionFor(paid())), true);
  assert.equal(refundFlagFor(voidActionFor(order())), false);
});

test("the RPC call derives p_refund from the action, not from an argument", () => {
  const code = stripComments(read("lib", "pos", "deliveryOrderManagement.ts"));
  const fn = code.slice(code.indexOf("export async function voidDeliveryOrder"), code.indexOf("export function voidReached"));
  assert.match(fn, /p_refund: refundFlagFor\(input\.action\)/);
  assert.equal(/p_refund: (true|false)/.test(fn), false, "p_refund must never be a literal");
});

const voidGate = (over: Record<string, unknown> = {}) =>
  voidOrderGate({
    deliveryAccess: allow,
    canCancelOrders: allow,
    order: order(),
    orderShiftOpen: true,
    online: true,
    busy: false,
    ...over,
  });

test("cancelling needs the cancel permission and a live order", () => {
  assert.equal(voidGate().allowed, true);
  assert.equal(voidGate({ canCancelOrders: denyCancel }).reason, denyCancel.reason);
  assert.equal(voidGate({ order: null }).allowed, false);
  assert.match(voidGate({ online: false }).reason ?? "", /needs a connection/i);
  assert.match(voidGate({ busy: true }).reason ?? "", /already being sent/i);
});

test("an already-terminal order offers neither action", () => {
  for (const status of TERMINAL_ORDER_STATUSES) {
    assert.equal(voidGate({ order: order({ status }) }).allowed, false, `${status} should refuse`);
  }
});

test("an UNPAID cancel does not need the order's shift open - it takes no lock", () => {
  assert.equal(voidGate({ orderShiftOpen: false }).allowed, true);
});

test("a REFUND needs the order's own shift open, and says why", () => {
  const g = voidGate({ order: paid(), orderShiftOpen: false });
  assert.equal(g.allowed, false);
  assert.match(g.reason ?? "", /shift that took the payment/i);
});

test("a reason is mandatory even though the server would accept an empty one", () => {
  assert.throws(() => validateVoidReason("   "), ReasonRequiredError);
  assert.equal(validateVoidReason("  Customer cancelled  "), "Customer cancelled");
});

// --- void recovery -----------------------------------------------------------

const voidResult = (over: Partial<VoidOrderResult> = {}): VoidOrderResult => ({
  order_id: "o1",
  voided: true,
  status: "voided",
  was_paid: false,
  refunded: false,
  refund_usd: 0,
  refund_amount: 0,
  refund_id: null,
  idempotent_replay: false,
  ...over,
});

test("the terminal state each action must reach differs", () => {
  assert.equal(voidReached("cancel", order({ status: "voided" })), true);
  assert.equal(voidReached("cancel", order({ status: "refunded" })), false);
  assert.equal(voidReached("refund", order({ status: "refunded", payment_status: "refunded" })), true);
  // Refunded status without refunded payment status is NOT the finished state.
  assert.equal(voidReached("refund", order({ status: "refunded", payment_status: "paid" })), false);
  assert.equal(voidReached("cancel", null), false);
});

test("two cancels in the same tick produce ONE call", async () => {
  const latch = createMutationLatch();
  let calls = 0;
  const submit = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return voidResult();
  };
  const [a, b] = await Promise.all([
    performVoid({ orderId: "o1", reason: "r", action: "cancel", submit, reread: neverRead, latch }),
    performVoid({ orderId: "o1", reason: "r", action: "cancel", submit, reread: neverRead, latch }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.ok, true);
  assert.ok(!b.ok && b.error instanceof MutationInProgressError);
});

test("a server idempotent replay is reported as recovered, not as a fresh void", async () => {
  const out = await performVoid({
    orderId: "o1",
    reason: "r",
    action: "cancel",
    submit: async () => voidResult({ idempotent_replay: true }),
    reread: neverRead,
  });
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.recovered, true);
});

test("a lost response whose cancel LANDED is recovered", async () => {
  const out = await performVoid({
    orderId: "o1",
    reason: "r",
    action: "cancel",
    submit: async () => {
      throw new Error("Failed to fetch");
    },
    reread: async () => order({ status: "voided" }),
  });
  assert.deepEqual(out, { ok: true, result: null, recovered: true });
});

test("a lost response whose REFUND landed is recovered only on the full terminal state", async () => {
  const done = await performVoid({
    orderId: "o1",
    reason: "r",
    action: "refund",
    submit: async () => {
      throw new Error("network");
    },
    reread: async () => order({ status: "refunded", payment_status: "refunded" }),
  });
  assert.equal(done.ok, true);
  assert.equal(done.ok && done.recovered, true);
});

test("an untouched order stays retryable - the server's own key makes that safe", async () => {
  const cause = new Error("network");
  const out = await performVoid({
    orderId: "o1",
    reason: "r",
    action: "cancel",
    submit: async () => {
      throw cause;
    },
    reread: async () => order(),
  });
  assert.deepEqual(out, { ok: false, error: cause, retryable: true });
});

test("a refund that left the order in the WRONG terminal state blocks", async () => {
  // Voided rather than refunded after a refund attempt is a contradiction, not a
  // success and not something to retry.
  const out = await performVoid({
    orderId: "o1",
    reason: "r",
    action: "refund",
    submit: async () => {
      throw new Error("network");
    },
    reread: async () => order({ status: "voided" }),
  });
  assert.ok(!out.ok && out.error instanceof MutationAmbiguousError);
  assert.equal(!out.ok && out.retryable, false);
});

test("an unreadable order after a failed void is ambiguous, never auto-retried", async () => {
  const out = await performVoid({
    orderId: "o1",
    reason: "r",
    action: "refund",
    submit: async () => {
      throw new Error("network");
    },
    reread: async () => {
      throw new Error("offline too");
    },
  });
  assert.ok(!out.ok && out.error instanceof MutationAmbiguousError);
  assert.equal(!out.ok && out.retryable, false);
});

test("submit is called at most once on every void path", async () => {
  let calls = 0;
  await performVoid({
    orderId: "o1",
    reason: "r",
    action: "refund",
    submit: async () => {
      calls += 1;
      throw new Error("network");
    },
    reread: async () => order(),
  });
  assert.equal(calls, 1);
});

// --- the allow-list ----------------------------------------------------------

test("the RPC allow-list grows 13 -> 16, and remove-item stays out", () => {
  const rpcSrc = stripComments(read("lib", "pos", "rpc.ts"));
  const union = rpcSrc.slice(rpcSrc.indexOf("export type PosRpcName"), rpcSrc.indexOf("export class PosRpcError"));
  const names = [...union.matchAll(/"(pos_[a-z_]+)"/g)].map((m) => m[1]);
  // Level 3D took it to 15; Desktop 1.0.4's `pos_configure_tables` is the 16th.
  assert.equal(names.length, 16);
  assert.ok(names.includes("pos_edit_order"));
  assert.ok(names.includes("pos_void_order"));
  assert.equal(names.includes("pos_remove_order_item"), false, "line removal is deferred");
  assert.equal(new Set(names).size, names.length);
});

test("order management calls only its own two RPCs", () => {
  const code = stripComments(read("lib", "pos", "deliveryOrderManagement.ts"));
  const calls = [...code.matchAll(/callPosRpc\(\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(calls, ["pos_edit_order", "pos_void_order"]);
});

test("order management touches no printer, no offline queue and no line removal", () => {
  const code = stripComments(read("lib", "pos", "deliveryOrderManagement.ts"));
  for (const token of ["pos_remove_order_item", "printer", "escpos", "enqueue", "outbox", "window.print"]) {
    assert.equal(code.includes(token), false, `${token} must not appear in Level 3D`);
  }
});
