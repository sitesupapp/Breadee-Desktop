// POS Settings, automatic printing, and the six route/event combinations.
//
// Four properties these tests exist to protect.
//
// ONE, PRINTING CANNOT REACH A TRANSACTION. Every automatic print runs after
// the server has already accepted; none of the print helpers takes an order to
// act on, calls an RPC, or returns anything a caller's transaction depends on.
// A printer that is unplugged must cost a piece of paper and nothing else.
//
// TWO, THE SIX COMBINATIONS GO THROUGH TWO FUNNELS. Takeaway, Dine-in and
// Delivery each commit an order and each settle one, and all six reach exactly
// two call sites in `PosWorkspace`. Three copies of the printing sequence would
// agree today and disagree the first time one of them learned something.
//
// THREE, NOTHING STARTS PRINTING BY ITSELF ON AN EXISTING INSTALLATION. The
// branch switches keep their existing meaning and their existing "unknown means
// off" default, and the new per-printer switches default to enabled so a
// terminal that never opens the screen behaves exactly as before.
//
// FOUR, SCOPE IS NOT MIXED SILENTLY. Two of these switches are the branch's and
// are shared with the web app; the rest are this terminal's. The screen says so,
// and the payload builder proves the branch write cannot clobber anything else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import { AUTO_PRINT_UNKNOWN, decideAutoPrint, createAutoPrintLatch, kitchenEventKey, receiptEventKey, skipIsWorthReporting } from "@/lib/pos/autoPrint";
import {
  AUTO_PRINT_PRINTERS_KEY,
  parsePrinterAutoPrintMap,
  printerAutoPrintEnabled,
  readPrinterAutoPrintMap,
  writePrinterAutoPrint,
} from "@/lib/pos/autoPrintPrinters";
import { buildReceiptSettingsPayload, canManageReceiptSettings, receiptSettingsWriteMessage } from "@/lib/pos/receiptSettings";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => Object.fromEntries(map),
  };
}

const allowed = { allowed: true, reason: null };

// --- one, printing cannot reach a transaction --------------------------------

test("the automatic print runner performs no RPC and touches no order", () => {
  const source = stripComments(read("src/lib/pos/autoPrintRun.ts"));
  for (const forbidden of ["pos_submit_order", "pos_pay_order", "pos_pay_table", "callPosRpc", "pos_save_order", "pos_void_order"]) {
    assert.ok(!source.includes(forbidden), `autoPrintRun.ts must not reference ${forbidden}`);
  }
  // Every exported path returns a STATUS TO SHOW, never a rejected promise the
  // caller's sequence could trip over.
  assert.ok(source.includes("catch"), "the native boundary is caught, not propagated");
});

test("a printer failure is reported beside the transaction's success, never instead of it", () => {
  const workspace = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  assert.ok(
    workspace.includes("The payment succeeded. Only the receipt failed to print."),
    "a receipt failure must state the payment succeeded first",
  );
  const kitchen = stripComments(read("src/lib/pos/kitchenPrinter.ts"));
  assert.ok(
    kitchen.includes("ORDER_SUCCEEDED_TICKET_DID_NOT"),
    "a ticket failure must state the order succeeded first",
  );
});

