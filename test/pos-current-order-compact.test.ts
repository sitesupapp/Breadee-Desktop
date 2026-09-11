// Current Order / Order Summary compaction + route Search Bar hide (v1.0.12).
//
// These pin the behaviour of the compact-UI change so a later edit cannot quietly
// undo it or regress the guarantees the product asked for:
//
//   A. The route Search Bar is HIDDEN (but not deleted) on Takeaway, Dine-in and
//      Delivery, and the keyboard shortcuts that focus it are NOT orphaned.
//   B. Menu categories, menu items, the table map and the delivery customer
//      workflow are untouched by the hide.
//   C. Every editable draft item keeps its minus / quantity / plus / Note /
//      Delete controls, at the 44px touch size.
//   D. Dine-in can PRINT the current bill before payment, through the MANUAL
//      receipt layer, and the printed bill represents EVERY order on the table.
//   E. Delivery's action is labelled "Print" (not the misleading "Receipt
//      preview") and still routes through the existing print path.
//
// Source-level assertions read the files (the runner cannot import .tsx); the
// bill-receipt completeness is checked against the pure builder directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import { matchShortcut } from "@/lib/keyboard/shortcuts";
import { buildTableBillReceipt } from "@/lib/pos/tablePaymentCompletion";
import type { BillLine, BillOrder, TableBill, TableSummary } from "@/types/tables";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const readSrc = (rel: string) => stripJsxComments(readFileSync(join(root, "src", rel), "utf8"));

const workspace = readSrc("screens/pos/PosWorkspace.tsx");
const dineInWorkspace = readSrc("screens/pos/DineInWorkspace.tsx");
const tableMap = readSrc("components/pos/TableMap.tsx");
const cartPanel = readSrc("components/pos/CartPanel.tsx");
const cartLineRow = readSrc("components/pos/CartLineRow.tsx");
const tableBillPanel = readSrc("components/pos/TableBillPanel.tsx");
const deliveryDetail = readSrc("components/pos/DeliveryOrderDetail.tsx");
const deliveryWorkspace = readSrc("screens/pos/DeliveryWorkspace.tsx");
const shortcuts = readSrc("lib/keyboard/shortcuts.ts");

// =============================================================================
// A + B. the route Search Bar is hidden, data is not
// =============================================================================

test("the menu Search Bar is visually hidden (sr-only), not deleted", () => {
  // The field stays in the DOM but inside an sr-only wrapper, so it takes no
  // visible space yet remains focusable for the shortcut below.
  assert.match(workspace, /sr-only[\s\S]{0,240}Search the menu \(Ctrl\+K\)/);
});

test("the table Search Bar is visually hidden (sr-only), not deleted", () => {
  assert.match(tableMap, /sr-only[\s\S]{0,240}Search tables \(Ctrl\+F\)/);
});

