// 1.0.41 (BUG 02 + BUG 01 preview) — one collected / due truth; every settlement and drain refreshes the shift's
// orders; a stale read never overwrites a fresher one; a table order is never paid from the list at its gross.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orderDue, DINE_IN_PAY_FROM_TABLE_MESSAGE, LOCAL_PAYMENT_PENDING_MESSAGE } from "@/lib/pos/orderDue";
import { paymentLabel } from "@/lib/pos/orderActions";
import { offlineLegCashUsd } from "@/lib/offline/drawerProjection";

const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");

test("orderDue: paid / part-paid / unpaid / UNKNOWN (a failed read is never zero)", () => {
  assert.deepEqual(orderDue({ payment_status: "paid", total_amount: 30 }), { state: "paid", collected: 30, due: 0 });
  assert.deepEqual(orderDue({ payment_status: "unpaid", total_amount: 30, collected: 7.5 }), { state: "part_paid", collected: 7.5, due: 22.5 });
  assert.deepEqual(orderDue({ payment_status: "unpaid", total_amount: 30, collected: 0 }), { state: "unpaid", collected: 0, due: 30 });
  assert.deepEqual(orderDue({ payment_status: "unpaid", total_amount: 30 }), { state: "unknown", collected: null, due: 30 });
  assert.equal(orderDue({ payment_status: "unpaid", total_amount: 30, collected: 45 }).due, 0, "never a negative due");
});

test("the Orders list labels a part-paid order 'part paid', never plain 'unpaid'", () => {
  assert.equal(paymentLabel({ payment_status: "unpaid", payment_method: null, collected: 0.2778 }), "part paid");
  assert.equal(paymentLabel({ payment_status: "unpaid", payment_method: null, collected: 0 }), "unpaid");
  assert.equal(paymentLabel({ payment_status: "unpaid", payment_method: null }), "unpaid");
  assert.equal(paymentLabel({ payment_status: "paid", payment_method: "cash", collected: 5 }), "paid · cash");
});

test("R5: the shift's orders re-read after every settlement and every drain; only the LATEST read commits", () => {
  const src = read("state", "shiftOrders.ts");
  assert.match(src, /window\.addEventListener\(POS_SETTLED_EVENT, again\)/);
  assert.match(src, /window\.addEventListener\(OFFLINE_DRAINED_EVENT, again\)/);
  assert.match(src, /const my = \+\+refreshSeq;/);
  assert.match(src, /if \(my !== refreshSeq\) return;/);
  assert.match(src, /attachCollected\(res\.orders, tenantId\)/, "part-paid orders carry what split payments collected");
  // every payment surface announces the settlement
  const dine = read("screens", "pos", "DineInWorkspace.tsx");
  assert.ok((dine.match(/notifyPosSettled\(\)/g) ?? []).length >= 5, "dine-in: offline pay / split / on-account, online pay / split");
  assert.match(read("screens", "pos", "DeliveryWorkspace.tsx"), /notifyPosSettled\(\);/);
  const pos = read("screens", "pos", "PosWorkspace.tsx");
  const at = pos.indexOf("const saveOfflineCashPayment");
  assert.ok(at > 0);
  const save = pos.slice(at, pos.indexOf("ticketForOrder(provisionalResult(localId", at));
  assert.ok(save.length > 0);
  assert.match(save, /notifyPosSettled\(\);/, "the offline takeaway Pay announces BEFORE the kitchen latch can return early");
});

test("Money A / B: a table order is not paid from the list (gross), nor an order whose payment is pending on this device", () => {
  const pos = read("screens", "pos", "PosWorkspace.tsx");
  const open = pos.slice(pos.indexOf("const openPaymentForOrder"), pos.indexOf("const confirmPayment"));
  assert.match(open, /order\.order_type === "dine_in" && order\.table_id[\s\S]{0,120}DINE_IN_PAY_FROM_TABLE_MESSAGE[\s\S]{0,40}return;/);
  assert.match(open, /order\.local_pending === true[\s\S]{0,120}LOCAL_PAYMENT_PENDING_MESSAGE[\s\S]{0,40}return;/);
  assert.match(DINE_IN_PAY_FROM_TABLE_MESSAGE, /Pay it from its table/);
  assert.match(LOCAL_PAYMENT_PENDING_MESSAGE, /Don't take payment again/);
});

test("BUG 01 preview: the merge preview uses the card's due source (server collected, else paid_by_split)", () => {
  const src = read("components", "pos", "TableOpsDialogs.tsx");
  assert.match(src, /t\.outstanding \?\? tableCardAmount\(t\)\.amount \?\? 0/);
  assert.match(src, /t\?\.collected \?\? t\?\.paid_by_split \?\? 0/);
});

test("U5: a cash leg's local USD amount (LBP via the rate); unknown line / rate / non-cash → null", () => {
  const lines = [{ id: "I1", final_unit_price: 25000 }, { id: "I2", final_unit_price: 4 }];
  assert.equal(offlineLegCashUsd([{ id: "I2", final_unit_price: 4 }], [{ order_item_id: "I2", quantity: 2 }], "cash", "USD", null), 8);
  assert.equal(offlineLegCashUsd(lines, [{ order_item_id: "I1", quantity: 2 }], "cash", "LBP", 90000), 0.56);
  assert.equal(offlineLegCashUsd(lines, [{ order_item_id: "I1", quantity: 2 }], "cash", "LBP", null), null);
  assert.equal(offlineLegCashUsd(lines, [{ order_item_id: "nope", quantity: 1 }], "cash", "USD", null), null);
  assert.equal(offlineLegCashUsd(lines, [{ order_item_id: "I2", quantity: 1 }], "card", "USD", null), null);
});
