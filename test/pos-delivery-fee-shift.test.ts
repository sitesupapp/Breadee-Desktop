// Delivery Fee End-Shift cash treatment (server migration m20260917120000).
//
// The business problem: a courier keeps the CASH delivery fee, but that fee is
// part of the cash-paid order total, so Expected Cash counts money that never
// reached the drawer - an artificial shortage. The fix adds ONE grouped,
// shift-level choice at End Shift: keep delivery fees IN the drawer (default,
// unchanged) or SEPARATE the cash-collected portion out of Expected Cash.
//
// As with every other cash figure, THE NUMBER IS THE SERVER'S. The desktop sends
// the chosen treatment and renders `expected` / `expected_excluded` verbatim; it
// performs no delivery arithmetic. The numeric formula (proration by the cash
// fraction, card / on-account excluded, once only) lives in the SQL functions and
// was verified against production data before this client shipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const shiftsLib = stripComments(read("lib", "pos", "shifts.ts"));
const shiftState = stripComments(read("state", "shift.ts"));
const shiftDialog = stripJsxComments(read("components", "pos", "ShiftDialog.tsx"));
const workspace = stripComments(read("screens", "pos", "PosWorkspace.tsx"));
const types = read("types", "pos.ts");

// --- 1. Included is the default, and it is what older clients already did ------

test("included is the default treatment sent to the server", () => {
  // A payload that omits the key, or an older desktop, must behave exactly like
  // before. The client defaults, and the SQL defaults again on its side.
  assert.match(shiftsLib, /delivery_fee_cash_treatment:\s*input\.deliveryFeeCashTreatment\s*\?\?\s*"included"/);
});

test("the toggle starts on 'include in cash' every time the dialog opens", () => {
  assert.match(shiftDialog, /useState<DeliveryFeeCashTreatment>\("included"\)/);
  // Reset on open, so a previous shift's choice never leaks into the next.
  assert.match(shiftDialog, /setTreatment\("included"\)/);
});

// --- 2. The choice is one grouped shift-level control, wired end to end --------

test("End Shift exposes exactly the two treatments, and no per-order control", () => {
  assert.match(shiftDialog, /Include in cash/);
  assert.match(shiftDialog, /Separate from cash/);
  assert.match(shiftDialog, /setTreatment\("excluded"\)/);
  // One shift-level choice: the toggle is not rendered per order row.
  assert.equal(/\.map\([^)]*setTreatment/.test(shiftDialog), false);
});

test("the chosen treatment travels dialog -> workspace -> store -> rpc", () => {
  // Dialog emits it.
  assert.match(shiftDialog, /onConfirm\(\{\s*actual:\s*counted,\s*notes:[^}]*treatment\s*\}\)/);
  // Workspace forwards it.
  assert.match(workspace, /deliveryFeeCashTreatment:\s*input\.treatment/);
  // Store forwards it.
  assert.match(shiftState, /endShift\(\{\s*shiftId:\s*shift\.id,\s*actualCashCounted,\s*notes,\s*deliveryFeeCashTreatment\s*\}\)/);
});

// --- 3. The desktop renders the SERVER's numbers; it computes nothing ----------

test("the Expected shown is the server's included/excluded figure, not a client calc", () => {
  // expectedForClose is a straight pick between two server-provided values.
  assert.match(shiftDialog, /treatment === "excluded"\s*\?\s*expected\.expected_excluded\s*:\s*expected\.expected/);
  // And the delivery fee is never arithmetic'd into the drawer on the client.
  assert.equal(/expected\.expected\s*-\s*expected\.delivery_fees_cash/.test(shiftDialog), false);
  assert.equal(/cash_sales\s*[+\-]\s*/.test(shiftDialog), false);
});

test("the delivery figures shown are read straight off the RPC response", () => {
  for (const field of ["delivery_order_count", "total_delivery_fees", "delivery_fees_cash", "delivery_fee_cash_treatment"]) {
    assert.ok(shiftsLib.includes(`row.${field}`), `${field} must be read from the RPC row`);
  }
});

// --- 4. Backward compatibility: an older server without the split still works --

test("a server that predates the split falls back to the included figure", () => {
  // expected_excluded / expected_cash_excluded absent => reuse expected(_cash).
  assert.match(shiftsLib, /row\.expected_excluded == null \? num\(row\.expected\) : num\(row\.expected_excluded\)/);
  assert.match(shiftsLib, /row\.expected_cash_excluded == null \? num\(row\.expected_cash\) : num\(row\.expected_cash_excluded\)/);
  // And an unknown / missing treatment reads as the historical "included".
  assert.match(shiftsLib, /str\(value\) === "excluded" \? "excluded" : "included"/);
});

// --- 5. The types carry the new server fields, nothing invented ---------------

test("the shift types declare the delivery treatment contract", () => {
  assert.match(types, /export type DeliveryFeeCashTreatment = "included" \| "excluded"/);
  for (const field of ["delivery_order_count", "total_delivery_fees", "delivery_fees_cash", "delivery_fee_cash_treatment"]) {
    assert.ok(types.includes(field), `${field} must be declared on the shift types`);
  }
  assert.ok(types.includes("expected_excluded"), "ShiftExpected must carry expected_excluded");
  assert.ok(types.includes("expected_cash_excluded"), "CashBox must carry expected_cash_excluded");
});

// --- 6. The closed report keeps delivery visible and reportable ---------------

test("the report reads and can display the persisted treatment and totals", () => {
  // endShift maps the persisted snapshot fields.
  assert.match(shiftsLib, /delivery_fee_cash_treatment:\s*toTreatment\(row\.delivery_fee_cash_treatment\)/);
  // The report dialog shows delivery fees whatever the treatment, and flags
  // the cash kept out of the drawer when separated.
  assert.match(shiftDialog, /Delivery fees \(\$\{report\.delivery_order_count\}\)|Delivery fees \(\$\{report\.delivery_order_count\}\)/);
  assert.match(shiftDialog, /report\.delivery_fee_cash_treatment === "excluded"/);
  assert.match(shiftDialog, /Kept out of drawer/);
});
