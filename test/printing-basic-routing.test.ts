// Basic print routing and the Test Center.
//
// Three properties these tests exist to protect.
//
// ONE, "use default" is the absence of a row. The whole of basic routing rests
// on the server matching an exact order source first and an `any` route second,
// so a Takeaway row that names the same printer as the default is not a harmless
// duplicate - it is a silent decision to stop following the default, taken by a
// screen rather than by the operator.
//
// TWO, the server resolves. Nothing on this side re-implements precedence, picks
// a printer when the server says none matched, or falls back to whatever Windows
// calls default. An unresolved route is a configuration state with a sentence,
// not an error and not an excuse to guess.
//
// THREE, simulating is not transacting and never printing. The Test Center may
// read the resolver as often as it likes because reading creates nothing; what
// it may never do is create an order, take money, or put paper through a
// printer without a confirmation that names the device.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MAX_COPIES } from "@/lib/nativePrinting";
import { FEATURES } from "@/lib/features";
import type { ServerPrinter } from "@/lib/pos/printerRegistry";
import { classifyPrinters } from "@/lib/pos/quickSetup";
import {
  EDITABLE_ORDER_SOURCES,
  PRINT_PURPOSES,
  RESOLVER_ORDER_SOURCES,
  ROUTE_PERMISSIONS,
  TESTABLE_ORDER_SOURCES,
  canManageRoutes,
  destinationReadiness,
  draftForRoute,
  indexRoutes,
  isDirty,
  isLocallyPrintable,
  isPrintPurpose,
  orderSourceLabel,
  planSave,
  printerOptions,
  purposeLabel,
  purposeSectionLabel,
  recommendedPrinterType,
  routeFor,
  routeWriteMessage,
  slotKey,
  type BasicRoute,
  type PrintPurpose,
} from "@/lib/pos/printRouting";
import {
  BASIC_SCOPE_TYPE,
} from "@/lib/pos/printRouteRepository";
import {
  RESOLVE_PRINT_ROUTE,
  UNRESOLVED,
  parseResolvedRoute,
  type ResolvedRoute,
} from "@/lib/pos/printRouteResolver";
import {
  NOT_A_REAL_ORDER,
  PHYSICAL_TEST_UNAVAILABLE,
  TEST_KITCHEN_TITLE,
  TEST_RECEIPT_TITLE,
  confirmationSentence,
  matchExplanation,
  syntheticDocument,
  syntheticKitchenTicket,
  syntheticReceipt,
  unresolvedExplanation,
} from "@/lib/pos/printTestCenter";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");

const routingModel = stripComments(readSrc("lib", "pos", "printRouting.ts"));
const repository = stripComments(readSrc("lib", "pos", "printRouteRepository.ts"));
const resolverClient = stripComments(readSrc("lib", "pos", "printRouteResolver.ts"));
const testCenterModel = stripComments(readSrc("lib", "pos", "printTestCenter.ts"));
const routingScreen = stripJsxComments(readSrc("screens", "settings", "PrintRouting.tsx"));
const testCenterScreen = stripJsxComments(readSrc("screens", "settings", "PrintTestCenter.tsx"));

// --- fixtures ----------------------------------------------------------------

const route = (over: Partial<BasicRoute> = {}): BasicRoute => ({
  id: "r1",
  printer_id: "printer-cashier",
  print_purpose: "receipt",
  order_source: "any",
  copy_count: 1,
  is_active: true,
  ...over,
});

const printer = (over: Partial<ServerPrinter> = {}): ServerPrinter => ({
  id: "printer-cashier",
  name: "Front Cashier",
  printer_type: "cashier",
  connection_type: "system",
  system_printer_name: "Xprinter XP-80",
  paper_width: "custom",
  custom_paper_width: 72,
  default_copy_count: 1,
  auto_cut_enabled: false,
  cash_drawer_enabled: false,
  status: "unknown",
  station_id: null,
  branch_id: "b1",
  is_active: true,
  ...over,
});

/** The staging fixture: an XP-80 cashier printer and an unbound kitchen row. */
const stagingPrinters = () =>
  classifyPrinters(
    [
      printer(),
      printer({
        id: "printer-kitchen",
        name: "QA Test Printer (delete me)",
        printer_type: "kitchen",
        system_printer_name: null,
        paper_width: "80mm",
        custom_paper_width: null,
      }),
    ],
    [{ name: "Xprinter XP-80", is_default: false, status: "ready" }],
  );

