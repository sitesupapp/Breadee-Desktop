// Dine-In table operations (Level 2C): Move, Close, Clear.
//
// These are the first dine-in actions that destroy or move money, so the tests
// are written against the SERVER definitions read from staging, not against what
// the UI happens to do:
//
//   pos_move_table   refuses same table / different tenants / occupied
//                    destination / a source with no open order.
//   pos_close_table  REFUSES while any unpaid order exists, and only completes
//                    already-paid ones.
//   pos_clear_table  VOIDS every open unpaid order and appends the reason.
//
// The single most important case in this file is the last one: `pos_pay_table`
// must still be unreachable. Level 2C adds three RPC names and must not add a
// fourth by accident, because the fourth one takes money.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CLEAR_REASON_SUGGESTIONS,
  MIN_CLEAR_REASON_LENGTH,
  clearConsequence,
  clearOutcomeMessage,
  closeOutcomeMessage,
  closeOutlook,
  moveDestinations,
  moveOutcomeMessage,
  tableOpGate,
  validateClearReason,
} from "@/lib/pos/tableOps";
import { canClearTable, canCloseTable, canMoveTable, type PosAccessContext } from "@/lib/pos/access";
import { classifyError } from "@/lib/pos/errors";
import { FEATURES } from "@/lib/features";
import type { TableSummary } from "@/types/tables";
import { stripJsxComments } from "./source-helpers.ts";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const table = (over: Partial<TableSummary> = {}): TableSummary => ({
  id: "t1",
  name: "Table 5",
  seats: 4,
  occupied: true,
  status: "occupied",
  canonical: true,
  configured: true,
  sort_order: 5,
  orders: 1,
  order_number: "A-14",
  opened_at: null,
  total: 42,
  currency: "USD",
  mixed_currency: false,
  ...over,
});

const free = (over: Partial<TableSummary> = {}): TableSummary =>
  table({ occupied: false, status: "available", orders: 0, order_number: null, total: null, ...over });

const ALLOWED = { allowed: true, reason: null } as const;

const ALL_FEATURES = {
  [FEATURES.POS]: true,
  [FEATURES.POS_DINE_IN]: true,
  [FEATURES.POS_SHIFTS]: true,
};

const ALL_PERMS = {
  "pos.access": true,
  "pos.tables.view": true,
  "pos.tables.move": true,
  "pos.tables.close": true,
  "pos.tables.clear": true,
};

const ctx = (over: Partial<PosAccessContext> = {}): PosAccessContext => ({
  membership: { role: "cashier", status: "active" },
  permissions: { ...ALL_PERMS },
  features: { ...ALL_FEATURES },
  ...over,
});

// --- permissions -------------------------------------------------------------

test("each operation is gated by its own permission key, from the map", () => {
  assert.equal(canMoveTable(ctx()).allowed, true);
  assert.equal(canCloseTable(ctx()).allowed, true);
  assert.equal(canClearTable(ctx()).allowed, true);

  const noMove = canMoveTable(ctx({ permissions: { ...ALL_PERMS, "pos.tables.move": false } }));
  assert.equal(noMove.allowed, false);
  assert.match(noMove.reason ?? "", /permission to move tables/);

  const noClear = canClearTable(ctx({ permissions: { ...ALL_PERMS, "pos.tables.clear": false } }));
  assert.equal(noClear.allowed, false);
  assert.match(noClear.reason ?? "", /permission to clear tables/);
});

test("one table permission does not grant another", () => {
  const onlyMove = ctx({ permissions: { ...ALL_PERMS, "pos.tables.clear": false, "pos.tables.close": false } });
  assert.equal(canMoveTable(onlyMove).allowed, true);
  assert.equal(canCloseTable(onlyMove).allowed, false);
  assert.equal(canClearTable(onlyMove).allowed, false);
});

test("an owner cannot move, close or clear - the same exclusion as everywhere else", () => {
  const owner = ctx({ membership: { role: "owner", status: "active" } });
  for (const gate of [canMoveTable(owner), canCloseTable(owner), canClearTable(owner)]) {
    assert.equal(gate.allowed, false);
    assert.match(gate.reason ?? "", /Owners cannot perform POS operations/);
  }
});

test("losing table view closes every operation with it", () => {
  const noView = ctx({ permissions: { ...ALL_PERMS, "pos.tables.view": false } });
  assert.equal(canMoveTable(noView).allowed, false);
  assert.equal(canCloseTable(noView).allowed, false);
  assert.equal(canClearTable(noView).allowed, false);
});

