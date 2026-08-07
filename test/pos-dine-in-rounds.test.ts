// Dine-In rounds (Level 2B): the contract, the gates and the submit sequence.
//
// The defect class this file exists to prevent is a SECOND BILL. m218 resolves
// the single active dine-in bill from `table_id`; a round that reaches the
// server without one does not fail loudly, it quietly opens a parallel bill that
// can never be settled with the first. So the payload cannot be built without a
// table, and the batch number is never computed here.
//
// The second defect class is a DUPLICATE BATCH: one logical round must carry one
// operation id across every retry, and a failed submit must leave the buffer
// exactly as it was.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addItemsGate,
  billMatchesTable,
  buildRoundPayload,
  describeBillChange,
  performRound,
  preparingRoundLabel,
  roundModifierViolations,
  roundOutcomeMessage,
  sentRoundLabel,
  submitRoundGate,
  BranchRequiredError,
  EmptyRoundError,
  IncompleteModifiersError,
  OfflineOrderingError,
  ROUND_SEQUENCE,
  type RoundContext,
  type RoundMenu,
} from "@/lib/pos/tableRounds";
import { ShiftRequiredError, TableRequiredError } from "@/lib/pos/orders";
import { classifyError } from "@/lib/pos/errors";
import { foldBill } from "@/lib/pos/tableBill";
import type { CartLine, ModifierGroup, SubmitOrderResult } from "@/types/pos";
import type { BillOrder, TableSummary } from "@/types/tables";

const TABLE: TableSummary = {
  id: "table-1",
  name: "Table 5",
  seats: 4,
  occupied: false,
  status: "available",
  canonical: true,
  configured: true,
  sort_order: 5,
  orders: 0,
  order_number: null,
  opened_at: null,
  total: null,
  currency: null,
  mixed_currency: false,
};

const ctx = (over: Partial<RoundContext> = {}): RoundContext => ({
  branchId: "branch-1",
  shiftId: "shift-1",
  table: TABLE,
  online: true,
  ...over,
});

const line = (over: Partial<CartLine> = {}): CartLine => ({
  key: "line-1",
  menu_item_id: "item-1",
  name: "Margherita",
  base_price: 7,
  quantity: 1,
  kitchen_note: null,
  modifiers: [],
  ...over,
});

const ALLOWED = { allowed: true, reason: null } as const;

const group = (over: Partial<ModifierGroup> = {}): ModifierGroup =>
  ({
    id: "g1",
    name: "Size",
    selection_type: "single",
    is_required: true,
    min_select: 1,
    max_select: 1,
    ...over,
  }) as ModifierGroup;

const menu = (over: Partial<RoundMenu> = {}): RoundMenu => ({
  groupsByItem: { "item-1": ["g1"] },
  groups: [group()],
  options: [{ id: "o1", modifier_group_id: "g1", name: "Large" }] as RoundMenu["options"],
  ...over,
});

const result = (over: Partial<SubmitOrderResult> = {}): SubmitOrderResult => ({
  order_id: "order-1",
  order_number: "A-14",
  subtotal: 7,
  total: 7,
  batch_no: 1,
  appended: false,
  idempotent: false,
  ...over,
});

// --- payload: the table binding ---------------------------------------------

test("a round payload carries table, shift, branch, items and the operation id", () => {
  const payload = buildRoundPayload({ ctx: ctx(), lines: [line()], clientOpId: "op-round-1" });
  assert.equal(payload.order_type, "dine_in");
  assert.equal(payload.table_id, "table-1");
  assert.equal(payload.shift_id, "shift-1");
  assert.equal(payload.branch_id, "branch-1");
  assert.equal(payload.client_op_id, "op-round-1");
  assert.equal(payload.items.length, 1);
});

test("no order id is ever sent - the server resolves the active bill from the table", () => {
  const payload = buildRoundPayload({ ctx: ctx(), lines: [line()], clientOpId: "op-1" });
  assert.equal("order_id" in payload, false);
  assert.equal("id" in payload, false);
  assert.equal("batch_no" in payload, false, "the client must never compute a batch number");
});