const resolved = (over: Partial<ResolvedRoute> = {}): ResolvedRoute => ({
  resolved: true,
  route_id: "r1",
  printer_id: "printer-cashier",
  printer_name: "Front Cashier",
  printer_type: "cashier",
  connection_type: "system",
  system_printer_name: "Xprinter XP-80",
  paper_width: "custom",
  custom_paper_width: 72,
  copies: 1,
  print_purpose: "receipt",
  matched_order_source: "any",
  used_default: true,
  ...over,
});

// --- the vocabulary ----------------------------------------------------------

test("only the two canonical print purposes exist", () => {
  assert.deepEqual([...PRINT_PURPOSES], ["receipt", "kitchen_ticket"]);
  // The four words that are NOT purposes: two are how people say "receipt",
  // two are printer roles.
  for (const wrong of ["customer", "cashier", "kitchen", "ticket"]) {
    assert.equal(isPrintPurpose(wrong), false, `${wrong} is not a print purpose`);
  }
});

test("a print purpose is never derived from a printer's type", () => {
  // printer_type decides the RECOMMENDATION order and nothing else.
  assert.equal(recommendedPrinterType("receipt"), "cashier");
  assert.equal(recommendedPrinterType("kitchen_ticket"), "kitchen");
  assert.equal(routingModel.includes("printer_type === \"kitchen\" ? \"kitchen_ticket\""), false);
});

test("the editable rows are the default plus three order sources", () => {
  assert.deepEqual([...EDITABLE_ORDER_SOURCES], ["any", "takeaway", "dine_in", "delivery"]);
  assert.deepEqual([...TESTABLE_ORDER_SOURCES], ["takeaway", "dine_in", "delivery"]);
  // `any` is a route scope, never something an order can be.
  assert.equal((RESOLVER_ORDER_SOURCES as readonly string[]).includes("any"), false);
});

test("the operator never reads a database word", () => {
  assert.equal(orderSourceLabel("any"), "Default");
  assert.equal(orderSourceLabel("dine_in"), "Dine-In");
  assert.equal(purposeLabel("kitchen_ticket"), "Kitchen ticket");
  assert.equal(purposeSectionLabel("receipt"), "Customer receipts");
  for (const raw of ["scope_type", "print_purpose", "order_source", "sort_order", "priority", "kitchen_print_routes"]) {
    assert.equal(routingScreen.includes(`>${raw}`), false, `${raw} must not be rendered`);
  }
});

// --- the grid ----------------------------------------------------------------

test("an unconfigured branch shows every row as unset, and saving does nothing", () => {
  const indexed = indexRoutes([]);
  for (const purpose of PRINT_PURPOSES) {
    for (const source of EDITABLE_ORDER_SOURCES) {
      const existing = routeFor(indexed, purpose, source);
      assert.equal(existing, null);
      const draft = draftForRoute(existing);
      assert.equal(draft.printerId, null);
      assert.equal(isDirty(draft, existing), false);
      assert.deepEqual(planSave({ purpose, source, draft, existing }), { kind: "none" });
    }
  }
});

test("an active row wins over a disabled leftover for the same slot", () => {
  // The uniqueness constraint covers ACTIVE routes only, so both can exist.
  const indexed = indexRoutes([
    route({ id: "stale", is_active: false, printer_id: "printer-old" }),
    route({ id: "live", printer_id: "printer-cashier" }),
  ]);
  assert.equal(routeFor(indexed, "receipt", "any")?.id, "live");
});

test("a disabled route reads as unset, so the screen does not name a printer nothing prints to", () => {
  const draft = draftForRoute(route({ is_active: false }));
  assert.equal(draft.printerId, null);
});

test("routes are keyed by purpose AND source - the two grids never collide", () => {
  const indexed = indexRoutes([
    route({ id: "receipt-default" }),
    route({ id: "kitchen-default", print_purpose: "kitchen_ticket" }),
  ]);
  assert.equal(routeFor(indexed, "receipt", "any")?.id, "receipt-default");
  assert.equal(routeFor(indexed, "kitchen_ticket", "any")?.id, "kitchen-default");
  assert.notEqual(slotKey("receipt", "any"), slotKey("kitchen_ticket", "any"));
});

test("an order source this phase cannot show is recognised, not mangled", () => {
  // An e_menu route is real configuration. Parsing it into one of the four
  // editable slots would let this screen overwrite a row it never displayed.
  const indexed = indexRoutes([route({ id: "emenu", order_source: "e_menu" })]);
  assert.equal(routeFor(indexed, "receipt", "any"), null);
  assert.equal(indexed[slotKey("receipt", "e_menu")]?.id, "emenu");
});

