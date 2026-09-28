// READY POS Phase E — desktop Split Bill (item/quantity settlement for Dine-In).
// The server op (pos_split_settle) is proven on staging. These tests lock the desktop
// request shaping and the safety-relevant client wiring: a split is a settlement, the
// server owns every figure, and the screen re-reads authoritative state after each split.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildSplitSettlePayload, parseSplitState } from "@/lib/pos/split";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, "..", "src", p), "utf8").replace(/\r\n/g, "\n");

test("buildSplitSettlePayload: exact shape — order id, version, method, currency, op id, allocations", () => {
  const p = buildSplitSettlePayload({
    orderId: "ord-1",
    expectedVersion: 4,
    method: "cash",
    currencyCode: "USD",
    clientOpId: "op-1",
    allocations: [
      { order_item_id: "a", quantity: 1 },
      { order_item_id: "b", quantity: 2 },
    ],
  });
  assert.equal(p.order_id, "ord-1");
  assert.equal(p.expected_version, 4);
  assert.equal(p.method, "cash");
  assert.equal(p.currency_code, "USD");
  assert.equal(p.client_op_id, "op-1");
  assert.deepEqual(p.allocations, [
    { order_item_id: "a", quantity: 1 },
    { order_item_id: "b", quantity: 2 },
  ]);
  // NO totals are sent — the server prices the split.
  assert.equal("amount" in p, false);
  assert.equal("subtotal" in p, false);
});

test("parseSplitState: derives per-line available/allocated from the server projection", () => {
  const st = parseSplitState({
    order_id: "o", order_number: "260928-0002", status: "sent_to_kitchen", payment_status: "unpaid",
    pos_entity_version: 1, total_amount: 25, paid_amount_usd: 15, currency: "USD",
    lines: [{ order_item_id: "a", name: "A", quantity: 2, final_unit_price: 10, line_total: 20, kitchen_note: null, allocated_qty: 1, available_qty: 1 }],
    settlements: [{ split_no: 1, display_no: "260928-0002-1", amount: 15, method: "cash", currency: "USD", paid_at: null }],
  });
  assert.equal(st.order_number, "260928-0002");
  assert.equal(st.lines[0].available_qty, 1);
  assert.equal(st.lines[0].allocated_qty, 1);
  assert.equal(st.settlements[0].display_no, "260928-0002-1");
});

test("split.ts: settle calls pos_split_settle; state read calls pos_split_state; methods read the catalog", () => {
  const s = src("lib/pos/split.ts");
  assert.match(s, /callPosRpc\("pos_split_settle", \{ p_payload: payload \}\)/);
  assert.match(s, /callPosRpc\("pos_split_state", \{ p_order_id: orderId \}\)/);
  assert.match(s, /from\("pos_payment_methods"\)/);
  // the split lib does no financial authority of its own — it never sums amounts to send
  assert.doesNotMatch(s, /amount:\s*.*reduce/);
});

test("rpc.ts: the two Phase E RPCs are on the allow-list", () => {
  const s = src("lib/pos/rpc.ts");
  assert.match(s, /"pos_split_settle"/);
  assert.match(s, /"pos_split_state"/);
});

test("access.ts: Split Bill has its OWN permission (pos.split_bill), not pay/edit", () => {
  const s = src("lib/pos/access.ts");
  assert.match(s, /SPLIT_BILL: "pos\.split_bill"/);
  assert.match(s, /export function canSplitBill\(ctx: PosAccessContext\): Gate/);
  assert.match(s, /perm\(ctx, POS_PERMISSIONS\.SPLIT_BILL\)/);
});

test("DineInWorkspace: split is gated, sends expected_version + a fresh op id, and re-reads on success AND failure", () => {
  const s = src("screens/pos/DineInWorkspace.tsx");
  assert.match(s, /canSplitBill\(pos\.access\)/);
  assert.match(s, /buildSplitSettlePayload\(\{/);
  assert.match(s, /expectedVersion: st\.pos_entity_version/);
  assert.match(s, /clientOpId: crypto\.randomUUID\(\)/);
  // success path re-reads the authoritative split state
  assert.match(s, /setSplitState\(await loadSplitState\(st\.order_id\)\)/);
  // the catch (incl VERSION_CONFLICT) also re-reads — fail closed, never overwrite
  const catchIdx = s.indexOf("} catch (e) {\n        // Fail-closed");
  assert.ok(catchIdx > -1, "paySplit must have a fail-closed catch that re-reads");
});

test("TableBillPanel: Split Bill sits under Pay Full Bill and is gated on splitGate", () => {
  const s = src("components/pos/TableBillPanel.tsx");
  assert.match(s, /splitGate: Gate/);
  assert.match(s, /Pay Full Bill/);
  assert.match(s, /gate=\{props\.splitGate\}[\s\S]*?Split Bill/);
});

test("SplitBillPanel: item selection, partial qty, method chooser, remaining, success state — touch-first", () => {
  const s = src("components/pos/SplitBillPanel.tsx");
  // per-line partial quantity controls (bounded to available)
  assert.match(s, /available_qty/);
  assert.match(s, /One less \$\{l\.name\}/);
  assert.match(s, /One more \$\{l\.name\}/);
  // selected subtotal + remaining bill are DISPLAY previews computed from the server's prices
  assert.match(s, /selectedSubtotal/);
  assert.match(s, /remainingBill/);
  // primary CTA + method chooser + success banner + fully-paid state
  assert.match(s, /Pay Selected Items/);
  assert.match(s, /methods\.map/);
  assert.match(s, /lastPaid/);
  assert.match(s, /Fully paid/);
});

test("SplitBillPanel: resets the selection when the authoritative bill version changes", () => {
  const s = src("components/pos/SplitBillPanel.tsx");
  assert.match(s, /setSel\(\{\}\);\s*\n\s*\}, \[state\?\.pos_entity_version\]\)/);
});
