// KITCHEN ROUTING PREFLIGHT: eligible lines in = routed lines + unresolved lines,
// with no unexplained remainder, and NO partial paper.
//
// This suite pins the fix for production order #260916-0003: nine eligible kitchen
// lines, six routed to a category printer and printed, three with no matching rule
// and no branch default kitchen route - dropped in silence while the run reported
// success. The plan below resolves EVERY line first and refuses to dispatch
// anything when even one line has nowhere to go.
//
// The routing/coalescing/classification logic is pure, so it is tested directly.
// The dispatch WIRING - preflight before paper, blocked shown not swallowed - is
// pinned by source reads, the same convention `kitchen-printing-and-auto-print`
// uses: "the guard is not reached" is weaker than "the guard precedes the loop".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildKitchenTicket } from "@/lib/pos/kitchenPrinter";
import { splitTicketByStation } from "@/lib/pos/stationTickets";
import type { ItemRoute } from "@/lib/pos/itemRouting";
import type { RouteOrderSource } from "@/lib/pos/printRouting";
import type { ServerPrinter } from "@/lib/pos/printerRegistry";
import type { InstalledPrinter } from "@/lib/nativePrinting";
import type { PrintResolution, PrintTarget } from "@/lib/pos/printTarget";
import {
  blockedPlanFix,
  classifyKitchenDispatch,
  planKitchenRouting,
  unresolvedItemNames,
  type JobDispatchResult,
  type KitchenLineRef,
} from "@/lib/pos/kitchenRoutingPlan";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

// --- fixtures ----------------------------------------------------------------

const STARTERS = "cat-starters";
const HOTDOGS = "cat-hotdogs";

const installed = (name: string): InstalledPrinter => ({ name, is_default: false, status: "unknown" });

const printer = (over: Partial<ServerPrinter> = {}): ServerPrinter => ({
  id: "p-cashier",
  name: "cashier",
  printer_type: "cashier",
  connection_type: "system",
  system_printer_name: "Xprinter XP-80",
  paper_width: "80mm",
  custom_paper_width: null,
  default_copy_count: 1,
  auto_cut_enabled: false,
  cash_drawer_enabled: false,
  status: "unknown",
  station_id: null,
  branch_id: "b1",
  is_active: true,
  ...over,
});

const singleDefault = (over: Partial<PrintTarget> = {}): PrintResolution => ({
  kind: "single",
  target: {
    printerName: "cashier",
    windowsName: "Xprinter XP-80",
    paperWidth: "80mm",
    copies: 1,
    usedDefault: true,
    printerId: "p-cashier",
    ...over,
  },
});

const blockedDefault: PrintResolution = { kind: "blocked", block: { reason: "no_route" } };

const categoryRoute = (categoryId: string, printerId: string, source: RouteOrderSource = "takeaway"): ItemRoute => ({
  id: `r-${categoryId}-${printerId}-${source}`,
  printerId,
  scope: "category",
  categoryId,
  menuItemId: null,
  orderSource: source,
  copies: 1,
  isActive: true,
});

const itemRoute = (menuItemId: string, printerId: string, source: RouteOrderSource = "any"): ItemRoute => ({
  id: `ri-${menuItemId}-${printerId}`,
  printerId,
  scope: "menu_item",
  categoryId: null,
  menuItemId,
  orderSource: source,
  copies: 1,
  isActive: true,
});

/** The production order: six Starters, then three Hotdogs, in the order taken. */
const order9 = () =>
  buildKitchenTicket({
    businessName: "Franks",
    branchName: "Main Branch(Dahie)",
    orderNumber: "260916-0003",
    source: "takeaway",
    at: "now",
    lines: [
      { name: "French Fries", qty: 1, menuItemId: "m1", categoryId: STARTERS },
      { name: "Curly Fries", qty: 1, menuItemId: "m2", categoryId: STARTERS },
      { name: "Frank's Fries Hotdog", qty: 1, menuItemId: "m3", categoryId: STARTERS },
      { name: "Frank's Fries Chicken", qty: 1, menuItemId: "m4", categoryId: STARTERS },
      { name: "Cheese Balls", qty: 1, menuItemId: "m5", categoryId: STARTERS },
      { name: "Mozarella Sticks", qty: 1, menuItemId: "m6", categoryId: STARTERS },
      { name: "New York Hotdog", qty: 1, menuItemId: "m7", categoryId: HOTDOGS },
      { name: "Regular Hotdog", qty: 1, menuItemId: "m8", categoryId: HOTDOGS },
      { name: "Double Cheese Hotdog", qty: 1, menuItemId: "m9", categoryId: HOTDOGS },
    ],
  });

