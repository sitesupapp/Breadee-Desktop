// Fast-track fixes: shift Order Summary, real fullscreen, receipt currency.
//
// Three narrow changes, three properties worth pinning:
//   1. The Order Summary is scoped to the ACTIVE SHIFT and can only read - its
//      one side effect (Print) goes through the existing manual preview.
//   2. Fullscreen is a real native toggle whose LABEL cannot lie: the state
//      shown is re-read from the platform, and the missing capability that made
//      the button "do nothing" on a customer PC is granted and pinned here.
//   3. A receipt's denomination comes from the TRANSACTION SNAPSHOT, never from
//      the currency the customer happened to be charged in - order 260814-0009
//      ($43.00 USD rendered as "43 LBP" on first open) is the regression model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isOpenOrder,
  loadShiftOrders,
  nextOrderIndex,
  orderLifecycleLabel,
  orderLifecycleTone,
  orderRouteLabel,
  previousOrderIndex,
  stableSelectionIndex,
  type ShiftOpenOrder,
} from "@/lib/pos/shiftOrderSummary";
import { getFullscreen, toggleFullscreen } from "@/lib/window/state";
import { buildHistoricalReceipt } from "@/lib/pos/deliveryHistory";
import type { CurrencyCode } from "@/lib/currency";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");

const summaryLib = stripComments(readSrc("lib", "pos", "shiftOrderSummary.ts"));
const panel = stripJsxComments(readSrc("components", "pos", "CurrentOrderPanel.tsx"));
const statusBar = stripJsxComments(readSrc("components", "pos", "PosStatusBar.tsx"));
const ordersStore = stripComments(readSrc("state", "shiftOrders.ts"));
const workspace = stripJsxComments(readSrc("screens", "pos", "PosWorkspace.tsx"));
const windowState = stripComments(readSrc("lib", "window", "state.ts"));
const shell = stripJsxComments(readSrc("layouts", "PosShell.tsx"));
const deliveryWs = stripJsxComments(readSrc("screens", "pos", "DeliveryWorkspace.tsx"));
const capabilities = readFileSync(join(root, "..", "src-tauri", "capabilities", "default.json"), "utf8");

const order = (over: Partial<ShiftOpenOrder> = {}): ShiftOpenOrder => ({
  id: "o1",
  order_number: "260814-0001",
  order_type: "takeaway",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  subtotal: 7,
  discount_amount: 0,
  total_amount: 7,
  currency: "USD",
  table_id: null,
  customer_id: null,
  customer_name: null,
  notes: null,
  created_at: null,
  ...over,
});

// --- Item 1: Order Summary ---------------------------------------------------

test("no active shift means an empty list and no network at all", async () => {
  // The guard returns before the supabase import - which is why this resolves
  // in Node, where no client exists to import. Nothing historical is borrowed.
  assert.deepEqual(await loadShiftOrders({ tenantId: "t1", shiftId: null }), []);
  assert.deepEqual(await loadShiftOrders({ tenantId: null, shiftId: "s1" }), []);
});

test("the query is scoped to the shift, and to NOTHING else", () => {
  // The shift id is the PRIMARY scope - a previous shift, another cashier's
  // shift and branch-wide rows have no way in, because the filter is an
  // equality on the active shift.
  assert.match(summaryLib, /\.eq\("shift_id", input\.shiftId\)/);
  assert.match(summaryLib, /\.eq\("tenant_id", input\.tenantId\)/);
});

test("the whole shift is returned, settled and voided orders included", () => {
  // REVISED: an earlier cut filtered to outstanding orders only, which made the
  // panel useless for reviewing a till at close. The lifecycle filters are gone
  // from the query on purpose.
  assert.equal(/\.eq\("status", OPEN_ORDER_STATUS\)/.test(summaryLib), false);
  assert.equal(/\.neq\("payment_status", "paid"\)/.test(summaryLib), false);
});

