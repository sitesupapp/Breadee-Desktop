// POS v1: kitchen tickets, and safe automatic printing.
//
// TWO RULES ARE WORTH ALMOST ALL OF THIS FILE.
//
//   1. A KITCHEN COOKS WHAT THE TICKET SAYS. Print round 1 again alongside round
//      2 and the kitchen makes round 1 twice - food, time and a customer waiting
//      for something that was already made. So the ticket is built from the
//      batch that was SUBMITTED, never from a re-read of the bill, and the tests
//      below pin that structurally rather than by inspection.
//   2. PAPER MUST NEVER REACH THE TRANSACTION. Automatic printing runs after the
//      server has already committed. A print failure that could fail an order,
//      retry a payment or roll back a shift would turn a jammed printer into a
//      financial incident. The print path has no way back: no RPC, no cart, no
//      shift, no cash box, and no failure channel out of the auto-print
//      functions at all.
//
// UI and wiring assertions are static source reads, for the reason the earlier
// suites give: "the control is not rendered" is weaker than "the call site does
// not exist".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  NATIVE_COMMANDS,
  printKitchenTicket,
  toKitchenTicketDoc,
  type InstalledPrinter,
} from "@/lib/nativePrinting";
import {
  buildKitchenTicket,
  kitchenBlockMessage,
  kitchenOrderTypeLabel,
  kitchenPrintGate,
  resolveKitchenTarget,
  ORDER_SUCCEEDED_TICKET_DID_NOT,
} from "@/lib/pos/kitchenPrinter";
import {
  AUTO_PRINT_UNKNOWN,
  createAutoPrintLatch,
  decideAutoPrint,
  kitchenEventKey,
  receiptEventKey,
  skipIsWorthReporting,
} from "@/lib/pos/autoPrint";
import { describeBlock, resolveRouteTarget } from "@/lib/pos/printTarget";
import { canPrintKitchenTickets } from "@/lib/pos/access";
import type { ResolvedRoute } from "@/lib/pos/printRouteResolver";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");
const readTauri = (...p: string[]) => readFileSync(join(root, "..", "src-tauri", ...p), "utf8");

/**
 * Whole-line `//` comments, removed BEFORE the shared strippers run.
 *
 * `stripComments` takes block comments out first, and a line comment that
 * happens to contain a slash-star - `PosWorkspace.tsx` line 3 says the rules
 * live in "lib/pos/<star>" - opens a block match that then runs on to the next
 * real `<star>/`, deleting several hundred lines of real code in between. A
 * source assertion against a file that was silently truncated does not fail: it
 * passes for the wrong reason, or fails against code that is perfectly correct.
 * Level 3A lost a whole render function to the same class of bug.
 *
 * Dropping the line comments first removes the only thing that can open a false
 * block, and leaves the shared helpers doing exactly what they document.
 */
const dropLineComments = (src: string) => src.replace(/^[^\S\r\n]*\/\/[^\r\n]*(\r?\n)/gm, "");
const readJsx = (...p: string[]) => stripJsxComments(dropLineComments(readSrc(...p)));
const readTs = (...p: string[]) => stripComments(dropLineComments(readSrc(...p)));

const kitchenModal = readJsx("screens", "pos", "KitchenTicketPreview.tsx");
const receiptModal = readJsx("screens", "pos", "ReceiptPreview.tsx");
const workspace = readJsx("screens", "pos", "PosWorkspace.tsx");
const dineIn = readJsx("screens", "pos", "DineInWorkspace.tsx");
const delivery = readJsx("screens", "pos", "DeliveryWorkspace.tsx");
const autoPrintSrc = readTs("lib", "pos", "autoPrint.ts");
const autoPrintRunSrc = readTs("lib", "pos", "autoPrintRun.ts");
const kitchenLib = readTs("lib", "pos", "kitchenPrinter.ts");
const settingsLib = readTs("lib", "pos", "receiptSettings.ts");
const kitchenRs = readTauri("src", "printing", "kitchen.rs");
const libRs = readTauri("src", "lib.rs");

const allow = { allowed: true, reason: null };
const installed = (name: string): InstalledPrinter => ({ name, is_default: false, status: "unknown" });