test("table permissions fail closed on an empty permission map", () => {
  const none = ctx({ permissions: {} });
  assert.equal(canMoveTable(none).allowed, false);
  assert.equal(canCloseTable(none).allowed, false);
  assert.equal(canClearTable(none).allowed, false);
});

// --- desktop preconditions ---------------------------------------------------

test("DESKTOP POLICY: every table operation requires an open shift", () => {
  for (const kind of ["move", "close", "clear"] as const) {
    const gate = tableOpGate({ kind, permitted: ALLOWED, table: table(), hasOpenShift: false, online: true });
    assert.equal(gate.allowed, false, `${kind} was allowed with no shift`);
    assert.match(gate.reason ?? "", new RegExp(`Open a shift before you ${kind} a table`));
  }
});

test("table operations are refused offline - they all mutate server state", () => {
  const gate = tableOpGate({ kind: "clear", permitted: ALLOWED, table: table(), hasOpenShift: true, online: false });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /need a connection/);
});

test("Move and Clear need a bill to act on; Close does not", () => {
  const empty = free();
  assert.equal(
    tableOpGate({ kind: "move", permitted: ALLOWED, table: empty, hasOpenShift: true, online: true }).allowed,
    false,
  );
  assert.equal(
    tableOpGate({ kind: "clear", permitted: ALLOWED, table: empty, hasOpenShift: true, online: true }).allowed,
    false,
  );
  // Close is the path for a table whose bill was settled elsewhere, so an
  // apparently empty table is exactly when it is useful.
  assert.equal(
    tableOpGate({ kind: "close", permitted: ALLOWED, table: empty, hasOpenShift: true, online: true }).allowed,
    true,
  );
});

test("no table selected refuses before anything else is considered", () => {
  const gate = tableOpGate({ kind: "move", permitted: ALLOWED, table: null, hasOpenShift: true, online: true });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /Select a table first/);
});

test("the permission refusal outranks the desktop preconditions", () => {
  const denied = { allowed: false, reason: "You do not have permission to clear tables." };
  const gate = tableOpGate({ kind: "clear", permitted: denied, table: null, hasOpenShift: false, online: false });
  assert.deepEqual(gate, denied, "a missing permission must not be reported as a missing shift");
});

// --- Clear: the reason is mandatory -----------------------------------------

test("a clear reason is required - the server accepts an empty one, the desktop does not", () => {
  assert.match(validateClearReason("").error ?? "", /Enter why/);
  assert.match(validateClearReason("   ").error ?? "", /Enter why/);
  assert.match(validateClearReason("x").error ?? "", /at least/);
});

test("a valid reason is trimmed, never stored with its padding", () => {
  const v = validateClearReason("  Walked out without paying  ");
  assert.equal(v.error, null);
  assert.equal(v.reason, "Walked out without paying");
});

test("every suggested reason passes the desktop's own validation", () => {
  for (const s of CLEAR_REASON_SUGGESTIONS) {
    assert.equal(validateClearReason(s).error, null, `suggestion rejected: ${s}`);
    assert.ok(s.trim().length >= MIN_CLEAR_REASON_LENGTH);
  }
});

test("clearTable refuses a blank reason before any request is made", async () => {
  const { clearTable } = await import("@/lib/pos/tableOps");
  await assert.rejects(() => clearTable({ tableId: "t1", reason: "   " }), /reason is required/i);
});

test("the clear confirmation names the consequence in the server's terms", () => {
  const text = clearConsequence(table({ orders: 1 }));
  assert.match(text, /VOIDS/);
  assert.match(text, /not collected/i);
  assert.match(text, /cannot be undone/i);
  // An empty table is a different, milder statement - it must not cry wolf.
  assert.doesNotMatch(clearConsequence(free()), /VOIDS/);
});

// --- Move --------------------------------------------------------------------

test("only free tables are offered as move destinations", () => {
  const source = table({ id: "a" });
  const tables = [source, free({ id: "b" }), table({ id: "c" }), free({ id: "d", status: "reserved" })];
  const options = moveDestinations(tables, source);
  assert.deepEqual(options.map((t) => t.id), ["b"], "an occupied or reserved table must not be offered");
});

test("the source table is never offered as its own destination", () => {
  const source = free({ id: "a" });
  assert.equal(moveDestinations([source], source).length, 0);
  assert.equal(moveDestinations([source], null).length, 0);
});

