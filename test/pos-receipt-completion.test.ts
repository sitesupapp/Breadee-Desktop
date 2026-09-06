// Post-payment completion: the receipt must be presented, exactly once, from the
// server's own figures, and must survive the cart reset that follows it.
//
// Staging 2026-08-05: a real payment produced correct receipt DATA and cleared
// the cart, but the preview never appeared - Ctrl+P recovered it. The data
// survived while the "open" signal did not, because they were two independent
// pieces of component state inside a screen that early-returns a skeleton.
// These tests lock in the atomic replacement.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { completePayment, buildPaymentReceipt, tenderTotalFor, COMPLETION_SEQUENCE } from "@/lib/pos/paymentCompletion";
import { useReceipt, shouldShowReceipt } from "@/state/receipt";
import { useCart } from "@/state/cart";
import { matchShortcut } from "@/lib/keyboard/shortcuts";
import type { CartLine, PayOrderResult, SubmitOrderResult } from "@/types/pos";

const line: CartLine = {
  key: "line-1",
  menu_item_id: "item-1",
  name: "Margherita",
  base_price: 7,
  quantity: 1,
  kitchen_note: "Desktop Level 1 receipt auto-open verification",
  modifiers: [{ group_id: "g", option_id: "o", name: "Medium", price_delta: 3, quantity: 1 }],
};

const paid: PayOrderResult = {
  order_id: "order-1",
  paid: true,
  method: "cash",
  subtotal: 10,
  discount: 1,
  amount: 9,
  order_number: "260805-0002",
  currency_code: "USD",
  original_amount: 9,
  exchange_rate: null,
};

const savedOrder: SubmitOrderResult = { order_id: "order-1", order_number: "260805-0002", subtotal: 10, total: 10 };

const baseInput = {
  result: paid,
  lines: [line],
  fallbackOrderNumber: "fallback",
  tenantName: "Dominos Pizza",
  branchName: "Main Branch",
  operatorName: "Cashier",
  primaryCurrency: "USD" as const,
  // 6B-2: the server-provided historical currency + precision. For USD these mirror the
  // primary currency; the caller obtains them from finance_order_financials.
  receiptCurrency: "USD",
  decimalDigits: 2,
  tenderCurrency: "USD" as const,
  rate: 89500,
  tenderedInput: 20,
  shiftId: "ad4aa9bb-724b-4cca-b46e-343c04a2008b",
  at: "8/5/2026, 11:00:00 AM",
};

beforeEach(() => {
  useReceipt.getState().clear();
  useCart.getState().reset();
});

// --- the completion sequence --------------------------------------------------

test("the receipt is presented BEFORE the dialog closes and the cart resets", () => {
  assert.deepEqual(COMPLETION_SEQUENCE, ["present-receipt", "close-payment-dialog", "reset-cart"]);
  const { steps } = completePayment(baseInput);
  assert.equal(steps.indexOf("present-receipt"), 0, "the receipt must be stored first");
  assert.ok(steps.indexOf("present-receipt") < steps.indexOf("reset-cart"));
});

test("the receipt carries the server's figures, not the cart's", () => {
  const receipt = buildPaymentReceipt(baseInput);
  assert.equal(receipt.subtotal, 10);
  assert.equal(receipt.discount, 1);
  assert.equal(receipt.total, 9, "the total is the server's charged amount");
  assert.equal(receipt.orderNumber, "260805-0002");
  assert.equal(receipt.paid, true);
  assert.equal(receipt.method, "cash");
  assert.equal(receipt.businessName, "Dominos Pizza");
  assert.equal(receipt.branchName, "Main Branch");
  assert.equal(receipt.staffName, "Cashier");
  assert.equal(receipt.shiftRef, "ad4aa9bb");
  assert.equal(receipt.lines[0].name, "Margherita");
  assert.equal(receipt.lines[0].unitPrice, 10, "base + modifier");
  assert.equal(receipt.lines[0].modifiers?.[0].name, "Medium");
  assert.equal(receipt.lines[0].note, "Desktop Level 1 receipt auto-open verification");
});

test("tendered and change come from what the cashier actually handed over", () => {
  const receipt = buildPaymentReceipt(baseInput);
  assert.equal(receipt.tenderTotal, 9);
  assert.equal(receipt.tendered, 20);
  assert.equal(receipt.change, 11);
});

test("an omitted tender prints as paid-exact rather than negative change", () => {
  const receipt = buildPaymentReceipt({ ...baseInput, tenderedInput: null });
  assert.equal(receipt.tendered, 9);
  assert.equal(receipt.change, 0);
});

test("a cross-currency tender without a rate omits the tender block", () => {
  assert.equal(tenderTotalFor(9, "USD", "LBP", null), null);
  const receipt = buildPaymentReceipt({ ...baseInput, tenderCurrency: "LBP", rate: null });
  assert.equal(receipt.tenderTotal, null);
  assert.equal(receipt.change, null);
});

test("an LBP tender with a valid rate converts once", () => {
  const receipt = buildPaymentReceipt({ ...baseInput, tenderCurrency: "LBP", tenderedInput: null });
  assert.equal(receipt.tenderTotal, 805500); // 9 * 89500
});

// --- atomic presentation ------------------------------------------------------

test("presenting stores the data and shows it in one transition", () => {
  const { receipt } = completePayment(baseInput);
  useReceipt.getState().present(receipt);
  const s = useReceipt.getState();
  assert.equal(s.visible, true);
  assert.equal(s.receipt?.orderNumber, "260805-0002");
  assert.equal(shouldShowReceipt(s), true);
});

