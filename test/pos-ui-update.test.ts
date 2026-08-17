// The POS UI update: the Current Order, action priority, and the print separations.
//
// WHAT THESE TESTS ARE FOR. The redesign touched the three surfaces where money
// and paper meet, so the properties worth pinning are not "does it look right"
// but "can this new button reach something it must not":
//
//   1. Every takeaway action operates on the order actually on screen - the live
//      cart for a draft, the selected REAL order for a saved one - and never on
//      an invented slot index.
//   2. The new manual Print goes to the EXISTING receipt service and cannot pay,
//      cannot route a kitchen ticket, and cannot trigger the automatic path.
//   3. The cart still carries its `client_op_id` and its saved order together,
//      so a retried submission is never a second order.
//   4. Nothing new prints. There is still exactly one automatic call site per
//      document type, and the new UI reaches them through the same handlers.
//   5. No new component hard-codes a colour, so every theme still styles them.
//
// 1.0.4 RETARGETED THE SLOT ASSERTIONS RATHER THAN DELETING THEM. The tests that
// described `Order 1/2/3` described a model that shipped and turned out to be
// wrong: those numbers were the till's own invention and nothing in the business
// answered to them. What those tests were really guarding - one selected order,
// no second order model, no id that can go stale, no way for a view to submit -
// are all still asserted below, now against the real orders in
// `state/shiftOrders.ts`. See `pos-1-0-4-hotfix.test.ts` for the rest.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import { stableSelectionIndex, type ShiftOpenOrder } from "@/lib/pos/shiftOrderSummary";
import { ICON_SECTIONS, POS_ICONS, searchIcons, sectionsWithCounts } from "@/lib/icons/catalog";
import {
  DEFAULT_ICON_DISPLAY,
  ICON_PIXELS,
  parseIconDisplay,
  readIconDisplay,
  writeIconDisplay,
} from "@/lib/icons/display";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");

const workspace = stripJsxComments(readSrc("screens", "pos", "PosWorkspace.tsx"));
const cartPanel = stripJsxComments(readSrc("components", "pos", "CartPanel.tsx"));
const shell = stripJsxComments(readSrc("layouts", "PosShell.tsx"));
const carousel = stripJsxComments(readSrc("components", "pos", "OrderCarousel.tsx"));
const footer = stripJsxComments(readSrc("components", "pos", "PosFooterBar.tsx"));

const order = (over: Partial<ShiftOpenOrder> = {}): ShiftOpenOrder => ({
  id: "o1",
  order_number: "260817-0004",
  order_type: "takeaway",
  status: "sent_to_kitchen",
  payment_status: "unpaid",
  payment_method: null,
  subtotal: 100,
  discount_amount: 0,
  total_amount: 100,
  currency: "USD",
  table_id: null,
  customer_id: null,
  customer_name: null,
  customer_phone: null,
  cashier_user_id: null,
  staff_name: null,
  notes: null,
  created_at: null,
  ...over,
});

// --- 1. the selected order is a REAL order -----------------------------------