test("moveTable refuses the same table locally, before the server has to", async () => {
  const { moveTable } = await import("@/lib/pos/tableOps");
  await assert.rejects(() => moveTable({ fromTableId: "t1", toTableId: "t1" }), /different destination/i);
});

// --- Close -------------------------------------------------------------------

test("Close says it will be refused BEFORE it is pressed on an unpaid bill", () => {
  const outlook = closeOutlook(table({ orders: 1 }));
  assert.equal(outlook.willRefuse, true);
  assert.match(outlook.explanation, /unpaid/i);
  assert.match(outlook.explanation, /clear the table/i);
});

test("Close on a settled table explains what it will actually do", () => {
  const outlook = closeOutlook(free());
  assert.equal(outlook.willRefuse, false);
  assert.match(outlook.explanation, /complete/i);
});

// --- outcome wording ---------------------------------------------------------

test("outcome messages report the server's counts, not an assumption", () => {
  assert.match(moveOutcomeMessage({ ok: true, orders_moved: 1 }, "Table 5", "Table 9"), /Table 5 moved to Table 9/);
  assert.match(moveOutcomeMessage({ ok: true, orders_moved: 3 }, "Table 5", "Table 9"), /3 orders/);
  assert.match(closeOutcomeMessage({ ok: true, orders_completed: 2 }, "Table 5"), /2 orders completed/);
  assert.match(closeOutcomeMessage({ ok: true, orders_completed: 0 }, "Table 5"), /now available/);
  assert.match(clearOutcomeMessage({ ok: true, orders_voided: 1 }, "Table 5"), /1 order voided/);
  assert.match(clearOutcomeMessage({ ok: true, orders_voided: 0 }, "Table 5"), /now available/);
});

// --- server refusals ---------------------------------------------------------

test("the server's own refusals are classified with a usable next step", () => {
  const close = classifyError(new Error("Pay the table bill first, or clear the table"));
  assert.equal(close.kind, "close_needs_payment");
  assert.match(close.hint ?? "", /clear the table with a reason/i);
  // It must admit that paying from the desktop is not possible yet.
  assert.match(close.hint ?? "", /Level 2D/);

  assert.equal(classifyError(new Error("Choose a different destination table")).kind, "same_table");
  assert.equal(classifyError(new Error("Tables belong to different tenants")).kind, "cross_tenant_table");
  assert.equal(classifyError(new Error("The destination table already has an open order")).kind, "table_occupied");
  assert.equal(classifyError(new Error("That table has no open order to move")).kind, "table_no_open_order");
  assert.equal(classifyError(new Error("Table not found")).kind, "table_not_found");
});

test("every table-operation refusal is an expected refusal, not a fault", () => {
  for (const message of [
    "Pay the table bill first, or clear the table",
    "Choose a different destination table",
    "Tables belong to different tenants",
    "The destination table already has an open order",
    "That table has no open order to move",
  ]) {
    assert.equal(classifyError(new Error(message)).expected, true, message);
  }
});

// --- reachability ------------------------------------------------------------

// RETARGETED IN LEVEL 2D. This assertion used to read `length === 11` and
// `pos_pay_table` absent, which was correct for exactly as long as settlement was
// not implemented. It was left failing until Pay was genuinely wired rather than
// being relaxed in advance - a size assertion that is loosened before the feature
// lands stops being a guard and becomes a comment.
test("the operation RPCs are callable, and settlement joined them exactly once", () => {
  const source = read("lib", "pos", "rpc.ts").replace(/\/\/.*$/gm, "");
  const decl = /export type PosRpcName\s*=([\s\S]*?);/.exec(source);
  assert.ok(decl, "the PosRpcName union could not be located");
  const members = Array.from(decl[1].matchAll(/"([a-z_]+)"/g)).map((m) => m[1]);

  for (const rpc of ["pos_move_table", "pos_close_table", "pos_clear_table"]) {
    assert.ok(members.includes(rpc), `${rpc} should be callable in Level 2C`);
  }
  // The one that takes money. Present now, and present ONCE.
  assert.equal(members.filter((m) => m === "pos_pay_table").length, 1, "pos_pay_table is not listed exactly once");
  assert.equal(new Set(members).size, members.length, "an RPC name is declared twice");
  // RETARGETED AGAIN IN LEVEL 3A: 12 -> 13, for `pos_upsert_customer`, and
  // AGAIN IN LEVEL 3D: 13 -> 15, for the two order-management RPCs. Same
  // discipline as the 11 -> 12 bump above.
  assert.equal(members.length, 15, `the RPC allow-list changed size: ${members.join(", ")}`);
});