const plan = (input: {
  ticket: ReturnType<typeof buildKitchenTicket>;
  routes: ItemRoute[];
  defaultResolution: PrintResolution;
  printers: ServerPrinter[];
  installed: InstalledPrinter[];
  source?: RouteOrderSource;
}) =>
  planKitchenRouting({
    ticket: input.ticket,
    groups: splitTicketByStation({ ticket: input.ticket, routes: input.routes, orderSource: input.source ?? "takeaway" }),
    defaultResolution: input.defaultResolution,
    printers: input.printers,
    installed: input.installed,
  });

const jobFor = (p: ReturnType<typeof plan>, printerId: string) => p.jobs.find((j) => j.printerId === printerId);
const names = (refs: KitchenLineRef[]) => refs.map((r) => r.name);

// --- Case 1: no routing -> one complete ticket -------------------------------

test("no item or category routing: every line goes to the branch default, once", () => {
  const p = plan({ ticket: order9(), routes: [], defaultResolution: singleDefault(), printers: [], installed: [installed("Xprinter XP-80")] });
  assert.equal(p.routable, true);
  assert.equal(p.jobs.length, 1);
  assert.equal(p.jobs[0].printerId, "p-cashier");
  assert.equal(p.jobs[0].lines.length, 9);
  assert.equal(p.unresolved.length, 0);
  assert.equal(p.routed.length, 9);
});

// --- Case 2: everything explicitly routed ------------------------------------

test("all lines have an explicit category route: one complete, routable ticket", () => {
  const ticket = order9();
  const p = plan({
    ticket,
    routes: [categoryRoute(STARTERS, "p-cashier"), categoryRoute(HOTDOGS, "p-cashier")],
    defaultResolution: blockedDefault, // deliberately blocked: nothing should need it
    printers: [printer()],
    installed: [installed("Xprinter XP-80")],
  });
  assert.equal(p.routable, true);
  assert.equal(p.jobs.length, 1);
  assert.equal(p.jobs[0].lines.length, 9);
});

// --- Case 3: the production incident -----------------------------------------

test("mixed routed + no-route lines: plan is NOT routable and names the exact 3", () => {
  const p = plan({
    ticket: order9(),
    routes: [categoryRoute(STARTERS, "p-cashier")], // Hotdogs has no rule; no default route
    defaultResolution: blockedDefault,
    printers: [printer()],
    installed: [installed("Xprinter XP-80")],
  });

  // The whole point: the resolvable subset EXISTS (six Starters would print) but
  // the plan is not routable, so the caller must dispatch nothing.
  assert.equal(p.routable, false);
  assert.deepEqual(unresolvedItemNames(p), ["New York Hotdog", "Regular Hotdog", "Double Cheese Hotdog"]);
  assert.equal(p.unresolved.length, 3);
  // The six Starters DID resolve - proving the loss was a routing gap, not the items.
  const cashier = jobFor(p, "p-cashier");
  assert.ok(cashier);
  assert.equal(cashier?.lines.length, 6);
  // The fix sentence points at kitchen-ticket routing, not receipts.
  assert.match(blockedPlanFix(p), /No kitchen ticket route is configured/);
  assert.match(blockedPlanFix(p), /Printing & Routing/);
});

// --- Case 4: mixed + a configured default ------------------------------------

