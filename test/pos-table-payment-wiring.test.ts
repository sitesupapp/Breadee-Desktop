// How settlement is wired into the workspace, and what Level 2D must NOT have
// disturbed.
//
// The project has no DOM test library, so the wiring is asserted by reading
// source. That is not a weaker test here - both classes of regression this file
// guards are literally source-level: a second gate computation, a keyboard
// handler that charges instead of opening a dialog, a Takeaway path quietly
// re-routed through the dine-in one.
//
// The regression half matters as much as the new half. Level 2D touched three
// shared things - the payment dialog, the receipt model and the errors table -
// and each of them belongs to Takeaway first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SHORTCUTS, matchShortcut, shortcutHelp, RESERVED_SHORTCUTS } from "@/lib/keyboard/shortcuts";
import { classifyError } from "@/lib/pos/errors";
import {
  PaymentAmbiguousError,
  PaymentInProgressError,
  StaleBillError,
  TenderTooLowError,
  DiscountNotPermittedError,
  InvalidDiscountError,
} from "@/lib/pos/tablePayment";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

// --- F4 / keyboard / touch ---------------------------------------------------

test("F4 is the payment binding, and it works from inside a text field", () => {
  const f4 = SHORTCUTS.find((s) => s.id === "openPayment");
  assert.ok(f4, "the openPayment binding disappeared");
  assert.deepEqual(f4!.keys, ["F4"]);
  assert.equal(f4!.worksInInput, true, "F4 would be dead while the table search box has focus");
  assert.equal(matchShortcut({ key: "F4", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), "openPayment");
});

test("F4 OPENS the dialog in dine-in - it never charges", () => {
  const source = read("screens", "pos", "DineInWorkspace.tsx");
  assert.match(
    source,
    /openPayment: \(\) => payGate\.allowed && requestPay\(\)/,
    "F4 no longer routes through the gated requestPay",
  );
  // The handler must not be able to reach the payment itself.
  const handler = /openPayment: \(\) =>[^\n]*/.exec(source)?.[0] ?? "";
  assert.doesNotMatch(handler, /confirmPay|performTablePayment|payTable\(/, "F4 can settle a bill directly");
});

test("F4 is registered on the table map only, not while Add Items owns the menu", () => {
  const source = read("screens", "pos", "DineInWorkspace.tsx");
  const mapBlock = source.slice(source.indexOf("tableSearch: () =>"), source.indexOf('active && view === "map"'));
  assert.match(mapBlock, /openPayment:/, "F4 is not bound in the map view");
  const addItemsBlock = source.slice(
    source.indexOf("// Add Items bindings."),
    source.indexOf('active && view === "add_items"'),
  );
  assert.doesNotMatch(addItemsBlock, /openPayment:/, "F4 is bound while building a round");
});

test("Ctrl+Enter confirms, and the payment dialog owns it while it is open", () => {
  const dialog = read("components", "pos", "PaymentDialog.tsx");
  assert.match(dialog, /useShortcuts\(\{ confirmPayment: confirm \}, props\.open\)/, "the dialog no longer owns Ctrl+Enter");
  // `confirm` refuses when the dialog says it cannot confirm - the same guard
  // the button uses, so the keyboard cannot bypass the mouse's conditions.
  assert.match(dialog, /function confirm\(\) \{\s*if \(!canConfirm\) return;/);
});

test("Enter cannot reach payment twice - confirm goes through the same latch", () => {
  const workspace = read("screens", "pos", "DineInWorkspace.tsx");
  // Exactly one call to performTablePayment, and it is handed the shared latch.
  assert.equal(workspace.split("performTablePayment(").length - 1, 1, "a second payment call site appeared");
  assert.match(workspace, /latch: payLatch\.current/, "the payment does not use the shared latch");
  assert.match(workspace, /const payLatch = useRef\(createPaymentLatch\(\)\)/, "the latch is no longer a ref");
});

test("Esc still closes the payment dialog without settling", () => {
  const dialog = read("components", "pos", "PaymentDialog.tsx");
  assert.match(dialog, /onClose=\{props\.onCancel\}/, "the dialog's Esc route no longer cancels");
  const workspace = read("screens", "pos", "DineInWorkspace.tsx");
  assert.match(workspace, /onCancel=\{\(\) => setPayOpen\(false\)\}/, "cancelling does more than close the dialog");
});

test("Move, Close and Clear keep their bindings", () => {
  for (const id of ["moveTable", "closeTable", "clearTable"]) {
    assert.ok(SHORTCUTS.some((s) => s.id === id), `${id} lost its binding`);
  }
  assert.deepEqual(RESERVED_SHORTCUTS, [], "a shortcut was declared without a handler");
});

test("the F1 help sheet describes F4 honestly for both order types", () => {
  const order = shortcutHelp().find((g) => g.group === "Order");
  assert.ok(order);
  const f4 = order!.items.find((i) => i.display === "F4");
  assert.ok(f4, "F4 vanished from the help sheet");
  assert.match(f4!.label, /table/i, "the help sheet does not mention that F4 also pays a table");
  assert.doesNotMatch(f4!.label, /takeaway only/i);
});

test("the bill panel's new Pay control is a full-size touch target", () => {
  const panel = read("components", "pos", "TableBillPanel.tsx");
  const pay = panel.slice(panel.indexOf("gate={props.payGate}"), panel.indexOf("Pay (F4)"));
  assert.match(pay, /size="lg"/, "the Pay button is not a large control");
  assert.doesNotMatch(pay, /size="sm"/);
});

// --- error mapping -----------------------------------------------------------

test("every Level 2D refusal classifies to its own kind, with its own next step", () => {
  const cases: [Error, string][] = [
    [new PaymentInProgressError(), "payment_in_progress"],
    [new StaleBillError("the total changed from 40 to 55"), "stale_bill_total"],
    [new PaymentAmbiguousError(new Error("Failed to fetch")), "payment_ambiguous"],
    [new TenderTooLowError(), "tender_too_low"],
    [new DiscountNotPermittedError(null), "discount_permission"],
    [new InvalidDiscountError("Percentage cannot exceed 100%."), "invalid_discount"],
    [new Error("No open order on this table to pay"), "no_open_bill_to_pay"],
    [new Error("These table orders span multiple shifts or branches; settle them separately."), "split_shift"],
    [new Error("These orders were created under different currency settings"), "mixed_currency"],
    [new Error("You do not have permission to take payments."), "permission"],
    [new Error("Open a shift before taking payment."), "no_shift"],
    [new Error("This bill belongs to another branch. Switch branch before settling it."), "branch"],
    [new Error("Set the USD to LBP exchange rate on the dashboard before accepting LBP payments"), "exchange_rate"],
  ];
  for (const [error, kind] of cases) {
    const c = classifyError(error);
    assert.equal(c.kind, kind, `"${error.message}" classified as ${c.kind}`);
    assert.ok(c.hint, `"${error.message}" has no next step`);
  }
});

test("the ambiguous refusal is the only Level 2D one rendered as a fault", () => {
  assert.equal(classifyError(new PaymentAmbiguousError(null)).expected, false);
  for (const e of [new PaymentInProgressError(), new StaleBillError("x"), new TenderTooLowError()]) {
    assert.equal(classifyError(e).expected, true, `${e.name} renders as a fault`);
  }
});

test("a discount refusal does not read as a payment refusal", () => {
  const c = classifyError(new DiscountNotPermittedError(null));
  assert.match(c.hint!, /full price/i, "the hint does not say the payment itself is still possible");
});

test("the stale-bill refusal tells the operator to review, not to retry", () => {
  const c = classifyError(new StaleBillError("the total changed from 40 to 55"));
  assert.match(c.message, /the total changed from 40 to 55/);
  assert.match(c.hint!, /review/i);
  assert.doesNotMatch(c.hint!, /try again|retry/i);
});

// --- regression: Takeaway --------------------------------------------------

test("Takeaway still pays an ORDER through pos_pay_order, untouched", () => {
  const payments = read("lib", "pos", "payments.ts");
  assert.match(payments, /callPosRpc\("pos_pay_order"/, "the takeaway payment RPC changed");
  assert.match(payments, /order_id: input\.orderId/, "the takeaway payload changed");
  assert.doesNotMatch(payments, /pos_pay_table|table_id/, "the takeaway module learned about tables");

  const workspace = read("screens", "pos", "PosWorkspace.tsx");
  assert.match(workspace, /await payOrder\(\{ orderId: saved\.order_id/, "the takeaway payment call changed");
  assert.match(workspace, /completePayment\(\{/, "takeaway no longer uses its own completion sequence");
});

test("the takeaway completion sequence is unchanged", async () => {
  const { COMPLETION_SEQUENCE } = await import("@/lib/pos/paymentCompletion");
  assert.deepEqual(COMPLETION_SEQUENCE, ["present-receipt", "close-payment-dialog", "reset-cart"]);
});

test("the dialog's takeaway behaviour is unchanged when no dine-in context is given", () => {
  const dialog = read("components", "pos", "PaymentDialog.tsx");
  // The dine-in context is OPTIONAL and defaults to null; every takeaway branch
  // is reached exactly as before.
  assert.match(dialog, /dineIn\?:/, "the dine-in context became required");
  assert.match(dialog, /const dineIn = props\.dineIn \?\? null/);
  assert.match(dialog, /: props\.orderNumber\s*\?\s*`Payment - order \$\{props\.orderNumber\}`/, "the takeaway title changed");
  assert.match(dialog, /Retrying will settle this same order/, "the takeaway subtitle was lost");
});

test("the receipt model's dine-in fields are optional, so takeaway receipts are unaffected", async () => {
  const { buildReceipt } = await import("@/lib/receipt");
  const r = buildReceipt({
    businessName: "Breadee",
    branchName: "Main",
    staffName: "C",
    orderNumber: "T-1",
    at: "now",
    paid: true,
    method: "cash",
    currency: "USD",
    lines: [],
    subtotal: 0,
    discount: 0,
    total: 0,
  });
  assert.equal(r.orderType, "Takeaway", "the default order type changed");
  assert.equal(r.tableName, undefined);
  assert.equal(r.seats, undefined);
});

// --- regression: the other dine-in actions ----------------------------------

test("Move, Close and Clear still go through tableOps, with Clear's reason intact", async () => {
  const ops = await import("@/lib/pos/tableOps");
  assert.equal(ops.MIN_CLEAR_REASON_LENGTH, 4);
  assert.equal(ops.validateClearReason("  ").error !== null, true);
  assert.equal(ops.validateClearReason("Walked out").reason, "Walked out");
  const source = read("lib", "pos", "tableOps.ts");
  for (const rpc of ["pos_move_table", "pos_close_table", "pos_clear_table"]) {
    assert.match(source, new RegExp(`callPosRpc\\("${rpc}"`), `${rpc} left tableOps`);
  }
});

test("Delivery is still disabled", () => {
  const source = read("screens", "pos", "PosWorkspace.tsx");
  assert.match(
    source,
    /key: "delivery",[^}]*enabled: false/,
    "the Delivery route became enabled",
  );
});

test("offline payment does not exist, and sync replay is still review-only", () => {
  const workspace = read("screens", "pos", "DineInWorkspace.tsx");
  assert.doesNotMatch(workspace, /enqueue|offlineMode/, "the dine-in payment path knows about offline mode");
  // Payment requires a connection, stated by the gate itself.
  assert.match(read("lib", "pos", "tablePayment.ts"), /Taking payment needs a connection/);
});

test("the dine-in payment path never touches the cart buffer", () => {
  // The cart belongs to rounds. A payment that reset it would discard an unsent
  // round for a DIFFERENT table.
  const workspace = read("screens", "pos", "DineInWorkspace.tsx");
  const start = workspace.indexOf("const confirmPay = useCallback(");
  const end = workspace.indexOf("// A payment dialog left open");
  assert.ok(start > 0 && end > start, "confirmPay could not be located");
  const body = workspace.slice(start, end);
  assert.doesNotMatch(body, /cart\.|useCart/, "the payment path mutates the cart buffer");
});
