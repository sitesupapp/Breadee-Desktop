// READY POS Phase G — desktop POS Payouts / Cash Drawer Outflows.
//
// The server ops (pos_payout_create / _reverse / _list) are proven on staging. These
// tests lock the desktop request shaping and the safety-relevant wiring: a payout is a
// DRAWER-MOVEMENT layer linked to an EXISTING economic source and NEVER a second
// economic event; the server owns every figure; and — because the source can only be
// validated against the live DB — a payout is ONLINE-ONLY and fails closed offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PAYOUT_SOURCE_TYPES,
  PayoutOfflineError,
  buildPayoutCreatePayload,
  createPayout,
  parsePayoutList,
  reversePayout,
} from "@/lib/pos/payouts";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, "..", "src", p), "utf8").replace(/\r\n/g, "\n");

// --- W: request shaping (pure) ----------------------------------------------

test("W — buildPayoutCreatePayload: exact shape; no currency/amount_usd/label sent (server prices + snapshots)", () => {
  const p = buildPayoutCreatePayload({
    shiftId: "shift-1",
    amount: 12.5,
    sourceType: "expense",
    sourceId: "exp-1",
    note: "  petty cash  ",
    clientOpId: "op-1",
  });
  assert.deepEqual(p, {
    shift_id: "shift-1",
    amount: 12.5,
    source_type: "expense",
    source_id: "exp-1",
    note: "petty cash", // trimmed
    client_op_id: "op-1",
  });
  // The desktop never sends money authority beyond the amount itself.
  assert.equal("currency" in p, false);
  assert.equal("amount_usd" in p, false);
  assert.equal("source_reference" in p, false);
});

test("X — buildPayoutCreatePayload: an empty/whitespace note becomes null", () => {
  const p = buildPayoutCreatePayload({
    shiftId: "s",
    amount: 1,
    sourceType: "purchase_invoice",
    sourceId: "pi",
    note: "   ",
    clientOpId: "op",
  });
  assert.equal(p.note, null);
});

// --- Y: response parsing -----------------------------------------------------

test("Y — parsePayoutList: rows + totals; unknown status coerces to active; missing → []", () => {
  const st = parsePayoutList({
    payouts: [
      { id: "a", amount: 10, currency: "USD", amount_usd: 10, source_type: "expense", source_id: "e", source_reference: "Expense · X", note: null, status: "active", created_at: "2026-09-28T10:00:00Z", created_by: "u", reversed_at: null, reversal_reason: null },
      { id: "b", amount: 5, currency: "USD", amount_usd: 5, source_type: "supplier_payment", source_id: "s", source_reference: "Supplier Payment · cash", note: "n", status: "reversed", created_at: null, created_by: null, reversed_at: "2026-09-28T11:00:00Z", reversal_reason: "mistake" },
      { id: "c", amount: 1, currency: "USD", amount_usd: 1, source_type: "expense", source_id: "e2", source_reference: null, note: null, status: "weird", created_at: null, created_by: null, reversed_at: null, reversal_reason: null },
    ],
    active_total: 11,
    count: 3,
    reversed_count: 1,
    currency: "USD",
  });
  assert.equal(st.count, 3);
  assert.equal(st.active_total, 11);
  assert.equal(st.reversed_count, 1);
  assert.equal(st.payouts[0].status, "active");
  assert.equal(st.payouts[1].status, "reversed");
  assert.equal(st.payouts[2].status, "active"); // unknown → active
  assert.deepEqual(parsePayoutList({}).payouts, []);
});

// --- Z / AA / S / V: ONLINE-ONLY, fail-closed offline ------------------------

test("Z / S — createPayout fails closed offline (PayoutOfflineError), never touches the network", async () => {
  await assert.rejects(
    () =>
      createPayout({
        payload: buildPayoutCreatePayload({ shiftId: "s", amount: 5, sourceType: "expense", sourceId: "e", note: null, clientOpId: "op" }),
        online: false,
      }),
    (e) => e instanceof PayoutOfflineError,
  );
});