test("visible-with-no-data can never render", () => {
  // Even if visibility were forced on with no receipt, nothing is shown.
  useReceipt.setState({ visible: true, receipt: null });
  assert.equal(shouldShowReceipt(useReceipt.getState()), false);
});

test("the receipt opens exactly once per payment", () => {
  const { receipt } = completePayment(baseInput);
  let renders = 0;
  const stop = useReceipt.subscribe((s) => {
    if (shouldShowReceipt(s)) renders += 1;
  });
  useReceipt.getState().present(receipt);
  stop();
  assert.equal(renders, 1, "present() must produce a single visible transition");
});

// --- persistence across the cart reset ----------------------------------------

test("the receipt survives the cart reset that follows payment", () => {
  useCart.getState().addLine({ menuItemId: "item-1", name: "Margherita", basePrice: 7 });
  useCart.getState().setSavedOrder(savedOrder);

  const { receipt, steps } = completePayment(baseInput);
  for (const step of steps) {
    if (step === "present-receipt") useReceipt.getState().present(receipt);
    if (step === "reset-cart") useCart.getState().reset();
  }

  assert.equal(useCart.getState().lines.length, 0, "cart resets after success");
  assert.equal(useCart.getState().savedOrder, null);
  assert.equal(useCart.getState().clientOpId, null);
  assert.equal(shouldShowReceipt(useReceipt.getState()), true, "the receipt is still on screen");
  assert.equal(useReceipt.getState().receipt?.total, 9);
});

test("closing the preview keeps the receipt so Ctrl+P can reopen it", () => {
  const { receipt } = completePayment(baseInput);
  useReceipt.getState().present(receipt);
  useReceipt.getState().hide();

  assert.equal(useReceipt.getState().visible, false);
  assert.notEqual(useReceipt.getState().receipt, null, "hide() must not discard the data");

  assert.equal(matchShortcut({ key: "p", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }), "print");
  useReceipt.getState().reopen();
  assert.equal(shouldShowReceipt(useReceipt.getState()), true);
  assert.equal(useReceipt.getState().receipt?.orderNumber, "260805-0002", "the SAME receipt reopens");
});

test("reopen does nothing when there has been no payment", () => {
  useReceipt.getState().reopen();
  assert.equal(useReceipt.getState().visible, false);
});

test("starting a new cart does not reopen the old receipt", () => {
  const { receipt } = completePayment(baseInput);
  useReceipt.getState().present(receipt);
  useReceipt.getState().hide();

  useCart.getState().addLine({ menuItemId: "item-2", name: "Fries", basePrice: 2.5 });
  assert.equal(useReceipt.getState().visible, false, "a new sale must not resurrect the last receipt");
  assert.notEqual(useReceipt.getState().receipt, null, "though it stays available for Ctrl+P");
});

// --- failure path -------------------------------------------------------------

test("a failed payment presents no receipt and keeps the order for retry", async () => {
  useCart.getState().addLine({ menuItemId: "item-1", name: "Margherita", basePrice: 7 });
  useCart.getState().setSavedOrder(savedOrder);

  let submits = 0;
  let pays = 0;
  const ensureOrder = async () => {
    const existing = useCart.getState().savedOrder;
    if (existing) return existing;
    submits += 1;
    const created = savedOrder;
    useCart.getState().setSavedOrder(created);
    return created;
  };
  const payOrder = async () => {
    pays += 1;
    if (pays === 1) throw new Error("This shift is closed");
    return paid;
  };

  // Attempt 1 - refused.
  let failed = false;
  try {
    const saved = await ensureOrder();
    await payOrder();
    void saved;
  } catch {
    failed = true;
  }
  assert.equal(failed, true);
  assert.equal(shouldShowReceipt(useReceipt.getState()), false, "no receipt on failure");
  assert.deepEqual(useCart.getState().savedOrder, savedOrder, "the order reference is kept");
  assert.equal(useCart.getState().lines.length, 1, "the cart is NOT reset on failure");

  // Attempt 2 - retry pays the SAME order.
  const saved = await ensureOrder();
  const result = await payOrder();
  assert.equal(saved.order_id, savedOrder.order_id, "retry settles the same order");
  assert.equal(submits, 0, "retry must not submit another order");
  assert.equal(pays, 2);

  const { receipt, steps } = completePayment({ ...baseInput, result });
  for (const step of steps) {
    if (step === "present-receipt") useReceipt.getState().present(receipt);
    if (step === "reset-cart") useCart.getState().reset();
  }
  assert.equal(shouldShowReceipt(useReceipt.getState()), true);
  assert.equal(useCart.getState().savedOrder, null);
});

// --- modal sequencing ---------------------------------------------------------

test("closing the payment dialog is a separate step that cannot close the receipt", () => {
  const { receipt, steps } = completePayment(baseInput);
  let payDialogOpen = true;
  for (const step of steps) {
    if (step === "present-receipt") useReceipt.getState().present(receipt);
    if (step === "close-payment-dialog") payDialogOpen = false;
  }
  assert.equal(payDialogOpen, false, "the payment dialog closes");
  assert.equal(shouldShowReceipt(useReceipt.getState()), true, "and the receipt stays up");
});

test("Escape maps to closing the active dialog only", () => {
  assert.equal(matchShortcut({ key: "Escape", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }), "closeModal");
  const { receipt } = completePayment(baseInput);
  useReceipt.getState().present(receipt);
  // The receipt's own close handler is hide(), which never discards the data.
  useReceipt.getState().hide();
  assert.equal(useReceipt.getState().visible, false);
  assert.notEqual(useReceipt.getState().receipt, null);
});
