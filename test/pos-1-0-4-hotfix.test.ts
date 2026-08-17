// Desktop 1.0.4 - the emergency POS corrections, pinned.
//
// A tenant was affected in production by four things at once, and each has a
// property here that would have caught it:
//
//   1. THE CURRENT ORDER WAS FICTION. The side column offered `Order 1`,
//      `Order 2`, `Order 3` - numbers the till invented for three parked cart
//      snapshots. Nothing in the business answered to them, so the number on the
//      screen, the number on the paper and the number in the Orders list were
//      three names for one sale, and the buttons acted on whichever the slot
//      happened to hold. The carousel now shows the order number the SERVER
//      issued, one at a time, over the orders that actually exist.
//   2. VIEWING AN ORDER MUST COST NOTHING. Selecting, stepping or opening an
//      order issues no submission and no payment. This is the assertion that
//      matters most in the file: a browse that writes is a duplicate order.
//   3. AN ORDER IS PAID ONCE. Pay is offered only while the shared lifecycle
//      rule says the server would accept it, and there is one payment handler
//      reaching one `pos_pay_order`.
//   4. AUTO PRINT IS A CONVENIENCE, NEVER A GATE. On is silent, off keeps the
//      preview, and a printer failure leaves a committed transaction committed.
//
// Source assertions are used where the property is structural (what a handler
// can reach, which module owns a decision); behaviour is exercised directly
// where a pure function or a store makes that possible, because a real call is
// worth more than a matching string.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import { useShiftOrders, selectedShiftOrder } from "@/state/shiftOrders";
import {
  DESTRUCTIVE_ORDER_CTA,
  canSettleOrder,
  isTerminalOrder,
  reversalActionFor,
} from "@/lib/pos/orderActions";
import { stableSelectionIndex, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import {
  COMPLETION_SEQUENCE,
  EXISTING_ORDER_COMPLETION_SEQUENCE,
  buildPaymentReceipt,
  completePayment,
} from "@/lib/pos/paymentCompletion";
import { tableNamesForCount, validateTableCount } from "@/lib/pos/tables";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");
const srcPath = (...p: string[]) => join(root, "..", "src", ...p);

const workspace = stripJsxComments(readSrc("screens", "pos", "PosWorkspace.tsx"));
const cartPanel = stripJsxComments(readSrc("components", "pos", "CartPanel.tsx"));
const currentOrder = stripJsxComments(readSrc("components", "pos", "CurrentOrderPanel.tsx"));
const carousel = stripJsxComments(readSrc("components", "pos", "OrderCarousel.tsx"));
const ordersStore = stripComments(readSrc("state", "shiftOrders.ts"));
const posSettings = stripJsxComments(readSrc("screens", "settings", "PosSettings.tsx"));
const tablesLib = stripComments(readSrc("lib", "pos", "tables.ts"));
const paymentDialog = stripJsxComments(readSrc("components", "pos", "PaymentDialog.tsx"));
const keypad = stripJsxComments(readSrc("components", "pos", "NumericKeypad.tsx"));
const receiptStore = stripComments(readSrc("state", "receipt.ts"));
const kitchenStore = stripComments(readSrc("state", "kitchenTicket.ts"));

const order = (over: Partial<ShiftOpenOrder> = {}): ShiftOpenOrder => ({
  id: "o1",
  order_number: "260817-0004",
  order_type: "takeaway",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  payment_method: null,
  subtotal: 100,
  discount_amount: 0,
  total_amount: 100,
  currency: "USD",
  table_id: null,
  customer_id: null,
  customer_name: null,
  customer_phone: null,
  cashier_user_id: null,
  staff_name: null,
  notes: null,
  created_at: null,
  ...over,
});

/** Three real orders, oldest first, exactly as `loadShiftOrders` returns them. */
const THREE = [
  order({ id: "a", order_number: "260817-0003" }),
  order({ id: "b", order_number: "260817-0004" }),
  order({ id: "c", order_number: "260817-0005" }),
];

/** Seed the real store without a network. `refresh` is the only reader. */
function seed(orders: ShiftOpenOrder[], index: number) {
  useShiftOrders.setState({ orders, index, loading: false, error: null, shiftId: "shift-1" });
}

// =============================================================================
// 1. the fake Order 1 / Order 2 / Order 3 model is gone
// =============================================================================

test("the invented order slots do not exist anywhere in the app", () => {
  // The two modules that WERE the model.
  assert.equal(existsSync(srcPath("state", "takeawayOrders.ts")), false, "the slot store must be gone");
  assert.equal(existsSync(srcPath("components", "pos", "OrderTabs.tsx")), false, "the tab strip must be gone");
  // And nothing renders a slot index as if it were an order.
  for (const src of [workspace, cartPanel, currentOrder, carousel]) {
    assert.equal(/Order \{[^}]*position/.test(src), false, "a slot position must never be shown as an order");
    assert.equal(src.includes("TAKEAWAY_SLOT_COUNT"), false);
    assert.equal(src.includes("takeawayOrders"), false);
  }
});

test("the carousel shows ONE real order number, from the server", () => {
  // The centre is the server's `order_number`, prefixed - never an index, and
  // never a count of slots.
  assert.match(carousel, /`#\$\{props\.orderNumber\}`/);
  assert.match(currentOrder, /orderNumber=\{order \? \(order\.order_number \?\? order\.id\.slice\(0, 8\)\) : null\}/);
  // Exactly one value is rendered in the centre - there is no list of tabs.
  assert.equal(carousel.includes(".map("), false, "the carousel must not render a list of orders");
});

test("an unsaved draft shows no order number at all", () => {
  // The draft is the one thing that legitimately has no number, and inventing a
  // placeholder for it is precisely how `Order 1` came to exist.
  assert.match(carousel, /props\.draft \?/);
  assert.match(carousel, /New order/);
  assert.match(workspace, /orderNumber=\{null\}[\s\S]{0,200}draft/);
});

// =============================================================================
// 2. the arrows navigate REAL orders, and navigating writes nothing
// =============================================================================

test("the arrows step through the shift's real orders, with wrap-around", () => {
  seed(THREE, 1);
  assert.equal(selectedShiftOrder(useShiftOrders.getState())?.order_number, "260817-0004");
  useShiftOrders.getState().step(1);
  assert.equal(selectedShiftOrder(useShiftOrders.getState())?.order_number, "260817-0005");
  useShiftOrders.getState().step(1);
  assert.equal(selectedShiftOrder(useShiftOrders.getState())?.order_number, "260817-0003", "last wraps to first");
  useShiftOrders.getState().step(-1);
  assert.equal(selectedShiftOrder(useShiftOrders.getState())?.order_number, "260817-0005");
});

test("one order means the arrows are disabled", () => {
  // The rule lives in the carousel, and it is the literal requirement: a shift
  // holding a single order has nowhere to step to.
  assert.match(carousel, /const disabled = props\.count === 0 \|\| \(props\.count === 1 && !props\.draft\)/);
  assert.equal((carousel.match(/disabled=\{disabled\}/g) ?? []).length, 2, "both arrows read the same flag");
  // Stepping a single-order shift is a no-op in the store too, so the UI is not
  // the only thing standing between an arrow and a wrong selection.
  seed([THREE[0]], 0);
  useShiftOrders.getState().step(1);
  assert.equal(selectedShiftOrder(useShiftOrders.getState())?.id, "a");
});

test("selecting or stepping an order cannot reach a write of any kind", () => {
  // THE assertion of this file. The store that owns selection issues nothing but
  // SELECTs, and the workspace's two entry points call it and set a view flag.
  for (const forbidden of [
    "callPosRpc",
    ".rpc(",
    "pos_submit_order",
    "pos_pay_order",
    "pos_configure_tables",
    "submitOrder",
    "payOrder",
    "autoPrint",
    ".insert(",
    ".update(",
    ".delete(",
  ]) {
    assert.equal(ordersStore.includes(forbidden), false, `${forbidden} must not be reachable from the order store`);
  }
  const show = workspace.slice(workspace.indexOf("const showSavedOrder"), workspace.indexOf("const stepSavedOrder"));
  assert.match(show, /useShiftOrders\.getState\(\)\.select\(orderId\)/);
  for (const forbidden of ["submitOrder", "ensureOrder", "payOrder", "cart.", "useCart", "sendToKitchen"]) {
    assert.equal(show.includes(forbidden), false, `selecting an order must not reach ${forbidden}`);
  }
  const step = workspace.slice(workspace.indexOf("const stepSavedOrder"), workspace.indexOf("const showDraft"));
  assert.match(step, /useShiftOrders\.getState\(\)\.step\(direction\)/);
  for (const forbidden of ["submitOrder", "ensureOrder", "payOrder", "useCart"]) {
    assert.equal(step.includes(forbidden), false, `stepping must not reach ${forbidden}`);
  }
});

test("the Orders dropdown and the Orders modal load the SAME order into the panel", () => {
  // Both surfaces go through the one handler, so "select an order" means one
  // thing wherever it was pressed - and the handler closes the modal, switches
  // to the route that owns the Current Order, and selects by id.
  assert.equal((workspace.match(/onSelectOrder=\{showSavedOrder\}/g) ?? []).length, 3);
  const show = workspace.slice(workspace.indexOf("const showSavedOrder"), workspace.indexOf("const stepSavedOrder"));
  assert.match(show, /setViewingSavedOrder\(true\)/);
  assert.match(show, /setMode\("takeaway"\)/);
  assert.match(show, /setOrdersOpen\(false\)/);
  // And selecting an unknown id changes nothing rather than clearing the panel.
  seed(THREE, 1);
  useShiftOrders.getState().select("not-in-this-shift");
  assert.equal(selectedShiftOrder(useShiftOrders.getState())?.id, "b");
  useShiftOrders.getState().select("c");
  assert.equal(selectedShiftOrder(useShiftOrders.getState())?.id, "c");
});

test("no stale order survives a refresh or a navigation", () => {
  // The panel has no order of its own: it renders `props.order`, which is
  // derived from the index every render. There is no second copy to go stale.
  assert.match(workspace, /const currentOrder = selectedShiftOrder\(shiftOrders\)/);
  assert.equal(currentOrder.includes("useState<ShiftOpenOrder"), false, "the panel must not cache an order");
  // A refresh keeps the SELECTED order rather than the index, so an order
  // arriving underneath the operator cannot swap what they are reading.
  assert.equal(stableSelectionIndex("c", 2, [THREE[2], ...THREE.slice(0, 2)]), 0);
  // An order that has left the shift falls back rather than pointing past the end.
  assert.equal(stableSelectionIndex("gone", 9, THREE), 2);
  // And a just-created order wins outright - that is "it becomes the Current Order".
  assert.equal(stableSelectionIndex("a", 0, THREE, "c"), 2);
});

test("a newly created order becomes the Current Order, but never at the cart's expense", () => {
  const adopt = workspace.slice(workspace.indexOf("const adoptCreatedOrder"), workspace.indexOf("const sendToKitchen"));
  assert.match(adopt, /preferId: orderId/);
  // The cart is freed ONLY once the refreshed list actually holds the order.
  assert.match(adopt, /if \(!found\) return false/);
  assert.ok(
    adopt.indexOf("if (!found) return false") < adopt.indexOf("useCart.getState().reset()"),
    "an unconfirmed handover must not clear the cart - that is how order 260814-0001 was stranded",
  );
});

// =============================================================================
// 3. action states derive from the real order
// =============================================================================

test("Pay is offered for an unpaid order and withheld from a settled one", () => {
  assert.equal(canSettleOrder(order({ payment_status: "unpaid" })), true);
  assert.equal(canSettleOrder(order({ payment_status: "paid", status: "completed" })), false);
  assert.equal(canSettleOrder(order({ status: "voided" })), false);
  assert.equal(canSettleOrder(order({ status: "cancelled" })), false);
  assert.equal(canSettleOrder(order({ status: "refunded", payment_status: "refunded" })), false);
  // The panel uses that rule rather than an opinion of its own, and REMOVES the
  // control rather than disabling it - a disabled Pay still says settling here
  // is a thing that exists.
  assert.match(currentOrder, /const settleable = order \? canSettleOrder\(order\) : false/);
  assert.match(currentOrder, /props\.onPay && settleable/);
});

test("a second settlement is refused again at the press, not only at the render", () => {
  const open = workspace.slice(workspace.indexOf("const openPaymentForOrder"), workspace.indexOf("const confirmPayment"));
  assert.match(open, /if \(!canSettleOrder\(order\)\)/);
  // One dialog, one confirm handler, one payment RPC in the whole workspace.
  assert.equal((workspace.match(/<PaymentDialog/g) ?? []).length, 1);
  assert.equal((workspace.match(/const confirmPayment = useCallback/g) ?? []).length, 1);
  assert.equal((workspace.match(/await payOrder\(/g) ?? []).length, 1);
  // And the synchronous latch still guards it, so two clicks in one tick cannot
  // both reach the server.
  const pay = workspace.slice(workspace.indexOf("const confirmPayment"), workspace.indexOf("const doOpenShift"));
  assert.match(pay, /if \(inFlight\.current\) return;\s*inFlight\.current = true;/);
});

test("settling an existing order does not touch the draft cart", () => {
  assert.deepEqual(COMPLETION_SEQUENCE, ["present-receipt", "close-payment-dialog", "reset-cart"]);
  assert.deepEqual(EXISTING_ORDER_COMPLETION_SEQUENCE, ["present-receipt", "close-payment-dialog"]);
  const input = {
    result: {
      order_id: "o1",
      order_number: "260817-0004",
      method: "cash",
      subtotal: 100,
      discount: 0,
      amount: 100,
      exchange_rate: null,
    },
    lines: [],
    fallbackOrderNumber: "260817-0004",
    tenantName: "T",
    branchName: "B",
    operatorName: "O",
    primaryCurrency: "USD",
    tenderCurrency: "USD",
    rate: null,
    tenderedInput: null,
    shiftId: null,
    at: "now",
  } as Parameters<typeof completePayment>[0];
  assert.equal(completePayment(input).steps.includes("reset-cart"), true);
  assert.equal(completePayment({ ...input, existingOrder: true }).steps.includes("reset-cart"), false);
  // The receipt for an existing order is built from the SERVER's lines.
  const receipt = buildPaymentReceipt({
    ...input,
    existingOrder: true,
    receiptLines: [{ name: "Manakish", qty: 2, unitPrice: 50, lineTotal: 100, modifiers: [], note: null }],
  });
  assert.equal(receipt.lines.length, 1);
  assert.equal(receipt.lines[0].name, "Manakish");
  // Every money figure is still the server's response, never the cart's.
  assert.equal(receipt.total, 100);
});

test("Print binds to the selected order and takes no payment", () => {
  // The panel reads the order it was given, at call time, and goes to the
  // server for the lines rather than to whatever the cart holds.
  assert.match(currentOrder, /readOrderReceiptLines\(order\.id\)/);
  for (const forbidden of ["payOrder", "submitOrder", "autoPrintReceipt", "autoPrintKitchenTicket", "presentReceipt("]) {
    assert.equal(currentOrder.includes(forbidden), false, `Print must not reach ${forbidden}`);
  }
  // And the workspace hands it the MANUAL layer in both places it mounts it.
  assert.equal((workspace.match(/onPresentReceipt=\{\(receipt\) => receiptStore\.present\(receipt\)\}/g) ?? []).length, 2);
});

test("a saved order says Delete / Void and a draft says Clear cart", () => {
  assert.equal(DESTRUCTIVE_ORDER_CTA, "Delete / Void");
  assert.match(currentOrder, /\{DESTRUCTIVE_ORDER_CTA\}/);
  // The draft keeps its own wording, and never borrows the saved one.
  assert.match(cartPanel, /props\.clearLabel \?\? "Clear cart"/);
  assert.equal(cartPanel.includes("DESTRUCTIVE_ORDER_CTA"), false, "a draft has no order to void");
  assert.equal(cartPanel.includes("Delete / Void"), false);
  assert.match(workspace, /clearLabel=\{cart\.savedOrder \? "Clear cart \(leaves the order unpaid\)" : "Clear cart"\}/);
  // The destructive control is offered only where the lifecycle permits one, and
  // the existing reversal semantics are untouched: unpaid cancels, paid refunds.
  assert.equal(reversalActionFor(order({ payment_status: "unpaid" })), "cancel");
  assert.equal(reversalActionFor(order({ payment_status: "paid" })), "refund");
  assert.equal(reversalActionFor(order({ status: "voided" })), null);
  assert.equal(isTerminalOrder(order({ status: "refunded" })), true);
});

// =============================================================================
// 4. tables - one shared contract with the web app
// =============================================================================

test("the desktop configures tables through the web app's own RPC", () => {
  assert.match(tablesLib, /callPosRpc\("pos_configure_tables", \{ p_branch: input\.branchId, p_names: input\.names \}\)/);
  assert.match(posSettings, /configureTables\(\{ branchId, names \}\)/);
  // Branch-scoped, and refused rather than guessed when there is no branch.
  assert.match(tablesLib, /if \(!input\.branchId\) throw new Error\("A branch is required to configure tables"\)/);
  // NOT a terminal preference. A second store is how two answers to one question
  // begin, and capacity has to be the same number the web app shows.
  for (const forbidden of ["localStorage", "sessionStorage", "breadee-desktop"]) {
    assert.equal(tablesLib.includes(forbidden), false, `table capacity must not be kept in ${forbidden}`);
  }
  assert.equal(
    /localStorage[\s\S]{0,400}table/i.test(posSettings),
    false,
    "the tables section must not cache capacity locally",
  );
});

test("existing table names survive a count change and new positions are left to the server", () => {
  const tables = [
    { name: "Terrace 1", configured: true, sort_order: 1 },
    { name: "Terrace 2", configured: true, sort_order: 2 },
    // A legacy free-text row. It is NOT capacity and must not be adopted.
    { name: "7", configured: false, sort_order: null },
  ] as never as Parameters<typeof tableNamesForCount>[1];
  assert.deepEqual(tableNamesForCount(4, tables), ["Terrace 1", "Terrace 2", "", ""]);
  assert.deepEqual(tableNamesForCount(1, tables), ["Terrace 1"]);
  assert.deepEqual(tableNamesForCount(0, tables), []);
  // The blank entries are the server's `Table i` default, not one invented here.
  assert.equal(tablesLib.includes('"Table "'), false, "the desktop must not name tables itself");
});

test("an impossible table count is refused before it reaches the server", () => {
  assert.equal(validateTableCount("10").count, 10);
  assert.equal(validateTableCount("0").count, 0);
  assert.equal(validateTableCount("").count, null);
  assert.equal(validateTableCount("-1").count, null);
  assert.equal(validateTableCount("4.5").count, null);
  assert.equal(validateTableCount("501").count, null);
  assert.ok(validateTableCount("501").error?.includes("500"));
});

test("the counters and the shrink rule are the server's, not the screen's", () => {
  // Configured / available / occupied come straight from `pos_table_map`.
  assert.match(posSettings, /loadTableMap\(branchId\)/);
  assert.match(posSettings, /tableMap\?\.configured/);
  assert.match(posSettings, /tableMap\?\.available/);
  assert.match(posSettings, /tableMap\?\.occupied/);
  // Legacy rows are reported separately and never folded into the count.
  assert.match(posSettings, /legacy_hidden/);
  // The refusal to shrink past an occupied table is the server's message,
  // surfaced verbatim rather than pre-empted by a rule invented here.
  assert.equal(/if \(count < .*occupied/.test(posSettings), false, "the desktop must not re-implement the shrink rule");
  assert.match(posSettings, /setTablesError\(e instanceof Error \? e\.message/);
  // An authoritative re-read after the save, rather than a local patch.
  assert.match(posSettings, /await loadTables\(\)/);
});

test("Configure tables lands on the tables section of Desktop POS settings", () => {
  assert.match(workspace, /onConfigureTables: \(\) => navigate\("\/settings\/pos#tables"\)/);
  assert.match(posSettings, /id="tables"/);
  assert.match(posSettings, /document\.getElementById\("tables"\)/);
  // It does NOT send the operator back to the web app now that the desktop owns
  // the setting.
  assert.equal(/breadee\.com|web app to configure/i.test(posSettings), false);
});

test("this hotfix adds no database migration", () => {
  // The contracts it uses already exist. A desktop release that shipped a
  // migration would be a schema change riding on an emergency UI fix.
  assert.equal(existsSync(join(root, "..", "supabase")), false, "the desktop repo carries no migrations");
});

// =============================================================================
// 5. the payment modal - smaller, and identical underneath
// =============================================================================

test("every payment control survives the compact layout", () => {
  for (const control of [
    "Subtotal",
    "Total",
    'label="Method"',
    'label="Currency"',
    'label="Discount"',
    "Tendered",
    'label="Due"',
    'label="Change"',
    "<NumericKeypad",
    "Cancel",
    "Confirm ",
  ]) {
    assert.ok(paymentDialog.includes(control), `${control} must still be in the payment dialog`);
  }
  assert.match(paymentDialog, /PAYMENT_METHODS\.map/);
  assert.match(paymentDialog, /\["USD", "LBP"\]/);
  assert.match(paymentDialog, /\["none", "percent", "amount"\]/);
  assert.match(keypad, /"7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00", "\."/);
  assert.match(keypad, />\s*Back\s*</);
  assert.match(keypad, />\s*Clear\s*</);
});

test("the compact layout changed no arithmetic and no contract", () => {
  // Every figure still comes from the same shared validator and the same
  // conversion helpers - this was a layout change and nothing else.
  assert.match(paymentDialog, /computeDiscount\(props\.subtotal, props\.discountGate\.allowed \? discountType : "none", discountInPrimary\)/);
  assert.match(paymentDialog, /computeChange\(dueInTender, tenderedNum, currency\)/);
  assert.match(paymentDialog, /fixedDiscountToPrimary\(discountType, discountValue, currency, props\.primaryCurrency, props\.rate\)/);
  assert.match(paymentDialog, /discountPayload\(props\.discountGate\.allowed, props\.subtotal, discountType, discountInPrimary\)/);
  // It calls no RPC and owns no order.
  for (const forbidden of ["callPosRpc", "payOrder", "pos_pay_order", ".rpc("]) {
    assert.equal(paymentDialog.includes(forbidden), false, `${forbidden} must not be in the payment dialog`);
  }
  // Confirm fires the caller's handler exactly once, and only when allowed.
  assert.equal((paymentDialog.match(/props\.onConfirm\(\{/g) ?? []).length, 1);
  assert.match(paymentDialog, /if \(!canConfirm\) return;/);
  assert.equal((paymentDialog.match(/onClick=\{confirm\}/g) ?? []).length, 1);
});

test("the payment modal fits a 1366x768 till", () => {
  // `lg` is 896px of modal for a form whose widest row is three buttons, and it
  // pushed Confirm below the fold at 768px tall.
  // The MODAL's own size - read from the <Modal> props, not from the two
  // deliberately large buttons in its footer.
  const modal = paymentDialog.slice(paymentDialog.indexOf("<Modal"), paymentDialog.indexOf("footer={"));
  assert.match(modal, /size="md"/);
  assert.equal(modal.includes('size="lg"'), false, "the payment modal must not be the widest size");
  assert.equal(paymentDialog.includes("md:grid-cols-[1fr_260px]"), false, "the old two-column split must be gone");
  assert.match(paymentDialog, /sm:grid-cols-\[minmax\(0,1fr\)_212px\]/);
  assert.match(paymentDialog, /<NumericKeypad compact/);
  // The keys stay at or above the touch target the rest of the POS holds to.
  assert.match(keypad, /const key = compact \? "min-h-\[44px\]" : "min-h-\[56px\]"/);
  // Confirm is still the strong primary and Cancel still secondary.
  assert.match(paymentDialog, /<Button variant="ghost" size="lg" onClick=\{props\.onCancel\}/);
  assert.match(paymentDialog, /<Button size="lg" onClick=\{confirm\} disabled=\{!canConfirm\}/);
});

// =============================================================================
// 6. auto print - the 1.0.4 matrix
// =============================================================================

test("Customer Auto Print ON is silent: paper, and no preview", () => {
  const present = workspace.slice(workspace.indexOf("const presentReceipt"), workspace.indexOf("const [cartDrawerOpen"));
  // The receipt is STORED either way, so Ctrl+P can reopen it...
  assert.match(present, /receiptStore\.stage\(receipt\)/);
  // ...and the preview is raised only when nothing was printed automatically.
  assert.match(present, /if \(printed\.kind === "sent"\) return;/);
  assert.match(receiptStore, /stage: \(receipt\) => set\(\{ receipt, visible: false \}\)/);
  assert.match(receiptStore, /present: \(receipt\) => set\(\{ receipt, visible: true \}\)/);
});

test("Customer Auto Print OFF keeps the preview and its manual Print", () => {
  const present = workspace.slice(workspace.indexOf("const presentReceipt"), workspace.indexOf("const [cartDrawerOpen"));
  assert.match(present, /receiptStore\.present\(receipt\)/);
  // The decision is the PRINT RESULT, never a second settings read - the screen
  // and the printer cannot disagree if only one of them decided.
  assert.equal(present.includes("readReceiptDesign"), false);
  assert.equal(present.includes("autoPrintEnabled"), false);
});

test("Kitchen Auto Print ON is silent, OFF keeps the ticket preview", () => {
  assert.match(kitchenStore, /present: \(ticket, status\) => set\(\{ ticket, status, visible: status\.kind !== "auto_sent" \}\)/);
  assert.match(kitchenStore, /stage: \(ticket, status\) => set\(\{ ticket, status, visible: false \}\)/);
  // The three statuses, and no fourth model.
  for (const kind of ["auto_sent", "auto_failed", "manual"]) {
    assert.ok(kitchenStore.includes(`"${kind}"`), `${kind} must be part of the status model`);
  }
});

test("a print failure is a notice, never a rolled-back transaction", () => {
  const present = workspace.slice(workspace.indexOf("const presentReceipt"), workspace.indexOf("const [cartDrawerOpen"));
  assert.match(present, /The payment succeeded\. Only the receipt failed to print\./);
  assert.match(present, /tone: "warning"/);
  // A failure must NOT reopen the preview - the sale is done and a modal in the
  // cashier's way is the thing this release removes.
  const failure = present.slice(present.indexOf('printed.kind === "failed"'));
  assert.equal(
    failure.slice(0, failure.indexOf("return;")).includes("receiptStore.present"),
    false,
    "a failed automatic print must not raise the preview",
  );
  const kitchen = workspace.slice(workspace.indexOf("const printKitchenFor"), workspace.indexOf("const presentReceipt"));
  assert.match(kitchen, /status\.kind === "auto_failed"/);
  assert.match(kitchen, /kitchenStore\.stage\(ticket, status\)/);
  assert.match(kitchen, /Order sent\. The kitchen ticket was not printed\./);
  // Nothing on either path voids, reverses or retries the transaction.
  for (const forbidden of ["voidOrder", "pos_void_order", "rollback", "setTimeout"]) {
    assert.equal(workspace.includes(forbidden), false, `printing must not be able to ${forbidden}`);
  }
});

test("one print per event, and one automatic call site per document", () => {
  assert.equal((workspace.match(/autoPrintReceipt\(/g) ?? []).length, 1);
  assert.equal((workspace.match(/autoPrintKitchenTicket\(/g) ?? []).length, 1);
  // The presentation latch is keyed on the batch and is a ref, so two calls in
  // one tick cannot both decide the ticket has not been shown yet.
  assert.match(workspace, /const presentedTickets = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(workspace, /presentedTickets\.current\.has\(eventKey\)/);
  assert.match(workspace, /\$\{input\.orderId\}:\$\{input\.batchNo \?\? 1\}/);
});
