// The Level 3D operational surface: queue, detail, edit, cancel/refund, receipt.
//
// The adapter's own contract is proved in `pos-delivery-order-management`. What
// is proved HERE is that the screens reach it correctly, because every safety
// property in that file can be defeated by a call site: a queue that reads
// another branch, an edit dialog that sends the note it was merely shown, a
// Cancel button wired to the refund action, or a second settlement path that
// skips the pre-payment re-read.
//
// The UI assertions are static reads of the source. "The button is not there" is
// not the same guarantee as "the call site does not exist", and for controls
// that reverse payments only the second one is worth having.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  addressText,
  buildHistoricalReceipt,
  editReached,
  orderShiftOpen,
  orderStateLabel,
  orderStateTone,
  orderTimeLabel,
  paymentStateLabel,
  paymentStateTone,
  shiftIsOpen,
  toOpenDeliveryOrder,
  UNKNOWN_PARTY,
  type OrderParty,
} from "@/lib/pos/deliveryHistory";
import { voidActionFor, type DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const workspaceSrc = read("screens", "pos", "DeliveryWorkspace.tsx");
const queueSrc = read("components", "pos", "DeliveryOrderQueue.tsx");
const detailSrc = read("components", "pos", "DeliveryOrderDetail.tsx");
const dialogsSrc = read("components", "pos", "DeliveryOrderDialogs.tsx");
const historySrc = read("lib", "pos", "deliveryHistory.ts");
const accessSrc = read("lib", "pos", "access.ts");

const workspace = stripJsxComments(workspaceSrc);
const queue = stripJsxComments(queueSrc);
const detail = stripJsxComments(detailSrc);
const dialogs = stripJsxComments(dialogsSrc);
const history = stripComments(historySrc);

const order = (over: Partial<DeliveryQueueOrder> = {}): DeliveryQueueOrder => ({
  id: "o1",
  order_number: "260810-0001",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  payment_method: null,
  subtotal: 8,
  discount_amount: 0,
  total_amount: 8,
  currency: "USD",
  customer_id: "c1",
  address_id: "a1",
  notes: "Desktop Level 3D order management verification",
  shift_id: "s1",
  created_at: "2026-08-10T09:00:00Z",
  ...over,
});

const party: OrderParty = {
  customerName: "Desktop Level 3A QA",
  customerPhone: "03 111 222",
  addressText: "Home, Beirut, Hamra",
};

// --- the switch and the queue ------------------------------------------------

test("Delivery gained an Orders view rather than a second POS workspace", () => {
  assert.match(workspace, /export type DeliveryView = "customer" \| "add_items" \| "orders"/);
  // One shell, one status bar, one payment dialog. A cross-order-type Orders
  // screen would be a second architecture, and is deliberately not here.
  assert.equal(workspace.includes("PosShell"), false);
  assert.match(workspace, /Customers \/ New order/);
  assert.match(workspace, /<DeliveryOrderQueue/);
});

test("the queue is read through the audited reader, with the shift as its scope", () => {
  assert.match(workspace, /loadDeliveryQueue\(\{[\s\S]*?tenantId: pos\.tenantId,[\s\S]*?branchId,[\s\S]*?shiftId: input\.shiftId/);
  // The scope sentence on screen is derived from the same condition the reader
  // branches on, so the list cannot describe itself wrongly.
  assert.match(workspace, /shiftScoped=\{Boolean\(input\.shiftId\)\}/);
  assert.match(queue, /This shift's delivery orders/);
  assert.match(queue, /Today's delivery orders for this branch/);
});

test("the queue widens neither the branch nor the order type from the UI", () => {
  // The component never sees a branch, a tenant or a query at all - it renders
  // whatever the audited reader returned, so there is nowhere for a UI-side
  // "show all branches" to be added later without moving this assertion.
  for (const token of ["order_type", "branch_id", "branchId", "tenantId", "eq(", "supabase"]) {
    assert.equal(queue.includes(token), false, `${token} must not appear in the queue component`);
  }
});

test("the queue carries no mutation control - every row is a read", () => {
  for (const token of ["callPosRpc", "pos_edit_order", "pos_void_order", "pos_pay_order", "onVoid", "onEdit", "onPay"]) {
    assert.equal(queue.includes(token), false, `${token} must not appear in a queue row`);
  }
  assert.match(queue, /onSelect: \(order: DeliveryQueueOrder\) => void/);
});

test("the queue says when it has stopped at the limit rather than implying that is all", () => {
  assert.match(queue, /orders\.length >= DELIVERY_QUEUE_LIMIT/);
  assert.match(queue, /Showing the \{DELIVERY_QUEUE_LIMIT\} most recent orders/);
});

test("the queue has an empty state, an error state and a manual refresh", () => {
  assert.match(queue, /<EmptyState/);
  assert.match(queue, /<ErrorState/);
  assert.match(queue, /onRefresh/);
});

test("opening Orders loads the queue, and loading it mutates nothing", () => {
  assert.match(workspace, /if \(!active \|\| view !== "orders" \|\| !viewOrdersGate\.allowed\) return;\s*void refreshQueue\(\);/);
  const refresh = workspace.slice(workspace.indexOf("const refreshQueue"), workspace.indexOf("const refreshDetail"));
  for (const token of ["callPosRpc", "insert", "update", "upsert", "delete"]) {
    assert.equal(refresh.includes(token), false, `refreshQueue must not ${token}`);
  }
});

// --- the state chips ---------------------------------------------------------

test("the chips use only states the server produces", () => {
  assert.equal(orderStateLabel("sent_to_kitchen"), "Sent to kitchen");
  assert.equal(orderStateLabel("completed"), "Completed");
  assert.equal(orderStateLabel("voided"), "Cancelled");
  assert.equal(orderStateLabel("refunded"), "Refunded");
  assert.equal(paymentStateLabel("unpaid"), "Unpaid");
  assert.equal(paymentStateLabel("paid"), "Paid");
  assert.equal(paymentStateLabel("refunded"), "Refunded");
  // An unknown status is shown verbatim rather than mapped onto a guess.
  assert.equal(orderStateLabel("something_new"), "something_new");
  assert.equal(paymentStateLabel("partial"), "partial");
});

test("no collection lifecycle is invented anywhere on the delivery surface", () => {
  // The web calls settlement "Mark collected". The desktop has no collection
  // step to mark: `pos_pay_order` sets paid AND completed in one statement.
  for (const src of [workspace, queue, detail, dialogs]) {
    for (const phrase of ["Mark collected", "Collected", "Awaiting collection", "Out for delivery", "Dispatch"]) {
      assert.equal(src.includes(phrase), false, `"${phrase}" is not a state this system has`);
    }
  }
});

test("the tones separate money from motion", () => {
  assert.equal(paymentStateTone("paid"), "green");
  assert.equal(paymentStateTone("unpaid"), "amber");
  assert.equal(paymentStateTone("refunded"), "red");
  assert.equal(orderStateTone("refunded"), "red");
  assert.equal(orderStateTone("voided"), "slate");
});

test("a missing timestamp renders as nothing rather than as a wrong time", () => {
  assert.equal(orderTimeLabel(null), "");
  assert.equal(orderTimeLabel("not-a-date"), "");
  assert.notEqual(orderTimeLabel("2026-08-10T09:00:00Z"), "");
});

// --- the detail --------------------------------------------------------------

test("the detail is built from an authoritative re-read, not from the row", () => {
  assert.match(workspace, /const \[fresh, lines\] = await Promise\.all\(\[readDeliveryOrder\(orderId\), loadDeliveryOrderLines\(orderId\)\]\)/);
  assert.match(workspace, /void refreshDetail\(order\.id\)/);
});

test("the detail shows the customer, the address, the items and the money", () => {
  for (const token of ["customerName", "customerPhone", "addressText", "kitchenNote", "modifiers", "Subtotal", "Discount", "Total", "Payment", "Shift"]) {
    assert.ok(detail.includes(token), `the detail should show ${token}`);
  }
  assert.match(detail, /Delivery note/);
});

test("the detail exposes no way to change what was ordered or who ordered it", () => {
  for (const token of [
    "addLine",
    "adjustQuantity",
    "removeLine",
    "ModifierDialog",
    "pos_remove_order_item",
    "customer_id =",
    "address_id =",
    "onSelectAddress",
    "onSelectCustomer",
    "branch",
  ]) {
    assert.equal(detail.includes(token), false, `${token} is not part of Level 3D editing`);
  }
});

test("a terminal order keeps its detail readable and loses every mutation control", () => {
  assert.match(detail, /const terminal = isTerminal\(o\.status\)/);
  // Pay, Edit and the void action are all behind `!terminal`. The receipt is
  // not: reading what was sold is exactly what a cancelled order still supports.
  const gated = detail.match(/\{!terminal &&/g) ?? [];
  assert.ok(gated.length >= 3, "pay, edit and void must each be behind the terminal check");
  assert.match(detail, /It can be read, but not changed/);
});

// --- reusing Level 3C's payment ----------------------------------------------

test("paying from the queue reuses Level 3C - there is no second payment path", () => {
  // Counted in the BODY, so the import list does not inflate the figures.
  const body = workspace.slice(workspace.indexOf("export function useDeliveryWorkspace"));
  // The FULL-pay path is still single: one settlement primitive, one pay RPC.
  assert.equal((body.match(/performDeliverySettlement\(/g) ?? []).length, 1);
  assert.equal((body.match(/submit: payDeliveryOrder/g) ?? []).length, 1);
  // Wave 2C's on-account settlement is an additive path (performOnAccount +
  // completeOnAccount, NOT a second pos_pay_order), and it reuses the SAME
  // stale-guard before submitting - so checkSettlementTarget is now called from
  // both the full-pay and the on-account paths.
  assert.equal((body.match(/checkSettlementTarget\(/g) ?? []).length, 2);
  assert.equal((body.match(/submit: payDeliveryOrder|performDeliverySettlement\(/g) ?? []).length, 2, "no second full-pay path");
  // The queue's Pay button is the same entry point the customer half uses.
  assert.match(detail, /onPay: \(\) => void;/);
  assert.match(workspace, /onPay=\{requestPay\}/);
});

test("the pay target is resolved once, and carries the ORDER's shift with it", () => {
  assert.match(workspace, /const payTarget = useMemo/);
  assert.match(workspace, /shiftOpen: orderShiftOpen\(detail, shiftOpenMap\)/);
  // `pos_pay_order` locks the ORDER's shift, so the payment gate reads the
  // target's shift rather than the cashier's. (The SEND gate still asks about
  // the cashier's own shift, and rightly - a new order needs one open.)
  const payGateBlock = workspace.slice(workspace.indexOf("deliveryPaymentGate({"), workspace.indexOf("const receiptIdentity"));
  assert.match(payGateBlock, /hasOpenShift: payTarget\.shiftOpen/);
  assert.equal(payGateBlock.includes("Boolean(input.shiftId)"), false);
});

test("a paid order offers no Pay control at all", () => {
  assert.match(detail, /!terminal && o\.payment_status !== "paid" && \(\s*<GatedButton gate=\{props\.payGate\}/);
});

test("F4 stays Level 3C's, and reaches the same gate from both views", () => {
  assert.match(workspace, /useShortcuts\(\{ openPayment: requestPay \}, active && view !== "add_items" && payGate\.allowed\)/);
  // One opener. F4 and every button call it, and it cannot charge.
  assert.match(workspace, /const requestPay = useCallback\(\(\) => \{[\s\S]*?setPayOpen\(true\);/);
});

test("the payment dialog describes the order that would actually be charged", () => {
  // Not "whoever is selected on the customer half" - that is how the wrong name
  // reaches a receipt when an order is opened from the queue.
  assert.match(workspace, /subtotal=\{payTarget\.order\?\.total_amount \?\? 0\}/);
  assert.match(workspace, /orderNumber=\{payTarget\.order\?\.order_number \?\? null\}/);
  assert.match(workspace, /receiptIdentity\(payTarget\.order\)/);
});

// --- edit: presence semantics ------------------------------------------------

test("an untouched note is omitted, and a cleared one is sent as an empty string", () => {
  assert.match(dialogs, /const noteTouched = note\.trim\(\) !== original\.trim\(\)/);
  assert.match(dialogs, /note: noteTouched \? note\.trim\(\) : null/);
  // The three states are said out loud to the operator too.
  assert.match(dialogs, /The note will be cleared/);
  assert.match(dialogs, /The note will be replaced/);
  assert.match(dialogs, /The note is unchanged and will not be sent/);
});

test("the discount is sent only when the operator opts into changing it", () => {
  assert.match(dialogs, /discount: changeDiscount \? \{ type: discountType, value: discountValue \} : null/);
  assert.match(dialogs, /Change the discount on this order/);
});

test("the discount permission is required only when a discount is actually sent", () => {
  // The edit gate checks `pos.edit_orders`; the discount key is what pulls
  // `pos.apply_discounts` in, inside `buildEditPayload`.
  assert.match(dialogs, /disabled=\{!props\.discountGate\.allowed\}/);
  assert.match(workspace, /canDiscount: input\.applyDiscounts/);
});

test("a paid order can have its note edited and its discount not even offered", () => {
  assert.match(dialogs, /const paid = order\?\.payment_status === "paid"/);
  assert.match(dialogs, /This order is paid\. Its note can still be corrected, but the discount can no longer be changed/);
  // Absent rather than disabled: the server refuses it, so offering it greyed
  // out would only invite the question "why not?".
  assert.match(dialogs, /\{paid \? \(/);
});

test("saving is refused when the operator changed nothing", () => {
  assert.match(dialogs, /const nothingToSave = !noteTouched && !changeDiscount/);
  assert.match(dialogs, /disabled=\{props\.busy \|\| nothingToSave\}/);
});

test("the form is re-seeded per order, so one order's note cannot be written to another", () => {
  assert.match(dialogs, /useEffect\(\(\) => \{\s*if \(!props\.open\) return;\s*setNote\(original\)/);
});

// --- edit: safety ------------------------------------------------------------

test("every edit re-reads the order and runs the branch check first", () => {
  const edit = workspace.slice(workspace.indexOf("const submitOrderEdit"), workspace.indexOf("const submitOrderVoid"));
  assert.match(edit, /const fresh = await readDeliveryOrder\(target\.id\)/);
  assert.match(edit, /checkOrderContext\(fresh, \{ orderId: target\.id, branchOrderIds: new Set\(queue\.map\(\(o\) => o\.id\)\) \}\)/);
  // Identity is not editable at this level, so it moving stops the mutation.
  assert.match(edit, /order\.customer_id !== target\.customer_id \|\| order\.address_id !== target\.address_id/);
  assert.match(edit, /throw new OrderChangedError/);
  assert.match(edit, /latch: editLatch\.current/);
});

test("edit recovery proves the SET landed rather than re-sending it", () => {
  const edit = workspace.slice(workspace.indexOf("const submitOrderEdit"), workspace.indexOf("const submitOrderVoid"));
  assert.match(edit, /matches: \(o\) => editReached\(\{ payload, expectedDiscountAmount, order: o \}\)/);
  // No timer, no queue, no automatic second attempt anywhere on this path.
  for (const token of ["setTimeout", "setInterval", "retry(", "while ("]) {
    assert.equal(edit.includes(token), false, `${token} must not appear on the edit path`);
  }
});

test("editReached only asserts the keys the edit actually sent", () => {
  const o = order({ notes: "left alone", discount_amount: 3 });
  // A note-only edit says nothing about the discount, so a discount of 3 is
  // not evidence the edit failed.
  assert.equal(editReached({ payload: { note: "left alone" }, expectedDiscountAmount: null, order: o }), true);
  assert.equal(editReached({ payload: { note: "something else" }, expectedDiscountAmount: null, order: o }), false);
  // An edit that sent nothing optional is satisfied by the order existing.
  assert.equal(editReached({ payload: {}, expectedDiscountAmount: null, order: o }), true);
  assert.equal(editReached({ payload: {}, expectedDiscountAmount: null, order: null }), false);
});

test("a cleared note reads back as null, and editReached knows it", () => {
  // `strOrNull("")` is null, so the comparison normalises both sides to "".
  assert.equal(editReached({ payload: { note: "" }, expectedDiscountAmount: null, order: order({ notes: null }) }), true);
  assert.equal(editReached({ payload: { note: "" }, expectedDiscountAmount: null, order: order({ notes: "still here" }) }), false);
});

test("a discount edit is only recovered when the amount the server holds matches", () => {
  assert.equal(
    editReached({ payload: { discount_type: "percent" }, expectedDiscountAmount: 0.8, order: order({ discount_amount: 0.8 }) }),
    true,
  );
  assert.equal(
    editReached({ payload: { discount_type: "percent" }, expectedDiscountAmount: 0.8, order: order({ discount_amount: 0 }) }),
    false,
  );
});

test("a refused edit refreshes the screen instead of leaving stale state on it", () => {
  const edit = workspace.slice(workspace.indexOf("const submitOrderEdit"), workspace.indexOf("const submitOrderVoid"));
  assert.match(edit, /catch \(e\) \{[\s\S]*?void refreshDetail\(target\.id\)/);
});

// --- cancel / refund ---------------------------------------------------------

test("the action is named by the order's payment state, and the UI cannot choose it", () => {
  assert.equal(voidActionFor(order({ payment_status: "unpaid" })), "cancel");
  assert.equal(voidActionFor(order({ payment_status: "paid" })), "refund");
  // The dialog is TOLD which action this is.
  assert.match(workspace, /action=\{detail \? voidActionFor\(detail\) : "cancel"\}/);
  assert.match(workspace, /voidAction=\{voidActionFor\(detail\)\}/);
  // The panel is handed the decision; it holds no branch that could re-decide.
  assert.match(detail, /voidAction: VoidAction;/);
  assert.equal(detail.includes("voidActionFor"), false);
});

test("no surface anywhere writes p_refund, or offers it as a choice", () => {
  for (const [name, src] of [
    ["workspace", workspace],
    ["queue", queue],
    ["detail", detail],
    ["dialogs", dialogs],
  ] as const) {
    assert.equal(src.includes("p_refund"), false, `${name} must not name p_refund`);
    assert.equal(/refund\s*[:=]\s*(true|false)/.test(src), false, `${name} must not set a refund boolean`);
  }
  assert.equal(dialogs.includes("Refund?"), false);
});

test("an unpaid order is cancelled in words that involve no money", () => {
  assert.match(dialogs, /Cancel this order\?/);
  assert.match(dialogs, /Keep the order/);
  assert.match(dialogs, /This order has not been paid, so no money is involved/);
  assert.match(detail, /"Cancel order"/);
});

test("a refund is visually and procedurally heavier than a cancel", () => {
  assert.match(dialogs, /Refund this order\?/);
  assert.match(dialogs, /This reverses a payment that was taken/);
  assert.match(dialogs, /A negative payment and a refund record are written against the shift that took the money/);
  // The acknowledgement is required for a refund and for nothing else.
  assert.match(dialogs, /const ready = reasonOk && \(!refund \|\| acknowledged\)/);
  assert.match(dialogs, /variant="danger"/);
});

test("a reason is mandatory for both actions", () => {
  assert.match(dialogs, /const reasonOk = reason\.trim\(\) !== ""/);
  assert.match(dialogs, /A reason is required/);
  assert.match(workspace, /const reason = validateVoidReason\(rawReason\)/);
});

test("the void path re-reads, re-derives the action, and re-gates before the RPC", () => {
  const v = workspace.slice(workspace.indexOf("const submitOrderVoid"), workspace.indexOf("Level 3D: the receipt"));
  assert.match(v, /const fresh = await readDeliveryOrder\(target\.id\)/);
  assert.match(v, /checkOrderContext\(fresh/);
  // Paid on another terminal while the dialog sat open: the operator's "cancel"
  // is no longer the action the server would perform, so it stops.
  assert.match(v, /if \(voidActionFor\(order\) !== intendedAction\)/);
  assert.match(v, /const shifts = await loadShiftOpenMap\(\[order\.shift_id\]\)/);
  assert.match(v, /if \(!gate\.allowed\) throw new Error/);
  assert.match(v, /latch: voidLatch\.current/);
  assert.match(v, /action: intendedAction/);
});

test("a closed-shift refund is stopped before the RPC, and explained in words", () => {
  const v = workspace.slice(workspace.indexOf("const submitOrderVoid"), workspace.indexOf("Level 3D: the receipt"));
  // The gate is re-evaluated against a freshly read shift state, and the throw
  // happens before `performVoid` is reached.
  assert.ok(v.indexOf("if (!gate.allowed) throw new Error") < v.indexOf("performVoid"));
  assert.match(detail, /\{!props\.voidGate\.allowed && props\.voidGate\.reason && \(/);
  // The reason itself says the ORDER's shift, so nobody tries opening their own.
  assert.match(read("lib", "pos", "deliveryOrderManagement.ts"), /A refund must be recorded in the shift that took the payment/);
});

test("a replayed void is reported as a replay, not as a second reversal", () => {
  assert.match(workspace, /That refund had already been recorded/);
  assert.match(workspace, /Nothing was reversed twice/);
  // And an unresolved state does not invite another tap.
  assert.match(workspace, /check the order before trying again/);
});

test("the order's own shift decides a refund, and a missing shift decides against it", () => {
  assert.equal(shiftIsOpen("open"), true);
  assert.equal(shiftIsOpen("closed"), false);
  assert.equal(shiftIsOpen("pending_manager_review"), false);
  assert.equal(shiftIsOpen(null), false);
  const shifts = new Map([["s1", true]]);
  assert.equal(orderShiftOpen(order(), shifts), true);
  assert.equal(orderShiftOpen(order({ shift_id: "s2" }), shifts), false);
  assert.equal(orderShiftOpen(order({ shift_id: null }), shifts), false);
  assert.equal(orderShiftOpen(null, shifts), false);
});

// --- the historical receipt --------------------------------------------------

test("a past order's receipt is a Delivery receipt, with the identity it was sent to", () => {
  const r = buildHistoricalReceipt({
    tenantName: "Dominos Pizza",
    branchName: "Main Branch",
    staffName: "Cashier",
    order: order({ status: "completed", payment_status: "paid", payment_method: "cash" }),
    payment: { method: "cash", currency: "USD", amount: 8, originalAmount: 8, exchangeRate: null, paidAt: null },
    lines: [{ name: "Pizza", qty: 1, unitPrice: 8, lineTotal: 8, modifiers: [{ name: "Small", price_delta: 0, quantity: 1 }] }],
    party,
    fallbackCurrency: "USD",
    at: "10/08/2026, 09:00",
  });
  // Without the explicit order type this inherits "Takeaway" - wrong on the one
  // document that leaves the building.
  assert.equal(r.orderType, "Delivery");
  assert.equal(r.customerName, "Desktop Level 3A QA");
  assert.equal(r.customerPhone, "03 111 222");
  assert.equal(r.deliveryAddress, "Home, Beirut, Hamra");
  assert.equal(r.paid, true);
  assert.equal(r.method, "cash");
  assert.equal(r.lines[0].modifiers?.[0].name, "Small");
});

test("every figure on a reprint is the server's, and cash handling is left blank", () => {
  const r = buildHistoricalReceipt({
    tenantName: "Dominos Pizza",
    branchName: "Main Branch",
    staffName: "Cashier",
    order: order({ subtotal: 10, discount_amount: 2, total_amount: 8, payment_status: "paid" }),
    payment: { method: "cash", currency: "USD", amount: 8, originalAmount: 8, exchangeRate: null, paidAt: null },
    lines: [],
    party,
    fallbackCurrency: "LBP",
    at: "x",
  });
  assert.equal(r.subtotal, 10);
  assert.equal(r.discount, 2);
  assert.equal(r.total, 8);
  // Tendered and change are captured at the till and stored nowhere. Inventing
  // them would put unsupported numbers on a document the customer keeps.
  assert.equal(r.tendered, null);
  assert.equal(r.change, null);
  // The order's own currency wins over the fallback.
  assert.equal(r.currency, "USD");
});

test("an unpaid order's receipt says unpaid rather than pretending otherwise", () => {
  const r = buildHistoricalReceipt({
    tenantName: null,
    branchName: "Main Branch",
    staffName: null,
    order: order(),
    payment: null,
    lines: [],
    party: UNKNOWN_PARTY,
    fallbackCurrency: "USD",
    at: "x",
  });
  assert.equal(r.paid, false);
  assert.equal(r.method, null);
  assert.equal(r.businessName, "Breadee");
});

test("opening a past receipt writes nothing", () => {
  const receipt = workspace.slice(workspace.indexOf("const openHistoricalReceipt"), workspace.indexOf("// F4 OPENS"));
  for (const token of ["callPosRpc", "pos_pay_order", "pos_edit_order", "pos_void_order", "insert", "update"]) {
    assert.equal(receipt.includes(token), false, `reopening a receipt must not ${token}`);
  }
  assert.match(receipt, /readHistoricalReceipt\(/);
  // The reader itself is three reads.
  assert.match(history, /readOrderReceiptLines\(input\.order\.id\)/);
  assert.match(history, /readOrderPayment\(input\.order\.id\)/);
});

// Found on staging: the queue is scoped to the open shift, or to today when
// there is none, so an order from a previous day is not reachable from it at
// all. With the detail panel as the only entry point, a delivery receipt could
// be reopened for a few hours and then never again - the "read-only receipt
// gap" this level exists to close was only closed for today. The customer's
// order history is the one surface that does list older orders, so the entry
// point belongs there too.
test("a receipt can be reopened from the customer's history, not only from today's queue", () => {
  const dialogs = stripJsxComments(read("components", "pos", "CustomerDialogs.tsx"));
  assert.match(dialogs, /onReceipt\?: \(orderId: string\) => void;/);
  assert.match(dialogs, /props\.onReceipt && o\.order_type === "delivery"/);
  assert.match(workspace, /onReceipt=\{\(orderId\) => void openHistoricalReceiptById\(orderId\)\}/);
});

test("a history receipt re-reads the order rather than trusting the history row", () => {
  // The row carries no subtotal, discount, note or shift. A receipt assembled
  // from it would be a document with invented figures on it.
  const fn = workspace.slice(workspace.indexOf("const openHistoricalReceiptById"), workspace.indexOf("// F4 OPENS"));
  assert.match(fn, /const order = await readDeliveryOrder\(orderId\)/);
  assert.match(fn, /await openHistoricalReceipt\(order\)/);
  // Same builder as the queue path - not a second receipt implementation.
  assert.equal((workspace.match(/readHistoricalReceipt\(/g) ?? []).length, 1);
});

test("the history receipt is offered for delivery orders only", () => {
  // The rebuilt receipt names itself a Delivery receipt, so offering it on a
  // takeaway row would print the wrong order type onto a real document.
  const dialogs = stripJsxComments(read("components", "pos", "CustomerDialogs.tsx"));
  const guard = dialogs.slice(dialogs.indexOf("props.onReceipt &&"), dialogs.indexOf("props.onReceipt &&") + 200);
  assert.match(guard, /o\.order_type === "delivery"/);
});

test("reopening a receipt from history still writes nothing, and says so", () => {
  const dialogs = stripJsxComments(read("components", "pos", "CustomerDialogs.tsx"));
  for (const token of ["callPosRpc", "pos_pay_order", "pos_void_order", "pos_edit_order", "insert", "update"]) {
    assert.equal(dialogs.includes(token), false, `the history dialog must not ${token}`);
  }
  // The footer no longer claims refunding is unavailable "yet" - Level 3D
  // added it, on the detail panel where the gates live - but it still says
  // plainly that this list reorders and edits nothing.
  assert.match(dialogs, /Read only\. Reordering and editing a past order from here are not available/);
});

test("a reprint carries the order's own time, not the moment it was reprinted", () => {
  assert.match(workspace, /at: order\.created_at \? new Date\(order\.created_at\)\.toLocaleString\(\) : ""/);
});

test("a refunded order's receipt shows what was charged, not the reversal", () => {
  // Two payment rows exist after a refund; the earliest is the charge.
  assert.match(history, /\.order\("paid_at"\)\s*\.limit\(1\)/);
});

test("Level 3D routes nothing to a printer", () => {
  for (const [name, src] of [
    ["workspace", workspace],
    ["detail", detail],
    ["history", history],
  ] as const) {
    for (const token of ["escpos", "ESC/POS", "printerId", "usb", "socket", "invoke("]) {
      assert.equal(src.toLowerCase().includes(token.toLowerCase()), false, `${name} must not reach a printer (${token})`);
    }
  }
});

// --- identity ----------------------------------------------------------------

test("one address formatter serves the card, the queue, the detail and the receipt", () => {
  assert.equal(
    addressText({ address_label: "Home", area: "Beirut", street: "Hamra", building: "5", floor: "2" }),
    "Home, Beirut, Hamra, Bldg 5, Fl 2",
  );
  assert.equal(addressText({ street: "Hamra" }), "Hamra");
  assert.equal(addressText(null), "");
  // The card re-exports it rather than keeping a second copy that could drift.
  assert.match(stripComments(read("components", "pos", "CustomerCard.tsx")), /return addressText\(a\)/);
});

test("a receipt's identity comes from the ORDER, never from the current selection", () => {
  assert.match(workspace, /const receiptIdentity = useCallback/);
  assert.match(workspace, /if \(selected && selected\.id === order\.customer_id\)/);
  assert.match(workspace, /selected\.addresses\.find\(\(x\) => x\.id === order\.address_id\)/);
  // The fallback is the queue's own lookup, keyed by ORDER id.
  assert.match(workspace, /const p = parties\.get\(order\.id\)/);
});

test("an unresolved party degrades to blanks rather than to somebody else's name", () => {
  assert.deepEqual(UNKNOWN_PARTY, { customerName: null, customerPhone: null, addressText: null });
  assert.match(queue, /props\.parties\.get\(o\.id\) \?\? UNKNOWN_PARTY/);
});

test("the queue row shape is converted for settlement rather than re-implemented", () => {
  const o = order();
  const open = toOpenDeliveryOrder(o);
  assert.equal(open.id, o.id);
  assert.equal(open.payment_status, o.payment_status);
  assert.equal(open.total_amount, o.total_amount);
  assert.equal(open.customer_id, o.customer_id);
  assert.equal(open.address_id, o.address_id);
  // Queue-only fields do not travel into the settlement shape.
  assert.equal("shift_id" in open, false);
  assert.equal("subtotal" in open, false);
});

// --- permissions -------------------------------------------------------------

test("the three Level 3D permissions are separate, because the server separates them", () => {
  assert.match(accessSrc, /VIEW_ORDERS: "pos\.view_orders"/);
  assert.match(accessSrc, /EDIT_ORDERS: "pos\.edit_orders"/);
  assert.match(accessSrc, /CANCEL_ORDERS: "pos\.cancel_orders"/);
  // A cashier who may correct a note is not thereby one who may reverse money.
  assert.match(accessSrc, /export function canEditOrders/);
  assert.match(accessSrc, /export function canCancelOrders/);
  assert.equal(/canEditOrders[\s\S]{0,200}CANCEL_ORDERS/.test(accessSrc), false);
});

test("the Orders view is gated, and the gate is honoured rather than decorative", () => {
  assert.match(workspace, /const viewOrdersGate = useMemo\(\(\) => canViewOrders\(pos\.access\)/);
  assert.match(workspace, /gate=\{viewOrdersGate\}/);
  assert.match(workspace, /viewOrdersGate\.allowed \? \(/);
});

// --- the allow-list ----------------------------------------------------------

test("Level 3D's screens add no RPC of their own, and never the item remover", () => {
  const rpcSrc = stripComments(read("lib", "pos", "rpc.ts"));
  const union = rpcSrc.slice(rpcSrc.indexOf("export type PosRpcName"), rpcSrc.indexOf("export class PosRpcError"));
  const names = [...union.matchAll(/"(pos_[a-z_]+)"/g)].map((m) => m[1]);
  // 16 since Desktop 1.0.4; 18 since Wave 2C added the two receivables
  // settlement RPCs (`pos_complete_on_account`, `pos_complete_table_on_account`).
  assert.equal(names.length, 18);
  assert.ok(names.includes("pos_edit_order"));
  assert.ok(names.includes("pos_void_order"));
  assert.ok(names.includes("pos_complete_on_account"));
  assert.ok(names.includes("pos_complete_table_on_account"));
  assert.equal(names.includes("pos_remove_order_item"), false);
  // And no component reaches an RPC directly - they all go through the adapter.
  for (const src of [queue, detail, dialogs]) {
    assert.equal(src.includes("callPosRpc"), false);
  }
});

test("the new read module writes to no table", () => {
  for (const table of ["pos_orders", "pos_payments", "pos_shifts", "pos_customers", "pos_customer_addresses"]) {
    const writes = [...history.matchAll(new RegExp(`from\\("${table}"\\)\\s*\\.(insert|update|upsert|delete)`, "g"))];
    assert.equal(writes.length, 0, `${table} must not be written`);
  }
  const froms = [...history.matchAll(/\.from\("pos_[a-z_]+"\)\s*\n?\s*\.(\w+)/g)].map((m) => m[1]);
  assert.ok(froms.length >= 3);
  assert.deepEqual([...new Set(froms)], ["select"]);
});

// --- regression --------------------------------------------------------------

test("Levels 3A/3B/3C are still reachable and unchanged in shape", () => {
  // Customer foundation, ordering, and settlement all still hang off the same
  // workspace, and Level 3D did not fork any of them.
  for (const token of [
    "performCustomerCreate",
    "decideCreate",
    "buildDeliveryPayload",
    "performDeliveryOrder",
    "revalidateTarget",
    "performDeliverySettlement",
    "checkSettlementTarget",
    "deliveryIsSettled",
  ]) {
    assert.ok(workspace.includes(token), `${token} should still be wired`);
  }
  assert.equal((workspace.match(/createDeliveryLatch\(\)/g) ?? []).length, 1);
  assert.equal((workspace.match(/createSettlementLatch\(\)/g) ?? []).length, 1);
});

test("Level 3D queues nothing offline and holds no cart of its own", () => {
  for (const src of [queue, detail, dialogs, history]) {
    assert.equal(/enqueue|outbox|offline\/db|pendingCount/.test(src), false);
    assert.equal(src.includes("useCart"), false);
  }
});

test("the shell, the single-instance guard and the other order types are untouched", () => {
  const posWorkspace = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  // Level 3D added a view INSIDE delivery, so the shell needed no new branch.
  for (const token of ["DeliveryOrderQueue", "DeliveryOrderDetail", "EditOrderDialog", "VoidOrderDialog", 'view === "orders"']) {
    assert.equal(posWorkspace.includes(token), false, `${token} belongs inside Delivery, not in the shell`);
  }
  assert.match(posWorkspace, /deliveryActive && !addingToDelivery \? \(/);
});

test("the dashboard copy still promises only what the desktop has", () => {
  // RETARGETED BY POS v1: the exact sentence changed when printing shipped. What
  // Level 3D cared about here was that DELIVERY is named as a full order type
  // rather than the customers-only phase it used to describe, so that is what is
  // asserted now. The tile's full both-directions rule lives in
  // `native-printing.test.ts`.
  const modules = stripComments(read("lib", "modules.ts"));
  const desc = modules.slice(modules.indexOf('key: "pos"'), modules.indexOf('key: "inventory"'));
  assert.ok(desc.includes("Takeaway, Dine-in and Delivery POS"));
  assert.ok(desc.includes("customers and addresses"));
  assert.equal(/delivery customers only|customers only/i.test(desc), false);
});