/** The staging fixture: the XP-80, bound exactly, at a custom 72mm width. */
const route = (over: Partial<ResolvedRoute> = {}): ResolvedRoute => ({
  resolved: true,
  route_id: "r1",
  printer_id: "p1",
  printer_name: "Xprinter XP-80 (Customer receipts)",
  printer_type: "cashier",
  connection_type: "system",
  system_printer_name: "Xprinter XP-80",
  paper_width: "custom",
  custom_paper_width: 72,
  copies: 1,
  print_purpose: "kitchen_ticket",
  matched_order_source: "any",
  used_default: true,
  ...over,
});

const unresolved = (): ResolvedRoute => ({ ...route(), resolved: false });

const line = (name: string, qty = 1) => ({ name, qty });

// --- the ticket document -----------------------------------------------------

test("a ticket carries the order, its source, the time and the items", () => {
  const t = buildKitchenTicket({
    businessName: "Dominos Pizza",
    branchName: "Main Branch",
    staffName: "Cashier",
    orderNumber: "260814-0001",
    source: "takeaway",
    at: "8/14/2026, 11:20:00 AM",
    lines: [{ name: "Margherita", qty: 2, modifiers: [{ name: "Small" }], note: "No olives" }],
  });
  assert.equal(t.orderNumber, "260814-0001");
  assert.equal(t.orderType, "Takeaway");
  assert.equal(t.at, "8/14/2026, 11:20:00 AM");
  assert.deepEqual(t.lines[0], {
    name: "Margherita",
    qty: 2,
    modifiers: [{ name: "Small", quantity: 1 }],
    note: "No olives",
  });
});

test("the ticket has nowhere to put money, and the mapper adds none", () => {
  // The strongest available statement: serialise the whole document Rust would
  // receive and look for anything monetary. A price cannot appear on paper if it
  // cannot appear in the document.
  const doc = toKitchenTicketDoc(
    buildKitchenTicket({
      businessName: "Dominos Pizza",
      branchName: "Main Branch",
      orderNumber: "1",
      source: "delivery",
      at: "now",
      customerName: "Desktop Level 3A QA",
      orderNote: "Ring the bell",
      lines: [{ name: "Margherita", qty: 1, modifiers: [{ name: "Extra cheese" }], note: "No olives" }],
    }),
  );
  const json = JSON.stringify(doc).toLowerCase();
  for (const money of ["price", "total", "subtotal", "discount", "currency", "paid", "tender", "change", "amount"]) {
    assert.equal(json.includes(money), false, `a kitchen ticket must not carry ${money}`);
  }
});

test("a dine-in ticket carries its table and ONLY its own round", () => {
  const t = buildKitchenTicket({
    businessName: "B",
    branchName: "Br",
    orderNumber: "260814-0002",
    source: "dine_in",
    at: "now",
    tableName: "Table 4",
    batchNo: 2,
    lines: [line("Fries")],
  });
  assert.equal(t.tableName, "Table 4");
  assert.equal(t.batchLabel, "Round 2");
  assert.equal(t.lines.length, 1);
});

test("the table name is used verbatim - never prefixed (m256)", () => {
  const t = buildKitchenTicket({
    businessName: "B",
    branchName: "Br",
    orderNumber: "1",
    source: "dine_in",
    at: "now",
    tableName: "Table 4",
    batchNo: 1,
    lines: [line("Fries")],
  });
  assert.equal(t.tableName, "Table 4");
  assert.equal(JSON.stringify(t).includes("Table Table"), false);
});

test("a table name cannot leak onto a takeaway or delivery ticket", () => {
  for (const source of ["takeaway", "delivery"] as const) {
    const t = buildKitchenTicket({
      businessName: "B",
      branchName: "Br",
      orderNumber: "1",
      source,
      at: "now",
      tableName: "Table 4",
      batchNo: 3,
      lines: [line("Fries")],
    });
    assert.equal(t.tableName, null, `${source} must not carry a table`);
    assert.equal(t.batchLabel, null, `${source} must not carry a round label`);
  }
});