test("mixed lines with a configured branch default: every line routes", () => {
  const p = plan({
    ticket: order9(),
    routes: [categoryRoute(STARTERS, "p-cashier")],
    defaultResolution: singleDefault({ printerId: "p-default", printerName: "kitchen", windowsName: "Kitchen-Printer" }),
    printers: [printer()],
    installed: [installed("Xprinter XP-80"), installed("Kitchen-Printer")],
  });
  assert.equal(p.routable, true);
  assert.equal(p.jobs.length, 2);
  assert.equal(jobFor(p, "p-cashier")?.lines.length, 6);
  assert.equal(jobFor(p, "p-default")?.lines.length, 3);
});

// --- Case 5: same physical printer coalesces ---------------------------------

test("an explicit group and the default resolving to the SAME printer merge into one job", () => {
  const p = plan({
    ticket: order9(),
    routes: [categoryRoute(STARTERS, "p-cashier")],
    defaultResolution: singleDefault({ printerId: "p-cashier" }), // same station as the rule
    printers: [printer()],
    installed: [installed("Xprinter XP-80")],
  });
  assert.equal(p.routable, true);
  assert.equal(p.jobs.length, 1, "one printer, one ticket - not two fragments");
  assert.equal(p.jobs[0].lines.length, 9);
  // ...and in the order taken, not default-then-rule.
  assert.deepEqual(names(p.jobs[0].refs).slice(0, 2), ["French Fries", "Curly Fries"]);
});

// --- Case 6: distinct printers split, even when sharing a queue --------------

test("explicit groups to DIFFERENT printers stay separate", () => {
  const p = plan({
    ticket: order9(),
    routes: [categoryRoute(STARTERS, "p-cashier"), categoryRoute(HOTDOGS, "p-grill")],
    defaultResolution: blockedDefault,
    printers: [printer(), printer({ id: "p-grill", name: "grill", system_printer_name: "Grill-Printer" })],
    installed: [installed("Xprinter XP-80"), installed("Grill-Printer")],
  });
  assert.equal(p.routable, true);
  assert.equal(p.jobs.length, 2);
  assert.equal(jobFor(p, "p-cashier")?.lines.length, 6);
  assert.equal(jobFor(p, "p-grill")?.lines.length, 3);
});

test("two distinct stations sharing one Windows queue are NOT merged - two tickets are intended", () => {
  const p = plan({
    ticket: order9(),
    routes: [categoryRoute(STARTERS, "p-cashier"), categoryRoute(HOTDOGS, "p-grill")],
    defaultResolution: blockedDefault,
    printers: [printer(), printer({ id: "p-grill", name: "grill", system_printer_name: "Xprinter XP-80" })],
    installed: [installed("Xprinter XP-80")],
  });
  assert.equal(p.jobs.length, 2, "distinct stations = distinct tickets even on a shared queue");
  assert.equal(jobFor(p, "p-cashier")?.target.windowsName, "Xprinter XP-80");
  assert.equal(jobFor(p, "p-grill")?.target.windowsName, "Xprinter XP-80");
});

// --- Case 7: an item rule beats the default for its own line -----------------

test("one item rule routes its line; every unmatched line follows the default", () => {
  const p = plan({
    ticket: order9(),
    routes: [itemRoute("m7", "p-grill")], // just New York Hotdog
    defaultResolution: singleDefault(),
    printers: [printer({ id: "p-grill", name: "grill", system_printer_name: "Grill-Printer" })],
    installed: [installed("Xprinter XP-80"), installed("Grill-Printer")],
  });
  assert.equal(p.routable, true);
  assert.equal(p.jobs.length, 2);
  assert.deepEqual(names(jobFor(p, "p-grill")?.refs ?? []), ["New York Hotdog"]);
  assert.equal(jobFor(p, "p-cashier")?.lines.length, 8);
});

// --- Case: a station rule pointing at a deleted printer fails closed ---------

test("a rule that names a printer this branch no longer has blocks, never drops", () => {
  const p = plan({
    ticket: order9(),
    routes: [categoryRoute(HOTDOGS, "p-ghost")], // printer p-ghost is not in the list
    defaultResolution: singleDefault(),
    printers: [printer()],
    installed: [installed("Xprinter XP-80")],
  });
  assert.equal(p.routable, false);
  assert.deepEqual(unresolvedItemNames(p), ["New York Hotdog", "Regular Hotdog", "Double Cheese Hotdog"]);
  assert.match(blockedPlanFix(p), /no longer exists/);
});

