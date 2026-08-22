// Category and menu-item print routing, and the station tickets it produces.
//
// FIVE PROPERTIES THESE TESTS EXIST TO PROTECT.
//
// ONE, AN EXISTING TENANT'S PRINTING DOES NOT CHANGE. A branch with no rules
// gets exactly one ticket, to exactly the printer it went to before, holding
// exactly the lines it held before, in the same order. This is the property that
// makes the feature safe to ship to tills already taking orders, and it is
// asserted first because it is the one that matters most.
//
// TWO, PRECEDENCE IS TOTAL AND DETERMINISTIC. Item beats category beats the
// branch route, and a source-specific rule beats an "all orders" one. An item
// rule SHADOWS its category rather than adding to it.
//
// THREE, ONE ORDER STAYS ONE ORDER. Splitting is a paper operation. Nothing in
// these modules can create, read, submit or settle an order.
//
// FOUR, A PRODUCTION TICKET CARRIES NO MONEY. Not a price, not a total, not a
// currency - and it cannot, because the type it is built from has nowhere to put
// one.
//
// FIVE, ROUTING BELONGS TO THE ITEM, NOT TO A BUTTON. The same product chosen
// from the default menu, a custom main-page key or a custom category prints in
// the same room.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import {
  ROUTING_SOURCES,
  boundCopies,
  draftFromRules,
  draftIsDirty,
  groupLinesByPrinter,
  hasItemRules,
  originForLine,
  planIsEmpty,
  planRoutingSave,
  routingSourceLabel,
  rulesForLine,
  type ItemRoute,
} from "@/lib/pos/itemRouting";
import { printerById, routeFromPrinter, splitTicketByStation, stationEventKey } from "@/lib/pos/stationTickets";
import { buildKitchenTicket } from "@/lib/pos/kitchenPrinter";
import { toKitchenTicketDoc } from "@/lib/nativePrinting";
import { resolveRouteTarget } from "@/lib/pos/printTarget";
import type { ServerPrinter } from "@/lib/pos/printerRegistry";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const PIZZA = { menuItemId: "i-pizza", categoryId: "c-food" };
const CREPE = { menuItemId: "i-crepe", categoryId: "c-dessert" };
const PEPSI = { menuItemId: "i-pepsi", categoryId: "c-drinks" };
const COFFEE = { menuItemId: "i-coffee", categoryId: "c-drinks" };

function rule(over: Partial<ItemRoute>): ItemRoute {
  return {
    id: "r1",
    printerId: "p-kitchen",
    scope: "category",
    categoryId: "c-food",
    menuItemId: null,
    orderSource: "any",
    copies: 1,
    isActive: true,
    ...over,
  };
}

function ticketOf(lines: { name: string; qty: number; menuItemId: string; categoryId: string }[]) {
  return buildKitchenTicket({
    businessName: "Dominos Pizza",
    branchName: "Main Branch",
    staffName: "Sam",
    orderNumber: "260821-1257",
    source: "takeaway",
    at: "21 Aug 2026, 7:02 PM",
    lines,
  });
}

// --- one, an existing tenant's printing does not change ----------------------

test("NO rules means ONE ticket, to the branch default, with every line in order", () => {
  const lines = [
    { ...PIZZA, name: "Pizza", qty: 1 },
    { ...CREPE, name: "Crepe", qty: 1 },
    { ...PEPSI, name: "Pepsi", qty: 1 },
  ];
  const groups = groupLinesByPrinter({ lines, routes: [], orderSource: "takeaway" });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].printerId, null, "null is the branch's existing route");
  assert.deepEqual(groups[0].lines.map((l) => l.name), ["Pizza", "Crepe", "Pepsi"]);
  assert.equal(hasItemRules([]), false);
});

test("rules that are all INACTIVE are the same as no rules at all", () => {
  const groups = groupLinesByPrinter({
    lines: [{ ...PIZZA, name: "Pizza", qty: 1 }],
    routes: [rule({ isActive: false, printerId: "p-oven" })],
    orderSource: "takeaway",
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].printerId, null);
});