test("lifecycle labels come from the two stored fields, never invented", () => {
  assert.equal(orderLifecycleLabel({ status: "sent_to_kitchen", payment_status: "unpaid" }), "Open");
  assert.equal(orderLifecycleLabel({ status: "sent_to_kitchen", payment_status: "paid" }), "Paid");
  assert.equal(orderLifecycleLabel({ status: "completed", payment_status: "paid" }), "Paid");
  assert.equal(orderLifecycleLabel({ status: "voided", payment_status: "unpaid" }), "Voided");
  assert.equal(orderLifecycleLabel({ status: "cancelled", payment_status: "unpaid" }), "Cancelled");
  assert.equal(orderLifecycleLabel({ status: "refunded", payment_status: "refunded" }), "Refunded");
  // An unrecognised status falls through to itself rather than being guessed.
  assert.equal(orderLifecycleLabel({ status: "some_new_state", payment_status: "unpaid" }), "some new state");
  // Reversals read as reversals; money reads as money.
  assert.equal(orderLifecycleTone({ status: "voided", payment_status: "unpaid" }), "red");
  assert.equal(orderLifecycleTone({ status: "completed", payment_status: "paid" }), "green");
  assert.equal(orderLifecycleTone({ status: "sent_to_kitchen", payment_status: "unpaid" }), "amber");
  // "Open" is now a label, not a filter.
  assert.equal(isOpenOrder({ status: "sent_to_kitchen", payment_status: "unpaid" }), true);
  assert.equal(isOpenOrder({ status: "completed", payment_status: "paid" }), false);
});

test("the summary module can only read", () => {
  for (const write of [".insert(", ".update(", ".upsert(", ".delete(", "callPosRpc", ".rpc("]) {
    assert.equal(summaryLib.includes(write), false, `${write} must not appear in a read-only module`);
  }
});

test("all three routes are displayable and labelled in operator wording", () => {
  assert.equal(orderRouteLabel("takeaway"), "Takeaway");
  assert.equal(orderRouteLabel("dine_in"), "Dine-In");
  assert.equal(orderRouteLabel("delivery"), "Delivery");
});

test("arrows wrap in both directions and stay put on a single order", () => {
  assert.equal(nextOrderIndex(2, 3), 0, "last → next → first");
  assert.equal(previousOrderIndex(0, 3), 2, "first → previous → last");
  assert.equal(nextOrderIndex(0, 3), 1);
  assert.equal(previousOrderIndex(2, 3), 1);
  assert.equal(nextOrderIndex(0, 1), 0);
  assert.equal(previousOrderIndex(0, 1), 0);
  assert.equal(nextOrderIndex(0, 0), -1);
  assert.equal(previousOrderIndex(-1, 0), -1);
});

test("the selection survives a refresh when its order still exists", () => {
  const list = [order({ id: "a" }), order({ id: "b" }), order({ id: "c" })];
  assert.equal(stableSelectionIndex("b", 0, list), 1);
});

test("the newest order is the default selection", () => {
  // The list is oldest-first, so "most recent" is the last index. This is both
  // the first-load default and where a vanished selection lands.
  const list = [order({ id: "a" }), order({ id: "b" }), order({ id: "c" })];
  assert.equal(stableSelectionIndex(null, -1, list), 2);
});

test("a newly created order becomes the selection", () => {
  // `preferId` is the "an order was just created" signal - no reload, no route
  // switch, no manual refresh.
  const list = [order({ id: "a" }), order({ id: "b" }), order({ id: "c" })];
  assert.equal(stableSelectionIndex("a", 0, list, "c"), 2);
  // An unknown preferId falls back to the normal rules rather than losing the
  // selection - a refresh that raced the insert must not blank the panel.
  assert.equal(stableSelectionIndex("a", 0, list, "missing"), 0);
});