// --- saving ------------------------------------------------------------------

test("a default receipt route is created with the purpose and the `any` source", () => {
  const plan = planSave({
    purpose: "receipt",
    source: "any",
    draft: { printerId: "printer-cashier", copies: 1 },
    existing: null,
  });
  assert.deepEqual(plan, {
    kind: "create",
    purpose: "receipt",
    source: "any",
    printerId: "printer-cashier",
    copies: 1,
  });
});

test("a default kitchen route is the same shape with the other purpose", () => {
  const plan = planSave({
    purpose: "kitchen_ticket",
    source: "any",
    draft: { printerId: "printer-kitchen", copies: 2 },
    existing: null,
  });
  assert.equal(plan.kind === "create" && plan.purpose, "kitchen_ticket");
  assert.equal(plan.kind === "create" && plan.source, "any");
  assert.equal(plan.kind === "create" && plan.copies, 2);
});

test("each source override is created against its own source", () => {
  for (const source of ["takeaway", "dine_in", "delivery"] as const) {
    const plan = planSave({
      purpose: "receipt",
      source,
      draft: { printerId: "printer-cashier", copies: 1 },
      existing: null,
    });
    assert.equal(plan.kind === "create" && plan.source, source);
  }
});

test("choosing Use Default REMOVES the source row rather than copying the default", () => {
  // The property the whole feature rests on. A Takeaway row naming the same
  // printer as the default looks identical today and stops following it
  // tomorrow.
  const existing = route({ id: "takeaway-row", order_source: "takeaway" });
  assert.deepEqual(
    planSave({ purpose: "receipt", source: "takeaway", draft: { printerId: null, copies: 1 }, existing }),
    { kind: "remove", id: "takeaway-row" },
  );
});

test("Use Default on a source that has no row is a no-op, not a write", () => {
  assert.deepEqual(
    planSave({ purpose: "receipt", source: "delivery", draft: { printerId: null, copies: 1 }, existing: null }),
    { kind: "none" },
  );
});

test("clearing the picker never deletes the default route", () => {
  const existing = route({ id: "default-row", order_source: "any" });
  assert.deepEqual(
    planSave({ purpose: "receipt", source: "any", draft: { printerId: null, copies: 1 }, existing }),
    { kind: "none" },
  );
});

test("an existing row is updated in place, including a disabled one", () => {
  const plan = planSave({
    purpose: "receipt",
    source: "any",
    draft: { printerId: "printer-kitchen", copies: 3 },
    existing: route({ id: "default-row", is_active: false }),
  });
  // Reusing the disabled row rather than inserting beside it: the uniqueness
  // constraint would accept the insert, and the branch would then own two rows
  // describing one decision.
  assert.deepEqual(plan, { kind: "update", id: "default-row", printerId: "printer-kitchen", copies: 3 });
});

test("copies are bounded, and an out-of-range value is refused rather than clamped", () => {
  for (const copies of [0, -1, 1.5, MAX_COPIES + 1, Number.NaN]) {
    const plan = planSave({
      purpose: "receipt",
      source: "any",
      draft: { printerId: "printer-cashier", copies },
      existing: null,
    });
    assert.equal(plan.kind, "invalid", `copies=${copies}`);
  }
  assert.equal(
    planSave({
      purpose: "receipt",
      source: "any",
      draft: { printerId: "printer-cashier", copies: MAX_COPIES },
      existing: null,
    }).kind,
    "create",
  );
});

test("a row is only offered for saving once something actually changed", () => {
  const existing = route({ copy_count: 2 });
  assert.equal(isDirty({ printerId: "printer-cashier", copies: 2 }, existing), false);
  assert.equal(isDirty({ printerId: "printer-cashier", copies: 3 }, existing), true);
  assert.equal(isDirty({ printerId: "printer-kitchen", copies: 2 }, existing), true);
  assert.equal(isDirty({ printerId: null, copies: 2 }, existing), true);
});

// --- what a write may touch --------------------------------------------------

