// Dine-In action state: what Level 2A may do, and what it must NOT do.
//
// WHY THIS FILE EXISTS
// A single inline `payDisabled: false` in `PosWorkspace.tsx` once enabled the
// bottom bar's PAY slot. Its handler was harmless at the time, but a control
// sitting in the pay position, enabled, one edit away from a real handler, is
// not an acceptable resting state for a level that must not settle anything.
//
// So this file asserts THREE independent layers, because any one of them alone
// can be defeated by a plausible edit:
//   1. the pure decision   - `lib/pos/dineInActions.ts` cannot say "enabled",
//   2. the wiring          - `PosWorkspace.tsx` takes its bottom bar from that
//                            module and hands the pay slot a no-op,
//   3. the reachability    - the RPCs these actions will one day call are absent
//                            from `PosRpcName`, so `callPosRpc` will not take them.
//
// Layers 2 and 3 are asserted by reading source text: the project has no DOM test
// library, and both regressions ARE source-level (a prop literal, a union member),
// which is exactly what a source assertion catches. This is deliberately separate
// from the touch-target scan, which only looks at control sizing.

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
  type DeferredTableActionKey,
} from "@/lib/pos/dineInActions";

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

/** RPCs that would mutate or settle a table. None may be reachable in Level 2A. */
/**
 * The RPC that must stay unreachable.
 *
 * Level 2C added `pos_move_table`, `pos_close_table` and `pos_clear_table` to
 * the allow-list, so they are no longer forbidden. `pos_pay_table` is - it is
 * the one that takes the customer's money, and it belongs to Level 2D.
 */
const FORBIDDEN_RPCS = ["pos_pay_table"];

/**
 * Every action that must stay non-functional.
 *
 * Level 2B shipped Add items and Submit round; Level 2C shipped Move, Close and
 * Clear. What is left is SETTLEMENT.
 */
const MUST_BE_DISABLED: DeferredTableActionKey[] = ["pay"];

// --- Layer 1: the pure decision ---------------------------------------------

test("the deferred list covers every action this level must not perform", () => {
  const keys = DEFERRED_TABLE_ACTIONS.map((a) => a.key);
  for (const key of MUST_BE_DISABLED) {
    assert.ok(keys.includes(key), `${key} is not declared as a deferred action`);
  }
  assert.equal(new Set(keys).size, keys.length, "a deferred action is declared twice");
});

test("no dine-in action can be enabled - the check takes no arguments to be swayed by", () => {
  for (const key of MUST_BE_DISABLED) {
    assert.equal(isTableActionEnabled(key), false, `${key} reported itself as enabled`);
  }
});

test("the bottom bar's pay slot is disabled for EVERY bill state", () => {
  const states = [
    { itemCount: 0, subtotal: 0 },
    { itemCount: 1, subtotal: 12.5 },
    { itemCount: 40, subtotal: 999_999 },
    { itemCount: 0, subtotal: 25 },
  ];
  for (const s of states) {
    const bar = dineInBottomBar(s);
    assert.equal(bar.payDisabled, true, `pay was enabled for ${JSON.stringify(s)}`);
    assert.equal(bar.itemCount, s.itemCount);
    assert.equal(bar.subtotal, s.subtotal);
  }
});

test("the pay slot is labelled Pay and says which level delivers it", () => {
  const bar = dineInBottomBar({ itemCount: 2, subtotal: 30 });
  assert.equal(bar.payLabel, "Pay");
  assert.match(bar.payReason, /Level 2D/);
  // It must not imply the operator is missing a permission.
  assert.doesNotMatch(bar.payReason, /permission/i);
});

test("every deferred action explains itself by level, never by permission", () => {
  for (const action of DEFERRED_TABLE_ACTIONS) {
    const reason = deferredActionReason(action);
    assert.match(reason, /Level 2[CD]\.$/, `${action.key} does not name its level: ${reason}`);
    assert.doesNotMatch(reason, /permission/i);
  }
});

