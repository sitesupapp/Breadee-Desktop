// POS operations: the Orders workspace, the shift report, reversals, delivery.
//
// The properties worth pinning here are all about AUTHORITY:
//   * one lifecycle decides what an order permits, so three screens cannot
//     offer three different sets of buttons for the same row;
//   * one collection answers "what did this shift do", so the badge, the list
//     and the report cannot disagree;
//   * the SERVER owns every figure on the end-of-shift report, and the desktop
//     adds only the detail the RPC does not return;
//   * nothing invents a lifecycle state the schema cannot store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  canEditOrder,
  canSettleOrder,
  isTerminalOrder,
  paymentLabel,
  reversalActionFor,
  reversalLabel,
  reversalTitle,
  reversalWarning,
  typeLabel,
} from "@/lib/pos/orderActions";
import {
  buildShiftReportDetail,
  buildShiftReportLines,
  isReversed,
  reversalTotals,
  routeTotals,
  salesByItemFromReport,
} from "@/lib/pos/shiftReport";
import { shiftDay, toDayKey, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import type { CurrencyCode } from "@/lib/currency";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");
const readTauri = (...p: string[]) => readFileSync(join(root, "..", "src-tauri", ...p), "utf8");
const dropLineComments = (src: string) => src.replace(/^[^\S\r\n]*\/\/[^\r\n]*(\r?\n)/gm, "");
const readJsx = (...p: string[]) => stripJsxComments(dropLineComments(readSrc(...p)));
const readTs = (...p: string[]) => stripComments(dropLineComments(readSrc(...p)));

const ordersModal = readJsx("components", "pos", "OrdersModal.tsx");
const deliveryModal = readJsx("components", "pos", "DeliveryModal.tsx");
const reverseDialog = readJsx("components", "pos", "ReverseOrderDialog.tsx");
const currentOrder = readJsx("components", "pos", "CurrentOrderPanel.tsx");
const statusBar = readJsx("components", "pos", "PosStatusBar.tsx");
const workspace = readJsx("screens", "pos", "PosWorkspace.tsx");
const actionsLib = readTs("lib", "pos", "orderActions.ts");
const reportLib = readTs("lib", "pos", "shiftReport.ts");
const reportRs = readTauri("src", "printing", "report.rs");

const order = (over: Partial<ShiftOpenOrder> = {}): ShiftOpenOrder => ({
  id: "o1",
  order_number: "260815-0001",
  order_type: "takeaway",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  payment_method: null,
  subtotal: 10,
  discount_amount: 0,
  total_amount: 10,
  currency: "USD",
  table_id: null,
  customer_id: null,
  customer_name: null,
  customer_phone: null,
  cashier_user_id: null,
  staff_name: "Cashier",
  notes: null,
  created_at: "2026-08-15T10:00:00.000Z",
  ...over,
});

// --- lifecycle: one authority ------------------------------------------------

test("the reversal is derived from payment state, never chosen by a screen", () => {
  assert.equal(reversalActionFor(order({ payment_status: "unpaid" })), "cancel");
  assert.equal(reversalActionFor(order({ payment_status: "paid" })), "refund");
  // A refund is never called a cancellation.
  assert.equal(reversalLabel("refund"), "Refund order");
  assert.equal(reversalLabel("cancel"), "Cancel order");
  assert.match(reversalTitle("refund", "260815-0001"), /Refund order #260815-0001/);
  // Only the refund warns about money, because only the refund moves any.
  assert.match(reversalWarning("refund"), /negative payment/);
  assert.match(reversalWarning("cancel"), /never paid/);
});

test("a terminal order offers nothing at all", () => {
  for (const status of ["voided", "cancelled", "refunded"]) {
    const o = order({ status });
    assert.equal(isTerminalOrder(o), true, status);
    assert.equal(reversalActionFor(o), null, `${status} must offer no reversal`);
    assert.equal(canEditOrder(o), false, `${status} must not be editable`);
    assert.equal(canSettleOrder(o), false, `${status} must not be payable`);
  }
});

test("settlement is offered once, and never to a paid order", () => {
  assert.equal(canSettleOrder(order({ payment_status: "unpaid" })), true);
  assert.equal(canSettleOrder(order({ payment_status: "paid" })), false);
});

test("no screen invents a collection lifecycle", () => {
  // Level 3C: `pos_pay_order` sets paid AND completed in one statement, and the
  // schema has no `collected` state - so payment IS the completion. A button
  // labelled "Mark collected" would be a status the server cannot store.
  for (const [name, src] of [["actions", actionsLib], ["delivery", deliveryModal], ["orders", ordersModal]] as const) {
    assert.equal(/mark collected/i.test(src), false, `${name} must not invent a collection action`);
    assert.equal(src.includes("pos_collect"), false, `${name} must not call a collection RPC`);
  }
  // The real action is offered instead, under its real name.
  assert.match(deliveryModal, /canSettleOrder\(o\) && props\.onSettleOrder/);
  assert.match(deliveryModal, />\s*Pay\s*<\/Button>/);
});

test("an unpaid order never shows a payment method", () => {
  assert.equal(paymentLabel(order({ payment_status: "unpaid", payment_method: null })), "unpaid");
  assert.equal(paymentLabel(order({ payment_status: "unpaid", payment_method: "cash" })), "unpaid");
  assert.equal(paymentLabel(order({ payment_status: "paid", payment_method: "cash" })), "paid · cash");
  assert.equal(paymentLabel(order({ payment_status: "paid", payment_method: null })), "paid");
  assert.equal(paymentLabel(order({ payment_status: "refunded" })), "refunded");
});

test("the type cell names the table only for dine-in", () => {
  assert.equal(typeLabel(order({ order_type: "dine_in" }), "Table 6"), "dine-in · Table 6");
  assert.equal(typeLabel(order({ order_type: "takeaway" }), "Table 6"), "takeaway");
  assert.equal(typeLabel(order({ order_type: "delivery" }), null), "delivery");
});

// --- the reversal dialog -----------------------------------------------------

test("a reason is required, and blank whitespace is not a reason", () => {
  assert.match(reverseDialog, /const reasonGiven = reason\.trim\(\) !== ""/);
  assert.match(reverseDialog, /disabled=\{busy \|\| !reasonGiven\}/);
  assert.match(reverseDialog, /validateVoidReason\(reason\)/);
});

test("the reversal is sent once, from one place in the app", () => {
  assert.match(reverseDialog, /if \(busy \|\| !reasonGiven\) return;/);
  // Exactly one call site for the mutation, and it is this dialog.
  for (const [name, src] of [["orders", ordersModal], ["delivery", deliveryModal], ["panel", currentOrder]] as const) {
    assert.equal(src.includes("voidDeliveryOrder"), false, `${name} must not reverse for itself`);
    assert.equal(src.includes("pos_void_order"), false, `${name} must not name the RPC`);
  }
  assert.match(reverseDialog, /voidDeliveryOrder\(\{ orderId: order\.id, reason: clean, action \}\)/);
});

test("success re-reads authoritatively rather than patching locally", () => {
  const onDone = workspace.slice(workspace.indexOf("<ReverseOrderDialog"), workspace.indexOf("/>", workspace.indexOf("<ReverseOrderDialog")));
  assert.match(onDone, /refreshShiftOrders\(\)/);
  assert.match(onDone, /shiftStore\.refreshCashBox\(\)/);
});

test("the reversal is the LAST action in the Current Order panel, and unmistakable", () => {
  // RETARGETED IN 1.0.4. It used to sit above Print because the panel had only
  // those two controls. The panel is now the takeaway Current Order and carries
  // Pay, so the destructive action moves to the position every other action
  // stack in this POS puts it in: last, after Pay, Print and New order. That is
  // the rule stated in `CartPanel.tsx` - the button under a thumb is never the
  // one beside the one that was meant - and this asserts the panel follows it.
  const footer = currentOrder.slice(currentOrder.indexOf("shrink-0 space-y-2 border-t"));
  const destructive = footer.indexOf("DESTRUCTIVE_ORDER_CTA");
  assert.ok(destructive > 0, "the destructive action could not be located");
  assert.ok(footer.indexOf('"Preparing..." : "Print"') < destructive, "Print comes before it");
  assert.ok(footer.indexOf("props.onPay?.(order)") < destructive, "Pay comes before it");
  assert.match(footer, /variant="danger"/);
  // Absent entirely for a terminal order, rather than present and refused.
  assert.match(currentOrder, /const reversal = order \? reversalActionFor\(order\) : null/);
  // The precise reversal is still named - the CTA is the plain wording, not a
  // replacement for telling the operator whether this refunds money.
  assert.match(footer, /reversalLabel\(reversal\)/);
});

// --- Orders workspace --------------------------------------------------------

test("the date toolbar walks days locally, without timezone guessing", () => {
  assert.equal(shiftDay("2026-08-15", -1), "2026-08-14");
  assert.equal(shiftDay("2026-08-15", 1), "2026-08-16");
  // Month and year boundaries, both directions.
  assert.equal(shiftDay("2026-09-01", -1), "2026-08-31");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(toDayKey(new Date(2026, 7, 5)), "2026-08-05");
});

test("the current-shift scope is only offered when it is truthful", () => {
  // "Current shift" browsing back to last week would be a lie about the rows.
  assert.match(ordersModal, /const shiftScopeAvailable = Boolean\(props\.shiftId\) && day === today/);
  assert.match(ordersModal, /if \(!shiftScopeAvailable && scope === "shift"\) setScope\("day"\)/);
});

test("the shift scope reuses the shared store instead of re-querying", () => {
  assert.match(ordersModal, /const source = scope === "shift" \? props\.shiftOrders : \(dayOrders \?\? \[\]\)/);
  assert.match(ordersModal, /if \(!props\.open \|\| scope !== "day"\) return;/);
});

test("the day query is branch-scoped and bounded", () => {
  const lib = readTs("lib", "pos", "shiftOrderSummary.ts");
  assert.match(lib, /\.gte\("created_at", from\.toISOString\(\)\)/);
  assert.match(lib, /\.lt\("created_at", to\.toISOString\(\)\)/);
  assert.match(lib, /if \(input\.branchId\) query = query\.eq\("branch_id", input\.branchId\)/);
});

test("row actions follow the lifecycle, not the layout", () => {
  assert.match(ordersModal, /const reversal = reversalActionFor\(o\)/);
  assert.match(ordersModal, /const editable = canEditOrder\(o\)/);
  assert.match(ordersModal, /\{editable && props\.onEditOrder && \(/);
  assert.match(ordersModal, /\{reversal && \(/);
  // View selects and STAYS, because the detail now sits beside the table. The
  // original rule behind this assertion - that the modal must not grow its own
  // second order-detail screen - is unchanged and is what the rest of this test
  // pins: the detail arrives as a NODE from the workspace, and the modal builds
  // no order rendering of its own.
  assert.match(ordersModal, /onClick=\{\(\) => props\.onSelectOrder\(o\.id\)\}/);
  assert.equal(
    /props\.onSelectOrder\(o\.id\);\s*props\.onClose\(\);/.test(ordersModal),
    false,
    "View must no longer close the surface the detail is on",
  );
  assert.match(ordersModal, /detail\?: ReactNode/, "the detail is supplied, not built here");
  assert.match(ordersModal, /\{props\.detail\}/);
  for (const token of ["buildReceipt", "readOrderReceiptLines", "reversalLabel"]) {
    assert.equal(ordersModal.includes(token), false, `${token} belongs to the shared panel, not to this table`);
  }
});

test("the Orders table carries the operational columns", () => {
  for (const column of ["Order #", "Time", "Type", "Staff", "Total", "Payment", "Status", "Actions"]) {
    assert.ok(ordersModal.includes(column), `the table needs a ${column} column`);
  }
});

// --- Delivery ----------------------------------------------------------------

test("delivery is scoped to the active shift and says so when there is none", () => {
  assert.match(deliveryModal, /subtitle="Current shift · delivery orders"/);
  assert.match(deliveryModal, /No active shift/);
  assert.match(deliveryModal, /props\.shiftOrders\.filter\(\(o\) => o\.order_type === "delivery"\)/);
});

test("the delivery footer excludes reversed orders from the money", () => {
  // A voided order is neither collected nor owed; counting it as either would
  // make the footer disagree with the drawer.
  assert.match(deliveryModal, /if \(reversed\) continue;/);
  assert.match(deliveryModal, /if \(o\.payment_status === "paid"\) collected \+= amount;\s*else unpaid \+= amount;/);
  for (const label of ["Orders", "Total amount", "Collected", "Unpaid"]) {
    assert.ok(deliveryModal.includes(label), `the footer needs ${label}`);
  }
});

// --- the end-of-shift report -------------------------------------------------

const shiftSet = [
  order({ id: "a", order_type: "takeaway", total_amount: 10 }),
  order({ id: "b", order_type: "dine_in", total_amount: 20, payment_status: "paid", status: "completed" }),
  order({ id: "c", order_type: "delivery", total_amount: 30, status: "voided" }),
  order({ id: "d", order_type: "delivery", total_amount: 40, status: "refunded" }),
];

test("routes count every order but only bank the successful money", () => {
  const routes = routeTotals(shiftSet);
  const delivery = routes.find((r) => r.route === "delivery")!;
  assert.equal(delivery.orders, 2, "a reversed order still happened");
  assert.equal(delivery.total, 0, "reversed money is not a sale");
  assert.equal(routes.find((r) => r.route === "takeaway")!.total, 10);
  assert.equal(routes.find((r) => r.route === "dine_in")!.total, 20);
});

test("reversals are visible and separate, never netted off sales", () => {
  const r = reversalTotals(shiftSet);
  assert.equal(r.voided, 1);
  assert.equal(r.refunded, 1);
  assert.equal(r.cancelled, 0);
  assert.equal(r.amount, 70, "shown for visibility");
  assert.equal(isReversed(order({ status: "completed" })), false);
});

test("sales by item comes from the SERVER's aggregation", () => {
  // `pos_end_shift` returns `by_item`, computed from the same rows it used for
  // gross and net - recomputing it here could disagree with the totals printed
  // two inches above it. Dine-in rounds append to ONE order, so there is one
  // order per table to aggregate and no round is counted twice.
  assert.equal(reportLib.includes("pos_order_items"), false, "the report must not re-aggregate items");
  const items = salesByItemFromReport([
    { item: "Pepsi", qty: 16, total: 16 },
    { item: "Burger", qty: 5, total: 25 },
  ]);
  assert.deepEqual(items.map((i) => i.name), ["Pepsi", "Burger"], "biggest sellers first");
  assert.equal(items[0].quantity, 16);
});

test("the detail adds only what the RPC does not return", () => {
  const detail = buildShiftReportDetail(shiftSet, [{ item: "Burger", qty: 5, total: 25 }]);
  assert.equal(detail.successfulOrders, 2);
  assert.equal(detail.successfulTotal, 30);
  assert.equal(detail.routes.length, 3);
  assert.equal(detail.items[0].name, "Burger");
});

test("no report figure is recomputed at today's rate", () => {
  // The builder takes the server's money verbatim and has no rate input at all.
  assert.equal(reportLib.includes("convertCurrency"), false);
  assert.equal(reportLib.includes("exchange_rate"), false);
  assert.equal(reportLib.includes("session"), false);
});

test("the printed report is one document covering the whole shift", () => {
  const lines = buildShiftReportLines({
    businessName: "Dominos Pizza",
    branchName: "Main Branch",
    staffName: "Cashier",
    shiftRef: "eb623251",
    openedAt: "opened",
    closedAt: "closed",
    currency: "USD" as CurrencyCode,
    money: {
      orders: 4,
      grossSales: 100,
      discounts: 5,
      netSales: 95,
      cashSales: 95,
      cashUsd: 95,
      cashLbpOriginal: 0,
      openingCash: 20,
      expectedCash: 115,
      actualCash: 115,
      difference: 0,
    },
    detail: buildShiftReportDetail(shiftSet, [{ item: "Burger", qty: 5, total: 25 }]),
    note: "all good",
    fmt: (a, c) => `${a.toFixed(2)} ${c}`,
  });
  const labels = lines.map((l) => l.label);
  // DRAWER carries its unit since the LBP hotfix: the drawer block is USD while
  // the sales block above it is in the order currency, and a printed page has no
  // tooltip to explain why the two differ by three orders of magnitude.
  for (const section of ["SALES", "BY ROUTE", "REVERSED", "PAYMENTS", "DRAWER (USD)", "SALES BY ITEM", "NOTE"]) {
    assert.ok(labels.includes(section), `the report needs a ${section} section`);
  }
  // One title, one document - not one page per order.
  assert.equal(labels.filter((l) => l === "END OF SHIFT REPORT").length, 1);
  assert.ok(labels.some((l) => l.startsWith("Burger x5")));
  // LBP is printed only when some was actually taken.
  assert.equal(labels.includes("Cash LBP"), false);
});

test("the report is a fourth DOCUMENT on the existing native path", () => {
  // Not a fourth printing system: same `print_document`, same queue-title rule.
  assert.match(reportRs, /use super::page::\{Direction, LineStyle, PageLine\}/);
  const service = readTauri("src", "printing", "service.rs");
  assert.match(service, /REPORT_DOCUMENT_TITLE: &str = "Breadee shift report"/);
  assert.match(service, /validate_report\(doc\)\?;/);
  // And the frontend reaches it through the one adapter.
  const client = readTs("lib", "nativePrinting.ts");
  assert.match(client, /invokeNative<PrintOutcome>\("print_report"/);
  for (const forbidden of ["window.print", "localhost", "bridge"]) {
    assert.equal(client.toLowerCase().includes(forbidden), false, `${forbidden} must not appear`);
  }
});

test("printing the report cannot touch the shift", () => {
  const start = workspace.indexOf("const printShiftReport");
  assert.ok(start > 0, "printShiftReport must exist");
  const fn = workspace.slice(start, workspace.indexOf("[currency, pos.branch.id", start));
  assert.ok(fn.length > 200, "the slice must actually cover the function");
  for (const token of ["pos_end_shift", "shiftStore.close", "callPosRpc"]) {
    assert.equal(fn.includes(token), false, `${token} must not be on the report print path`);
  }
  assert.match(workspace, /The shift is closed\. Only the report failed to print\./);
});

test("the report describes the shift it closed, not the empty one after it", () => {
  assert.match(workspace, /const closing = useShiftOrders\.getState\(\)\.orders;/);
  assert.match(workspace, /setClosedShiftOrders\(closing\);/);
  assert.match(workspace, /shiftOrders=\{closedShiftOrders\}/);
});

// --- top bar + preserved behaviour -------------------------------------------

test("the top bar carries Delivery and Orders without exposing the drawer", () => {
  assert.match(statusBar, /onClick=\{props\.onOpenDelivery\}/);
  assert.match(statusBar, /Orders \{props\.shiftOrders\.length\}/);
  assert.match(statusBar, /See all orders/);
  // Drawer privacy, unchanged by this revision.
  assert.equal(/Drawer \{formatMoney/.test(statusBar), false);
});

test("the Takeaway right panel keeps the live cart and its identity", () => {
  // Browsing shift orders must not replace the cart a cashier is building - and
  // under the approved design it cannot, because the browser is no longer in
  // this column at all. The takeaway panel is the cart, unconditionally.
  assert.match(workspace, /<CartPanel/);
  assert.equal(
    /cart\.lines\.length > 0 \? \(\s*<CartPanel/.test(workspace),
    false,
    "the cart panel must not be swapped out when the cart is empty",
  );
  // The browser is still rendered by the workspace, as the Orders detail pane.
  assert.match(workspace, /<CurrentOrderPanel/);
  assert.match(workspace, /detail=\{\s*<CurrentOrderPanel/);
  // Viewing never mutates the cart or the order.
  for (const token of ["cart.reset()", "useCart.getState().reset()"]) {
    assert.equal(currentOrder.includes(token), false, `${token} must not be reachable from viewing`);
  }
});

test("every surface reads the one shift-order store", () => {
  const store = readTs("state", "shiftOrders.ts");
  assert.equal((store.match(/loadShiftOrders\(/g) ?? []).length, 1);
  for (const [name, src] of [["orders", ordersModal], ["delivery", deliveryModal], ["panel", currentOrder]] as const) {
    assert.equal(src.includes("loadShiftOrders"), false, `${name} renders, it does not query the shift`);
  }
});
