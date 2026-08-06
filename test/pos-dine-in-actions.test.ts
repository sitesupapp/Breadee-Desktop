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
const FORBIDDEN_RPCS = ["pos_move_table", "pos_close_table", "pos_clear_table", "pos_pay_table"];

/** Every action the brief requires to stay non-functional. */
const MUST_BE_DISABLED: DeferredTableActionKey[] = ["addItems", "submitRound", "move", "close", "clear", "pay"];

// --- Layer 1: the pure decision ---------------------------------------------

test("the deferred list covers every action Level 2A must not perform", () => {
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
    assert.match(reason, /Level 2[BCD]\.$/, `${action.key} does not name its level: ${reason}`);
    assert.doesNotMatch(reason, /permission/i);
  }
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

test("dine-in mode renders the read-only bill, never the cart panel that can submit or pay", () => {
  const source = read("screens", "pos", "PosWorkspace.tsx");
  const cartProp = source.indexOf("cart={(layout) =>");
  const dineInBill = source.indexOf("dineIn.bill(layout)");
  const cartPanel = source.indexOf("<CartPanel");
  assert.ok(cartProp >= 0 && dineInBill >= 0 && cartPanel >= 0, "the cart prop structure changed");
  assert.ok(dineInBill > cartProp, "the dine-in bill is not inside the cart prop");
  assert.ok(
    dineInBill < cartPanel,
    "CartPanel is reached before the dine-in branch - Send to kitchen and Pay would render on a table",
  );
});

test("dine-in mode renders the table map, never the menu grid that adds items", () => {
  const source = read("screens", "pos", "PosWorkspace.tsx");
  const workProp = source.indexOf("work={(layout) =>");
  const dineInWork = source.indexOf("dineIn.work(layout)");
  const menuGrid = source.indexOf("<MenuItemGrid");
  assert.ok(dineInWork > workProp, "the table map is not inside the work prop");
  assert.ok(menuGrid > dineInWork, "the menu grid is reached before the dine-in branch");
});

test("the deferred buttons carry no click handler at all", () => {
  const source = read("components", "pos", "TableBillPanel.tsx");
  const start = source.indexOf("DEFERRED_TABLE_ACTIONS.map(");
  assert.ok(start > 0, "the deferred action block could not be located");
  const block = source.slice(start, source.indexOf("</div>", start));
  assert.match(block, /\bdisabled\b/, "the deferred buttons are no longer disabled");
  assert.doesNotMatch(block, /onClick/, "a deferred action was given a click handler");
});

test("the reserved dine-in shortcuts have no handler anywhere in the app", () => {
  // A registered id fires; an unregistered one does nothing. These must stay
  // unregistered, or Ctrl+Shift+C would reach a half-built close-table path.
  const sources = [
    read("screens", "pos", "DineInWorkspace.tsx"),
    read("screens", "pos", "PosWorkspace.tsx"),
    read("components", "pos", "TableBillPanel.tsx"),
    read("components", "pos", "TableMap.tsx"),
  ].join("\n");
  for (const id of ["addItems", "moveTable", "closeTable", "clearTable"]) {
    assert.doesNotMatch(sources, new RegExp(`\\b${id}\\s*:\\s*\\(`), `${id} has a shortcut handler registered`);
  }
});

test("the dine-in workspace calls no mutating table RPC", () => {
  const sources = [
    read("screens", "pos", "DineInWorkspace.tsx"),
    read("components", "pos", "TableBillPanel.tsx"),
    read("lib", "pos", "tables.ts"),
    read("lib", "pos", "tableBill.ts"),
    read("state", "tables.ts"),
    read("lib", "pos", "dineInActions.ts"),
  ].join("\n");
  for (const rpc of FORBIDDEN_RPCS) {
    // The names may be MENTIONED in a comment; what must not exist is a call.
    assert.doesNotMatch(sources, new RegExp(`callPosRpc\\(\\s*"${rpc}"`), `${rpc} is called from the dine-in path`);
  }
});

// --- Layer 3: reachability ---------------------------------------------------

test("the mutating table RPCs are not in PosRpcName, so callPosRpc cannot accept them", () => {
  const members = allowedRpcNames();

  for (const rpc of FORBIDDEN_RPCS) {
    assert.equal(members.includes(rpc), false, `${rpc} became callable`);
  }
  // Positive control: the two table RPCs Level 2A DOES use are present, so this
  // test cannot pass merely because the parse found nothing.
  assert.ok(members.includes("pos_table_map"));
  assert.ok(members.includes("pos_open_table"));
  assert.equal(members.length, 8, `the RPC allow-list changed size: ${members.join(", ")}`);
});

test("every deferred action's future RPC is either unreachable or gated elsewhere", () => {
  const members = allowedRpcNames();

  for (const action of DEFERRED_TABLE_ACTIONS) {
    if (action.rpc === "pos_submit_order") {
      // Reachable by design - Takeaway needs it. Dine-in is blocked one layer up:
      // a dine_in payload cannot be built without a table (TableRequiredError),
      // and dine-in mode never renders the control that submits.
      const orders = read("lib", "pos", "orders.ts");
      assert.match(orders, /throw new TableRequiredError\(\)/, "the dine-in submit guard was removed");
      continue;
    }
    assert.equal(members.includes(action.rpc), false, `${action.key} can reach ${action.rpc}`);
  }
});