test("shipped actions leave the deferred list as each level lands", () => {
  const keys = DEFERRED_TABLE_ACTIONS.map((a) => String(a.key));
  // Level 2B.
  assert.equal(keys.includes("addItems"), false, "Add items is a real gated action now");
  assert.equal(keys.includes("submitRound"), false, "Submit round is a real gated action now");
  // Level 2C.
  assert.equal(keys.includes("move"), false, "Move is a real gated action now");
  assert.equal(keys.includes("close"), false, "Close is a real gated action now");
  assert.equal(keys.includes("clear"), false, "Clear is a real gated action now");
  assert.deepEqual(keys, ["pay"], `only settlement should remain, got ${keys.join(", ")}`);
});

// --- Layer 2: the wiring -----------------------------------------------------

test("PosWorkspace takes its dine-in bottom bar from the module, not from a literal", () => {
  const source = read("screens", "pos", "PosWorkspace.tsx");
  assert.match(source, /\.\.\.dineInBottomBar\(dineIn\.summary\)/, "the dine-in bottom bar is no longer module-driven");
  assert.match(source, /onPay: NO_OP/, "the dine-in pay slot has a handler again");
  assert.doesNotMatch(source, /payDisabled:\s*false/, "a literal re-enabled the pay slot");
  assert.doesNotMatch(source, /payDisabled=\{false\}/, "a literal re-enabled the pay slot");
});