test("a delivery ticket names the customer and never their address", () => {
  const t = buildKitchenTicket({
    businessName: "B",
    branchName: "Br",
    orderNumber: "1",
    source: "delivery",
    at: "now",
    customerName: "Desktop Level 3A QA",
    lines: [line("Margherita")],
  });
  assert.equal(t.customerName, "Desktop Level 3A QA");
  // There is no address field on the type at all - this pins the intent so a
  // future edit has to argue with a test rather than add a property.
  assert.equal(Object.keys(t).some((k) => /address|phone/i.test(k)), false);
});

test("a customer name cannot leak onto a takeaway or dine-in ticket", () => {
  for (const source of ["takeaway", "dine_in"] as const) {
    const t = buildKitchenTicket({
      businessName: "B",
      branchName: "Br",
      orderNumber: "1",
      source,
      at: "now",
      customerName: "Someone Else",
      lines: [line("Fries")],
    });
    assert.equal(t.customerName, null);
  }
});

test("empty and zero-quantity lines are dropped rather than cooked", () => {
  const t = buildKitchenTicket({
    businessName: "B",
    branchName: "Br",
    orderNumber: "1",
    source: "takeaway",
    at: "now",
    lines: [line("Fries", 0), line("Margherita", 2), line("Pepsi", -1)],
  });
  assert.deepEqual(t.lines.map((l) => l.name), ["Margherita"]);
});

test("blank notes become null rather than an empty line on paper", () => {
  const t = buildKitchenTicket({
    businessName: "B",
    branchName: "Br",
    orderNumber: "1",
    source: "takeaway",
    at: "now",
    orderNote: "   ",
    lines: [{ name: "Fries", qty: 1, note: "  " }],
  });
  assert.equal(t.orderNote, null);
  assert.equal(t.lines[0].note, null);
});

test("the source labels match what the routes and receipts say", () => {
  assert.equal(kitchenOrderTypeLabel("takeaway"), "Takeaway");
  assert.equal(kitchenOrderTypeLabel("dine_in"), "Dine-In");
  assert.equal(kitchenOrderTypeLabel("delivery"), "Delivery");
});

// --- routing -----------------------------------------------------------------

test("a kitchen ticket resolves through the same route mechanism as a receipt", () => {
  const r = resolveKitchenTarget({ route: route(), installed: [installed("Xprinter XP-80")] });
  assert.equal(r.kind, "single");
  if (r.kind !== "single") return;
  assert.equal(r.target.windowsName, "Xprinter XP-80");
  assert.equal(r.target.paperWidth, "custom:72");
  assert.equal(r.target.copies, 1);
  assert.equal(r.target.usedDefault, true);
  // Byte-identical to the shared resolver - there is one implementation.
  assert.deepEqual(r, resolveRouteTarget({ route: route(), installed: [installed("Xprinter XP-80")] }));
});

test("matching is exact for tickets too - a near miss is a different device", () => {
  for (const near of ["xprinter xp-80", "XPRINTER XP-80", "Xprinter XP-80 ", "Xprinter"]) {
    const r = resolveKitchenTarget({ route: route(), installed: [installed(near)] });
    assert.equal(r.kind, "blocked", `${near} must not bind`);
  }
});

test("no kitchen route is a blocked state, never a fallback to a receipt printer", () => {
  const r = resolveKitchenTarget({ route: unresolved(), installed: [installed("Xprinter XP-80")] });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "no_route");
  assert.match(kitchenBlockMessage(r.block), /No kitchen ticket route is configured/);
  assert.match(kitchenBlockMessage(r.block), /Printing & Routing/);
});

test("nothing is ever guessed in the shared resolver", () => {
  const shared = readTs("lib", "pos", "printTarget.ts");
  for (const token of ["is_default", "installed[0]", "printers[0]", "?? installed", "find((p) => p.is_default"]) {
    assert.equal(shared.includes(token), false, `${token} must not be a fallback`);
  }
  // And it writes nothing.
  for (const write of ["insert", "update", "upsert", "delete", "rpc("]) {
    assert.equal(shared.includes(write), false, write);
  }
});

test("each purpose is explained in its own words and sent to its own screen", () => {
  const block = { reason: "no_route" } as const;
  assert.match(describeBlock(block, "receipt"), /No receipt route/);
  assert.match(describeBlock(block, "kitchen_ticket"), /No kitchen ticket route/);
  assert.notEqual(describeBlock(block, "receipt"), describeBlock(block, "kitchen_ticket"));
});