test("an unrouted line still prints - it follows the branch route, never nothing", () => {
  const groups = groupLinesByPrinter({
    lines: [
      { ...PIZZA, name: "Pizza", qty: 1 },
      { ...COFFEE, name: "Coffee", qty: 1 },
    ],
    routes: [rule({ printerId: "p-oven", categoryId: "c-food" })],
    orderSource: "takeaway",
  });
  const byPrinter = Object.fromEntries(groups.map((g) => [g.printerId ?? "default", g.lines.map((l) => l.name)]));
  assert.deepEqual(byPrinter.default, ["Coffee"], "a line nobody wrote a rule for is still food somebody cooks");
  assert.deepEqual(byPrinter["p-oven"], ["Pizza"]);
});

test("a line with no canonical identity follows the branch route", () => {
  // Every line did this before station routing existed, and a caller that does
  // not know an item id must not have its lines silently dropped.
  const groups = groupLinesByPrinter({
    lines: [{ menuItemId: null, categoryId: null, name: "Ad-hoc", qty: 1 }],
    routes: [rule({ printerId: "p-oven" })],
    orderSource: "takeaway",
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].printerId, null);
});

// --- two, precedence ----------------------------------------------------------

test("an ITEM rule shadows its CATEGORY completely - it never adds to it", () => {
  const routes = [
    rule({ id: "r-cat", printerId: "p-kitchen", scope: "category", categoryId: "c-drinks" }),
    rule({ id: "r-item", printerId: "p-counter", scope: "menu_item", categoryId: null, menuItemId: "i-pepsi" }),
  ];
  const matched = rulesForLine({ line: PEPSI, routes, orderSource: "takeaway" });
  assert.deepEqual(matched.map((r) => r.printerId), ["p-counter"], "Pepsi goes to the counter, and ONLY the counter");
  assert.equal(originForLine({ line: PEPSI, routes, orderSource: "takeaway" }), "item");
  // Its neighbour in the same category is unaffected.
  assert.deepEqual(
    rulesForLine({ line: COFFEE, routes, orderSource: "takeaway" }).map((r) => r.printerId),
    ["p-kitchen"],
  );
  assert.equal(originForLine({ line: COFFEE, routes, orderSource: "takeaway" }), "category");
});

test("a SOURCE-SPECIFIC rule beats an all-orders rule at the same level", () => {
  const routes = [
    rule({ id: "r-any", printerId: "p-kitchen", categoryId: "c-food", orderSource: "any" }),
    rule({ id: "r-din", printerId: "p-expo", categoryId: "c-food", orderSource: "dine_in" }),
  ];
  assert.deepEqual(rulesForLine({ line: PIZZA, routes, orderSource: "dine_in" }).map((r) => r.printerId), ["p-expo"]);
  assert.deepEqual(rulesForLine({ line: PIZZA, routes, orderSource: "takeaway" }).map((r) => r.printerId), ["p-kitchen"]);
});

test("the ladder is walked in full: item source, item any, category source, category any", () => {
  const itemAny = rule({ id: "r1", printerId: "p-a", scope: "menu_item", categoryId: null, menuItemId: "i-pizza", orderSource: "any" });
  const catExact = rule({ id: "r2", printerId: "p-b", scope: "category", categoryId: "c-food", orderSource: "takeaway" });
  // An item's "all orders" rule outranks a category's takeaway-specific one:
  // the item is more specific, and specificity is the axis this ladder sorts on.
  assert.deepEqual(
    rulesForLine({ line: PIZZA, routes: [itemAny, catExact], orderSource: "takeaway" }).map((r) => r.printerId),
    ["p-a"],
  );
  assert.equal(originForLine({ line: PIZZA, routes: [catExact], orderSource: "takeaway" }), "category");
  assert.equal(originForLine({ line: PIZZA, routes: [], orderSource: "takeaway" }), "branch_default");
});

