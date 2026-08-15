// The POS cash/drawer unit contract.
//
// PRODUCTION DEFECT, 2026-08-15, tenant "Burger nation" (primary currency LBP,
// rate 90,000). A shift had taken eight paid orders totalling 10,220,000 LBP.
// The drawer read "114 LBP" and End Shift offered "Expected 114 LBP".
//
// 114 was not a wrong sum. It was the RIGHT sum in the WRONG unit: the server's
// `expected_cash` is 113.5555 US dollars, and rendering it with the LBP
// formatter - which rounds to whole units and appends " LBP" - produced "114
// LBP". Every cash figure the POS RPCs exchange is USD-normalised:
//
//   _pos_shift_cash.net_cash = sum(pos_payments.amount) - refunds   [USD]
//   pos_shift_expected.expected = opening_cash_amount + net_cash    [USD]
//   pos_end_shift: difference = expected - actual_cash_counted      [USD]
//
// The fix says what the number IS. It does NOT convert: re-valuing a settled
// aggregate at today's rate is the one thing a POS must never do.
//
// The counted-cash INPUT was the dangerous half. It was labelled with the
// tenant's primary currency, so an LBP tenant counting their drawer would type
// 10,220,000 into a field the server subtracts from 113.56 dollars.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CASH_CONTRACT_CURRENCY, formatMoney, type CurrencyCode } from "@/lib/currency";
import { buildShiftReportDetail, buildShiftReportLines } from "@/lib/pos/shiftReport";
import type { ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import { stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");
const dropLineComments = (src: string) => src.replace(/^[^\S\r\n]*\/\/[^\r\n]*(\r?\n)/gm, "");
const readJsx = (...p: string[]) => stripJsxComments(dropLineComments(readSrc(...p)));

const shiftDialog = readJsx("components", "pos", "ShiftDialog.tsx");
const statusBar = readJsx("components", "pos", "PosStatusBar.tsx");
const currentOrder = readJsx("components", "pos", "CurrentOrderPanel.tsx");

/** The production shift that exposed this, to the cent. */
const PROD = {
  expectedCashUsd: 113.56,
  ordersLbp: 10_220_000,
  rate: 90_000,
};

// --- the contract ------------------------------------------------------------

test("the cash contract is USD, whatever the tenant's primary currency is", () => {
  assert.equal(CASH_CONTRACT_CURRENCY, "USD");
});

test("the production figure renders as dollars, not as 114 LBP", () => {
  // The exact regression. 113.5555 USD is what the server had.
  assert.equal(formatMoney(PROD.expectedCashUsd, CASH_CONTRACT_CURRENCY), "$113.56");
  assert.equal(formatMoney(PROD.expectedCashUsd, "LBP"), "114 LBP", "the old, wrong rendering");
  // And it is NOT silently converted to look like the order total either.
  assert.notEqual(formatMoney(PROD.expectedCashUsd, CASH_CONTRACT_CURRENCY), `${PROD.ordersLbp} LBP`);
});

test("the USD cash figure and the LBP sales figure are consistent, not equal", () => {
  // The drawer was never wrong - only mislabelled. 113.5555 USD x 90,000 comes
  // back to 10,219,995: five LBP short of the 10,220,000 of orders, because each
  // payment stores its USD normalisation at 4dp and eight of them were summed.
  //
  // That residue is exactly why this fix does not "helpfully" convert the drawer
  // figure into LBP for display. A converted drawer would read 10,219,995 beside
  // sales of 10,220,000 and invite someone to hunt a five-pound discrepancy that
  // is really just USD_STORE_DP. Showing the dollars the server actually holds
  // has no such failure mode.
  const roundTripped = Math.round(113.5555 * PROD.rate);
  assert.equal(roundTripped, 10_219_995);
  assert.ok(Math.abs(roundTripped - PROD.ordersLbp) <= 10, "consistent to within the 4dp residue");
});

// --- End Shift: expected, counted and difference share one unit --------------

test("every drawer figure in End Shift is USD", () => {
  for (const row of ["expected.opening_cash", "expected.cash_sales", "expected.expected"]) {
    assert.match(
      shiftDialog,
      new RegExp(`formatMoney\\(${row.replace(".", "\\.")}, CASH_CONTRACT_CURRENCY\\)`),
      `${row} must be USD`,
    );
  }
  for (const row of ["report.opening_cash", "report.cash_sales", "report.expected_cash", "report.actual_cash"]) {
    assert.match(
      shiftDialog,
      new RegExp(`formatMoney\\(${row.replace(/\./g, "\\.")}, CASH_CONTRACT_CURRENCY\\)`),
      `${row} must be USD`,
    );
  }
});

test("the difference is computed and shown in the same unit as expected", () => {
  // Both the live preview and the final badge.
  assert.match(shiftDialog, /formatMoney\(Math\.abs\(preview \?\? 0\), CASH_CONTRACT_CURRENCY\)/);
  assert.match(shiftDialog, /formatMoney\(Math\.abs\(report\.difference\), CASH_CONTRACT_CURRENCY\)/);
});

test("the counted-cash input asks for the unit the server subtracts", () => {
  // This is the half that could corrupt a shift, not merely mislead.
  assert.match(shiftDialog, /Counted cash \(\{CASH_CONTRACT_CURRENCY\}\)/);
  assert.match(shiftDialog, /Opening float \(\{CASH_CONTRACT_CURRENCY\}\)/);
  assert.equal(/Counted cash \(\{currency\}\)/.test(shiftDialog), false);
  assert.equal(/Opening float \(\{currency\}\)/.test(shiftDialog), false);
});

test("cents can be entered on an LBP tenant", () => {
  // `allowDecimal={currency === "USD"}` disabled the decimal key whenever the
  // tenant was LBP - which, now the field is dollars, would make $113.56
  // untypeable on exactly the tenant that found this bug.
  assert.equal(/allowDecimal=\{currency === "USD"\}/.test(shiftDialog), false);
  assert.equal((shiftDialog.match(/allowDecimal(?![=])/g) ?? []).length, 2, "float and counted keypads");
});

test("sales stay in the order currency and say so", () => {
  // The mix is the real contract: cash_sales sums USD payments, net_sales sums
  // pos_orders.total_amount in the order's own currency. Both headings are
  // labelled so the reader is never left inferring it.
  assert.match(shiftDialog, /Cash \(\{CASH_CONTRACT_CURRENCY\}\)/);
  assert.match(shiftDialog, /Sales \(\{currency\}\)/);
  for (const row of ["report.gross_sales", "report.discounts", "report.net_sales"]) {
    assert.match(shiftDialog, new RegExp(`formatMoney\\(${row.replace(/\./g, "\\.")}, currency\\)`), `${row}`);
  }
});

test("the tendered breakdown still shows each currency in its own units", () => {
  // Untouched by this fix, and must stay that way: these are the only two
  // figures that were already correct.
  assert.match(shiftDialog, /formatMoney\(report\.cash_usd, "USD"\)/);
  assert.match(shiftDialog, /formatMoney\(report\.cash_lbp_original, "LBP"\)/);
});

// --- Drawer ------------------------------------------------------------------

test("the drawer popover shows dollars and says where it came from", () => {
  assert.match(statusBar, /formatMoney\(props\.cashBox\.expected_cash, CASH_CONTRACT_CURRENCY\)/);
  assert.equal(/formatMoney\(props\.cashBox\.expected_cash, props\.currency\)/.test(statusBar), false);
  assert.match(statusBar, /in USD/);
  // Drawer privacy, unchanged: still no amount in the top-bar label.
  assert.equal(/Drawer \{formatMoney/.test(statusBar), false);
});

// --- the printed report ------------------------------------------------------

const order = (over: Partial<ShiftOpenOrder> = {}): ShiftOpenOrder => ({
  id: "o1", order_number: "260815-0001", order_type: "takeaway", status: "completed",
  payment_status: "paid", payment_method: "cash", subtotal: 1_830_000, discount_amount: 0,
  total_amount: 1_830_000, currency: "LBP", table_id: null, customer_id: null,
  customer_name: null, customer_phone: null, cashier_user_id: null, staff_name: "Cashier",
  notes: null, created_at: "2026-08-15T11:30:00.000Z", ...over,
});

function lines(currency: CurrencyCode) {
  return buildShiftReportLines({
    businessName: "Burger nation", branchName: "Main Branch", staffName: "Cashier",
    shiftRef: "fa25a0c1", openedAt: "opened", closedAt: "closed", currency,
    money: {
      orders: 8, grossSales: PROD.ordersLbp, discounts: 0, netSales: PROD.ordersLbp,
      cashSales: PROD.expectedCashUsd, cashUsd: PROD.expectedCashUsd, cashLbpOriginal: 0,
      openingCash: 0, expectedCash: PROD.expectedCashUsd, actualCash: PROD.expectedCashUsd,
      difference: 0,
    },
    detail: buildShiftReportDetail([order()], [{ item: "Burger", qty: 8, total: PROD.ordersLbp }]),
    note: null,
    fmt: formatMoney,
  });
}

test("the printed drawer block is dollars on an LBP shift", () => {
  const out = lines("LBP");
  const find = (label: string) => out.find((l) => l.label === label)?.value;
  assert.ok(out.some((l) => l.label === "DRAWER (USD)"), "the heading must name the unit");
  assert.equal(find("Expected"), "$113.56");
  assert.equal(find("Counted"), "$113.56");
  assert.equal(find("Difference"), "$0.00");
  assert.equal(find("Opening cash"), "$0.00");
  assert.equal(find("Cash sales"), "$113.56");
  // ...while sales stay in the order's currency on the very same report.
  assert.equal(find("Net sales"), "10,220,000 LBP");
  assert.equal(find("Gross sales"), "10,220,000 LBP");
});

test("a USD shift is unchanged - every figure was already right", () => {
  const out = lines("USD");
  const find = (label: string) => out.find((l) => l.label === label)?.value;
  assert.equal(find("Expected"), "$113.56");
  assert.equal(find("Counted"), "$113.56");
  assert.equal(find("Net sales"), "$10220000.00");
  // No LBP suffix anywhere on a USD report.
  assert.equal(out.some((l) => (l.value ?? "").endsWith(" LBP")), false);
});

test("no report figure is re-valued at today's rate", () => {
  const src = readFileSync(join(root, "..", "src", "lib", "pos", "shiftReport.ts"), "utf8");
  for (const forbidden of ["convertCurrency", "convertUsdToLbp", "convertLbpToUsd", "exchange_rate", "usd_to_lbp"]) {
    assert.equal(src.includes(forbidden), false, `${forbidden} must not appear`);
  }
});

// --- the duplicate suffix ----------------------------------------------------

test("a total carries exactly one currency label", () => {
  assert.equal(formatMoney(200_000, "LBP"), "200,000 LBP");
  assert.equal(formatMoney(200_000, "LBP").match(/LBP/g)?.length, 1);
  // The panel renders the formatted total and nothing after it.
  assert.match(currentOrder, /<span>\{formatMoney\(order\.total_amount \?\? 0, currency\)\}<\/span>/);
  assert.equal(
    /formatMoney\(order\.total_amount \?\? 0, currency\)\}\s*<span[^>]*>\{currency\}<\/span>/.test(currentOrder),
    false,
    "the second label must be gone",
  );
});

test("USD formatting is untouched", () => {
  assert.equal(formatMoney(12.34, "USD"), "$12.34");
  assert.equal(formatMoney(0, "USD"), "$0.00");
  assert.equal(formatMoney(12.34, "USD").includes("USD"), false);
});