test("no table action is deferred any more - Pay was the last one", async () => {
  const { DEFERRED_TABLE_ACTIONS, isTableActionEnabled } = await import("@/lib/pos/dineInActions");
  assert.deepEqual(DEFERRED_TABLE_ACTIONS.map((a) => a.key), []);
  // The predicate survives as the seam for the next deferred action, and still
  // refuses unconditionally.
  assert.equal(isTableActionEnabled(undefined as never), false);
});

test("the bottom-bar pay slot follows the shared gate, and takes no boolean", async () => {
  const { dineInBottomBar } = await import("@/lib/pos/dineInActions");
  const summary = { itemCount: 3, subtotal: 42 };

  const refused = dineInBottomBar({ summary, payGate: { allowed: false, reason: "Open a shift before taking payment." } });
  assert.equal(refused.payDisabled, true);
  assert.equal(refused.payReason, "Open a shift before taking payment.");

  const allowed = dineInBottomBar({ summary, payGate: { allowed: true, reason: null } });
  assert.equal(allowed.payDisabled, false);
  assert.equal(allowed.payReason, null);
  assert.equal(allowed.payLabel, "Pay");
});

// --- wiring ------------------------------------------------------------------

test("a shortcut opens a confirmation - it never performs the operation", () => {
  const source = read("screens", "pos", "DineInWorkspace.tsx");
  for (const id of ["moveTable", "closeTable", "clearTable"]) {
    const line = new RegExp(`${id}: \\(\\) =>[^\\n]*requestOp\\(`);
    assert.match(source, line, `${id} does not route through requestOp`);
  }
  // The chord must not reach the operation directly.
  assert.doesNotMatch(source, /clearTable: \(\) =>[^\n]*clearTable\(\{/);
  assert.doesNotMatch(source, /moveTable: \(\) =>[^\n]*moveTable\(\{/);
});

test("Clear is visually separated from the routine operations", () => {
  const source = read("components", "pos", "TableBillPanel.tsx");
  const clearIdx = source.indexOf('gate={props.clearGate}');
  const moveIdx = source.indexOf('gate={props.moveGate}');
  assert.ok(moveIdx > 0 && clearIdx > moveIdx, "Clear should render after Move");
  const between = source.slice(moveIdx, clearIdx);
  assert.match(between, /border-t border-dashed/, "Clear is not separated from the routine actions");
  assert.match(source.slice(clearIdx, clearIdx + 200), /variant="danger"/, "Clear is not styled as destructive");
});

test("the destructive chord is not the Chromium DevTools inspector", async () => {
  const { SHORTCUTS } = await import("@/lib/keyboard/shortcuts");
  const close = SHORTCUTS.find((s) => s.id === "closeTable");
  assert.ok(close);
  // Ctrl+Shift+C opens the DevTools inspector in the Tauri webview, so a handler
  // bound to it would be eaten before the app ever saw it.
  const isDevToolsChord = close.ctrl === true && close.shift === true && close.keys.some((k) => k.toLowerCase() === "c");
  assert.equal(isDevToolsChord, false, "Close reclaimed the DevTools inspector chord");
  assert.equal(close.display, "Alt+C");
});

test("no dine-in shortcut is reserved any more - every declared id has a handler", async () => {
  const { RESERVED_SHORTCUTS } = await import("@/lib/keyboard/shortcuts");
  assert.deepEqual(RESERVED_SHORTCUTS, []);
});

test("no dine-in surface still claims move, close or clear is unavailable", () => {
  // Staging verification, 2026-08-07: the round panel still read "Move, close,
  // clear and payment for dine-in are not enabled yet" after Level 2C shipped
  // three of those four. There are two panels with this footer and only one was
  // updated. The UI must never tell an operator that a control they can see and
  // press does not exist.
  for (const file of [
    ["components", "pos", "DineInRoundPanel.tsx"],
    ["components", "pos", "TableBillPanel.tsx"],
  ]) {
    // Comments are stripped: this asserts what the panel RENDERS, not what it
    // says about itself. Level 2D's note recording that the old "not enabled
    // yet" line was removed contains the words "removed" and "not enabled yet"
    // on one line, which the pattern below matched - a false positive against a
    // file that had just been fixed.
    const source = stripJsxComments(read(...file));
    assert.doesNotMatch(
      source,
      /(move|close|clear)[^.\n]*not enabled yet/i,
      `${file.join("/")} still describes a shipped Level 2C action as unavailable`,
    );
  }
});