test("routing can differ per order type, which is the point of the source column", () => {
  const routes = [
    rule({ id: "r1", printerId: "p-kitchenA", categoryId: "c-food", orderSource: "takeaway" }),
    rule({ id: "r2", printerId: "p-kitchenA", categoryId: "c-food", orderSource: "dine_in" }),
    rule({ id: "r3", printerId: "p-expo", categoryId: "c-food", orderSource: "dine_in" }),
    rule({ id: "r4", printerId: "p-packing", categoryId: "c-food", orderSource: "delivery" }),
  ];
  const printersFor = (source: "takeaway" | "dine_in" | "delivery") =>
    rulesForLine({ line: PIZZA, routes, orderSource: source }).map((r) => r.printerId).sort();
  assert.deepEqual(printersFor("takeaway"), ["p-kitchenA"]);
  assert.deepEqual(printersFor("dine_in"), ["p-expo", "p-kitchenA"]);
  assert.deepEqual(printersFor("delivery"), ["p-packing"]);
});

test("one line may go to several printers, and never twice to the same one", () => {
  const routes = [
    rule({ id: "r1", printerId: "p-grill", categoryId: "c-food" }),
    rule({ id: "r2", printerId: "p-pass", categoryId: "c-food" }),
    // A second rule naming a printer already named must not double the paper.
    rule({ id: "r3", printerId: "p-pass", categoryId: "c-food" }),
  ];
  const groups = groupLinesByPrinter({ lines: [{ ...PIZZA, name: "Pizza", qty: 1 }], routes, orderSource: "takeaway" });
  assert.deepEqual(groups.map((g) => g.printerId).sort(), ["p-grill", "p-pass"]);
  for (const group of groups) assert.equal(group.lines.length, 1);
});

test("when two rules disagree about copies, the higher wins", () => {
  const routes = [
    rule({ id: "r1", printerId: "p-grill", categoryId: "c-food", copies: 2 }),
    rule({ id: "r2", printerId: "p-grill", categoryId: "c-drinks", copies: 1 }),
  ];
  const groups = groupLinesByPrinter({
    lines: [
      { ...PIZZA, name: "Pizza", qty: 1 },
      { ...PEPSI, name: "Pepsi", qty: 1 },
    ],
    routes,
    orderSource: "takeaway",
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].copies, 2, "somebody who asked for two copies must not be given one");
  assert.equal(boundCopies(99), 5);
  assert.equal(boundCopies(0), 1);
});

test("grouping is deterministic: the default first, then printers in a fixed order", () => {
  const routes = [
    rule({ id: "r1", printerId: "p-zeta", categoryId: "c-food" }),
    rule({ id: "r2", printerId: "p-alpha", categoryId: "c-dessert" }),
  ];
  const lines = [
    { ...PIZZA, name: "Pizza", qty: 1 },
    { ...CREPE, name: "Crepe", qty: 1 },
    { ...COFFEE, name: "Coffee", qty: 1 },
  ];
  const once = groupLinesByPrinter({ lines, routes, orderSource: "takeaway" }).map((g) => g.printerId);
  const twice = groupLinesByPrinter({ lines, routes, orderSource: "takeaway" }).map((g) => g.printerId);
  assert.deepEqual(once, [null, "p-alpha", "p-zeta"]);
  assert.deepEqual(once, twice, "two identical orders must produce identical paper");
});

// --- three, one order stays one order ----------------------------------------