test("routing writes reach exactly one table", () => {
  const tables = [...repository.matchAll(/from\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ["kitchen_print_routes"]);
});

test("no advanced routing column is ever written", () => {
  // These are real server features belonging to a later phase. A screen that
  // cannot show them must not be able to blank them.
  for (const column of [
    "station_id",
    "section_id",
    "menu_category_id",
    "menu_item_id",
    "preparation_component_id",
    "receipt_type",
    "ticket_type",
    "template_id",
    "priority",
    "sort_order",
  ]) {
    assert.equal(repository.includes(column), false, `${column} must not appear in route writes`);
  }
});

test("every basic route carries the order-source scope", () => {
  assert.equal(BASIC_SCOPE_TYPE, "order_source");
  assert.match(repository, /scope_type: BASIC_SCOPE_TYPE/);
});

test("there is no is_default flag anywhere - a default is a route with source `any`", () => {
  for (const src of [routingModel, repository, routingScreen]) {
    assert.equal(src.includes("is_default"), false);
  }
});

test("routing keeps no local source of truth", () => {
  for (const src of [routingModel, repository, resolverClient, routingScreen, testCenterScreen, testCenterModel]) {
    assert.equal(src.includes("localStorage"), false);
    assert.equal(src.includes("lib/printers"), false);
    assert.equal(src.includes("loadPrinters"), false);
    assert.equal(src.includes("savePrinters"), false);
  }
});

// --- write errors ------------------------------------------------------------

test("a duplicate is explained, and nothing is retried", () => {
  assert.match(routeWriteMessage({ code: "23505", message: 'duplicate key value violates unique constraint' }), /already exists/);
  assert.match(routeWriteMessage({ message: "duplicate key value violates unique constraint" }), /already exists/);
  // No retry loop anywhere near a write.
  assert.equal(/retry|setTimeout|attempt\+\+/i.test(routingScreen), false);
});

test("a refusal is a sentence about permission, not a policy name", () => {
  for (const error of [
    { code: "42501", message: 'new row violates row-level security policy for table "kitchen_print_routes"' },
    { message: "permission denied for table kitchen_print_routes" },
  ]) {
    assert.match(routeWriteMessage(error), /do not have permission/);
  }
});

test("a feature refusal points at the plan, not at the operator", () => {
  assert.match(
    routeWriteMessage({ message: "assert_feature_access: feature kitchen_ops is not enabled for this subscription" }),
    /not enabled for this plan/,
  );
});

test("an unknown failure still says something, and never an empty string", () => {
  assert.ok(routeWriteMessage({}).length > 0);
  assert.ok(routeWriteMessage(null).length > 0);
  assert.equal(routeWriteMessage({ message: "connection refused" }), "connection refused");
});

// --- permissions -------------------------------------------------------------

test("receipt routing is POS configuration", () => {
  const features = { [FEATURES.POS]: true };
  assert.equal(
    canManageRoutes({ purpose: "receipt", permissions: { [ROUTE_PERMISSIONS.RECEIPT]: true }, features }).allowed,
    true,
  );
  // The practical path on a POS-only tenant.
  assert.equal(
    canManageRoutes({ purpose: "receipt", permissions: { [ROUTE_PERMISSIONS.RECEIPT_ALT]: true }, features }).allowed,
    true,
  );
  assert.equal(canManageRoutes({ purpose: "receipt", permissions: {}, features }).allowed, false);
  assert.equal(ROUTE_PERMISSIONS.RECEIPT, "kitchen.manage_printers");
  assert.equal(ROUTE_PERMISSIONS.RECEIPT_ALT, "pos.settings.manage");
});

test("kitchen ticket routing is Kitchen Ops configuration, with its own keys", () => {
  const features = { [FEATURES.KITCHEN_OPS]: true };
  assert.equal(
    canManageRoutes({ purpose: "kitchen_ticket", permissions: { [ROUTE_PERMISSIONS.KITCHEN]: true }, features }).allowed,
    true,
  );
  assert.equal(
    canManageRoutes({ purpose: "kitchen_ticket", permissions: { [ROUTE_PERMISSIONS.KITCHEN_ALT]: true }, features }).allowed,
    true,
  );
  // A POS permission does not open kitchen routing.
  assert.equal(
    canManageRoutes({ purpose: "kitchen_ticket", permissions: { [ROUTE_PERMISSIONS.RECEIPT_ALT]: true }, features }).allowed,
    false,
  );
  assert.equal(ROUTE_PERMISSIONS.KITCHEN, "kitchen.manage_print_routing");
  assert.equal(ROUTE_PERMISSIONS.KITCHEN_ALT, "kitchen.manage_configuration");
});

test("the feature is refused before the permission, in the order the server refuses", () => {
  const gate = canManageRoutes({
    purpose: "kitchen_ticket",
    permissions: { [ROUTE_PERMISSIONS.KITCHEN]: true },
    features: {},
  });
  assert.equal(gate.allowed, false);
  // Telling someone they lack a permission they hold sends them to fix the
  // wrong thing.
  assert.match(gate.reason ?? "", /Kitchen Ops is not enabled/);
});

test("a POS-only tenant is told why kitchen routing is unavailable, not shown a broken row", () => {
  const gate = canManageRoutes({ purpose: "kitchen_ticket", permissions: {}, features: { [FEATURES.POS]: true } });
  assert.equal(gate.allowed, false);
  assert.ok((gate.reason ?? "").length > 0);
});

test("no role name is used as an authorisation check anywhere in routing", () => {
  // NB "cashier" is deliberately absent from this list: in routing it is a
  // `printer_type`, not a tenant role, and it appears only where the screen
  // decides which printers to RECOMMEND. `"cashier_role"` stands in for the
  // role spelling, exactly as the Quick Setup suite does.
  for (const token of ['"owner"', '"manager"', '"cashier_role"', "role ===", "membership.role"]) {
    assert.equal(routingModel.includes(token), false, `${token} must not gate routing`);
    assert.equal(routingScreen.includes(token), false, `${token} must not gate the routing screen`);
  }
});

test("write controls are gated in the screen, not merely styled", () => {
  assert.match(routingScreen, /canManageRoutes\(/);
  assert.match(routingScreen, /disabled=\{!gate\.allowed/);
  assert.match(routingScreen, /gate\.allowed && dirty/);
});

// --- printer choice ----------------------------------------------------------

test("a receipt route recommends cashier printers first", () => {
  const options = printerOptions({ purpose: "receipt", printers: stagingPrinters(), selectedId: null });
  assert.equal(options[0].name, "Front Cashier");
  assert.equal(options[0].recommended, true);
  assert.equal(options[1].recommended, false);
});

test("a kitchen ticket route recommends kitchen printers first", () => {
  const options = printerOptions({ purpose: "kitchen_ticket", printers: stagingPrinters(), selectedId: null });
  assert.equal(options[0].name, "QA Test Printer (delete me)");
  assert.equal(options[0].recommended, true);
});

test("one physical printer may serve both purposes - the type recommends, it never blocks", () => {
  // A restaurant with a single till printer is a supported restaurant.
  const receipt = printerOptions({ purpose: "receipt", printers: stagingPrinters(), selectedId: null });
  const kitchen = printerOptions({ purpose: "kitchen_ticket", printers: stagingPrinters(), selectedId: null });
  assert.ok(receipt.some((o) => o.id === "printer-kitchen"), "a kitchen printer may print receipts");
  assert.ok(kitchen.some((o) => o.id === "printer-cashier"), "a cashier printer may print tickets");
  assert.equal(receipt.length, kitchen.length);
});

test("local readiness travels with the option but never filters it", () => {
  const options = printerOptions({ purpose: "receipt", printers: stagingPrinters(), selectedId: null });
  const cashier = options.find((o) => o.id === "printer-cashier");
  const kitchen = options.find((o) => o.id === "printer-kitchen");
  assert.equal(cashier?.readiness, "ready");
  assert.equal(cashier?.paperWidth, "custom:72");
  // The staging kitchen fixture has no Windows printer bound.
  assert.equal(kitchen?.readiness, "unbound");
  assert.equal(kitchen?.windowsName, null);
});

test("a route to a printer this terminal cannot see stays offered and stays configured", () => {
  const elsewhere = classifyPrinters([printer({ system_printer_name: "Kitchen Star TSP" })], []);
  const options = printerOptions({ purpose: "receipt", printers: elsewhere, selectedId: "printer-cashier" });
  assert.equal(options.length, 1);
  assert.equal(options[0].readiness, "missing");
});

test("a disabled printer is not offered, unless it is the one already routed to", () => {
  const disabled = classifyPrinters([printer({ is_active: false })], []);
  assert.equal(printerOptions({ purpose: "receipt", printers: disabled, selectedId: null }).length, 0);
  assert.equal(printerOptions({ purpose: "receipt", printers: disabled, selectedId: "printer-cashier" }).length, 1);
});

test("the Windows default printer is never used as a fallback", () => {
  // Windows saying a printer is default is a fact about one PC, not a decision
  // the branch made.
  for (const src of [routingModel, routingScreen, testCenterScreen, testCenterModel]) {
    assert.equal(src.includes("is_default"), false);
  }
  const withDefault = classifyPrinters(
    [printer()],
    [{ name: "Xprinter XP-80", is_default: true, status: "ready" }],
  );
  const options = printerOptions({ purpose: "receipt", printers: withDefault, selectedId: null });
  // Offered, yes. Selected, no - nothing here returns a selection at all.
  assert.equal(options.length, 1);
});

// --- the resolver ------------------------------------------------------------

test("the shared RPC is called by its contract name and its three parameters", () => {
  assert.equal(RESOLVE_PRINT_ROUTE, "resolve_print_route");
  assert.match(resolverClient, /p_branch: input\.branchId/);
  assert.match(resolverClient, /p_purpose: input\.purpose/);
  assert.match(resolverClient, /p_order_source: input\.orderSource/);
});

test("a one-row array is the shape PostgREST returns, and is read as one route", () => {
  const parsed = parseResolvedRoute([resolved()]);
  assert.equal(parsed.resolved, true);
  assert.equal(parsed.printer_name, "Front Cashier");
  assert.equal(parsed.used_default, true);
});

test("the custom 72 mm XP-80 survives the resolver round trip", () => {
  const parsed = parseResolvedRoute([resolved()]);
  const readiness = destinationReadiness({
    connectionType: parsed.connection_type,
    systemPrinterName: parsed.system_printer_name,
    paperWidth: parsed.paper_width,
    customPaperWidth: parsed.custom_paper_width,
    installedNames: ["Xprinter XP-80"],
  });
  assert.equal(readiness.paperWidth, "custom:72");
  assert.equal(readiness.status, "ready");
  assert.equal(isLocallyPrintable(readiness), true);
});

test("the copy count comes from the route, not from the printer's default", () => {
  assert.equal(parseResolvedRoute([resolved({ copies: 3 })]).copies, 3);
  // Absent is null - which the screen shows as one page, never as the
  // printer's own setting quietly substituted.
  assert.equal(parseResolvedRoute([resolved({ copies: null })]).copies, null);
});

test("an unresolved answer is a normal state, with no printer invented", () => {
  const parsed = parseResolvedRoute([{ resolved: false, print_purpose: "kitchen_ticket" }]);
  assert.equal(parsed.resolved, false);
  assert.equal(parsed.printer_id, null);
  assert.equal(parsed.printer_name, null);
  assert.equal(parsed.system_printer_name, null);
  assert.equal(parsed.copies, null);
});

test("a malformed or empty answer degrades to unresolved instead of throwing", () => {
  for (const raw of [null, undefined, [], {}, "", 0, [null], ["nonsense"], [{ resolved: "yes" }]]) {
    const parsed = parseResolvedRoute(raw);
    assert.equal(parsed.resolved, false, JSON.stringify(raw));
    assert.equal(parsed.printer_id, null);
  }
  assert.deepEqual(parseResolvedRoute([]), UNRESOLVED);
});

test("the resolver client is not a POS RPC and cannot become one", () => {
  // `PosRpcName` is the list of RPCs that create orders and move money.
  assert.equal(resolverClient.includes("callPosRpc"), false);
  assert.equal(resolverClient.includes("PosRpcName"), false);
  const posRpc = stripComments(readSrc("lib", "pos", "rpc.ts"));
  assert.equal(posRpc.includes("resolve_print_route"), false);
});

// --- match explanation -------------------------------------------------------

test("a default match says so, for each purpose", () => {
  assert.equal(matchExplanation(resolved({ used_default: true }), "receipt"), "Default receipt route");
  assert.equal(
    matchExplanation(resolved({ used_default: true, print_purpose: "kitchen_ticket" }), "kitchen_ticket"),
    "Default kitchen route",
  );
});

test("an exact-source match names the source", () => {
  assert.equal(
    matchExplanation(resolved({ used_default: false, matched_order_source: "takeaway" }), "receipt"),
    "Takeaway-specific receipt route",
  );
  assert.equal(
    matchExplanation(resolved({ used_default: false, matched_order_source: "dine_in" }), "receipt"),
    "Dine-In-specific receipt route",
  );
  assert.equal(
    matchExplanation(resolved({ used_default: false, matched_order_source: "delivery", print_purpose: "kitchen_ticket" }), "kitchen_ticket"),
    "Delivery-specific kitchen route",
  );
});

test("a matched `any` source reads as the default even without the flag", () => {
  assert.equal(
    matchExplanation(resolved({ used_default: null, matched_order_source: "any" }), "receipt"),
    "Default receipt route",
  );
});

test("an unexplained match is not dressed up as a default", () => {
  const explanation = matchExplanation(resolved({ used_default: null, matched_order_source: null }), "receipt");
  assert.equal(explanation, "Configured receipt route");
});

test("nothing is explained when nothing matched", () => {
  assert.equal(matchExplanation(UNRESOLVED, "receipt"), null);
  assert.match(unresolvedExplanation("receipt"), /No matching receipt route/);
  assert.match(unresolvedExplanation("kitchen_ticket"), /No matching kitchen ticket route/);
});

// --- the Test Center ---------------------------------------------------------

test("the Test Center asks the resolver twice for whichever source is selected", () => {
  // Both purposes, every time: a branch with receipts routed and tickets not is
  // the commonest real fault, and one-at-a-time hides exactly that.
  assert.match(testCenterScreen, /for \(const purpose of PRINT_PURPOSES\)/);
  assert.match(testCenterScreen, /resolvePrintRoute\(\{ branchId, purpose, orderSource: source \}\)/);
  assert.match(testCenterScreen, /TESTABLE_ORDER_SOURCES\.map/);
});

test("the Test Center uses the session's branch, never a typed or remembered one", () => {
  assert.match(testCenterScreen, /const branchId = pos\.branch\.id/);
  assert.equal(testCenterScreen.includes("p_branch"), false);
});

test("both the match reason and the unresolved sentence reach the screen", () => {
  assert.match(testCenterScreen, /Matched: \{matchExplanation\(route, purpose\)\}/);
  assert.match(testCenterScreen, /unresolvedExplanation\(purpose\)/);
  assert.match(testCenterScreen, /Configure route/);
});

test("an unresolved result never falls back to a printer", () => {
  for (const token of ["is_default", "printers[0]", "cashier", "?? installed[0]", "firstConfigured"]) {
    assert.equal(testCenterScreen.includes(token), false, `${token} must not be a fallback`);
  }
});

test("the synthetic documents announce themselves twice and carry no order", () => {
  for (const source of TESTABLE_ORDER_SOURCES) {
    for (const purpose of PRINT_PURPOSES) {
      const doc = syntheticDocument(purpose, source);
      assert.equal(doc.banner, NOT_A_REAL_ORDER);
      assert.ok(doc.title === TEST_RECEIPT_TITLE || doc.title === TEST_KITCHEN_TITLE);
      assert.ok(doc.lines.some((l) => l.includes(orderSourceLabel(source))));
      const body = doc.lines.join("\n");
      assert.match(body, /Test /);
      // A page found on a counter must not read as a record of money taken.
      assert.equal(/total/i.test(body), false);
      assert.equal(/\$|USD|LBP/.test(body), false);
      assert.match(body, /none - this is a test/);
    }
  }
  assert.equal(syntheticReceipt("takeaway").title, TEST_RECEIPT_TITLE);
  assert.equal(syntheticKitchenTicket("takeaway").title, TEST_KITCHEN_TITLE);
});

test("the confirmation names every fact that decides where paper appears", () => {
  const sentence = confirmationSentence({
    document: TEST_RECEIPT_TITLE,
    source: "takeaway",
    printerAlias: "Front Cashier",
    windowsPrinterName: "Xprinter XP-80",
    paperWidth: "custom:72",
    copies: 1,
  });
  assert.match(sentence, /1 TEST RECEIPT/);
  assert.match(sentence, /Takeaway/);
  assert.match(sentence, /Front Cashier/);
  assert.match(sentence, /Xprinter XP-80/);
  assert.match(sentence, /72 mm printable/);
});

test("a physical test is only ever offered for a locally printable destination", () => {
  const remote = destinationReadiness({
    connectionType: "system",
    systemPrinterName: "Kitchen Star TSP",
    paperWidth: "80mm",
    customPaperWidth: null,
    installedNames: ["Xprinter XP-80"],
  });
  assert.equal(remote.status, "missing");
  assert.equal(isLocallyPrintable(remote), false);
  assert.match(testCenterScreen, /isLocallyPrintable\(readiness\)/);
});

test("an unbound or unsupported destination is never locally printable", () => {
  const cases: [string, Parameters<typeof destinationReadiness>[0]][] = [
    ["unbound", { connectionType: "system", systemPrinterName: null, paperWidth: "80mm", customPaperWidth: null, installedNames: [] }],
    ["unsupported_connection", { connectionType: "network", systemPrinterName: "X", paperWidth: "80mm", customPaperWidth: null, installedNames: ["X"] }],
    ["unsupported_paper", { connectionType: "system", systemPrinterName: "X", paperWidth: "a4", customPaperWidth: null, installedNames: ["X"] }],
    ["unknown", { connectionType: null, systemPrinterName: "X", paperWidth: "80mm", customPaperWidth: null, installedNames: ["X"] }],
  ];
  for (const [expected, input] of cases) {
    const readiness = destinationReadiness(input);
    assert.equal(readiness.status, expected);
    assert.equal(isLocallyPrintable(readiness), false, `${expected} must not be printable`);
  }
});

test("no paper can leave this phase at all", () => {
  // The Test Center does not reach the native layer. The only page Rust can
  // render today is Quick Setup's printer diagnostic, which is a different
  // document from the two above - rendering these is a native change and a
  // later phase.
  for (const token of ["printTestPage", "invoke(", "@tauri-apps/api"]) {
    assert.equal(testCenterScreen.includes(token), false, `${token} must not appear in the Test Center`);
    assert.equal(routingScreen.includes(token), false, `${token} must not appear in the routing screen`);
  }
  assert.ok(PHYSICAL_TEST_UNAVAILABLE.length > 0);
  assert.match(testCenterScreen, /PHYSICAL_TEST_UNAVAILABLE/);
});

test("printing is never a side effect of saving a route or opening a screen", () => {
  assert.equal(routingScreen.includes("printTestPage"), false);
  assert.equal(routingModel.includes("printTestPage"), false);
  assert.equal(repository.includes("printTestPage"), false);
});

// --- isolation ---------------------------------------------------------------

test("routing and the Test Center create no POS transaction of any kind", () => {
  const forbidden = [
    "callPosRpc",
    "pos_submit_order",
    "pos_pay_order",
    "pos_pay_table",
    "pos_void_order",
    "pos_edit_order",
    "pos_open_shift",
    "pos_end_shift",
    "pos_upsert_customer",
    "pos_orders",
    "pos_payments",
    "pos_shifts",
    "pos_customers",
    "useCart",
    "useShift",
    "useTables",
    "buildReceipt",
    "openPayment",
  ];
  for (const [name, src] of [
    ["the routing screen", routingScreen],
    ["the Test Center screen", testCenterScreen],
    ["the routing model", routingModel],
    ["the route repository", repository],
    ["the resolver client", resolverClient],
    ["the Test Center model", testCenterModel],
  ] as const) {
    for (const token of forbidden) {
      assert.equal(src.includes(token), false, `${token} must not appear in ${name}`);
    }
  }
});

test("nothing in this phase writes inventory, accounting or the printer registry", () => {
  const writes = [
    ...repository.matchAll(/from\("([^"]+)"\)/g),
    ...routingScreen.matchAll(/from\("([^"]+)"\)/g),
    ...testCenterScreen.matchAll(/from\("([^"]+)"\)/g),
  ].map((m) => m[1]);
  assert.deepEqual([...new Set(writes)], ["kitchen_print_routes"]);
  // Printer rows are READ for the picker and never rewritten from here.
  for (const src of [routingScreen, testCenterScreen]) {
    for (const token of ["createPrinter", "updatePrinter", "setPrinterActive"]) {
      assert.equal(src.includes(token), false, `${token} must not be called from routing`);
    }
  }
});

test("the routing screen reuses Quick Setup's printer model rather than a second copy", () => {
  assert.match(routingScreen, /from "@\/lib\/pos\/quickSetup"/);
  assert.match(routingScreen, /loadServerPrinters/);
  assert.match(routingModel, /effectivePaperWidth/);
});

test("Quick Setup is reached, not rebuilt", () => {
  const printing = stripJsxComments(readSrc("screens", "settings", "Printing.tsx"));
  assert.match(printing, /import \{ Printers \}/);
  assert.match(printing, /Quick Setup/);
  assert.match(printing, /Routing/);
  assert.match(printing, /Test Center/);
});

test("the old printers address still lands somewhere real", () => {
  const settings = stripJsxComments(readSrc("screens", "settings", "Settings.tsx"));
  assert.match(settings, /path="printers"/);
  assert.match(settings, /\/settings\/printing\/setup/);
});

// --- purposes stay symmetrical ------------------------------------------------

test("every purpose has every row, and the grid is complete", () => {
  const purposes: PrintPurpose[] = [...PRINT_PURPOSES];
  const keys = purposes.flatMap((p) => EDITABLE_ORDER_SOURCES.map((s) => slotKey(p, s)));
  assert.equal(new Set(keys).size, 8);
});
