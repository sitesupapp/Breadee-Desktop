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
  loadShiftOpenOrders,
  nextOrderIndex,
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
const panel = stripJsxComments(readSrc("components", "pos", "OrderSummaryPanel.tsx"));
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
  // in Node, where no client exists to import.
  assert.deepEqual(await loadShiftOpenOrders({ tenantId: "t1", shiftId: null }), []);
  assert.deepEqual(await loadShiftOpenOrders({ tenantId: null, shiftId: "s1" }), []);
});

test("the query is scoped to the shift, and to open unsettled orders only", () => {
  // The shift id is the PRIMARY scope - branch-wide or historical rows have no
  // way in, because the filter is an equality on the active shift.
  assert.match(summaryLib, /\.eq\("shift_id", input\.shiftId\)/);
  assert.match(summaryLib, /\.eq\("tenant_id", input\.tenantId\)/);
  assert.match(summaryLib, /\.eq\("status", OPEN_ORDER_STATUS\)/);
  assert.match(summaryLib, /\.neq\("payment_status", "paid"\)/);
  assert.match(summaryLib, /OPEN_ORDER_STATUS = "sent_to_kitchen"/);
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

test("a selection that was settled elsewhere falls to the nearest order, never a crash", () => {
  const list = [order({ id: "a" }), order({ id: "c" })];
  assert.equal(stableSelectionIndex("b", 1, list), 1, "clamped to a live index");
  assert.equal(stableSelectionIndex("b", 5, list), 1, "an out-of-range fallback clamps");
  assert.equal(stableSelectionIndex("b", 0, []), -1, "an empty list selects nothing");
  assert.equal(stableSelectionIndex(null, -1, list), 0, "no prior selection starts at the first");
});

test("the count and the carousel are the same collection", () => {
  // One `orders` array: the pill renders its length and the arrows index into
  // it. There is no second query for the count to disagree with.
  assert.match(panel, /Open orders \{count\}/);
  assert.match(panel, /const count = orders\.length/);
  assert.equal((panel.match(/loadShiftOpenOrders\(/g) ?? []).length, 1);
});

test("Print presents the manual preview and can never auto-print", () => {
  // The workspace hands the panel receiptStore.present - the store-owned MANUAL
  // layer - and not presentReceipt, whose whole job is the automatic attempt.
  assert.match(workspace, /onPresentReceipt=\{\(receipt\) => receiptStore\.present\(receipt\)\}/);
  const panelBlock = workspace.slice(workspace.indexOf("<OrderSummaryPanel"), workspace.indexOf("</div>", workspace.indexOf("<OrderSummaryPanel")));
  assert.equal(panelBlock.includes("presentReceipt"), false, "the auto-print wrapper must not be reachable from the summary");
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
  // And the denomination is the order's own snapshot.
  assert.match(panel, /currency: \(order\.currency \?\? props\.fallbackCurrency\)/);
});

test("the panel mutates nothing anywhere", () => {
  for (const token of ["callPosRpc", ".rpc(", ".insert(", ".update(", ".upsert(", ".delete(", "pos_pay_order", "pos_submit_order", "useCart", "refreshCashBox"]) {
    assert.equal(panel.includes(token), false, `${token} must not appear on a read-only surface`);
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