test("the fake Order 1/2/3 slot model is gone from the source tree", () => {
  // RETARGETED, NOT DROPPED (1.0.4). This file used to assert that there were
  // exactly three slots and that switching parked one cart snapshot for another.
  // The property that mattered inside those assertions - that there is only ever
  // ONE selected order and no second order model to disagree with it - is what
  // is checked now; the three invented numbers are what changed.
  for (const gone of ["takeawayOrders", "OrderTabs", "TAKEAWAY_SLOT_COUNT", "slotSummaries"]) {
    assert.equal(workspace.includes(gone), false, `${gone} must not survive in the workspace`);
  }
  assert.equal(/Order \{?(slot\.position|props\.index)/.test(workspace + cartPanel), false, "a slot index is not an order number");
  // And the carousel shows the SERVER's number, prefixed, in the centre.
  assert.match(carousel, /`#\$\{props\.orderNumber\}`/);
});

test("exactly one order is selected, and the store decides which", () => {
  // `stableSelectionIndex` is the whole selection rule, and it is a pure
  // function so the case that used to be a slot index is testable directly.
  const orders = [order({ id: "a" }), order({ id: "b" }), order({ id: "c" })];
  // A just-created order wins outright - that is "it becomes the Current Order".
  assert.equal(stableSelectionIndex("a", 0, orders, "c"), 2);
  // Otherwise the selection survives a refresh rather than jumping.
  assert.equal(stableSelectionIndex("b", 1, orders), 1);
  // First load selects the newest, which is the one the cashier just took.
  assert.equal(stableSelectionIndex(null, -1, orders), 2);
  // And an empty shift selects nothing rather than index 0 of nothing.
  assert.equal(stableSelectionIndex(null, -1, []), -1);
});

test("no action takes an order id alongside the cart", () => {
  // The cart panel renders the UNSAVED draft only, so it has no order to be
  // given: a prop that carried an order id into it would be the disagreement
  // between "the order shown" and "the order acted on" all over again. A saved
  // order is rendered by CurrentOrderPanel, which takes the order explicitly.
  assert.equal(cartPanel.includes("orderId"), false, "the cart panel must not take an order id");
  assert.equal(cartPanel.includes("order_id"), false);
  // Print resolves its target at CALL time from the live cart, never from a
  // value closed over when the component rendered.
  assert.match(workspace, /const saved = useCart\.getState\(\)\.savedOrder;/);
});

// --- 2. the new Print cannot pay, route or auto-print -------------------------

test("manual Print goes to the existing manual receipt path", () => {
  const block = workspace.slice(
    workspace.indexOf("const printCurrentOrder"),
    workspace.indexOf("const openPayment"),
  );
  assert.ok(block.length > 0, "the Print handler could not be located");
  // It reuses the ONE manual path, shared with the Orders and Delivery modals.
  assert.match(block, /await printShiftOrder\(found\)/);
  for (const forbidden of [
    "presentReceipt",
    "autoPrintReceipt",
    "autoPrintKitchenTicket",
    "printKitchenFor",
    "sendToKitchen",
    "payOrder",
    "confirmPayment",
    "openPayment",
    "submitOrder",
  ]) {
    assert.equal(block.includes(forbidden), false, `Print must not be able to reach ${forbidden}`);
  }
});

test("the manual receipt path presents and never automatically prints", () => {
  const block = workspace.slice(
    workspace.indexOf("const printShiftOrder"),
    workspace.indexOf("const printShiftReport"),
  );
  assert.match(block, /receiptStore\.present\(/);
  assert.equal(block.includes("autoPrint"), false, "the manual path must not reach the automatic one");
});

test("there is still exactly one automatic call site per document", () => {
  assert.equal((workspace.match(/autoPrintReceipt\(/g) ?? []).length, 1);
  assert.equal((workspace.match(/autoPrintKitchenTicket\(/g) ?? []).length, 1);
  // And one place each that a route can reach them through.
  assert.equal((workspace.match(/const presentReceipt = useCallback/g) ?? []).length, 1);
  assert.equal((workspace.match(/const printKitchenFor = useCallback/g) ?? []).length, 1);
});

test("the cart panel's buttons each call exactly one handler", () => {
  assert.match(cartPanel, /onClick=\{props\.onPay\}/);
  assert.match(cartPanel, /onClick=\{props\.onSendToKitchen\}/);
  assert.match(cartPanel, /onClick=\{props\.onPrint\}/);
  assert.match(cartPanel, /onClick=\{props\.onNewOrder\}/);
  // No button both prints and does something else.
  assert.equal(/onClick=\{\(\)\s*=>\s*\{[^}]*;[^}]*\}\}/.test(cartPanel), false, "a control does two things");
  // The panel itself builds no document and calls no service.
  for (const forbidden of ["buildReceipt", "autoPrint", "printReceipt", "callPosRpc", ".rpc("]) {
    assert.equal(cartPanel.includes(forbidden), false, `${forbidden} must not be in the cart panel`);
  }
});

test("Print is refused, with a reason, until the server has accepted the order", () => {
  assert.match(cartPanel, /props\.savedOrderNumber \? null : "Send or pay this order first/);
  assert.match(cartPanel, /disabled=\{Boolean\(printReason\)/);
});

// --- 3. action priority ------------------------------------------------------

test("the takeaway actions are in the approved order", () => {
  const pay = cartPanel.indexOf("onClick={props.onPay}");
  const send = cartPanel.indexOf("onClick={props.onSendToKitchen}");
  const print = cartPanel.indexOf("onClick={props.onPrint}");
  const clear = cartPanel.indexOf("onClick={props.onNewOrder}");
  assert.ok(pay > 0 && send > 0 && print > 0 && clear > 0, "the four actions could not be located");
  assert.ok(pay < send, "Pay must be first");
  assert.ok(send < print, "Send to kitchen must be second");
  assert.ok(print < clear, "Print must be third and the destructive action last");
  // And the last one is styled as destructive rather than merely placed last.
  const destructive = cartPanel.slice(print, clear + 200);
  assert.match(destructive, /variant="danger"/);
});

// --- 4. the shell ------------------------------------------------------------

test("the POS rail carries the four routes and nothing administrative", () => {
  for (const route of ["Takeaway", "Dine-in", "Delivery", "Orders"]) {
    assert.ok(workspace.includes(`label: "${route}"`), `${route} must be in the rail`);
  }
  for (const forbidden of ['label: "Settings"', 'label: "Reports"', 'label: "Customers"']) {
    assert.equal(workspace.includes(forbidden), false, `${forbidden} does not belong in the POS rail`);
  }
});

test("Close leaves the workspace without ending anything", () => {
  const close = workspace.slice(workspace.indexOf("onExit={"), workspace.indexOf("onToggleFullscreen="));
  assert.match(close, /navigate\("\/dashboard"\)/);
  for (const forbidden of ["signOut", "close(", "endShift", "reset()", "logout"]) {
    assert.equal(close.includes(forbidden), false, `Close must not ${forbidden}`);
  }
});

test("Collapse overrides the measured default without replacing it", () => {
  assert.match(shell, /collapseOverride === null \? layout\.railExpanded : !collapseOverride/);
  assert.match(shell, /glyph=\{expanded \? "collapse" : "expand"\}/);
});

test("the footer reads the build's own version and invents no sync time", () => {
  assert.match(footer, /CURRENT_VERSION/);
  assert.equal(/v1\.2\.0/.test(footer), false, "the mockup's placeholder version must never be shipped");
  assert.equal(/Last sync/.test(footer), false, "there is no durable last-sync timestamp to show");
  assert.match(footer, /pendingSync/);
});

// --- 5. icons ----------------------------------------------------------------

test("the catalogue covers every declared section it claims to", () => {
  const used = new Set(POS_ICONS.map((i) => i.section));
  for (const icon of POS_ICONS) {
    assert.ok((ICON_SECTIONS as readonly string[]).includes(icon.section), `${icon.key}: unknown section`);
  }
  // Every section the gallery lists has at least one icon behind it.
  for (const { section, count } of sectionsWithCounts()) {
    assert.ok(count > 0, `${section} is listed with nothing in it`);
    assert.ok(used.has(section));
  }
  // The library is meaningfully larger than the four-category original.
  assert.ok(POS_ICONS.length >= 90, `expected a large catalogue, got ${POS_ICONS.length}`);
  assert.ok(sectionsWithCounts().length >= 50, "the section list is too small to be worth filtering");
});

test("search narrows by query, category and section together", () => {
  const beverages = searchIcons("", "Beverage", null);
  assert.ok(beverages.every((i) => i.category === "Beverage"));
  const espresso = searchIcons("", null, "Espresso");
  assert.ok(espresso.length > 0 && espresso.every((i) => i.section === "Espresso"));
  // All three at once, and the section name itself is searchable.
  assert.ok(searchIcons("manakish", null, null).length > 0);
  assert.equal(searchIcons("burger", "Beverage", null).length, 0);
});

test("icon display settings default to Outline / Medium and survive a corrupt store", () => {
  assert.deepEqual(DEFAULT_ICON_DISPLAY, { style: "outline", size: "m" });
  assert.deepEqual(parseIconDisplay("not json"), DEFAULT_ICON_DISPLAY);
  assert.deepEqual(parseIconDisplay('{"style":"nope","size":"xl"}'), { style: "outline", size: "xl" });
  const map = new Map<string, string>();
  const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  writeIconDisplay({ style: "filled", size: "l" }, store);
  assert.deepEqual(readIconDisplay(store), { style: "filled", size: "l" });
  // Sizes are bounded by what fits a menu button, largest last.
  assert.ok(ICON_PIXELS.s < ICON_PIXELS.m && ICON_PIXELS.m < ICON_PIXELS.l && ICON_PIXELS.l < ICON_PIXELS.xl);
});

test("every interface glyph draws something and names no colour", () => {
  // Read rather than imported: the node test runner cannot load a .tsx module,
  // and the property worth checking - that every declared name has a path - is a
  // property of the source either way.
  const source = readSrc("components", "Glyph.tsx");
  const table = source.slice(source.indexOf("const GLYPHS"), source.indexOf("export function Glyph"));
  const paths = [...table.matchAll(/:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length > 20, `expected a full glyph set, found ${paths.length}`);
  for (const path of paths) {
    // Path data only: commands and numbers. Anything else would be markup
    // smuggled into a `d` attribute - the same rule the food catalogue follows.
    assert.match(path, /^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/, path);
  }
  assert.ok(source.includes('stroke="currentColor"'));
  assert.ok(source.includes('fill="none"'));
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(source), false, "a glyph must not name a colour");
});

// --- 6. themes ---------------------------------------------------------------

test("no component added by this update hard-codes a colour", () => {
  const added = [
    ["components", "Glyph.tsx"],
    ["components", "PosIconGlyph.tsx"],
    ["components", "pos", "MenuCard.tsx"],
    ["components", "pos", "CartPanel.tsx"],
    ["components", "pos", "OrderCarousel.tsx"],
    ["components", "pos", "CurrentOrderPanel.tsx"],
    ["components", "pos", "PosFooterBar.tsx"],
    ["components", "pos", "TableCard.tsx"],
    ["layouts", "PosShell.tsx"],
    ["screens", "settings", "IconsGallery.tsx"],
  ];
  for (const parts of added) {
    const source = stripJsxComments(readSrc(...parts));
    const file = parts.join("/");
    assert.equal(/#[0-9a-fA-F]{3,8}/.test(source), false, `${file} names a literal colour`);
    // Arbitrary COLOUR values only. `text-[11px]` is a size and is fine; the
    // thing that would break a theme is a colour the token layer never sees.
    assert.equal(
      /(bg|text|border|ring|fill|stroke)-\[(#|rgb|hsl)/.test(source),
      false,
      `${file} uses an arbitrary colour value`,
    );
    // Tailwind palette names that the theme layer does NOT redefine would be
    // off-theme; only the redefined scales are allowed.
    assert.equal(
      /(bg|text|border|ring)-(green|emerald|teal|blue|indigo|violet|purple|pink|orange|yellow|lime|cyan|rose|fuchsia|stone|zinc|neutral|gray)-\d/.test(source),
      false,
      `${file} uses a palette the theme layer does not control`,
    );
  }
});

test("there is one theme applier and no second provider", () => {
  const files = readdirSync(join(root, "..", "src", "lib", "theme"));
  assert.deepEqual(files.sort(), ["apply.ts", "themes.ts", "tokens.ts"]);
});