test("one order splits into station tickets that ALL name the same order", () => {
  // The worked example from the brief: one takeaway order, four stations.
  const routes = [
    rule({ id: "r1", printerId: "p-pizza", categoryId: "c-food" }),
    rule({ id: "r2", printerId: "p-dessert", categoryId: "c-dessert" }),
    rule({ id: "r3", printerId: "p-counter", scope: "menu_item", categoryId: null, menuItemId: "i-pepsi" }),
    rule({ id: "r4", printerId: "p-bar", scope: "menu_item", categoryId: null, menuItemId: "i-coffee" }),
  ];
  const ticket = ticketOf([
    { ...PIZZA, name: "Pizza", qty: 1 },
    { ...CREPE, name: "Crepe", qty: 1 },
    { ...PEPSI, name: "Pepsi", qty: 1 },
    { ...COFFEE, name: "Coffee", qty: 1 },
  ]);
  const stations = splitTicketByStation({ ticket, routes, orderSource: "takeaway" });

  assert.equal(stations.length, 4);
  for (const station of stations) {
    assert.equal(station.ticket.orderNumber, "260821-1257", "one order number on every station's paper");
    assert.equal(station.ticket.orderType, "Takeaway");
    assert.equal(station.ticket.at, "21 Aug 2026, 7:02 PM");
    assert.equal(station.ticket.branchName, "Main Branch");
  }
  const byPrinter = Object.fromEntries(
    stations.map((s) => [s.printerId, s.ticket.lines.map((l) => l.name)]),
  );
  assert.deepEqual(byPrinter["p-pizza"], ["Pizza"]);
  assert.deepEqual(byPrinter["p-dessert"], ["Crepe"]);
  assert.deepEqual(byPrinter["p-counter"], ["Pepsi"]);
  assert.deepEqual(byPrinter["p-bar"], ["Coffee"]);
});

test("a station with nothing in this order gets NO ticket, not an empty one", () => {
  const routes = [rule({ id: "r1", printerId: "p-dessert", categoryId: "c-dessert" })];
  const stations = splitTicketByStation({
    ticket: ticketOf([{ ...PIZZA, name: "Pizza", qty: 1 }]),
    routes,
    orderSource: "takeaway",
  });
  assert.deepEqual(stations.map((s) => s.printerId), [null]);
});

test("modifiers, item notes and the order note survive onto every station's copy", () => {
  const ticket = buildKitchenTicket({
    businessName: "B",
    branchName: "Br",
    orderNumber: "1",
    source: "dine_in",
    at: "now",
    tableName: "Table 4",
    batchNo: 2,
    orderNote: "Allergy: nuts",
    lines: [
      { ...PIZZA, name: "Pizza", qty: 1, modifiers: [{ name: "Extra cheese", quantity: 2 }], note: "well done" },
      { ...PEPSI, name: "Pepsi", qty: 1 },
    ],
  });
  const stations = splitTicketByStation({
    ticket,
    routes: [
      rule({ id: "r1", printerId: "p-oven", categoryId: "c-food" }),
      rule({ id: "r2", printerId: "p-bar", categoryId: "c-drinks" }),
    ],
    orderSource: "dine_in",
  });
  const oven = stations.find((s) => s.printerId === "p-oven");
  assert.ok(oven);
  assert.deepEqual(oven!.ticket.lines[0].modifiers, [{ name: "Extra cheese", quantity: 2 }]);
  assert.equal(oven!.ticket.lines[0].note, "well done");
  for (const station of stations) {
    assert.equal(station.ticket.orderNote, "Allergy: nuts");
    assert.equal(station.ticket.tableName, "Table 4", "dine-in table information is on every station's copy");
    assert.equal(station.ticket.batchLabel, "Round 2");
  }
});

test("splitting cannot reach an order, a payment or a shift", () => {
  const source = stripJsxComments(read("src/lib/pos/stationTickets.ts"));
  for (const forbidden of ["supabase", "rpc", "pos_submit_order", "pos_pay_order", "useCart", "shift"]) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `must not reach ${forbidden}`);
  }
  const routing = stripJsxComments(read("src/lib/pos/itemRouting.ts"));
  for (const forbidden of ["supabase", "pos_submit_order", "pos_pay_order"]) {
    assert.equal(routing.includes(forbidden), false, `must not reach ${forbidden}`);
  }
});

// --- four, no money on a production ticket -----------------------------------

