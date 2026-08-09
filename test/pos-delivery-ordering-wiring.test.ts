// Delivery ordering, wired into the shared shell.
//
// Level 3A's risk was enabling a route inside a shared shell. Level 3B's is the
// opposite: it deliberately switches the menu and the cart ON for Delivery, and
// those components carry a payment affordance with them. Most of this file is
// about proving the payment half stayed off while the ordering half came on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { OPEN_DELIVERY_STATUSES, kitchenStateLabel } from "@/lib/pos/deliveryOrder";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const deliverySrc = read("screens", "pos", "DeliveryWorkspace.tsx");
const workspaceSrc = read("screens", "pos", "PosWorkspace.tsx");
const cartPanelSrc = read("components", "pos", "CartPanel.tsx");
const summarySrc = read("components", "pos", "DeliveryOrderSummary.tsx");

// --- no payment path ---------------------------------------------------------

test("Delivery mounts the cart panel WITHOUT a pay gate", () => {
  const code = stripJsxComments(deliverySrc);
  const panel = code.slice(code.indexOf("<CartPanel"), code.indexOf("<CartPanel") + 900);
  assert.ok(panel.includes("createGate={sendGate}"));
  assert.equal(/payGate=/.test(panel), false, "Delivery passed a payGate");
  assert.equal(/onPay=/.test(panel), false, "Delivery passed an onPay handler");
});