test("the payload keys are exactly what pos_submit_order parses for dine-in", () => {
  const payload = buildRoundPayload({ ctx: ctx(), lines: [line()], clientOpId: "op-1" });
  assert.deepEqual(Object.keys(payload).sort(), [
    "branch_id",
    "client_op_id",
    "items",
    "notes",
    "order_type",
    "shift_id",
    "status",
    "table_id",
  ]);
});

test("modifiers and notes survive into the payload with their full structure", () => {
  const payload = buildRoundPayload({
    ctx: ctx(),
    clientOpId: "op-1",
    lines: [
      line({
        quantity: 2,
        kitchen_note: "  no basil  ",
        modifiers: [
          { group_id: "g1", option_id: "o1", name: "Large", price_delta: 1.5, quantity: 1 },
          { group_id: "g2", option_id: "o2", name: "Extra cheese", price_delta: 0.5, quantity: 3 },
        ],
      }),
    ],
  });
  const item = payload.items[0];
  assert.equal(item.quantity, 2);
  assert.equal(item.kitchen_note, "no basil", "notes are trimmed, never padded");
  assert.deepEqual(item.modifiers[1], {
    group_id: "g2",
    option_id: "o2",
    name: "Extra cheese",
    price_delta: 0.5,
    quantity: 3,
  });
});

// --- payload: local refusals -------------------------------------------------

test("a round cannot be built without a table", () => {
  assert.throws(
    () => buildRoundPayload({ ctx: ctx({ table: null }), lines: [line()], clientOpId: "op-1" }),
    TableRequiredError,
  );
});

test("a round cannot be built without a shift", () => {
  assert.throws(
    () => buildRoundPayload({ ctx: ctx({ shiftId: null }), lines: [line()], clientOpId: "op-1" }),
    ShiftRequiredError,
  );
});

test("a round cannot be built without a branch", () => {
  assert.throws(
    () => buildRoundPayload({ ctx: ctx({ branchId: null }), lines: [line()], clientOpId: "op-1" }),
    BranchRequiredError,
  );
});

test("an empty round is refused before a request exists", () => {
  assert.throws(() => buildRoundPayload({ ctx: ctx(), lines: [], clientOpId: "op-1" }), EmptyRoundError);
});

test("an offline round is refused locally - nothing is ever queued", () => {
  assert.throws(
    () => buildRoundPayload({ ctx: ctx({ online: false }), lines: [line()], clientOpId: "op-1" }),
    OfflineOrderingError,
  );
});

test("offline is checked FIRST, so a disconnected terminal never blames the shift", () => {
  assert.throws(
    () => buildRoundPayload({ ctx: ctx({ online: false, shiftId: null }), lines: [line()], clientOpId: "op-1" }),
    OfflineOrderingError,
  );
});

test("a line missing its required modifier is refused with the item named", () => {
  try {
    buildRoundPayload({ ctx: ctx(), lines: [line()], clientOpId: "op-1", menu: menu() });
    assert.fail("expected IncompleteModifiersError");
  } catch (e) {
    assert.ok(e instanceof IncompleteModifiersError);
    assert.match(e.message, /Margherita/);
    assert.match(e.message, /Choose a Size/);
  }
});

test("a line with its required modifier answered builds fine", () => {
  const payload = buildRoundPayload({
    ctx: ctx(),
    clientOpId: "op-1",
    menu: menu(),
    lines: [line({ modifiers: [{ group_id: "g1", option_id: "o1", name: "Large", price_delta: 1, quantity: 1 }] })],
  });
  assert.equal(payload.items[0].modifiers.length, 1);
});

test("modifier re-validation names every offending line, not just the first", () => {
  const problems = roundModifierViolations([line({ key: "a" }), line({ key: "b", name: "Pepperoni" })], menu());
  assert.equal(problems.length, 2);
  assert.match(problems[1], /Pepperoni/);
});

test("an option that vanished from the menu is caught before the server sees it", () => {
  const problems = roundModifierViolations(
    [line({ modifiers: [{ group_id: "g1", option_id: "gone", name: "Large", price_delta: 1, quantity: 1 }] })],
    menu(),
  );
  assert.ok(problems.some((p) => /not available for this item/.test(p)));
});

// --- gates -------------------------------------------------------------------