test("a station ticket has nowhere to put money, and the mapper adds none", () => {
  const stations = splitTicketByStation({
    ticket: ticketOf([{ ...PIZZA, name: "Pizza", qty: 2 }]),
    routes: [rule({ id: "r1", printerId: "p-oven", categoryId: "c-food" })],
    orderSource: "takeaway",
  });
  const json = JSON.stringify(toKitchenTicketDoc(stations[0].ticket)).toLowerCase();
  for (const money of ["price", "total", "subtotal", "discount", "currency", "paid", "tender", "change", "amount"]) {
    assert.equal(json.includes(money), false, `a station ticket must not carry ${money}`);
  }
});

test("routing identity is carried but never printed", () => {
  const ticket = ticketOf([{ ...PIZZA, name: "Pizza", qty: 1 }]);
  assert.equal(ticket.lines[0].menuItemId, "i-pizza");
  const doc = toKitchenTicketDoc(ticket);
  const json = JSON.stringify(doc);
  assert.equal(json.includes("i-pizza"), false, "an id must not cross the native boundary");
  assert.equal(json.includes("menuItemId"), false);
  assert.equal(json.includes("categoryId"), false);
});

// --- five, routing belongs to the item ---------------------------------------

test("the custom grid holds no routing of its own", () => {
  for (const rel of [
    "src/lib/pos/grid/model.ts",
    "src/lib/pos/grid/storage.ts",
    "src/components/pos/grid/PosLayoutGrid.tsx",
    "src/lib/pos/grid/presentation.ts",
    "src/components/pos/grid/AddButtonWizard.tsx",
  ]) {
    const source = stripJsxComments(read(rel));
    for (const forbidden of ["printerId", "printer_id", "print_purpose", "kitchen_print_routes", "resolvePrintRoute"]) {
      assert.equal(source.includes(forbidden), false, `${rel} must not know about printers`);
    }
  }
});

test("all three routes hand over the canonical item id, so all three route alike", () => {
  for (const rel of [
    "src/screens/pos/PosWorkspace.tsx",
    "src/screens/pos/DineInWorkspace.tsx",
    "src/screens/pos/DeliveryWorkspace.tsx",
  ]) {
    assert.match(stripJsxComments(read(rel)), /menuItemId: l\.menu_item_id/, `${rel} must pass the canonical id`);
  }
  // And the CATEGORY is resolved once, in the shared call site.
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.match(workspace, /categoryByItemId\.get\(line\.menuItemId\)/);
});

// --- the destination, and the latch ------------------------------------------

test("a station printer is resolved through the SAME reachability rules as any route", () => {
  const printer: ServerPrinter = {
    id: "p-oven",
    name: "Kitchen A",
    printer_type: "kitchen",
    connection_type: "system",
    system_printer_name: "Xprinter XP-80",
    paper_width: "custom",
    custom_paper_width: 72,
    default_copy_count: 1,
    auto_cut_enabled: true,
    cash_drawer_enabled: false,
    status: "ready",
    station_id: null,
    branch_id: "b1",
    is_active: true,
  };
  const resolved = resolveRouteTarget({
    route: routeFromPrinter(printer, 2),
    installed: [{ name: "Xprinter XP-80", is_default: false, status: "ready" }],
  });
  assert.equal(resolved.kind, "single");
  if (resolved.kind === "single") {
    assert.equal(resolved.target.windowsName, "Xprinter XP-80");
    assert.equal(resolved.target.paperWidth, "custom:72");
    assert.equal(resolved.target.copies, 2);
    // An explicit rule is never "the default", and must not report itself as one.
    assert.equal(resolved.target.usedDefault, false);
  }
  // A printer that is not installed HERE is refused with a reason, not guessed at.
  assert.equal(resolveRouteTarget({ route: routeFromPrinter(printer, 1), installed: [] }).kind, "blocked");
  assert.equal(printerById([printer], "p-oven")?.name, "Kitchen A");
  assert.equal(printerById([printer], "nope"), null);
});

