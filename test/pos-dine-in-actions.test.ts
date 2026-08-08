// Dine-In action state: what the workspace may do, and how it is wired.
//
// WHY THIS FILE EXISTS
// A single inline `payDisabled: false` in `PosWorkspace.tsx` once enabled the
// bottom bar's PAY slot. Its handler was harmless at the time, but a control
// sitting in the pay position, enabled, one edit away from a real handler, is
// not an acceptable resting state.
//
// LEVEL 2D CHANGED WHAT THIS FILE GUARDS.
// Pay is real now, so "the slot is dead" is no longer the invariant - it would be
// a lie. The replacement is stronger and is what the rest of this file asserts:
// the pay slot has NO opinion of its own. `dineInBottomBar` accepts a Gate and no
// boolean, `PosWorkspace` hands it the same `payTableGate` result the bill panel
// and F4 use, and the shell still turns that into the button's `disabled`
// attribute. There is nowhere left to put a second answer.
//
// Layers 2 and 3 are asserted by reading source text: the project has no DOM test
// library, and both regressions ARE source-level (a prop literal, a union member),
// which is exactly what a source assertion catches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFERRED_TABLE_ACTIONS,
  deferredActionReason,
  dineInBottomBar,
  isTableActionEnabled,
} from "@/lib/pos/dineInActions";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...parts: string[]) => readFileSync(join(srcRoot, ...parts), "utf8");

/**
 * The RPC names `callPosRpc` will accept.
 *
 * Line comments are stripped FIRST: the union is documented with prose that
 * contains a semicolon, and parsing to the first `;` silently truncated the list
 * to six members - a parse bug that would have let a forbidden RPC through
 * unnoticed. The length assertion below is the backstop against that recurring.
 */
function allowedRpcNames(): string[] {
  const source = read("lib", "pos", "rpc.ts").replace(/\/\/.*$/gm, "");
  const decl = /export type PosRpcName\s*=([\s\S]*?);/.exec(source);
  assert.ok(decl, "the PosRpcName union could not be located");
  return Array.from(decl[1].matchAll(/"([a-z_]+)"/g)).map((m) => m[1]);
}

// --- Layer 1: the pure decision ---------------------------------------------

test("nothing is deferred any more - every dine-in table action is real", () => {
  assert.deepEqual(DEFERRED_TABLE_ACTIONS, [], "a table action was deferred again");
  // The predicate and its message helper survive as the seam for the next
  // deferred action, and still refuse unconditionally.
  assert.equal(isTableActionEnabled(undefined as never), false);
  assert.equal(
    deferredActionReason({ key: undefined as never, label: "Split bill", level: "Level 3", rpc: "pos_split_bill" }),
    "Split bill arrives in Level 3.",
  );
});

test("the bottom bar derives BOTH pay fields from one gate, and accepts no boolean", () => {
  const summary = { itemCount: 4, subtotal: 61.25 };
  const gates = [
    { allowed: false, reason: "You do not have permission to take payments." },
    { allowed: false, reason: "This table has no open bill to settle." },
    { allowed: false, reason: "This payment is already being sent." },
    { allowed: true, reason: null },
  ];
  for (const payGate of gates) {
    const bar = dineInBottomBar({ summary, payGate });
    assert.equal(bar.payDisabled, !payGate.allowed, `payDisabled disagreed with the gate: ${payGate.reason}`);
    assert.equal(bar.payReason, payGate.reason, "payReason is not the gate's own reason");
    assert.equal(bar.itemCount, summary.itemCount);
    assert.equal(bar.subtotal, summary.subtotal);
    assert.equal(bar.payLabel, "Pay");
  }
});

test("the pay slot never blames a permission the operator may hold", () => {
  const bar = dineInBottomBar({
    summary: { itemCount: 1, subtotal: 10 },
    payGate: { allowed: false, reason: "Open a shift before taking payment." },
  });
  assert.doesNotMatch(bar.payReason ?? "", /permission/i);
  // And it no longer promises a future level, because the feature has landed.
  assert.doesNotMatch(bar.payReason ?? "", /Level 2D/);
});