test("Add Items needs create-orders permission, a table, a shift and a connection", () => {
  assert.equal(addItemsGate({ ctx: ctx(), createOrders: ALLOWED }).allowed, true);

  const noPerm = addItemsGate({ ctx: ctx(), createOrders: { allowed: false, reason: "You do not have permission to create orders." } });
  assert.equal(noPerm.allowed, false);
  assert.match(noPerm.reason ?? "", /permission to create orders/);

  assert.match(addItemsGate({ ctx: ctx({ table: null }), createOrders: ALLOWED }).reason ?? "", /Select a table/);
  assert.match(addItemsGate({ ctx: ctx({ online: false }), createOrders: ALLOWED }).reason ?? "", /connection/);
  assert.match(addItemsGate({ ctx: ctx({ shiftId: null }), createOrders: ALLOWED }).reason ?? "", /Open a shift/);
});

test("Add Items does NOT consult payment permission", () => {
  // Only create-orders is passed in; there is no payment gate parameter at all.
  const gate = addItemsGate({ ctx: ctx(), createOrders: ALLOWED });
  assert.equal(gate.allowed, true);
  assert.doesNotMatch(JSON.stringify(gate), /payment/i);
});

test("Submit round refuses an empty round with a fixable reason", () => {
  const gate = submitRoundGate({ ctx: ctx(), lines: [], createOrders: ALLOWED });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /Add at least one item/);
});

test("Submit round refuses while offline, without a shift, and without a table", () => {
  assert.match(submitRoundGate({ ctx: ctx({ online: false }), lines: [line()], createOrders: ALLOWED }).reason ?? "", /connection/);
  assert.match(submitRoundGate({ ctx: ctx({ shiftId: null }), lines: [line()], createOrders: ALLOWED }).reason ?? "", /Open a shift/);
  assert.match(submitRoundGate({ ctx: ctx({ table: null }), lines: [line()], createOrders: ALLOWED }).reason ?? "", /Select a table/);
});

test("Submit round surfaces an incomplete required modifier as its reason", () => {
  const gate = submitRoundGate({ ctx: ctx(), lines: [line()], createOrders: ALLOWED, menu: menu() });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /Choose a Size/);
});

test("a complete round passes the gate", () => {
  const gate = submitRoundGate({
    ctx: ctx(),
    createOrders: ALLOWED,
    menu: menu(),
    lines: [line({ modifiers: [{ group_id: "g1", option_id: "o1", name: "Large", price_delta: 1, quantity: 1 }] })],
  });
  assert.deepEqual(gate, { allowed: true, reason: null });
});

// --- the submit sequence -----------------------------------------------------

function harness(submit: (p: unknown) => Promise<SubmitOrderResult>) {
  const calls: unknown[] = [];
  let cleared = 0;
  let refreshed = 0;
  return {
    calls,
    get cleared() {
      return cleared;
    },
    get refreshed() {
      return refreshed;
    },
    run: (over: { lines?: CartLine[]; clientOpId?: string; ctx?: RoundContext } = {}) =>
      performRound({
        ctx: over.ctx ?? ctx(),
        lines: over.lines ?? [line()],
        clientOpId: over.clientOpId ?? "op-round-1",
        submit: (p) => {
          calls.push(p);
          return submit(p);
        },
        clearBuffer: () => {
          cleared += 1;
        },
        refresh: async () => {
          refreshed += 1;
        },
      }),
  };
}

test("the documented sequence is build, submit, clear, refresh - in that order", async () => {
  assert.deepEqual([...ROUND_SEQUENCE], ["build", "submit", "clear-buffer", "refresh"]);
  const h = harness(async () => result());
  const outcome = await h.run();
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.steps, [...ROUND_SEQUENCE]);
});

test("the first round reports batch 1 and appended false, and clears the buffer once", async () => {
  const h = harness(async () => result({ batch_no: 1, appended: false }));
  const outcome = await h.run();
  assert.ok(outcome.ok);
  assert.equal(outcome.result.batch_no, 1);
  assert.equal(outcome.result.appended, false);
  assert.equal(outcome.result.tableId, "table-1");
  assert.equal(h.cleared, 1);
  assert.equal(h.refreshed, 1);
});