// --- the gate ----------------------------------------------------------------

test("the ticket gate refuses in the order an operator can act on", () => {
  const resolution = resolveKitchenTarget({ route: route(), installed: [installed("Xprinter XP-80")] });
  const base = { nativeAvailable: true, canPrintKitchenTickets: allow, resolution, hasTicket: true, busy: false };

  assert.equal(kitchenPrintGate(base).allowed, true);
  assert.match(
    kitchenPrintGate({ ...base, nativeAvailable: false }).reason ?? "",
    /installed Desktop app/,
  );
  assert.match(
    kitchenPrintGate({ ...base, canPrintKitchenTickets: { allowed: false, reason: "nope" } }).reason ?? "",
    /nope/,
  );
  assert.match(kitchenPrintGate({ ...base, hasTicket: false }).reason ?? "", /nothing to send/i);
  assert.match(kitchenPrintGate({ ...base, resolution: null }).reason ?? "", /Looking for a printer/);
  assert.match(kitchenPrintGate({ ...base, busy: true }).reason ?? "", /already being sent/);
});

test("kitchen tickets are gated on sending orders, not on printing receipts", () => {
  // A cashier who may take orders but holds no receipt permission must still be
  // able to tell the kitchen what to cook - otherwise the till silently stops
  // feeding the kitchen and looks like it is working.
  const ctx = (permissions: Record<string, boolean>) => ({
    membership: { role: "cashier" as const, status: "active" as const },
    permissions,
    features: { pos: true, "pos.printing": true },
  });
  assert.equal(
    canPrintKitchenTickets(ctx({ "pos.access": true, "pos.create_orders": true, "pos.print_receipts": false })).allowed,
    true,
  );
  assert.equal(
    canPrintKitchenTickets(ctx({ "pos.access": true, "pos.create_orders": false, "pos.print_receipts": true })).allowed,
    false,
  );
});

// --- the automatic decision --------------------------------------------------

const resolvedOk = () => resolveKitchenTarget({ route: route(), installed: [installed("Xprinter XP-80")] });

const decision = (over: Record<string, unknown> = {}) =>
  decideAutoPrint({
    nativeAvailable: true,
    enabled: true,
    permission: allow,
    hasDocument: true,
    resolution: resolvedOk(),
    alreadyAttempted: false,
    ...over,
  });

test("everything lined up prints, and each missing thing is named", () => {
  assert.equal(decision().kind, "print");
  const skipOf = (over: Record<string, unknown>) => {
    const d = decision(over);
    assert.equal(d.kind, "skip");
    return d.kind === "skip" ? d.skip.reason : "";
  };
  assert.equal(skipOf({ nativeAvailable: false }), "not_native");
  assert.equal(skipOf({ enabled: false }), "disabled");
  assert.equal(skipOf({ permission: { allowed: false, reason: "no" } }), "not_permitted");
  assert.equal(skipOf({ hasDocument: false }), "nothing_to_print");
  assert.equal(skipOf({ resolution: null }), "unroutable");
  assert.equal(skipOf({ alreadyAttempted: true }), "already_attempted");
});

test("a document that was never eligible does not report itself as already sent", () => {
  // Otherwise an operator is told to go and look at a printer that was never
  // asked for anything.
  const d = decision({ enabled: false, alreadyAttempted: true });
  assert.equal(d.kind === "skip" && d.skip.reason, "disabled");
});

test("only the silences worth interrupting an operator for are reported", () => {
  assert.equal(skipIsWorthReporting({ reason: "disabled" }), false);
  assert.equal(skipIsWorthReporting({ reason: "not_native" }), false);
  assert.equal(skipIsWorthReporting({ reason: "already_attempted" }), false);
  assert.equal(skipIsWorthReporting({ reason: "nothing_to_print" }), false);
  assert.equal(skipIsWorthReporting({ reason: "unroutable", resolution: { kind: "blocked", block: { reason: "no_route" } } }), true);
});