test("AA / V — reversePayout fails closed offline (PayoutOfflineError)", async () => {
  await assert.rejects(
    () => reversePayout({ payoutId: "p", reason: null, clientOpId: "op", online: false }),
    (e) => e instanceof PayoutOfflineError,
  );
});

// --- AB: the source domain matches the server ---------------------------------

test("AB — PAYOUT_SOURCE_TYPES are exactly the server's four source types", () => {
  assert.deepEqual(
    PAYOUT_SOURCE_TYPES.map((t) => t.type).sort(),
    ["expense", "maintenance_job", "purchase_invoice", "supplier_payment"],
  );
  // each carries a human label + hint for the "what is this for?" step
  for (const t of PAYOUT_SOURCE_TYPES) {
    assert.ok(t.label.length > 0 && t.hint.length > 0);
  }
});

// --- AC / U: the lib contract + NO second economic event / NO offline outbox --

test("AC — payouts.ts: calls the three RPCs, is online-only, and writes NO economic ledger", () => {
  const s = src("lib/pos/payouts.ts");
  assert.match(s, /callPosRpc\("pos_payout_create", \{ p_payload: input\.payload \}\)/);
  assert.match(s, /callPosRpc\("pos_payout_reverse",\s*\{\s*p_payload:/);
  assert.match(s, /callPosRpc\("pos_payout_list", \{ p_payload: \{ shift_id: shiftId \} \}\)/);
  // online-only guard is BEFORE the network call in both mutators
  assert.match(s, /if \(!input\.online\) throw new PayoutOfflineError\(\)/);
  // source pickers read exactly the four economic-source tables, branch-or-null scoped
  assert.match(s, /table: "expenses"/);
  assert.match(s, /table: "purchase_invoices"/);
  assert.match(s, /table: "supplier_payments"/);
  assert.match(s, /table: "maintenance_jobs"/);
  assert.match(s, /branch_id\.eq\.\$\{branchId\},branch_id\.is\.null/);
  // NEVER creates a second economic event: the lib only READS its source tables
  // (.select), and performs NO write mutation to any table whatsoever.
  assert.doesNotMatch(s, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  assert.match(s, /\.select\(q\.cols\)/);
});

test("U — payouts are NEVER enqueued to the offline outbox (online-only money-mover)", () => {
  const s = src("lib/pos/payouts.ts");
  // No offline-outbox WIRING (identifiers) — the word "outbox" may appear in prose.
  assert.doesNotMatch(s, /addPosOfflineTxn|posOfflineTxns|updatePosOfflineTxn|localdb\./);
});

// --- AD: the RPC allow-list ---------------------------------------------------

test("AD — rpc.ts: the three Phase G payout RPCs are on the allow-list", () => {
  const s = src("lib/pos/rpc.ts");
  assert.match(s, /"pos_payout_create"/);
  assert.match(s, /"pos_payout_reverse"/);
  assert.match(s, /"pos_payout_list"/);
});

// --- AE: dedicated permissions + gates ---------------------------------------

test("AE — access.ts: three DISTINCT payout permissions + gates with the owner block", () => {
  const s = src("lib/pos/access.ts");
  assert.match(s, /PAYOUTS_VIEW: "pos\.payouts\.view"/);
  assert.match(s, /PAYOUTS_CREATE: "pos\.payouts\.create"/);
  assert.match(s, /PAYOUTS_REVERSE: "pos\.payouts\.reverse"/);
  assert.match(s, /export function canViewPayouts\(ctx: PosAccessContext\): Gate/);
  assert.match(s, /export function canCreatePayout\(ctx: PosAccessContext\): Gate/);
  assert.match(s, /export function canReversePayout\(ctx: PosAccessContext\): Gate/);
  // each carries the owner block (canOperatePOS mirrors pos_assert_operator)
  const seg = s.slice(s.indexOf("export function canViewPayouts"), s.indexOf("export function canReversePayout") + 400);
  assert.match(seg, /canOperatePOS\(ctx\)/);
});

// --- AF: gates wired into the POS context ------------------------------------

test("AF — state/pos.ts: payout gates are computed into pos.gates", () => {
  const s = src("state/pos.ts");
  assert.match(s, /viewPayouts: canViewPayouts\(access\)/);
  assert.match(s, /createPayout: canCreatePayout\(access\)/);
  assert.match(s, /reversePayout: canReversePayout\(access\)/);
});

// --- Expected-cash + End Shift integration -----------------------------------

test("shifts.ts: cash_payouts is read from pos_shift_expected AND pos_end_shift", () => {
  const s = src("lib/pos/shifts.ts");
  assert.match(s, /cash_payouts: num\(row\.cash_payouts\)/);
  // it appears in both getShiftExpected and endShift parsers
  assert.equal((s.match(/cash_payouts: num\(row\.cash_payouts\)/g) ?? []).length, 2);
});

test("ShiftDialog: End Shift and the report show a 'Cash payouts' line, subtracted from Expected", () => {
  const s = src("components/pos/ShiftDialog.tsx");
  // shown only when there were payouts, as a negative amount, in both the End-Shift
  // preview and the report Cash box
  assert.equal((s.match(/Cash payouts/g) ?? []).length, 2);
  assert.match(s, /expected\.cash_payouts > 0/);
  assert.match(s, /report\.cash_payouts > 0/);
});

test("shiftReport.ts: the printed DRAWER block prints Cash payouts when present", () => {
  const s = src("lib/pos/shiftReport.ts");
  assert.match(s, /cashPayouts\?: number/);
  assert.match(s, /\(money\.cashPayouts \?\? 0\) > 0/);
});

// --- The Payouts surface + launcher ------------------------------------------

test("PosStatusBar: a Payouts launcher, offered only when the operator may view payouts", () => {
  const s = src("components/pos/PosStatusBar.tsx");
  assert.match(s, /onOpenPayouts\?: \(\) => void/);
  assert.match(s, /canViewPayouts\?: boolean/);
  assert.match(s, /props\.canViewPayouts && props\.onOpenPayouts/);
});

test("PayoutsModal: summary cards, guided New Payout, cash-leaving-drawer confirmation, reversal, online-only", () => {
  const s = src("components/pos/PayoutsModal.tsx");
  // summary cards
  assert.match(s, /Paid out this shift/);
  assert.match(s, /Reversed/);
  // guided flow: amount → what for → link record → confirm
  assert.match(s, /What is this cash for\?/);
  assert.match(s, /PAYOUT_SOURCE_TYPES\.map/);
  assert.match(s, /Cash leaving drawer/);
  assert.match(s, /Pay out cash · \$\{formatMoney\(amountNum, currency\)\}/);
  // it states plainly that no second economic entry is created
  assert.match(s, /does NOT create a new expense or payable/);
  // reversal returns the cash to the expected drawer, never touching the source
  assert.match(s, /The linked\s*\n?\s*record is NOT changed\.|linked[\s\S]{0,40}NOT changed/);
  // online-only: New payout + Reverse are disabled offline, with a reason
  assert.match(s, /Cash payouts need a connection/);
  assert.match(s, /const newAllowed = online && canCreate\.allowed/);
  // idempotent: one op id per attempt, reused on retry
  assert.match(s, /opId\.current = crypto\.randomUUID\(\)/);
});

test("PosWorkspace: renders PayoutsModal and re-reads the cash box after a payout changes the drawer", () => {
  const s = src("screens/pos/PosWorkspace.tsx");
  assert.match(s, /<PayoutsModal/);
  assert.match(s, /onChanged=\{\(\) => void shiftStore\.refreshCashBox\(\)\}/);
  assert.match(s, /canCreate=\{pos\.gates\.createPayout\}/);
  assert.match(s, /canReverse=\{pos\.gates\.reversePayout\}/);
});