test("the latch key names the PRINTER, so one station cannot silence another", () => {
  const grill = stationEventKey({ orderId: "o1", batchNo: 2, printerId: "p-grill" });
  const bar = stationEventKey({ orderId: "o1", batchNo: 2, printerId: "p-bar" });
  const fallback = stationEventKey({ orderId: "o1", batchNo: 2, printerId: null });
  assert.notEqual(grill, bar);
  assert.notEqual(grill, fallback);
  // Still one attempt per BATCH per destination.
  assert.equal(grill, stationEventKey({ orderId: "o1", batchNo: 2, printerId: "p-grill" }));
  assert.notEqual(grill, stationEventKey({ orderId: "o1", batchNo: 3, printerId: "p-grill" }));
  assert.match(fallback, /default$/);
});

// --- the editor ---------------------------------------------------------------

test("clearing a cell REMOVES its rows, so the next rule up applies again", () => {
  const existing = [rule({ id: "r1", printerId: "p-a" }), rule({ id: "r2", printerId: "p-b" })];
  const plan = planRoutingSave({ draft: { printerIds: [], copies: 1 }, existing });
  assert.deepEqual(plan.remove.sort(), ["r1", "r2"]);
  assert.deepEqual(plan.add, []);
  assert.equal(planIsEmpty(plan), false);
});

test("saving an unchanged cell does nothing at all", () => {
  const existing = [rule({ id: "r1", printerId: "p-a", copies: 2 })];
  assert.equal(planIsEmpty(planRoutingSave({ draft: draftFromRules(existing), existing })), true);
  assert.equal(draftIsDirty(draftFromRules(existing), existing), false);
  assert.equal(draftIsDirty({ printerIds: ["p-a", "p-b"], copies: 2 }, existing), true);
});

test("swapping one printer for another is a removal and an insert, never both at once", () => {
  const existing = [rule({ id: "r1", printerId: "p-a" })];
  const plan = planRoutingSave({ draft: { printerIds: ["p-b"], copies: 1 }, existing });
  assert.deepEqual(plan.remove, ["r1"]);
  assert.deepEqual(plan.add, [{ printerId: "p-b", copies: 1 }]);
});

test("a duplicate row for one printer is cleaned up rather than left to print twice", () => {
  const existing = [rule({ id: "r1", printerId: "p-a" }), rule({ id: "r2", printerId: "p-a" })];
  const plan = planRoutingSave({ draft: { printerIds: ["p-a"], copies: 1 }, existing });
  assert.deepEqual(plan.remove, ["r2"]);
  assert.deepEqual(plan.add, []);
});

test("the editor offers the default plus the three real order types, in words", () => {
  assert.deepEqual([...ROUTING_SOURCES], ["any", "takeaway", "dine_in", "delivery"]);
  assert.equal(routingSourceLabel("any"), "All orders");
  assert.equal(routingSourceLabel("dine_in"), "Dine-In");
});

// --- the repository boundary --------------------------------------------------

test("the repository writes ONLY category and item scopes, and only kitchen tickets", () => {
  const source = stripJsxComments(read("src/lib/pos/itemRouteRepository.ts"));
  assert.match(source, /print_purpose: ITEM_ROUTE_PURPOSE/);
  assert.match(source, /ITEM_ROUTE_PURPOSE = "kitchen_ticket"/);
  // The advanced columns a Kitchen Ops rule may hold are never named in a write,
  // so a screen that cannot show them cannot blank them.
  for (const column of ["station_id", "section_id", "preparation_component_id", "template_id", "priority", "sort_order", "receipt_type", "ticket_type"]) {
    assert.equal(source.includes(column), false, `${column} must never be written from the desktop`);
  }
});

test("the basic-routing repository and this one cannot edit each other's rows", () => {
  const basic = stripJsxComments(read("src/lib/pos/printRouteRepository.ts"));
  const items = stripJsxComments(read("src/lib/pos/itemRouteRepository.ts"));
  assert.match(basic, /BASIC_SCOPE_TYPE = "order_source"/);
  assert.equal(basic.includes('"menu_item"'), false);
  assert.equal(items.includes('scope_type: BASIC_SCOPE_TYPE'), false);
  assert.match(items, /scope_type: input\.target\.scope/);
});