test("an unreadable settings row leaves BOTH documents manual", () => {
  // The server column defaults to true; this deliberately does not. Failing to a
  // printing state would produce paper nobody asked for on a terminal whose
  // configuration is already in doubt.
  assert.deepEqual(AUTO_PRINT_UNKNOWN, { customer: false, kitchen: false });
});

// --- the latch ---------------------------------------------------------------

test("one attempt per transaction event, however many times it is asked for", () => {
  const latch = createAutoPrintLatch();
  const key = kitchenEventKey({ orderId: "o1", batchNo: 2 });
  assert.equal(latch.claim(key), true);
  latch.release(key);
  assert.equal(latch.claim(key), false, "a second claim must be refused after release");
  assert.equal(latch.claimed(key), true);
});

test("a second claim in the SAME tick is refused", () => {
  const latch = createAutoPrintLatch();
  assert.equal(latch.claim("a"), true);
  assert.equal(latch.claim("b"), false, "nothing else may start while one is in flight");
});

test("a key is spent BEFORE the attempt, so a crash cannot license a reprint", () => {
  // The spooler may already hold the job. Marking done only on success would
  // make a throw look like "never printed" and invite the duplicate.
  const latch = createAutoPrintLatch();
  latch.claim("k");
  assert.equal(latch.claimed("k"), true);
  assert.match(autoPrintSrc, /done\.add\(key\);\s*inFlight = true;/);
});

test("different batches of one order are different events", () => {
  assert.notEqual(kitchenEventKey({ orderId: "o1", batchNo: 1 }), kitchenEventKey({ orderId: "o1", batchNo: 2 }));
  // ...and the same batch is the same event however often it is described.
  assert.equal(kitchenEventKey({ orderId: "o1", batchNo: 2 }), kitchenEventKey({ orderId: "o1", batchNo: 2 }));
});

test("event keys are built from server facts, never from a clock or a random", () => {
  assert.equal(receiptEventKey({ orderNumber: "260814-0001" }), receiptEventKey({ orderNumber: "260814-0001" }));
  for (const nondeterminism of ["Math.random", "Date.now()", "crypto.randomUUID"]) {
    assert.equal(autoPrintSrc.includes(nondeterminism), false, `${nondeterminism} would defeat the latch`);
  }
});

test("kitchen and receipt keys can never collide", () => {
  assert.notEqual(kitchenEventKey({ orderId: "260814-0001" }), receiptEventKey({ orderNumber: "260814-0001" }));
});

// --- transaction independence ------------------------------------------------

test("the automatic print path performs no POS or financial call at all", () => {
  for (const src of [autoPrintSrc, autoPrintRunSrc, kitchenLib, kitchenModal]) {
    for (const token of [
      "callPosRpc", "pos_pay_order", "pos_pay_table", "pos_submit_order", "pos_void_order",
      "pos_edit_order", "useCart", "useShift", "refreshCashBox", "submitOrder", "print_jobs",
    ]) {
      assert.equal(src.includes(token), false, `${token} must not appear on the print path`);
    }
  }
});

test("there is no automatic retry anywhere on the automatic path", () => {
  for (const src of [autoPrintSrc, autoPrintRunSrc, kitchenModal]) {
    for (const token of ["retry", "attempt++", "setTimeout", "setInterval", "while ("]) {
      assert.equal(src.toLowerCase().includes(token.toLowerCase()), false, token);
    }
  }
});

test("the auto-print functions have no failure channel out of them", () => {
  // Every outcome, a native throw included, comes back as a status to SHOW. A
  // caller cannot accidentally propagate a print failure into its own
  // post-transaction sequence, because there is nothing to propagate.
  const kitchenFn = autoPrintRunSrc.slice(
    autoPrintRunSrc.indexOf("export async function autoPrintKitchenTicket"),
    autoPrintRunSrc.indexOf("export type ReceiptAutoPrintStatus"),
  );
  assert.match(kitchenFn, /catch \(e\)/);
  assert.equal(/\bthrow\b/.test(kitchenFn), false, "the kitchen path must not throw");
  const receiptFn = autoPrintRunSrc.slice(autoPrintRunSrc.indexOf("export async function autoPrintReceipt"));
  assert.match(receiptFn, /catch \(e\)/);
  assert.equal(/\bthrow\b/.test(receiptFn), false, "the receipt path must not throw");
});