test("an additional round appends to the SAME order with the server's batch number", async () => {
  const h = harness(async () => result({ batch_no: 2, appended: true, order_id: "order-1", order_number: "A-14", total: 14 }));
  const outcome = await h.run({ clientOpId: "op-round-2" });
  assert.ok(outcome.ok);
  assert.equal(outcome.result.order_id, "order-1", "an append must not create a second order");
  assert.equal(outcome.result.order_number, "A-14");
  assert.equal(outcome.result.batch_no, 2);
  assert.equal(outcome.result.appended, true);
});

test("the batch number is whatever the server says, even when it skips ahead", async () => {
  // Another cashier got there first: the server assigns 5, not our expected 2.
  const h = harness(async () => result({ batch_no: 5, appended: true }));
  const outcome = await h.run();
  assert.ok(outcome.ok);
  assert.equal(outcome.result.batch_no, 5);
});

test("a FAILED submit never clears the buffer and never refreshes", async () => {
  const h = harness(async () => {
    throw new Error("Network request failed");
  });
  const outcome = await h.run();
  assert.equal(outcome.ok, false);
  assert.equal(h.cleared, 0, "clearing after a failure loses a round the kitchen never saw");
  assert.equal(h.refreshed, 0);
  assert.deepEqual(outcome.steps, ["build"]);
});

test("a build refusal never reaches the network at all", async () => {
  const h = harness(async () => result());
  const outcome = await h.run({ lines: [] });
  assert.equal(outcome.ok, false);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(outcome.steps, []);
  assert.ok(!outcome.ok && outcome.error instanceof EmptyRoundError);
});

test("retrying a failed round sends the SAME operation id, so m224 replays it", async () => {
  let attempt = 0;
  const h = harness(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("Network request failed");
    return result({ idempotent: true });
  });
  const first = await h.run({ clientOpId: "op-round-1" });
  assert.equal(first.ok, false);
  const second = await h.run({ clientOpId: "op-round-1" });
  assert.equal(second.ok, true);

  const ids = h.calls.map((c) => (c as { client_op_id: string }).client_op_id);
  assert.deepEqual(ids, ["op-round-1", "op-round-1"]);
  assert.equal(h.cleared, 1, "the buffer clears exactly once, on the accepted attempt");
});

test("an idempotent replay is reported as such and adds no batch", async () => {
  const h = harness(async () => result({ batch_no: 1, appended: false, idempotent: true }));
  const outcome = await h.run();
  assert.ok(outcome.ok);
  assert.equal(outcome.result.idempotent, true);
  const { message } = roundOutcomeMessage(outcome.result);
  assert.match(message, /already sent/i);
});

test("round 2 must not reuse round 1's operation id", async () => {
  const h = harness(async () => result());
  await h.run({ clientOpId: "op-round-1" });
  await h.run({ clientOpId: "op-round-2" });
  const ids = h.calls.map((c) => (c as { client_op_id: string }).client_op_id);
  assert.equal(new Set(ids).size, 2, "two logical rounds shared one operation id");
});

// --- operator-facing wording -------------------------------------------------

test("the outcome message distinguishes opened, appended and replayed", () => {
  assert.match(roundOutcomeMessage({ ...result(), tableId: "t" }).message, /opened/i);
  assert.match(roundOutcomeMessage({ ...result({ appended: true, batch_no: 2 }), tableId: "t" }).message, /Round 2 added/i);
  assert.match(roundOutcomeMessage({ ...result({ idempotent: true }), tableId: "t" }).message, /already sent/i);
});

test("sent rounds are labelled by the SERVER's batch number", () => {
  assert.equal(sentRoundLabel(1), "Sent round 1");
  assert.equal(sentRoundLabel(3), "Sent round 3");
});

test("the round being prepared is labelled from how many the server has, not a local count", () => {
  assert.equal(preparingRoundLabel(null), "Round being prepared");
  const bill = foldBill("t1", [
    {
      id: "o1", order_number: "A-1", status: "sent_to_kitchen", payment_status: "unpaid", shift_id: "s1",
      branch_id: "b1", tenant_id: "t", subtotal: 7, discount_amount: 0, total_amount: 7, currency: "USD",
      exchange_rate: null, created_at: null,
      lines: [{ id: "l1", name: "X", quantity: 1, base_price: 7, modifiers_total: 0, final_unit_price: 7, line_total: 7, kitchen_note: null, batch_no: 1, modifiers: [] }],
    } as BillOrder,
  ]);
  assert.equal(preparingRoundLabel(bill), "Round being prepared (after 1 sent)");
});