// --- Case: a routed printer not installed on THIS terminal fails closed ------

test("a routed station whose Windows queue is not installed here blocks, never drops", () => {
  const p = plan({
    ticket: order9(),
    routes: [categoryRoute(HOTDOGS, "p-grill")],
    defaultResolution: singleDefault(),
    printers: [printer(), printer({ id: "p-grill", name: "grill", system_printer_name: "Grill-Printer" })],
    installed: [installed("Xprinter XP-80")], // Grill-Printer absent
  });
  assert.equal(p.routable, false);
  assert.deepEqual(unresolvedItemNames(p), ["New York Hotdog", "Regular Hotdog", "Double Cheese Hotdog"]);
  assert.match(blockedPlanFix(p), /not installed on this terminal/);
});

// --- Cases 13/14: modifiers, notes and quantity survive routing --------------

test("modifiers, notes and quantity are carried onto the routed line unchanged", () => {
  const ticket = buildKitchenTicket({
    businessName: "B",
    branchName: "Br",
    orderNumber: "1",
    source: "takeaway",
    at: "now",
    lines: [{ name: "Zinger", qty: 3, menuItemId: "z1", categoryId: STARTERS, modifiers: [{ name: "Spicy" }], note: "No mayo" }],
  });
  const p = plan({ ticket, routes: [categoryRoute(STARTERS, "p-cashier")], defaultResolution: blockedDefault, printers: [printer()], installed: [installed("Xprinter XP-80")] });
  assert.equal(p.routable, true);
  const l = p.jobs[0].lines[0];
  assert.equal(l.qty, 3);
  assert.equal(l.note, "No mayo");
  assert.deepEqual(l.modifiers, [{ name: "Spicy", quantity: 1 }]);
});

// --- Case 15: non-kitchen / zero-quantity lines are excluded upstream --------

test("zero-quantity lines never become eligible, so they are never an unresolved remainder", () => {
  const ticket = buildKitchenTicket({
    businessName: "B",
    branchName: "Br",
    orderNumber: "1",
    source: "takeaway",
    at: "now",
    lines: [
      { name: "Fries", qty: 0, menuItemId: "m1", categoryId: STARTERS },
      { name: "Burger", qty: 1, menuItemId: "m2", categoryId: STARTERS },
    ],
  });
  const p = plan({ ticket, routes: [], defaultResolution: singleDefault(), printers: [], installed: [installed("Xprinter XP-80")] });
  assert.equal(p.eligible.length, 1);
  assert.deepEqual(names(p.eligible), ["Burger"]);
});

// --- Case 16: a printer failing AFTER preflight is a physical failure --------

test("classification distinguishes physical failure from an unroutable plan", () => {
  const refs = (name: string): KitchenLineRef[] => [{ index: 0, name, categoryId: null }];
  const sent = (id: string): JobDispatchResult => ({ kind: "sent", printerId: id, printer: id, copies: 1, refs: refs("A") });
  const failed = (id: string): JobDispatchResult => ({ kind: "failed", printerId: id, printer: id, message: "jam", refs: refs("B") });
  const skipped = (id: string): JobDispatchResult => ({ kind: "skipped", printerId: id, refs: refs("C") });

  assert.equal(classifyKitchenDispatch({ results: [sent("a"), failed("b")] }).overallStatus, "partial_physical_failure");
  assert.equal(classifyKitchenDispatch({ results: [failed("b")] }).overallStatus, "complete_failure");
  assert.equal(classifyKitchenDispatch({ results: [sent("a")] }).overallStatus, "success");
  assert.equal(classifyKitchenDispatch({ results: [skipped("a")] }).overallStatus, "manual");
  // A skipped destination (auto-print vetoed on this till) is not a failure.
  assert.equal(classifyKitchenDispatch({ results: [sent("a"), skipped("b")] }).overallStatus, "success");
  // The printed/failed line evidence is exact.
  const partial = classifyKitchenDispatch({ results: [sent("a"), failed("b")] });
  assert.deepEqual(partial.printedLineIndexes, [0]);
  assert.deepEqual(partial.failedLineIndexes, [0]);
});