test("the hidden search fields cannot be focused - the shortcut handlers are removed", () => {
  // The bindings stay in the keyboard model (so the model contract is unchanged)
  // and still RESOLVE, but neither workspace registers a handler for them, so
  // pressing Ctrl+K / "/" / Ctrl+F focuses nothing: a cashier can never type
  // into an invisible field with no query feedback.
  assert.match(shortcuts, /id: "search"/);
  assert.match(shortcuts, /id: "tableSearch"/);
  assert.equal(matchShortcut({ key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), "search");
  assert.equal(matchShortcut({ key: "f", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), "tableSearch");
  assert.equal(
    workspace.includes("search: () => searchRef.current?.focus()"),
    false,
    "the menu-search focus handler must be removed so the hidden field cannot be focused",
  );
  assert.equal(
    dineInWorkspace.includes("tableSearch: () => searchRef.current?.focus()"),
    false,
    "the table-search focus handler must be removed so the hidden field cannot be focused",
  );
});

test("hiding the search bar does not touch categories, menu items or tables", () => {
  // The menu is still browsable by category, the item grid still renders, and
  // the table map is untouched - the hide is UI-only.
  assert.match(workspace, /<CategoryNavigation/);
  assert.match(workspace, /<MenuItemGrid/);
  assert.match(tableMap, /visible\.map\(/);
  // Delivery's customer lookup is a WORKFLOW control (find/create to place an
  // order), deliberately preserved rather than hidden.
  assert.match(deliveryWorkspace, /CustomerSearch/);
});

// =============================================================================
// C. editable draft items keep every control
// =============================================================================

test("a draft cart line keeps minus / quantity / plus / Note / Delete", () => {
  assert.match(cartLineRow, /onAdjust\(-1\)/, "decrease control missing");
  assert.match(cartLineRow, /onAdjust\(1\)/, "increase control missing");
  assert.match(cartLineRow, /\{line\.quantity\}/, "quantity is no longer shown");
  assert.match(cartLineRow, /onEditNote\(\)/, "Note control missing");
  assert.match(cartLineRow, /onRemove\(\)/, "Delete control missing");
  // The +/-/Del controls stay at the 44px touch size (h-11), never shrunk to
  // save height.
  assert.match(cartLineRow, /h-11 w-11/);
});

// =============================================================================
// D. compact action area, and the two-row grid
// =============================================================================

test("the Current Order actions are a compact grid, not four stacked large buttons", () => {
  assert.match(cartPanel, /grid grid-cols-2 gap-2/, "the action area is not a two-column grid");
  // The four takeaway actions are the touch-minimum size, not the tall 52px one.
  assert.equal(cartPanel.includes('size="lg"'), false, "a Current Order action is still oversized");
});

test("the takeaway order note moved into the panel header, plumbing unchanged", () => {
  // The compact control lives in CartPanel and writes the caller's value; the
  // standalone tall field above the panel is gone.
  assert.match(cartPanel, /onChange=\{\(e\) => props\.onOrderNoteChange\?\.\(e\.target\.value\)\}/);
  assert.match(workspace, /onOrderNoteChange=\{editOrderNote\}/);
});

// =============================================================================
// D. dine-in: print the bill before payment, complete and manual
// =============================================================================

test("the table bill panel offers Print, and Pay stays the large primary", () => {
  assert.match(tableBillPanel, /onPrintBill: \(\) => void;/);
  assert.match(tableBillPanel, /Print bill/);
  // The touch-target guard also enforces this; asserted here beside the change.
  assert.match(tableBillPanel, /gate=\{props\.payGate\}[\s\S]*?size="lg"[\s\S]*?Pay \(F4\)/);
});

test("dine-in prints the unpaid bill through the MANUAL layer, not the auto-print funnel", () => {
  // The workspace hands dine-in a manual presenter (receiptStore.present) for the
  // bill preview, distinct from the settlement funnel (onPresentReceipt), so an
  // unpaid bill can never reach the automatic path.
  assert.match(workspace, /onPreviewReceipt: \(receipt\) => receiptStore\.present\(receipt\)/);
  assert.match(dineInWorkspace, /input\.onPreviewReceipt\(\s*buildTableBillReceipt\(/);
  // And the payment path is untouched - still the shared auto-print funnel.
  assert.match(dineInWorkspace, /input\.onPresentReceipt\(\s*buildTablePaymentReceipt\(/);
});

test("the printed bill represents EVERY order on the table, unpaid, no tender", () => {
  const billLine = (over: Partial<BillLine>): BillLine => ({
    id: "l",
    name: "Item",
    quantity: 1,
    base_price: 10,
    modifiers_total: 0,
    final_unit_price: 10,
    line_total: 10,
    kitchen_note: null,
    batch_no: 1,
    modifiers: [],
    ...over,
  });
  const order1: BillOrder = {
    id: "o1",
    order_number: "260911-0001",
    status: "sent_to_kitchen",
    payment_status: "unpaid",
    shift_id: "s",
    branch_id: "b",
    tenant_id: "t",
    subtotal: 30,
    discount_amount: 0,
    total_amount: 30,
    currency: "USD",
    exchange_rate: null,
    created_at: null,
    lines: [
      billLine({ id: "l1", name: "Burger", quantity: 2, line_total: 20, batch_no: 1 }),
      billLine({ id: "l2", name: "Fries", line_total: 10, batch_no: 2 }),
    ],
  };
  // A SECOND order on the same table (the split-shift edge case). Its line must
  // still appear on the printed bill - dropping it would understate what is owed.
  const order2: BillOrder = {
    ...order1,
    id: "o2",
    order_number: "260911-0002",
    subtotal: 15,
    total_amount: 15,
    lines: [billLine({ id: "l3", name: "Cola", quantity: 3, base_price: 5, final_unit_price: 5, line_total: 15, batch_no: 1 })],
  };
  const bill: TableBill = {
    tableId: "t9",
    orders: [order1, order2],
    subtotal: 45,
    total: 45,
    currency: "USD",
    mixedCurrency: false,
    splitShift: true,
    batches: [1, 2],
  };
  const table: TableSummary = {
    id: "t9",
    name: "Terrace",
    seats: 4,
    occupied: true,
    status: "occupied",
    canonical: true,
    configured: true,
    sort_order: 1,
    orders: 2,
    order_number: "260911-0001",
    opened_at: null,
    total: 45,
    currency: "USD",
    mixed_currency: false,
  };

  const r = buildTableBillReceipt({
    bill,
    table,
    tenantName: "Cafe",
    branchName: "Main",
    operatorName: "Sam",
    // Production currency model: the bill's own selling currency, no per-order
    // decimalDigits (the shared formatMoney derives precision from the code).
    primaryCurrency: "USD",
    shiftId: "shift123",
    at: "now",
  });

  // COMPLETENESS: every line of every order on the table (3 lines, both orders).
  assert.equal(r.lines.length, 3);
  assert.ok(r.lines.some((l) => l.name === "Cola"), "the second order's line was dropped");
  assert.equal(r.orderNumber, "260911-0001, 260911-0002");
  // UNPAID: no payment is implied by printing the bill.
  assert.equal(r.paid, false);
  assert.equal(r.method, null);
  assert.equal(r.tenderCurrency, null);
  assert.equal(r.tendered ?? null, null);
  // Figures come straight from the server's bill; nothing is invented.
  assert.equal(r.subtotal, 45);
  assert.equal(r.total, 45);
  assert.equal(r.discount, 0);
  assert.equal(r.orderSource, "dine_in");
  assert.equal(r.tableName, "Terrace");
  // PRODUCTION CURRENCY PATH: the receipt carries the bill's own selling currency.
  assert.equal(r.currency, "USD");
});

// =============================================================================
// E. delivery: the "Receipt preview" button is now honestly labelled "Print"
// =============================================================================

test("the delivery order action is labelled Print, not the misleading Receipt preview", () => {
  assert.equal(deliveryDetail.includes("Receipt preview"), false, "the misleading label survives");
  assert.match(deliveryDetail, /\{props\.receiptBusy \? "Preparing\.\.\." : "Print"\}/);
  // The handler is unchanged - it still routes through the existing receipt path.
  assert.match(deliveryDetail, /onClick=\{props\.onReceipt\}/);
});