// --- concurrency -------------------------------------------------------------

test("a bill from another table never counts as this table's bill", () => {
  const bill = foldBill("table-9", []);
  assert.equal(billMatchesTable(bill, TABLE), false);
  assert.equal(billMatchesTable(foldBill("table-1", []), TABLE), true);
  assert.equal(billMatchesTable(null, TABLE), false);
  assert.equal(billMatchesTable(foldBill("table-1", []), null), false);
});

test("a round added by another cashier is described rather than silently absorbed", () => {
  const mk = (batches: number[]) =>
    foldBill("table-1", [
      {
        id: "o1", order_number: "A-14", status: "sent_to_kitchen", payment_status: "unpaid", shift_id: "s1",
        branch_id: "b1", tenant_id: "t", subtotal: 7, discount_amount: 0, total_amount: 7, currency: "USD",
        exchange_rate: null, created_at: null,
        lines: batches.map((b, i) => ({ id: `l${i}`, name: "X", quantity: 1, base_price: 7, modifiers_total: 0, final_unit_price: 7, line_total: 7, kitchen_note: null, batch_no: b, modifiers: [] })),
      } as BillOrder,
    ]);
  const change = describeBillChange(mk([1]), mk([1, 2]));
  assert.match(change ?? "", /Another round was added/);
  assert.equal(describeBillChange(mk([1]), mk([1])), null, "an unchanged bill reports no change");

  // Staging verification, 2026-08-07: this fired on EVERY successful submit.
  // The operator's own round grows the batch count, and the notice accused them
  // of a concurrent change they had just made themselves. A warning that cries
  // wolf on the happy path trains people to ignore the one that matters.
  assert.equal(
    describeBillChange(mk([1]), mk([1, 2]), 1),
    null,
    "the operator's own round must not be reported as somebody else's",
  );
  // A genuine concurrent round alongside our own is still reported.
  assert.match(
    describeBillChange(mk([1]), mk([1, 2, 3]), 1) ?? "",
    /Another round was added/,
    "a concurrent round hidden behind our own must still surface",
  );
  // An idempotent replay adds nothing, so nothing is discounted.
  assert.equal(describeBillChange(mk([1, 2]), mk([1, 2]), 0), null);
});

test("a bill that disappeared under the operator is reported, not ignored", () => {
  const withOrder = foldBill("table-1", [
    {
      id: "o1", order_number: "A-14", status: "sent_to_kitchen", payment_status: "unpaid", shift_id: "s1",
      branch_id: "b1", tenant_id: "t", subtotal: 7, discount_amount: 0, total_amount: 7, currency: "USD",
      exchange_rate: null, created_at: null, lines: [],
    } as BillOrder,
  ]);
  assert.match(describeBillChange(withOrder, foldBill("table-1", [])) ?? "", /settled or cleared/);
});

// --- error classification ----------------------------------------------------

test("every Level 2B refusal classifies to a kind with operator guidance", () => {
  assert.equal(classifyError(new EmptyRoundError()).kind, "empty_round");
  assert.equal(classifyError(new OfflineOrderingError()).kind, "offline");
  assert.equal(classifyError(new TableRequiredError()).kind, "table_not_found");
  assert.equal(classifyError(new ShiftRequiredError()).kind, "no_shift");
  assert.equal(classifyError(new BranchRequiredError()).kind, "branch");
  assert.equal(classifyError(new IncompleteModifiersError(["Margherita: Choose a Size."])).kind, "modifier_required");
  for (const e of [new EmptyRoundError(), new OfflineOrderingError(), new IncompleteModifiersError(["Choose a Size."])]) {
    const c = classifyError(e);
    assert.ok(c.hint, `${c.kind} has no next step for the cashier`);
    assert.equal(c.expected, true);
  }
});

test("a server append refusal warns against retrying on a different table", () => {
  const c = classifyError(new Error("could not resolve the active bill for this table"));
  assert.equal(c.kind, "append_refused");
  assert.match(c.hint ?? "", /Do NOT retry against a different table/);
});