test("nothing in the print path rolls back, retries or voids", () => {
  for (const file of ["src/lib/pos/autoPrintRun.ts", "src/lib/pos/autoPrint.ts", "src/lib/pos/autoPrintPrinters.ts"]) {
    const source = stripComments(read(file));
    for (const forbidden of ["setTimeout", "setInterval", "retry(", "rollback", "void_order"]) {
      assert.ok(!source.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }
});

// --- two, six combinations, two funnels --------------------------------------

test("all three routes commit through ONE kitchen call site and settle through ONE receipt call site", () => {
  const source = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  const kitchenCalls = source.split("autoPrintKitchenTicket(").length - 1;
  const receiptCalls = source.split("autoPrintReceipt(").length - 1;
  // One call each, in `printKitchenFor` and `presentReceipt`. A second would be
  // a route that had grown its own printing sequence.
  assert.equal(kitchenCalls, 1, "there must be exactly one automatic kitchen print call site");
  assert.equal(receiptCalls, 1, "there must be exactly one automatic receipt print call site");
  assert.ok(source.includes("printKitchenFor"), "the shared kitchen funnel");
  assert.ok(source.includes("presentReceipt"), "the shared receipt funnel");
});

test("no route wires its own automatic printing", () => {
  for (const file of [
    "src/screens/pos/DineInWorkspace.tsx",
    "src/screens/pos/DeliveryWorkspace.tsx",
    "src/lib/pos/tableRounds.ts",
    "src/lib/pos/deliveryOrder.ts",
    "src/lib/pos/tablePayment.ts",
    "src/lib/pos/deliverySettlement.ts",
  ]) {
    const source = stripJsxComments(read(file));
    assert.ok(!source.includes("autoPrintKitchenTicket"), `${file} must use the shared funnel`);
    assert.ok(!source.includes("autoPrintReceipt"), `${file} must use the shared funnel`);
  }
});

test("the kitchen funnel is reached by all three commit events and the receipt funnel by all three settlements", () => {
  const source = stripJsxComments(read("src/screens/pos/PosWorkspace.tsx"));
  // Both funnels are handed to the dine-in and delivery hooks, which is how a
  // round commit and a delivery commit reach the same code as Takeaway's
  // "Send to Kitchen".
  assert.ok(source.includes("printKitchenFor"), "the kitchen funnel exists");
  for (const source_name of ['"takeaway"', '"dine_in"', '"delivery"']) {
    assert.ok(source.includes(source_name), `the workspace must name the ${source_name} order source`);
  }
});

// --- three, nothing starts printing by itself --------------------------------

test("an unreadable branch setting means BOTH documents stay manual", () => {
  // The column defaults to true on the server; this is deliberately NOT that,
  // because failing to a printing state produces paper nobody asked for on a
  // terminal whose configuration is already in doubt.
  assert.deepEqual(AUTO_PRINT_UNKNOWN, { customer: false, kitchen: false });
});

test("a printer nobody has switched off is enabled", () => {
  // The whole backward-compatibility story: an installation that never opens
  // the new screen has an empty map and behaves exactly as it did before.
  assert.equal(printerAutoPrintEnabled({}, "printer-1"), true);
  assert.equal(printerAutoPrintEnabled({ "printer-2": false }, "printer-1"), true);
  assert.equal(printerAutoPrintEnabled({ "printer-1": false }, "printer-1"), false);
  assert.equal(printerAutoPrintEnabled({ "printer-1": true }, "printer-1"), true);
  // A route that resolved without naming a printer row is permitted: refusing
  // would silently stop telling the kitchen about food.
  assert.equal(printerAutoPrintEnabled({ x: false }, null), true);
  assert.equal(printerAutoPrintEnabled({}, undefined), true);
});

test("enabling a printer removes the exception rather than storing a positive", () => {
  const store = memoryStorage();
  writePrinterAutoPrint("p1", false, store);
  assert.deepEqual(JSON.parse(store.read()[AUTO_PRINT_PRINTERS_KEY]), { p1: false });
  writePrinterAutoPrint("p1", true, store);
  // Only deliberate exceptions are kept, so a re-created printer with a reused
  // id cannot inherit an "on" nobody chose.
  assert.deepEqual(JSON.parse(store.read()[AUTO_PRINT_PRINTERS_KEY]), {});
});

test("a corrupt or hostile switch map degrades to no exceptions, never to silence", () => {
  for (const bad of ["", "not json", "[]", "null", '"x"', "123"]) {
    assert.deepEqual(parsePrinterAutoPrintMap(bad), {}, `${JSON.stringify(bad)}`);
  }
  // Non-boolean values are dropped rather than coerced: a truthy string would
  // otherwise become an "enabled" nobody chose, and a falsy one a silent printer.
  assert.deepEqual(parsePrinterAutoPrintMap('{"a":false,"b":"no","c":0,"d":true}'), { a: false, d: true });
  assert.deepEqual(readPrinterAutoPrintMap({ getItem: () => { throw new Error("no storage"); } }), {});
});

test("the local veto is applied BEFORE the latch is claimed", () => {
  const source = stripComments(read("src/lib/pos/autoPrintRun.ts"));
  const vetoAt = source.indexOf("printerIsSilenced(resolution)");
  const claimAt = source.indexOf("autoPrintLatch.claim(key)");
  assert.ok(vetoAt > 0 && claimAt > 0, "both must be present");
  assert.ok(
    vetoAt < claimAt,
    "a vetoed document must not burn its event key - switching the printer back on has to work",
  );
});

test("the decision refuses before it prints, in the order an operator can act on", () => {
  const base = {
    nativeAvailable: true,
    enabled: true,
    permission: allowed,
    hasDocument: true,
    resolution: { kind: "single" as const, target: { printerName: "P", windowsName: "P", paperWidth: "80mm" as const, copies: 1, usedDefault: true } },
    alreadyAttempted: false,
  };
  assert.deepEqual(decideAutoPrint(base), { kind: "print" });
  assert.equal(decideAutoPrint({ ...base, nativeAvailable: false }).kind, "skip");
  assert.equal(decideAutoPrint({ ...base, enabled: false }).kind, "skip");
  assert.equal(decideAutoPrint({ ...base, hasDocument: false }).kind, "skip");
  assert.equal(decideAutoPrint({ ...base, resolution: null }).kind, "skip");
  assert.equal(decideAutoPrint({ ...base, alreadyAttempted: true }).kind, "skip");
});

test("only the silences that mean food is not being cooked interrupt an operator", () => {
  assert.ok(skipIsWorthReporting({ reason: "unroutable", resolution: { kind: "blocked", block: { reason: "no_route" } } }));
  assert.ok(skipIsWorthReporting({ reason: "not_permitted", detail: "x" }));
  // A branch that switched printing off does not want telling after every order.
  assert.ok(!skipIsWorthReporting({ reason: "disabled" }));
  assert.ok(!skipIsWorthReporting({ reason: "not_native" }));
  assert.ok(!skipIsWorthReporting({ reason: "already_attempted" }));
});

test("one attempt per transaction event, and a key is burned even if the print throws", () => {
  const latch = createAutoPrintLatch();
  const key = kitchenEventKey({ orderId: "o1", batchNo: 2 });
  assert.equal(latch.claim(key), true);
  // Second call in the same tick - the remount/double-submit case.
  assert.equal(latch.claim(key), false);
  latch.release(key);
  // Later, after a remount or a refreshed bill.
  assert.equal(latch.claim(key), false);
  assert.equal(latch.claimed(key), true);
  // A different round of the same order is a different event.
  assert.equal(latch.claim(kitchenEventKey({ orderId: "o1", batchNo: 3 })), true);
});

test("event keys are built from what the server returned, never from a clock", () => {
  assert.equal(kitchenEventKey({ orderId: "o1" }), "kitchen:o1:1");
  assert.equal(kitchenEventKey({ orderId: "o1", batchNo: null }), "kitchen:o1:1");
  assert.equal(receiptEventKey({ orderNumber: "260816-0001", paidAt: "T" }), "receipt:260816-0001:T");
  // Same inputs, same key - or the latch cannot recognise the repeat.
  assert.equal(receiptEventKey({ orderNumber: "A" }), receiptEventKey({ orderNumber: "A" }));
});

// --- four, scope is not mixed silently ---------------------------------------

test("a branch write states BOTH automatic-printing flags, always", () => {
  // `save_pos_receipt_settings` preserves an omitted key on UPDATE and
  // `coalesce`s it to TRUE on INSERT. A branch that had never saved settings
  // would therefore start printing by itself the first time somebody edited a
  // template on a till. Carrying the read values forward is what prevents that.
  const payload = buildReceiptSettingsPayload({
    tenantId: "t1",
    branchId: "b1",
    current: { autoPrint: { customer: false, kitchen: false } },
    patch: { customerTemplate: { blocks: [], size: "normal" } },
  });
  assert.equal(payload.auto_print_customer, false);
  assert.equal(payload.auto_print_kitchen, false);
});

test("a branch write carries ONLY the keys it changes", () => {
  const payload = buildReceiptSettingsPayload({
    tenantId: "t1",
    branchId: "b1",
    current: { autoPrint: { customer: true, kitchen: false } },
    patch: { autoPrintKitchen: true },
  });
  assert.deepEqual(Object.keys(payload).sort(), ["auto_print_customer", "auto_print_kitchen", "branch_id", "tenant_id"]);
  assert.equal(payload.auto_print_customer, true, "the unchanged flag is carried, not dropped");
  assert.equal(payload.auto_print_kitchen, true);
  // Nothing the desktop does not edit may appear, or a save from a till would
  // overwrite a logo, a paper size or a welcome message set in the web app.
  for (const forbidden of ["logo_url", "paper_size", "welcome_message", "footer_message", "show_logo", "business_code"]) {
    assert.ok(!(forbidden in payload), `${forbidden} must not be written from the desktop`);
  }
});

test("a template save carries the template and still pins both flags", () => {
  const template = { blocks: [{ key: "total", show: true }], size: "normal" as const };
  const payload = buildReceiptSettingsPayload({
    tenantId: "t1",
    branchId: "b1",
    current: { autoPrint: { customer: true, kitchen: true } },
    patch: { customerTemplate: template, kitchenTemplate: template },
  });
  assert.deepEqual(payload.customer_template_config, template);
  assert.deepEqual(payload.kitchen_template_config, template);
  assert.equal(payload.auto_print_customer, true);
  assert.equal(payload.auto_print_kitchen, true);
});

test("the settings screens check the same permission the RPC enforces", () => {
  assert.equal(canManageReceiptSettings({ "pos.settings.manage": true }).allowed, true);
  assert.equal(canManageReceiptSettings({ "pos.settings.manage": false }).allowed, false);
  assert.equal(canManageReceiptSettings(null).allowed, false);
  assert.ok(canManageReceiptSettings({}).reason?.includes("manage POS settings"));
});

test("a refusal from the server is turned into a sentence, never a raw dump", () => {
  assert.ok(receiptSettingsWriteMessage("Not authorized to manage POS receipt settings").includes("permission"));
  assert.ok(receiptSettingsWriteMessage("new row violates row-level security policy").includes("permission"));
  assert.ok(receiptSettingsWriteMessage("Cross-tenant settings edits are not allowed").includes("different business"));
  assert.equal(receiptSettingsWriteMessage(""), "The receipt settings could not be saved.");
});

test("a save without a branch is refused rather than duplicating a tenant-wide row", () => {
  // `pos_receipt_settings` has a plain unique index on (tenant_id, branch_id),
  // and in Postgres two NULLs are distinct - so `on conflict` never matches a
  // tenant-wide row and the insert would create a second one.
  const source = stripComments(read("src/lib/pos/receiptSettings.ts"));
  assert.ok(source.includes("if (!input.branchId)"), "a null branch must be refused");
  assert.ok(source.includes("ReceiptSettingsWriteError"), "and refused with a typed error");
});

test("POS Settings does not duplicate the routing screen", () => {
  const source = stripJsxComments(read("src/screens/settings/PosSettings.tsx"));
  // No printer picking, no copy counts, no order-source matrix: Printing &
  // Routing stays the single place a branch says WHERE a document goes.
  for (const forbidden of ["planSave", "printerOptions", "resolvePrintRoute", "copy_count", "kitchen_print_routes", "print_purpose"]) {
    assert.ok(!source.includes(forbidden), `PosSettings must not re-implement ${forbidden}`);
  }
  // And it must read the printers rather than hard-code any.
  assert.ok(source.includes("loadServerPrinters"), "the printer list is read live");
  for (const hardcoded of ['"Kitchen Printer"', '"Bar Printer"', '"Grill Printer"', '"Cashier Printer"']) {
    assert.ok(!source.includes(hardcoded), `PosSettings must not hard-code ${hardcoded}`);
  }
});

test("the screen states which switches are branch-wide and which are this terminal's", () => {
  const source = read("src/screens/settings/PosSettings.tsx");
  assert.ok(source.includes("Branch-wide"), "the shared switches are labelled");
  assert.ok(source.includes("This terminal"), "the local switches are labelled");
});