test("payDisabled is the Pay button's disabled attribute - the shell has not stopped honouring it", () => {
  const shell = read("layouts", "PosShell.tsx");
  assert.match(
    shell,
    /disabled=\{props\.cartSummary\.payDisabled\}/,
    "PosShell no longer disables the bottom-bar action from payDisabled",
  );
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

test("Level 2B's real actions are gated on preconditions, not on a deferral list", () => {
  const rounds = read("lib", "pos", "tableRounds.ts");
  for (const fn of ["addItemsGate", "submitRoundGate"]) {
    assert.match(rounds, new RegExp(`export function ${fn}`), `${fn} is missing`);
  }
  // Add Items must never consult payment permission.
  assert.doesNotMatch(rounds, /takePayments|canTakePayments|payGate/, "the round path consults payment permission");
});

test("the deferred buttons carry no click handler at all", () => {
  const source = read("components", "pos", "TableBillPanel.tsx");
  const start = source.indexOf("DEFERRED_TABLE_ACTIONS.map(");
  assert.ok(start > 0, "the deferred action block could not be located");
  const block = source.slice(start, source.indexOf("</div>", start));
  assert.match(block, /\bdisabled\b/, "the deferred buttons are no longer disabled");
  assert.doesNotMatch(block, /onClick/, "a deferred action was given a click handler");
});

test("the live table-operation shortcuts open a confirmation, never the operation", () => {
  // These are handled as of Level 2C. What must remain true is that the chord
  // reaches a DIALOG, not the RPC - so a mistyped Ctrl+Shift+X cannot void a
  // bill without the operator reading what it is about to do and typing why.
  const source = read("screens", "pos", "DineInWorkspace.tsx");
  for (const id of ["moveTable", "closeTable", "clearTable"]) {
    assert.match(source, new RegExp(`${id}: \\(\\) =>[^\\n]*requestOp\\(`), `${id} does not route through requestOp`);
  }
  assert.match(source, /const requestOp = useCallback\(/, "requestOp is gone - the chords may act directly now");
  assert.match(source, /setOpDialog\(kind\)/, "requestOp no longer opens a dialog");
});

test("no shortcut exists for the one action still deferred", () => {
  const sources = [
    read("screens", "pos", "DineInWorkspace.tsx"),
    read("screens", "pos", "PosWorkspace.tsx"),
    read("components", "pos", "TableBillPanel.tsx"),
  ].join("\n");
  assert.doesNotMatch(sources, /\bpayTable\s*:\s*\(/, "a pay-table shortcut handler appeared");
});

test("the dine-in workspace calls no mutating table RPC", () => {
  const sources = [
    read("screens", "pos", "DineInWorkspace.tsx"),
    read("components", "pos", "TableBillPanel.tsx"),
    read("components", "pos", "DineInRoundPanel.tsx"),
    read("lib", "pos", "tables.ts"),
    read("lib", "pos", "tableBill.ts"),
    read("lib", "pos", "tableRounds.ts"),
    read("state", "tables.ts"),
    read("lib", "pos", "dineInActions.ts"),
  ].join("\n");
  for (const rpc of FORBIDDEN_RPCS) {
    // The names may be MENTIONED in a comment; what must not exist is a call.
    assert.doesNotMatch(sources, new RegExp(`callPosRpc\\(\\s*"${rpc}"`), `${rpc} is called from the dine-in path`);
  }
});

// --- Layer 3: reachability ---------------------------------------------------

test("the settlement RPC is not in PosRpcName, so callPosRpc cannot accept it", () => {
  const members = allowedRpcNames();

  for (const rpc of FORBIDDEN_RPCS) {
    assert.equal(members.includes(rpc), false, `${rpc} became callable`);
  }
  // Positive control: the table RPCs this level DOES use are present, so this
  // test cannot pass merely because the parse found nothing.
  assert.ok(members.includes("pos_table_map"));
  assert.ok(members.includes("pos_open_table"));
  assert.ok(members.includes("pos_move_table"));
  assert.ok(members.includes("pos_close_table"));
  assert.ok(members.includes("pos_clear_table"));
  assert.equal(members.length, 11, `the RPC allow-list changed size: ${members.join(", ")}`);
});

test("every deferred action's future RPC is unreachable", () => {
  const members = allowedRpcNames();
  for (const action of DEFERRED_TABLE_ACTIONS) {
    assert.equal(members.includes(action.rpc), false, `${action.key} can reach ${action.rpc}`);
  }
});

test("dine-in ordering still reuses Takeaway's RPC, under its own guard", () => {
  // pos_submit_order was already in the allow-list for Takeaway; dine-in rounds
  // reuse it rather than adding a name. Level 2C's three additions are table
  // OPERATIONS, not a second ordering path.
  const members = allowedRpcNames();
  assert.ok(members.includes("pos_submit_order"));
  assert.equal(members.filter((m) => m.includes("submit")).length, 1, "a second submit RPC appeared");
  // And the dine-in guard that keeps that shared RPC safe is still in place.
  assert.match(read("lib", "pos", "orders.ts"), /throw new TableRequiredError\(\)/, "the dine-in submit guard was removed");
});

test("the table operations cannot be reached without going through tableOps", () => {
  // The three new RPC names must appear in exactly one module, so there is one
  // place where the reason requirement and the latch are enforced.
  const callers = ["lib/pos/tableOps.ts", "lib/pos/tables.ts", "lib/pos/orders.ts", "lib/pos/payments.ts", "lib/pos/shifts.ts"];
  for (const rpc of ["pos_move_table", "pos_close_table", "pos_clear_table"]) {
    const hits = callers.filter((f) => new RegExp(`callPosRpc\\(\\s*"${rpc}"`).test(read(...f.split("/"))));
    assert.deepEqual(hits, ["lib/pos/tableOps.ts"], `${rpc} is called from ${hits.join(", ") || "nowhere"}`);
  }
});

test("no offline queue is reachable from the dine-in round path", () => {
  const sources = [
    read("lib", "pos", "tableRounds.ts"),
    read("screens", "pos", "DineInWorkspace.tsx"),
    read("components", "pos", "DineInRoundPanel.tsx"),
  ].join("\n");
  assert.doesNotMatch(sources, /enqueue\s*\(/, "a dine-in round can be queued offline");
  assert.doesNotMatch(sources, /offline\/db|localdb/, "the dine-in round path reaches the offline database");
  // Offline is refused outright rather than deferred to a queue.
  assert.match(read("lib", "pos", "tableRounds.ts"), /OfflineOrderingError/);
});
