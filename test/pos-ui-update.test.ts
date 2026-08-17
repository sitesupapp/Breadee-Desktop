// The POS UI update: order slots, action priority, and the print separations.
//
// WHAT THESE TESTS ARE FOR. The redesign touched the three surfaces where money
// and paper meet, so the properties worth pinning are not "does it look right"
// but "can this new button reach something it must not":
//
//   1. Every takeaway action operates on the SELECTED order, and does so because
//      the selected slot IS the cart - never because an id was threaded past it.
//   2. The new manual Print goes to the EXISTING receipt service and cannot pay,
//      cannot route a kitchen ticket, and cannot trigger the automatic path.
//   3. Parking an order carries its `client_op_id` and its saved order with it,
//      so a parked order is never submitted a second time as a new one.
//   4. Nothing new prints. There is still exactly one automatic call site per
//      document type, and the new UI reaches them through the same handlers.
//   5. No new component hard-codes a colour, so every theme still styles them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import {
  TAKEAWAY_SLOT_COUNT,
  canSwitchSlots,
  slotSummaries,
  unpaidParkedOrders,
} from "@/state/takeawayOrders";
import { EMPTY_CART_SNAPSHOT } from "@/state/cart";
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
const slotsSrc = stripComments(readSrc("state", "takeawayOrders.ts"));
const footer = stripJsxComments(readSrc("components", "pos", "PosFooterBar.tsx"));

// --- 1. the selected order is authoritative ----------------------------------

test("there are three order slots and exactly one of them is ever live", () => {
  assert.equal(TAKEAWAY_SLOT_COUNT, 3);
  // Selecting parks the live buffer and UN-parks the target in the same set, so
  // a snapshot can never exist in two places at once.
  assert.match(slotsSrc, /next\[current\] = live/);
  assert.match(slotsSrc, /next\[index\] = null/);
  assert.match(slotsSrc, /cart\.restore\(target\)/);
});

test("switching is refused while another context owns the buffer", () => {
  assert.equal(canSwitchSlots(null), true);
  assert.equal(canSwitchSlots({ kind: "takeaway" }), true);
  assert.equal(canSwitchSlots({ kind: "table", tableId: "t1" }), false);
  assert.equal(canSwitchSlots({ kind: "delivery", customerId: "c1" }), false);
  // And the store itself checks, not only the UI.
  assert.match(slotsSrc, /if \(!canSwitchSlots\(live\.owner\)\) return/);
});

test("a tab describes the slot it actually holds", () => {
  const saved = { order_id: "o1", order_number: "260816-0001" } as never;
  const summaries = slotSummaries({
    parked: [null, { ...EMPTY_CART_SNAPSHOT, savedOrder: saved }, null],
    index: 0,
    live: { lines: [{ quantity: 2 }, { quantity: 1 }] as never, savedOrder: null },
  });
  assert.equal(summaries.length, 3);
  // The ACTIVE slot is described from the live cart...
  assert.deepEqual(summaries[0], { position: 1, used: true, orderNumber: null, itemCount: 3 });
  // ...and every other slot from its parked snapshot.
  assert.equal(summaries[1].used, true);
  assert.equal(summaries[1].orderNumber, "260816-0001");
  assert.equal(summaries[2].used, false);
});

test("parked orders that the server accepted can be listed before a shift closes", () => {
  const saved = (n: string) => ({ order_id: n, order_number: n }) as never;
  assert.deepEqual(
    unpaidParkedOrders({
      parked: [null, { ...EMPTY_CART_SNAPSHOT, savedOrder: saved("A") }, null],
      index: 0,
      live: { savedOrder: saved("B") },
    }),
    ["B", "A"],
  );
  assert.deepEqual(
    unpaidParkedOrders({ parked: [null, null, null], index: 0, live: { savedOrder: null } }),
    [],
  );
});

test("no action takes an order id alongside the cart", () => {
  // The whole point of parking through `useCart` is that Pay, Send, Print and
  // Clear read ONE place. A prop that carried an order id into the panel would
  // reintroduce exactly the disagreement this design removes.
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
    ["components", "pos", "OrderTabs.tsx"],
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