// --- Cases 17/18/19: isolation, no duplication -------------------------------

test("the plan holds no opinion about which tenant or branch - it only reads what it is given", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "pos", "kitchenRoutingPlan.ts"), "utf8");
  for (const forbidden of ["supabase", "loadServerPrinters", "loadItemRoutes", "printKitchenTicket", "invoke", "rpc("]) {
    assert.equal(src.includes(forbidden), false, `${forbidden} must not be reachable from the pure plan`);
  }
});

test("no line is placed on more than one job, and routed + unresolved accounts for every eligible line", () => {
  const p = plan({
    ticket: order9(),
    routes: [categoryRoute(STARTERS, "p-cashier"), categoryRoute(HOTDOGS, "p-grill")],
    defaultResolution: blockedDefault,
    printers: [printer(), printer({ id: "p-grill", name: "grill", system_printer_name: "Grill-Printer" })],
    installed: [installed("Xprinter XP-80"), installed("Grill-Printer")],
  });
  const placed = p.jobs.flatMap((j) => j.refs.map((r) => r.index));
  assert.equal(new Set(placed).size, placed.length, "a line must not be duplicated across jobs");
  assert.equal(p.routed.length + p.unresolved.length, p.eligible.length);
});

// --- wiring: the preflight gate precedes any dispatch ------------------------

const srcRoot = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(srcRoot, "..", "src", ...p), "utf8");
const dropLineComments = (src: string) => src.replace(/^[^\S\r\n]*\/\/[^\r\n]*(\r?\n)/gm, "");
const readTs = (...p: string[]) => stripComments(dropLineComments(readSrc(...p)));
const readJsx = (...p: string[]) => stripJsxComments(dropLineComments(readSrc(...p)));

test("nothing is dispatched until the plan is proven routable", () => {
  const src = readTs("lib", "pos", "autoPrintRun.ts");
  const fn = src.slice(src.indexOf("export async function autoPrintKitchenTicket"), src.indexOf("async function dispatchKitchenJob"));
  // The plan is built, then the gate, then the dispatch loop - in that order.
  assert.ok(fn.indexOf("planKitchenRouting(") < fn.indexOf("if (!plan.routable)"), "the plan is built before it is checked");
  assert.ok(fn.indexOf("if (!plan.routable)") < fn.indexOf("for (const job of plan.jobs)"), "the gate precedes the dispatch loop");
  assert.match(fn, /return \{ kind: "blocked"/);
  // The blocked return carries the items and the fix, from the plan.
  assert.match(fn, /items: unresolvedItemNames\(plan\)/);
  assert.match(fn, /blockedPlanFix\(plan\)/);
});

test("a blocked kitchen send is SHOWN and named, never merely staged", () => {
  const workspace = readJsx("screens", "pos", "PosWorkspace.tsx");
  const fn = workspace.slice(workspace.indexOf("const printKitchenFor"), workspace.indexOf("const presentReceipt"));
  const blocked = fn.slice(fn.indexOf('status.kind === "blocked"'));
  assert.ok(fn.includes('status.kind === "blocked"'), "the blocked case is handled");
  // Presented (visible), not staged, so the operator cannot walk past it.
  assert.match(blocked, /kitchenStore\.present\(ticket, status\)/);
  assert.match(blocked, /tone: "error"/);
  assert.match(blocked, /status\.items\.join/);
});

test("the modal lists the exact items that could not be routed", () => {
  const modal = readJsx("screens", "pos", "KitchenTicketPreview.tsx");
  const block = modal.slice(modal.indexOf('status.kind === "blocked"'));
  assert.ok(modal.includes('status.kind === "blocked"'));
  assert.match(block, /status\.items\.map/);
  assert.match(block, /Kitchen ticket not printed/);
});

test("the store carries a blocked status and shows it", () => {
  const store = readTs("state", "kitchenTicket.ts");
  assert.match(store, /kind: "blocked"; message: string; items: string\[\]/);
  // present() shows anything that is not a silent auto-send; blocked qualifies.
  assert.match(store, /visible: status\.kind !== "auto_sent"/);
});