test("shipped actions leave the deferred list as each level lands", () => {
  const keys = DEFERRED_TABLE_ACTIONS.map((a) => String(a.key));
  for (const shipped of ["addItems", "submitRound", "move", "close", "clear", "pay"]) {
    assert.equal(keys.includes(shipped), false, `${shipped} is a real gated action now`);
  }
});

// --- Layer 2: the wiring -----------------------------------------------------

test("PosWorkspace takes its dine-in bottom bar from the module, not from a literal", () => {
  const source = read("screens", "pos", "PosWorkspace.tsx");
  assert.match(
    source,
    /\.\.\.dineInBottomBar\(\{\s*summary: dineIn\.summary,\s*payGate: dineIn\.payGate\s*\}\)/,
    "the dine-in bottom bar is no longer module-driven, or no longer fed the shared gate",
  );
  assert.doesNotMatch(source, /payDisabled:\s*(false|true)/, "a literal decided the pay slot again");
  assert.doesNotMatch(source, /payDisabled=\{(false|true)\}/, "a literal decided the pay slot again");
});

test("the bottom bar's onPay OPENS the dialog - it is not a payment call", () => {
  const source = read("screens", "pos", "PosWorkspace.tsx");
  assert.match(source, /onPay: dineIn\.requestPay/, "the dine-in pay slot no longer routes through requestPay");
  const workspace = read("screens", "pos", "DineInWorkspace.tsx");
  // requestPay may only set dialog state. If it ever called the RPC, the bottom
  // bar would become a one-tap charge.
  const body = /const requestPay = useCallback\(([\s\S]*?)\n  \}, \[/.exec(workspace)?.[1] ?? "";
  assert.notEqual(body, "", "requestPay could not be located");
  assert.match(body, /setPayOpen\(true\)/, "requestPay no longer opens the dialog");
  assert.doesNotMatch(body, /payTable|performTablePayment|callPosRpc/, "requestPay can reach the server");
  assert.match(body, /payGate\.allowed/, "requestPay does not consult the shared gate");
});

test("payDisabled is the Pay button's disabled attribute - the shell has not stopped honouring it", () => {
  const shell = read("layouts", "PosShell.tsx");
  assert.match(
    shell,
    /disabled=\{props\.cartSummary\.payDisabled\}/,
    "PosShell no longer disables the bottom-bar action from payDisabled",
  );
});

test("every Pay surface renders from the SAME gate value, not its own computation", () => {
  const workspace = read("screens", "pos", "DineInWorkspace.tsx");
  // Exactly one call to payTableGate in the whole workspace.
  assert.equal(
    workspace.split("payTableGate(").length - 1,
    1,
    "payTableGate is computed more than once - the surfaces can now disagree",
  );
  assert.match(workspace, /payGate=\{payGate\}/, "the bill panel is not fed the shared gate");
  assert.match(workspace, /openPayment: \(\) => payGate\.allowed && requestPay\(\)/, "F4 does not respect the shared gate");
  // NB: `\s*` rather than `\n` - the workspace files use CRLF line endings.
  assert.match(workspace, /payGate,\s*requestPay,/, "the shared gate is not exported to the shell");

  // And the panel does not re-derive it. Comments are stripped: the panel's
  // header explains that it does NOT compute the gate, which must not be
  // mistaken for computing it.
  const panel = stripJsxComments(read("components", "pos", "TableBillPanel.tsx"));
  assert.doesNotMatch(panel, /payTableGate|takePayments/, "the bill panel computes its own payment permission");
  assert.match(panel, /gate=\{props\.payGate\}/, "the panel's Pay button is not gated by the shared result");
});

test("Pay and Clear are not adjacent - the collect and the void must not be mis-tapped", () => {
  const panel = read("components", "pos", "TableBillPanel.tsx");
  const pay = panel.indexOf("Pay (F4)");
  const clear = panel.indexOf("Clear (voids the bill)");
  assert.ok(pay > 0 && clear > 0, "the Pay/Clear controls could not be located");
  assert.ok(pay < clear, "Pay moved below Clear");
  // Separated by the whole operations block, not merely by a margin.
  const between = panel.slice(pay, clear);
  assert.match(between, /Add items/, "Pay and Clear are no longer separated by the other actions");
  assert.match(between, /props\.moveGate/, "Pay and Clear are no longer separated by the other actions");
});

test("dine-in never renders the cart panel, which can send a takeaway order and pay", () => {
  const source = read("screens", "pos", "PosWorkspace.tsx");
  const cartProp = source.indexOf("cart={(layout) =>");
  const roundPanel = source.indexOf("dineIn.roundPanel(layout)");
  const dineInBill = source.indexOf("dineIn.bill(layout)");
  const cartPanel = source.indexOf("<CartPanel");
  assert.ok(cartProp >= 0 && roundPanel >= 0 && dineInBill >= 0 && cartPanel >= 0, "the cart prop structure changed");
  assert.ok(roundPanel > cartProp && dineInBill > cartProp, "the dine-in panels are not inside the cart prop");
  assert.ok(
    cartPanel > roundPanel && cartPanel > dineInBill,
    "CartPanel is reached before the dine-in branches - Send to kitchen and Pay would render on a table",
  );
});

test("the table map owns the work area unless Add Items borrowed the menu", () => {
  const source = read("screens", "pos", "PosWorkspace.tsx");
  const workProp = source.indexOf("work={(layout) =>");
  const dineInWork = source.indexOf("dineIn.work(layout)");
  const menuGrid = source.indexOf("<MenuItemGrid");
  assert.ok(dineInWork > workProp, "the table map is not inside the work prop");
  assert.ok(menuGrid > dineInWork, "the menu grid is reached before the dine-in branch");
  // The menu is shared rather than duplicated: exactly one MenuItemGrid exists.
  assert.equal(source.split("<MenuItemGrid").length - 1, 1, "a second menu implementation appeared");
  assert.match(source, /dineIn\.view === "map"/, "the work area no longer branches on the dine-in view");
});

test("the payment dialog is REUSED, not duplicated", () => {
  // One implementation, imported by both workspaces. A second dialog would mean
  // a second discount validator and a second tender calculation.
  const files = readFileSync(join(srcRoot, "components", "pos", "PaymentDialog.tsx"), "utf8");
  assert.match(files, /export function PaymentDialog/);
  const takeaway = read("screens", "pos", "PosWorkspace.tsx");
  const dineIn = read("screens", "pos", "DineInWorkspace.tsx");
  for (const [name, source] of [["PosWorkspace", takeaway], ["DineInWorkspace", dineIn]] as const) {
    assert.match(source, /from "@\/components\/pos\/PaymentDialog"/, `${name} does not import the shared dialog`);
  }
  assert.doesNotMatch(dineIn, /function \w*PaymentDialog/, "a second payment dialog was declared");
});

test("Level 2B's real actions are gated on preconditions, not on a deferral list", () => {
  const rounds = read("lib", "pos", "tableRounds.ts");
  for (const fn of ["addItemsGate", "submitRoundGate"]) {
    assert.match(rounds, new RegExp(`export function ${fn}`), `${fn} is missing`);
  }
  // Add Items must never consult payment permission.
  assert.doesNotMatch(rounds, /takePayments|canTakePayments|payGate/, "the round path consults payment permission");
});

test("the live table-operation shortcuts open a confirmation, never the operation", () => {
  // What must remain true is that the chord reaches a DIALOG, not the RPC - so a
  // mistyped Ctrl+Shift+X cannot void a bill without the operator reading what it
  // is about to do and typing why. F4 obeys the same rule for payment.
  const source = read("screens", "pos", "DineInWorkspace.tsx");
  for (const id of ["moveTable", "closeTable", "clearTable"]) {
    assert.match(source, new RegExp(`${id}: \\(\\) =>[^\\n]*requestOp\\(`), `${id} does not route through requestOp`);
  }
  assert.match(source, /const requestOp = useCallback\(/, "requestOp is gone - the chords may act directly now");
  assert.match(source, /setOpDialog\(kind\)/, "requestOp no longer opens a dialog");
});

// --- Layer 3: reachability ---------------------------------------------------

test("settlement joined PosRpcName exactly once, and nothing else came with it", () => {
  const members = allowedRpcNames();
  assert.ok(members.includes("pos_pay_table"), "pos_pay_table is not callable - Level 2D cannot settle");
  assert.equal(new Set(members).size, members.length, "an RPC name is declared twice");
  // Positive control: the table RPCs the earlier levels use are still present, so
  // this test cannot pass merely because the parse found nothing.
  for (const rpc of ["pos_table_map", "pos_open_table", "pos_move_table", "pos_close_table", "pos_clear_table"]) {
    assert.ok(members.includes(rpc), `${rpc} disappeared from the allow-list`);
  }
  // RETARGETED BY LEVEL 3A: 12 -> 13, for `pos_upsert_customer`. Left failing
  // until that RPC was genuinely wired, on the same principle as Level 2D's
  // 11 -> 12 - a size assertion loosened before its feature lands stops being a
  // guard and becomes a comment. The point of the number is that a NEW RPC
  // cannot arrive unnoticed, so it is bumped by exactly one, deliberately.
  assert.equal(members.length, 13, `the RPC allow-list changed size: ${members.join(", ")}`);
  assert.ok(members.includes("pos_upsert_customer"), "pos_upsert_customer is not callable - Level 3A cannot save a customer");
  // Level 3A added no order or money RPC.
  assert.equal(members.filter((m) => /submit|pay|void|refund/.test(m)).length, 3);
});

test("pos_pay_table is called from exactly one module", () => {
  // One call site means one place where the re-read, the latch and the recovery
  // model are enforced. A second caller would be a second payment path.
  const callers = [
    "lib/pos/tablePayment.ts",
    "lib/pos/tableOps.ts",
    "lib/pos/tables.ts",
    "lib/pos/tableBill.ts",
    "lib/pos/tableRounds.ts",
    "lib/pos/orders.ts",
    "lib/pos/payments.ts",
    "lib/pos/shifts.ts",
    "screens/pos/DineInWorkspace.tsx",
    "screens/pos/PosWorkspace.tsx",
    "components/pos/TableBillPanel.tsx",
    "state/tables.ts",
  ];
  const hits = callers.filter((f) => /callPosRpc\(\s*"pos_pay_table"/.test(read(...f.split("/"))));
  assert.deepEqual(hits, ["lib/pos/tablePayment.ts"], `pos_pay_table is called from ${hits.join(", ") || "nowhere"}`);
});

test("dine-in ordering still reuses Takeaway's RPC, under its own guard", () => {
  const members = allowedRpcNames();
  assert.ok(members.includes("pos_submit_order"));
  assert.equal(members.filter((m) => m.includes("submit")).length, 1, "a second submit RPC appeared");
  assert.match(read("lib", "pos", "orders.ts"), /throw new TableRequiredError\(\)/, "the dine-in submit guard was removed");
});

test("the table operations cannot be reached without going through tableOps", () => {
  const callers = ["lib/pos/tableOps.ts", "lib/pos/tables.ts", "lib/pos/orders.ts", "lib/pos/payments.ts", "lib/pos/shifts.ts", "lib/pos/tablePayment.ts"];
  for (const rpc of ["pos_move_table", "pos_close_table", "pos_clear_table"]) {
    const hits = callers.filter((f) => new RegExp(`callPosRpc\\(\\s*"${rpc}"`).test(read(...f.split("/"))));
    assert.deepEqual(hits, ["lib/pos/tableOps.ts"], `${rpc} is called from ${hits.join(", ") || "nowhere"}`);
  }
});

test("no offline queue is reachable from the dine-in round or payment path", () => {
  const sources = [
    read("lib", "pos", "tableRounds.ts"),
    read("lib", "pos", "tablePayment.ts"),
    read("lib", "pos", "tablePaymentCompletion.ts"),
    read("screens", "pos", "DineInWorkspace.tsx"),
    read("components", "pos", "DineInRoundPanel.tsx"),
  ].join("\n");
  assert.doesNotMatch(sources, /enqueue\s*\(/, "a dine-in round or payment can be queued offline");
  assert.doesNotMatch(sources, /offline\/db|localdb/, "the dine-in path reaches the offline database");
  // Offline is refused outright rather than deferred to a queue.
  assert.match(read("lib", "pos", "tableRounds.ts"), /OfflineOrderingError/);
});