test("the cart panel renders Pay only when a gate is supplied", () => {
  const code = stripJsxComments(cartPanelSrc);
  assert.match(code, /payGate\?:/);
  assert.match(code, /onPay\?:/);
  // The button is inside a conditional, so it is absent from the DOM rather
  // than present-and-disabled. A disabled Pay is still a Pay.
  assert.match(code, /\{props\.payGate && \(/);
});

test("Takeaway still passes its pay gate, so nothing about it changed", () => {
  const code = stripJsxComments(workspaceSrc);
  assert.match(code, /payGate=\{payGate\}/);
  assert.match(code, /onPay=\{openPayment\}/);
});

// RETARGETED BY LEVEL 3C. Delivery now settles, so payment, the cash box and the
// receipt legitimately appear on this path - that was a scope statement about
// Level 3B, not a safety property. What must still hold is that Delivery reaches
// settlement only through the audited adapter, and touches nothing that belongs
// to a TABLE or to an offline queue.
test("delivery settles only through its own adapter, and never a table or a queue", () => {
  const code = stripComments(deliverySrc);
  for (const token of ["pos_pay_table", "pos_pay_order", "enqueue", "outbox", "tableId"]) {
    assert.equal(code.includes(token), false, `${token} must not appear in the delivery workspace`);
  }
  // The RPC is reached only via the adapter, which owns the re-read, the latch
  // and the recovery model.
  assert.match(code, /payDeliveryOrder/);
  assert.match(code, /performDeliverySettlement/);
  assert.match(code, /checkSettlementTarget/);
});

test("the cash box is re-read, never incremented locally", () => {
  const code = stripComments(deliverySrc);
  assert.match(code, /input\.refreshCashBox\(\)/);
  // No local arithmetic on drawer figures anywhere on this path.
  assert.equal(/cashBox\s*[+\-]=|expectedCash\s*=/.test(code), false);
});

test("Delivery still passes no bottom-bar summary, so there is no bottom Pay", () => {
  const code = stripJsxComments(stripComments(workspaceSrc));
  assert.match(code, /cartSummary=\{\s*deliveryActive\s*\?\s*undefined/);
});

test("F4 and the takeaway order shortcuts stay off in Delivery", () => {
  const code = stripComments(workspaceSrc);
  // newOrder / openPayment / print.
  assert.match(code, /!dineInActive && !deliveryActive/);
});

test("the menu shortcut layer follows the menu into Delivery Add Items", () => {
  const code = stripComments(workspaceSrc);
  assert.match(code, /\(!dineInActive \|\| addingToTable\) && \(!deliveryActive \|\| addingToDelivery\)/);
});

// --- one menu, one cart ------------------------------------------------------

test("Delivery renders no menu or cart implementation of its own", () => {
  const code = stripComments(deliverySrc);
  for (const token of ["MenuItemGrid", "CategoryNavigation", "ModifierDialog", "loadMenu"]) {
    assert.equal(code.includes(token), false, `${token} must not be re-implemented for Delivery`);
  }
  // It reuses the shared cart panel instead.
  assert.match(code, /import \{ CartPanel \}/);
});

test("Delivery Add Items borrows the shell's menu rather than bypassing it", () => {
  const code = stripJsxComments(stripComments(workspaceSrc));
  assert.match(code, /deliveryActive && !addingToDelivery \? \(/);
  assert.match(code, /const addingToDelivery = deliveryActive && delivery\.view === "add_items"/);
});

// REGRESSION, found by the staging smoke before any order was sent.
//
// The identity strip was built inside `work()`'s add_items branch - but while
// Add Items is open the SHELL owns the work area and renders the menu there, so
// `work()` is never called and the strip was dead code. The one screen where a
// cashier picks the food was the one screen that never said whose delivery it
// was for. The strip is now returned as `identity` and pinned by the shell.
test("the customer and address stay visible while items are being chosen", () => {
  const workspace = stripJsxComments(stripComments(workspaceSrc));
  // The shell renders it, in the Add Items header beside Back to customer.
  assert.match(workspace, /addingToDelivery && \([\s\S]{0,400}\{delivery\.identity\}/);

  const delivery = stripJsxComments(stripComments(deliverySrc));
  assert.match(delivery, /identity: identityStrip/);
  // And the strip actually carries name, phone and the chosen address.
  const strip = delivery.slice(delivery.indexOf("const identityStrip"), delivery.indexOf("const cartPanel"));
  assert.match(strip, /customers\.selected\?\.name/);
  assert.match(strip, /customers\.selected\?\.phone/);
  assert.match(strip, /addressLine\(address\)/);
});

test("work() no longer pretends to render an Add Items view", () => {
  // If this branch came back, the strip would silently stop rendering again -
  // the shell would win and nothing would say so.
  const delivery = stripJsxComments(stripComments(deliverySrc));
  const work = delivery.slice(delivery.indexOf("const work = (layout"), delivery.indexOf("const panel = ("));
  assert.equal(/view === "add_items" \?/.test(work), false);
});

test("the cart buffer is claimed for the DELIVERY CUSTOMER", () => {
  const code = stripComments(workspaceSrc);
  assert.match(code, /addingToDelivery && delivery\.cartOwner\s*\?\s*delivery\.cartOwner/);
});

// --- submit safety -----------------------------------------------------------

test("one gate feeds the button and the keyboard alike", () => {
  const code = stripComments(deliverySrc);
  assert.match(code, /const sendGate: Gate = useMemo\(/);
  assert.match(code, /onSendToKitchen=\{requestSend\}/);
  assert.match(code, /confirmPayment: requestSend/);
});

test("Ctrl+Enter is live only while an order is being composed", () => {
  const code = stripComments(deliverySrc);
  assert.match(code, /active && view === "add_items" && dialog\.kind === "none" && switchTo === null/);
});

test("the send path snapshots its identity before the first await", () => {
  const code = stripComments(deliverySrc);
  const send = code.slice(code.indexOf("const send = useCallback"), code.indexOf("const requestSend"));
  // Everything the request depends on is captured up front, so a customer
  // switch landing mid-flight cannot reach the payload.
  for (const field of ["customerId:", "addressId:", "shiftId:", "branchId", "lines:", "clientOpId:"]) {
    assert.ok(send.includes(field), `${field} is not snapshotted`);
  }
  assert.ok(send.indexOf("const snapshot") < send.indexOf("await"), "snapshot must precede the first await");
});

test("the payload is built from the snapshot, never from live state", () => {
  const code = stripComments(deliverySrc);
  const send = code.slice(code.indexOf("const send = useCallback"), code.indexOf("const requestSend"));
  const build = send.slice(send.indexOf("buildDeliveryPayload("), send.indexOf("performDeliveryOrder"));
  assert.equal(/customerId: customerId|addressId: addressId/.test(build), false);
  assert.match(build, /customerId: snapshot\.customerId/);
  assert.match(build, /addressId: snapshot\.addressId/);
  assert.match(build, /clientOpId: snapshot\.clientOpId/);
});

test("the customer and address are revalidated before every send", () => {
  const code = stripComments(deliverySrc);
  const send = code.slice(code.indexOf("const send = useCallback"), code.indexOf("const requestSend"));
  assert.ok(send.indexOf("revalidateTarget") < send.indexOf("buildDeliveryPayload"));
});

test("recovery is scoped to the SUBMITTED customer, not the selected one", () => {
  const code = stripComments(deliverySrc);
  const send = code.slice(code.indexOf("const send = useCallback"), code.indexOf("const requestSend"));
  const recover = send.slice(send.indexOf("recoverSearch:"), send.indexOf("matchesIntent"));
  assert.match(recover, /snapshot\.customerId/);
});

// --- completion --------------------------------------------------------------

test("the cart is cleared only AFTER the server accepts the order", () => {
  const code = stripComments(deliverySrc);
  const send = code.slice(code.indexOf("const send = useCallback"), code.indexOf("const requestSend"));
  const accepted = send.indexOf("completionDone.current = true");
  assert.ok(accepted > 0);
  assert.ok(send.indexOf("useCart.getState().reset()") > accepted, "the cart is cleared before acceptance");
});

test("completion runs once per accepted order", () => {
  const code = stripComments(deliverySrc);
  assert.match(code, /const completionDone = useRef\(false\)/);
  assert.match(code, /if \(completionDone\.current\) return;/);
});

test("history is refreshed authoritatively, never incremented locally", () => {
  const code = stripComments(deliverySrc);
  const send = code.slice(code.indexOf("const send = useCallback"), code.indexOf("const requestSend"));
  assert.match(send, /useCustomers\.getState\(\)\.refresh\(\)/);
});

// --- the sent order ----------------------------------------------------------

test("an unpaid order is never labelled completed", () => {
  assert.equal(kitchenStateLabel("sent_to_kitchen"), "Sent to kitchen");
  assert.equal(kitchenStateLabel("draft"), "Not sent yet");
  assert.equal(kitchenStateLabel("voided"), "Cancelled");
  assert.equal(kitchenStateLabel("completed"), "Completed");
});

// RETARGETED BY LEVEL 3C. Adding Pay to this panel is the whole point of the
// settlement level, so "offers no payment control" was a scope statement rather
// than a safety property. What must hold now is narrower and more useful: Pay
// appears ONLY while the order is unpaid and only when a gate is supplied, and a
// settled order offers nothing to press again.
test("the summary offers Pay only while the order is unpaid", () => {
  const code = stripJsxComments(summarySrc);
  assert.match(code, /Unpaid/);
  // Paid branch first: a settled order gets a statement, not a button.
  assert.match(code, /\{paid \? \(/);
  assert.match(code, /Paid and completed/i);
  // Pay is behind BOTH the paid check and the presence of a gate.
  assert.match(code, /\) : props\.payGate \? \([\s\S]{0,200}Pay \(F4\)/);
  // And the panel still mounts no payment dialog of its own.
  assert.equal(code.includes("PaymentDialog"), false);
});

test("the summary never offers a collection or completion action", () => {
  // `pos_pay_order` sets paid AND completed in one statement, and the schema has
  // no `collected` status - a second action would model a transition that does
  // not exist.
  const code = stripJsxComments(summarySrc);
  for (const token of ["Collected", "Awaiting collection", "Mark complete", "pos_collect"]) {
    assert.equal(code.includes(token), false, `${token} must not appear - the server has no such state`);
  }
});

test("recovery only looks at live, unpaid delivery orders", () => {
  assert.deepEqual([...OPEN_DELIVERY_STATUSES], ["draft", "sent_to_kitchen"]);
  const code = stripComments(read("lib", "pos", "deliveryOrder.ts"));
  const loader = code.slice(code.indexOf("export async function loadOpenDeliveryOrders"));
  assert.match(loader, /\.eq\("order_type", "delivery"\)/);
  assert.match(loader, /\.neq\("payment_status", "paid"\)/);
  assert.match(loader, /\.in\("status", \[\.\.\.OPEN_DELIVERY_STATUSES\]\)/);
});

test("the recovery read never writes", () => {
  const code = stripComments(read("lib", "pos", "deliveryOrder.ts"));
  const froms = [...code.matchAll(/\.from\("pos_[a-z_]+"\)\s*\.(\w+)/g)].map((m) => m[1]);
  assert.ok(froms.length >= 3);
  assert.deepEqual([...new Set(froms)], ["select"]);
});

// --- switching customers -----------------------------------------------------

test("switching customers with a loaded basket asks instead of guessing", () => {
  const code = stripComments(deliverySrc);
  assert.match(code, /if \(c\.lines\.length > 0 && c\.owner\?\.kind === "delivery" && c\.owner\.customerId !== id\)/);
  assert.match(code, /setSwitchTo\(id\)/);
  // Confirming discards the basket AND its op id, so the next send cannot
  // replay under the previous order's key.
  const confirm = code.slice(code.indexOf("const confirmSwitch"), code.indexOf("const requestLeaveAddItems"));
  assert.match(confirm, /useCart\.getState\(\)\.reset\(\)/);
});

test("the customer picker goes through the guarded selector", () => {
  const code = stripJsxComments(deliverySrc);
  assert.match(code, /onPick=\{selectCustomer\}/);
});