test("reading the settings can never interrupt a completed sale", () => {
  assert.match(settingsLib, /catch \{/);
  assert.match(settingsLib, /return AUTO_PRINT_UNKNOWN/);
  // Read-only: the desktop never writes the branch's printing preference.
  for (const write of ["insert", "update(", "upsert", "delete", "save_pos_receipt_settings"]) {
    assert.equal(settingsLib.includes(write), false, write);
  }
});

// --- wiring ------------------------------------------------------------------

test("a dine-in ticket is built from the SUBMITTED round, not from the bill", () => {
  // The whole feature. `useTables.getState().bill` holds every earlier round;
  // building a ticket from it would have the kitchen cook them again.
  // Bounded by CODE, not by a comment: the comments have been stripped, so a
  // comment anchor would return -1 and silently widen the slice to the rest of
  // the file - which is how an assertion ends up reading somebody else's code.
  const send = dineIn.slice(dineIn.indexOf("const sendRound"), dineIn.indexOf("const readTableState"));
  assert.match(send, /const submitted = useCart\.getState\(\)\.lines/);
  const call = send.slice(send.indexOf("onKitchenBatch"));
  assert.match(call, /lines: submitted\.map/);
  assert.equal(call.includes("getState().bill"), false, "the ticket must not be built from the bill");
  // The server's own batch number, never a locally computed one.
  assert.match(call, /batchNo: outcome\.result\.batch_no/);
});

test("the ticket is only requested after the server has accepted", () => {
  // Bounded by CODE, not by a comment: the comments have been stripped, so a
  // comment anchor would return -1 and silently widen the slice to the rest of
  // the file - which is how an assertion ends up reading somebody else's code.
  const send = dineIn.slice(dineIn.indexOf("const sendRound"), dineIn.indexOf("const readTableState"));
  assert.ok(
    send.indexOf("if (!outcome.ok) throw outcome.error") < send.indexOf("onKitchenBatch"),
    "nothing prints before the submission has succeeded",
  );
});

test("delivery snapshots its lines before the first await, as the payload does", () => {
  const send = delivery.slice(delivery.indexOf("const send = useCallback"), delivery.indexOf("const requestSend"));
  const call = send.slice(send.indexOf("onKitchenBatch"));
  assert.match(call, /lines: snapshot\.lines\.map/);
  assert.match(call, /source: "delivery"/);
});

test("all three routes share ONE kitchen call site and ONE receipt call site", () => {
  // Three copies would agree today and diverge the first time one learned
  // something - and what they would diverge about is whether a kitchen is told.
  assert.equal((workspace.match(/autoPrintKitchenTicket\(/g) ?? []).length, 1);
  assert.equal((workspace.match(/autoPrintReceipt\(/g) ?? []).length, 1);
  for (const src of [dineIn, delivery]) {
    assert.equal(src.includes("autoPrintKitchenTicket"), false, "a route must not print for itself");
    assert.equal(src.includes("autoPrintReceipt"), false, "a route must not print for itself");
  }
});

// --- RC acceptance regression: a sent takeaway order stays payable ----------
//
// FOUND ON REAL PAPER, NOT IN A TEST. Packaged RC acceptance sent takeaway order
// 260814-0001 to the kitchen and then could not pay it: `sendToKitchen` called
// `newOrder()`, which resets the cart INCLUDING `savedOrder` - and `savedOrder`
// is the only handle `ensureOrder()` has on an already-created order. The money
// was uncollectable from this app, and the order then blocked End Shift, because
// the server counts an unpaid order as still open ("Cannot close this shift:
// 1 order(s) still open"). The DoD flow is literally "Order -> Kitchen -> Pay ->
// Receipt", so this broke the headline path.

test("sending a takeaway order to the kitchen leaves it payable", () => {
  const send = workspace.slice(workspace.indexOf("const sendToKitchen"), workspace.indexOf("const clearOrder"));
  // The reset is gone from the success path - that is the whole fix.
  assert.equal(/newOrder\(\)/.test(send), false, "the sent order must not be discarded");
  // And it is gone from the dependency list too, so it cannot creep back in.
  assert.match(send, /\[cart\.lines\.length, ensureOrder, ticketForOrder, toast\]/);
});

test("clearing a SENT order asks first, and clearing a scratch cart does not", () => {
  const clear = workspace.slice(workspace.indexOf("const clearOrder"), workspace.indexOf("const sendToKitchen") > workspace.indexOf("const clearOrder") ? workspace.indexOf("const sendToKitchen") : workspace.length);
  assert.match(clear, /if \(useCart\.getState\(\)\.savedOrder\)/);
  assert.match(clear, /setClearConfirm\(true\)/);
  assert.match(clear, /newOrder\(\)/, "an unsent cart is still cleared without ceremony");
  // The Clear control goes through the guard, not straight to the reset.
  assert.match(workspace, /onNewOrder=\{clearOrder\}/);
});

test("the confirmation names the order and does not pretend it was cancelled", () => {
  assert.match(workspace, /Leave this order unpaid\?/);
  assert.match(workspace, /\{sentButUnpaid\?\.order_number\}/);
  assert.match(workspace, /does not cancel it/);
  // It must not claim the desktop can recover it - it cannot.
  assert.match(workspace, /cannot be paid from this terminal/);
});

test("a batch's ticket is presented once, even when its order is paid later", () => {
  // Found in RC acceptance: paying an order that had already been sent put the
  // kitchen ticket modal back on screen ON TOP of the receipt - at the one
  // moment the cashier needs to read the receipt. The PRINT latch did its job
  // (no second job was spooled); presentation is a separate question, because
  // with automatic printing off the latch is never claimed at all.
  const fn = workspace.slice(workspace.indexOf("const printKitchenFor"), workspace.indexOf("const presentReceipt"));
  assert.match(fn, /presentedTickets\.current\.has\(eventKey\)/);
  assert.match(fn, /presentedTickets\.current\.add\(eventKey\)/);
  // Keyed on the batch, so round 2 still gets its own ticket.
  assert.match(fn, /\$\{input\.orderId\}:\$\{input\.batchNo \?\? 1\}/);
  // A ref, so two calls in one tick cannot both read "not presented yet".
  assert.match(workspace, /const presentedTickets = useRef<Set<string>>\(new Set\(\)\)/);
});

test("the takeaway pay path still tells the kitchen", () => {
  // Paying without pressing Send is a normal takeaway flow. The latch makes the
  // unconditional call safe: a ticket already produced by Send is not repeated.
  const pay = workspace.slice(workspace.indexOf("const confirmPayment"), workspace.indexOf("const doOpenShift"));
  assert.match(pay, /ticketForOrder\(saved, lines\)/);
});

test("both documents are presented from a store-owned layer outside the workspace", () => {
  assert.match(workspace, /<ReceiptLayer \/>/);
  assert.match(workspace, /<KitchenTicketLayer \/>/);
  // Mounted next to each other, outside PosWorkspaceInner's loading states.
  assert.ok(workspace.indexOf("<KitchenTicketLayer />") < workspace.indexOf("function PosWorkspaceInner"));
});

test("an auto-printed ticket does not stop the cashier, a failed one does", () => {
  const store = readTs("state", "kitchenTicket.ts");
  assert.match(store, /visible: status\.kind !== "auto_sent"/);
});

test("the operator is always told the ORDER succeeded before the printer failed", () => {
  assert.equal(ORDER_SUCCEEDED_TICKET_DID_NOT, "The order was sent successfully. Only the kitchen ticket failed.");
  assert.match(autoPrintRunSrc, /ORDER_SUCCEEDED_TICKET_DID_NOT/);
  assert.match(workspace, /The payment succeeded\. Only the receipt failed to print\./);
});

test("the receipt preview stays a manual surface", () => {
  // Automatic printing is decided on the transaction-completion path, never in a
  // modal that can be reopened, re-rendered and remounted.
  for (const token of ["auto_print", "autoPrint", "pos_receipt_settings"]) {
    assert.equal(receiptModal.includes(token), false, token);
  }
  assert.equal(kitchenModal.includes("autoPrint"), false);
});

test("opening either preview prints nothing", () => {
  for (const [name, src] of [["kitchen", kitchenModal], ["receipt", receiptModal]] as const) {
    const effect = src.slice(src.indexOf("useEffect("), src.indexOf("const target ="));
    assert.equal(effect.includes("printKitchenTicket"), false, name);
    assert.equal(effect.includes("printReceipt"), false, name);
    assert.match(effect, /listPrinters\(\)/);
  }
  assert.match(kitchenModal, /resolvePrintRoute\(\{ branchId, purpose: "kitchen_ticket", orderSource: source \}\)/);
});

test("the manual ticket path sends only from a confirmation, and only once", () => {
  assert.match(kitchenModal, /onClick=\{\(\) => void send\(\)\}/);
  assert.equal((kitchenModal.match(/void send\(\)/g) ?? []).length, 1);
  assert.match(kitchenModal, /disabled=\{busy \|\| !target \|\| confirming\}/);
});

test("success is acceptance, never paper", () => {
  assert.match(kitchenModal, /\{ACCEPTED_MESSAGE\}/);
  assert.equal(/printed successfully/i.test(kitchenModal), false);
  assert.match(kitchenModal, /Check the printer/);
  assert.match(kitchenModal, /may already have received the job/);
});

// --- the native boundary -----------------------------------------------------

test("the kitchen command is on the one IPC surface, through the one adapter", () => {
  assert.ok([...NATIVE_COMMANDS].includes("print_kitchen_ticket"));
  assert.match(libRs, /printing::print_kitchen_ticket/);
  assert.equal(kitchenModal.includes("@tauri-apps/api/core"), false);
});

test("the client refuses without a Tauri runtime rather than pretending", async () => {
  const result = await printKitchenTicket({
    printerName: "Xprinter XP-80",
    paperWidth: "custom:72",
    copies: 1,
    ticket: buildKitchenTicket({
      businessName: "B",
      branchName: "Br",
      orderNumber: "1",
      source: "takeaway",
      at: "now",
      lines: [line("Fries")],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "native_unavailable");
});

test("the ticket document is built field by field, never spread", () => {
  const client = readTs("lib", "nativePrinting.ts");
  const fn = client.slice(client.indexOf("export function toKitchenTicketDoc"), client.indexOf("export async function printKitchenTicket"));
  assert.equal(/\.\.\.ticket/.test(fn), false);
  assert.match(fn, /orderNumber: ticket\.orderNumber/);
  assert.match(fn, /batchLabel: ticket\.batchLabel \?\? null/);
});

test("copies and width are validated before any invoke", () => {
  const client = readTs("lib", "nativePrinting.ts");
  const fn = client.slice(client.indexOf("export async function printKitchenTicket"));
  assert.ok(fn.indexOf("validateCopies") < fn.indexOf("invokeNative"));
  assert.ok(fn.indexOf("isPaperWidth") < fn.indexOf("invokeNative"));
});

test("the Rust ticket type has no monetary field", () => {
  const struct = kitchenRs.slice(kitchenRs.indexOf("pub struct KitchenTicketDoc"), kitchenRs.indexOf("fn too_long"));
  for (const money of ["f64", "price", "total", "subtotal", "discount", "currency"]) {
    assert.equal(struct.toLowerCase().includes(money), false, `KitchenTicketDoc must not carry ${money}`);
  }
});

test("no advanced routing, network printing or drawer concept leaks in", () => {
  for (const src of [kitchenLib, kitchenModal, autoPrintSrc, autoPrintRunSrc]) {
    for (const token of [
      "station_id", "section_id", "menu_category_id", "preparation_component_id",
      "escpos", "TcpStream", "cash_drawer", "auto_cut", "9100", "print_jobs",
      "printer_diagnostic_logs",
    ]) {
      assert.equal(src.toLowerCase().includes(token.toLowerCase()), false, token);
    }
  }
});

test("printing reads routing and never writes it", () => {
  for (const src of [kitchenLib, kitchenModal, autoPrintRunSrc]) {
    for (const write of ["createBasicRoute", "updateBasicRoute", "removeBasicRoute", "createPrinter", "updatePrinter", "setPrinterActive"]) {
      assert.equal(src.includes(write), false, write);
    }
  }
});