test("a selection that left the shift falls back safely, never a crash", () => {
  const list = [order({ id: "a" }), order({ id: "c" })];
  assert.equal(stableSelectionIndex("b", 1, list), 1, "clamped to a live index");
  assert.equal(stableSelectionIndex("b", 5, list), 1, "an out-of-range fallback clamps");
  assert.equal(stableSelectionIndex("b", 0, []), -1, "an empty list selects nothing");
});

test("the count and the carousel are the same collection", () => {
  // One store, one array: the top bar renders its length, the dropdown maps it,
  // and the panel indexes into it. There is no second query to disagree with.
  assert.match(statusBar, /Orders \{props\.shiftOrders\.length\}/);
  assert.match(workspace, /shiftOrders=\{shiftOrders\.orders\}/);
  assert.match(workspace, /count=\{shiftOrders\.orders\.length\}/);
  assert.equal((ordersStore.match(/loadShiftOrders\(/g) ?? []).length, 1);
  assert.equal(panel.includes("loadShiftOrders"), false, "the panel renders, it does not query");
});

test("a shift change drops the previous shift's orders before anything loads", () => {
  // NEW SHIFT ISOLATION: the store invalidates on a shift change *before* the
  // request, and discards a response that arrived after the shift moved on -
  // so the next cashier never reviews the previous cashier's till.
  assert.match(ordersStore, /if \(get\(\)\.shiftId !== shiftId\) \{\s*set\(\{ orders: \[\], index: -1, shiftId, error: null \}\)/);
  assert.match(ordersStore, /if \(get\(\)\.shiftId !== shiftId\) return;/);
});

test("clicking a shift order selects exactly that order", () => {
  assert.match(ordersStore, /select: \(orderId\) => \{/);
  assert.match(ordersStore, /const found = get\(\)\.orders\.findIndex\(\(o\) => o\.id === orderId\)/);
  assert.match(ordersStore, /if \(found >= 0\) set\(\{ index: found \}\)/);
  // The dropdown selects and closes; it does not navigate.
  assert.match(statusBar, /props\.onSelectOrder\(o\.id\);\s*setOrdersOpen\(false\);/);
  assert.equal(statusBar.includes("navigate"), false, "selecting must not leave POS");
});

test("the refresh is event-driven, not polled", () => {
  // Wired to the call sites that already exist for submission and settlement.
  assert.match(workspace, /refreshShiftOrders\(input\.orderId\)/, "a submitted batch refreshes and selects");
  const present = workspace.slice(workspace.indexOf("const presentReceipt"), workspace.indexOf("const [cartDrawerOpen"));
  assert.match(present, /refreshShiftOrders\(\)/, "a settlement refreshes");
  for (const poll of ["setInterval", "setTimeout"]) {
    assert.equal(ordersStore.includes(poll), false, `${poll} must not drive the shift order list`);
  }
});

test("the order shows in the right-hand panel, not behind a dropdown", () => {
  // REVISED UX: the "Open orders N" pill over the work area is gone; the order
  // renders directly in the panel the cashier already looks at. The live cart
  // still wins whenever there are lines, so taking an order is unchanged.
  assert.equal(workspace.includes("OrderSummaryPanel"), false, "the old pill must be gone");
  assert.match(workspace, /cart\.lines\.length > 0 \? \(\s*<CartPanel/);
  assert.match(workspace, /<CurrentOrderPanel/);
  assert.match(panel, /onStep\(-1\)/);
  assert.match(panel, /onStep\(1\)/);
});

test("Print presents the manual preview and can never auto-print", () => {
  // The workspace hands the panel receiptStore.present - the store-owned MANUAL
  // layer - and not presentReceipt, whose whole job is the automatic attempt.
  assert.match(workspace, /onPresentReceipt=\{\(receipt\) => receiptStore\.present\(receipt\)\}/);
  const panelBlock = workspace.slice(workspace.indexOf("<CurrentOrderPanel"), workspace.indexOf("/>", workspace.indexOf("<CurrentOrderPanel")));
  assert.equal(panelBlock.includes("presentReceipt"), false, "the auto-print wrapper must not be reachable from the panel");
  for (const token of ["autoPrintReceipt", "autoPrintKitchenTicket", "printReceipt(", "printKitchenTicket("]) {
    assert.equal(panel.includes(token), false, `${token} must not appear in the panel`);
  }
});

test("printing an open order fabricates nothing", () => {
  // Unpaid stays unpaid: paid comes from the stored payment_status, the method
  // is null, and no tendered/change key exists anywhere in the build.
  assert.match(panel, /paid: order\.payment_status === "paid"/);
  assert.match(panel, /method: null/);
  for (const invented of ["tendered:", "change:", "tenderCurrency:", "tenderTotal:"]) {
    assert.equal(panel.includes(invented), false, `${invented} must not be invented for an open order`);
  }
  // And the denomination is the order's own snapshot - the same source-of-truth
  // rule the delivery receipt fix establishes, never a display currency.
  assert.match(panel, /const currency = \(order\?\.currency \?\? props\.fallbackCurrency\)/);
  // NB the line-ending class. `\n` alone does not match this repo's CRLF files
  // once CI has checked them out with autocrlf - the same trap documented in
  // `source-helpers.ts`. Anchored on `[\r\n]` so the assertion means the same
  // thing on both sides.
  assert.match(panel, /buildReceipt\(\{[\s\S]*?[\r\n]\s*currency,[\r\n]/);
});

test("the panel mutates nothing anywhere", () => {
  for (const token of ["callPosRpc", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete(", "pos_pay_order", "pos_submit_order", "useCart", "refreshCashBox"]) {
    assert.equal(panel.includes(token), false, `${token} must not appear on a read-only surface`);
  }
  // The store is read-only too: it loads and selects, and that is all.
  for (const token of ["callPosRpc", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete("]) {
    assert.equal(ordersStore.includes(token), false, `${token} must not appear in the store`);
  }
});

// --- Item 3: drawer privacy --------------------------------------------------

test("the closed top bar never renders the drawer amount", () => {
  // THE WHOLE POINT. The bar used to carry "Drawer {formatMoney(...)}" all day,
  // which put the till's cash in front of anyone standing behind the cashier.
  // The trigger is now the bare word, and the figure exists only inside the
  // popover body - not in the label, not in a badge, not in a title tooltip.
  assert.equal(/Drawer \{formatMoney/.test(statusBar), false, "no amount in the label");
  assert.equal(/title=\{?"?[^"]*formatMoney/.test(statusBar), false, "no amount in a tooltip");
  const trigger = statusBar.slice(statusBar.indexOf('label="Drawer"'), statusBar.indexOf("Current drawer"));
  assert.equal(trigger.includes("formatMoney"), false, "the trigger must not compute an amount");
  assert.match(trigger, />\s*Drawer\s*<\/Button>/, "the trigger is the bare word");
});

test("the amount lives only inside the opened popover", () => {
  const body = statusBar.slice(statusBar.indexOf("Current drawer"));
  assert.match(body, /formatMoney\(props\.cashBox\.expected_cash, props\.currency\)/);
  // Rendered under `props.open`, so closing removes it from the DOM entirely
  // rather than hiding it behind a style.
  const popover = stripJsxComments(readSrc("components", "pos", "TopBarPopover.tsx"));
  assert.match(popover, /\{props\.open && \(/);
  assert.equal(/hidden|opacity-0|invisible/.test(popover), false, "closed must mean absent, not merely unseen");
});

test("the drawer control toggles, closes on outside click and on Escape", () => {
  assert.match(statusBar, /onClick=\{\(\) => setDrawerOpen\(\(o\) => !o\)\}/);
  const popover = stripComments(readSrc("components", "pos", "TopBarPopover.tsx"));
  assert.match(popover, /if \(wrapRef\.current && !wrapRef\.current\.contains\(e\.target as Node\)\) props\.onOpenChange\(false\)/);
  assert.match(popover, /if \(e\.key === "Escape"\) props\.onOpenChange\(false\)/);
  // Not a full-screen modal, and it never navigates away.
  assert.equal(popover.includes("Modal"), false);
  assert.equal(popover.includes("navigate"), false);
});

test("the drawer figure is the existing authoritative value, unchanged", () => {
  // Same `cashBox.expected_cash` the old permanent label used - this revision
  // moved it, it did not recompute it. No new financial logic anywhere.
  assert.match(statusBar, /props\.cashBox\.expected_cash/);
  assert.equal(/expected_cash\s*[+\-*/]/.test(statusBar), false, "the amount must not be recomputed");
  assert.equal(statusBar.includes("convertCurrency"), false);
});

test("viewing the drawer mutates nothing", () => {
  for (const token of ["callPosRpc", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete(", "pos_end_shift", "pos_open_shift", "refreshCashBox", "cashIn", "cashOut"]) {
    assert.equal(statusBar.includes(token), false, `${token} must not be reachable from the status bar`);
  }
});

// --- Item 2: fullscreen ------------------------------------------------------

test("the capability now grants exactly the two fullscreen permissions", () => {
  // THE ROOT CAUSE, pinned. `core:default` excludes window setters, so
  // setFullscreen was silently denied in the packaged build and the button
  // "did nothing". The grant is the fix; everything dangerous stays out.
  const parsed = JSON.parse(capabilities) as { permissions: string[] };
  assert.ok(parsed.permissions.includes("core:default"));
  assert.ok(parsed.permissions.includes("opener:default"));
  const windowPerms = parsed.permissions.filter((p) => p.includes("window"));
  assert.deepEqual(windowPerms.sort(), ["core:window:allow-is-fullscreen", "core:window:allow-set-fullscreen"]);
  for (const forbidden of ["shell", "fs:", "http", "process", "dialog", "path:"]) {
    assert.equal(parsed.permissions.some((p) => p.includes(forbidden)), false, `${forbidden} must not be granted`);
  }
});

test("the toggle reports the state the window is ACTUALLY in", () => {
  // The return value is re-read from the platform after the set, so a denied
  // call leaves the label truthful instead of flipping a fiction.
  assert.match(windowState, /await win\.setFullscreen\(next\);\s*return await win\.isFullscreen\(\)/);
  assert.match(windowState, /export async function getFullscreen/);
});

test("outside Tauri the toggle degrades without crashing and without lying", async () => {
  // Node has neither Tauri nor a document: both paths land in a catch and
  // resolve rather than reject.
  assert.equal(await toggleFullscreen(), false);
  assert.equal(await getFullscreen(), false);
});

test("the shell label follows the native state it is handed", () => {
  assert.match(shell, /isFullscreen\?: boolean/);
  assert.match(shell, /props\.isFullscreen \? "Exit Full Screen" : "Full Screen"/);
});

test("both fullscreen surfaces go through one handler that refreshes the label", () => {
  assert.match(workspace, /const doToggleFullscreen = useCallback\(\(\) => \{\s*void toggleFullscreen\(\)\.then\(setFullscreen\);/);
  assert.match(workspace, /fullscreen: doToggleFullscreen/);
  assert.match(workspace, /onToggleFullscreen=\{doToggleFullscreen\}/);
  assert.match(workspace, /isFullscreen=\{fullscreen\}/);
  // Toggling is a pure window call: nothing on this path touches POS state.
  const handler = workspace.slice(workspace.indexOf("const doToggleFullscreen"), workspace.indexOf("}, []);", workspace.indexOf("const doToggleFullscreen")));
  for (const token of ["cart", "shift", "order", "print"]) {
    assert.equal(handler.toLowerCase().includes(token), false, `fullscreen must not touch ${token}`);
  }
});

// --- Item 3: receipt currency ------------------------------------------------

const queueOrder = (over: Record<string, unknown> = {}) =>
  ({
    id: "ord-9",
    order_number: "260814-0009",
    status: "completed",
    payment_status: "paid",
    total_amount: 43,
    currency: "USD",
    customer_id: null,
    address_id: null,
    notes: null,
    created_at: null,
    subtotal: 43,
    discount_amount: 0,
    payment_method: "cash",
    shift_id: null,
    ...over,
  }) as Parameters<typeof buildHistoricalReceipt>[0]["order"];

const historicalInput = (over: Partial<Parameters<typeof buildHistoricalReceipt>[0]> = {}) => ({
  tenantName: "Dominos Pizza",
  branchName: "Main Branch",
  staffName: "Cashier",
  order: queueOrder(),
  payment: null,
  lines: [],
  party: { customerName: null, customerPhone: null, addressText: null },
  fallbackCurrency: "USD" as CurrencyCode,
  at: "now",
  ...over,
});

test("a USD order stays USD even when it was charged in LBP", () => {
  // The 260814-0009 shape: $43.00 order, payment recorded in LBP. The receipt's
  // denomination is the ORDER's snapshot; the LBP charge is separate.
  const r = buildHistoricalReceipt(
    historicalInput({
      payment: { method: "cash", currency: "LBP" as CurrencyCode, originalAmount: 3_848_500, exchangeRate: 89_500 } as never,
    }),
  );
  assert.equal(r.currency, "USD");
  assert.equal(r.total, 43);
  assert.equal(r.tenderCurrency, "LBP");
  assert.equal(r.tenderTotal, 3_848_500);
});

test("an LBP order genuinely renders as LBP", () => {
  const r = buildHistoricalReceipt(historicalInput({ order: queueOrder({ currency: "LBP", total_amount: 895_000, subtotal: 895_000 }) }));
  assert.equal(r.currency, "LBP");
  assert.equal(r.total, 895_000);
});

test("first open and reopen are financially identical", () => {
  // Same inputs, two builds - byte-equal receipts. There is no state for a
  // second open to correct, which is the whole invariant.
  const input = historicalInput({
    payment: { method: "cash", currency: "LBP" as CurrencyCode, originalAmount: 3_848_500, exchangeRate: 89_500 } as never,
  });
  assert.deepEqual(buildHistoricalReceipt(input), buildHistoricalReceipt(input));
});

test("today's exchange rate cannot reach a historical receipt", () => {
  // The rate on the receipt is the stored payment snapshot; the builder has no
  // other rate input to consult, so changing today's tenant rate changes
  // nothing here.
  const r = buildHistoricalReceipt(
    historicalInput({
      payment: { method: "cash", currency: "LBP" as CurrencyCode, originalAmount: 3_848_500, exchangeRate: 89_500 } as never,
    }),
  );
  assert.equal(r.exchangeRate, 89_500);
  const src = stripComments(readSrc("lib", "pos", "deliveryHistory.ts"));
  const builder = src.slice(src.indexOf("export function buildHistoricalReceipt"));
  assert.equal(builder.includes("session"), false, "no live session value may enter a historical receipt");
});

test("the settlement receipt build reads the order snapshot, not the charge currency", () => {
  // THE FIX ITSELF. `money.currency_code` is what the customer was charged in;
  // labelling the order's figures with it produced "43 LBP" on first open.
  const build = deliveryWs.slice(deliveryWs.indexOf("const money = outcome.result"), deliveryWs.indexOf("if (fromQueue)"));
  assert.match(build, /currency: \(settled!\.currency \?\? input\.currency\)/);
  assert.equal(/currency: \(money\?\.currency_code/.test(build), false, "the charge currency must not denominate the receipt");
  // The charge currency lands where it belongs: the tender fields.
  assert.match(build, /tenderCurrency: \(money\?\.currency_code \?\? confirm\.currency\)/);
});
