// Level 3E-B: printing a cashier receipt.
//
// The rules worth protecting here are about WHERE paper comes out and WHETHER
// printing can touch a sale. A receipt printed to the wrong device is a customer
// handed someone else's total; a print path that can reach a payment is a
// spooler fault turning into a refund argument. Both are prevented structurally,
// and the tests below are the structure.
//
// UI assertions are static source reads, for the reason the earlier suites give:
// "the control is not rendered" is weaker than "the call site does not exist".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ACCEPTED_MESSAGE,
  NATIVE_COMMANDS,
  printReceipt,
  toReceiptDoc,
  type InstalledPrinter,
} from "@/lib/nativePrinting";
import {
  blockMessage,
  receiptOrderSource,
  receiptPrintGate,
  resolveReceiptTarget,
} from "@/lib/pos/cashierPrinter";
import type { ResolvedRoute } from "@/lib/pos/printRouteResolver";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");
const readTauri = (...p: string[]) => readFileSync(join(root, "..", "src-tauri", ...p), "utf8");

const preview = stripJsxComments(readSrc("screens", "pos", "ReceiptPreview.tsx"));
const client = stripComments(readSrc("lib", "nativePrinting.ts"));
const resolver = stripComments(readSrc("lib", "pos", "cashierPrinter.ts"));
const libRs = readTauri("src", "lib.rs");
const capabilities = readTauri("capabilities", "default.json");

const allow = { allowed: true, reason: null };
const deny = { allowed: false, reason: "You do not have permission to print receipts." };

const installed = (name: string): InstalledPrinter => ({ name, is_default: false, status: "unknown" });

/**
 * The routing answer for the branch that actually exists on staging: the XP-80,
 * bound exactly, at a CUSTOM 72mm printable width, matched by the `any` default
 * receipt route. This fixture is the reconciliation - before P2/P3-B the same
 * printer was `80mm` and the target was chosen by scanning cashier rows.
 */
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
  print_purpose: "receipt",
  matched_order_source: "any",
  used_default: true,
  ...over,
});

const unresolved = (): ResolvedRoute => ({
  resolved: false,
  route_id: null,
  printer_id: null,
  printer_name: null,
  printer_type: null,
  connection_type: null,
  system_printer_name: null,
  paper_width: null,
  custom_paper_width: null,
  copies: null,
  print_purpose: "receipt",
  matched_order_source: null,
  used_default: null,
});

const receipt = () => ({
  businessName: "Dominos Pizza",
  branchName: "Main Branch",
  staffName: "Cashier",
  orderNumber: "260809-0001",
  orderType: "Delivery",
  at: "8/9/2026, 8:12:54 PM",
  paid: true,
  method: "cash",
  currency: "USD",
  lines: [
    {
      name: "Margherita",
      qty: 1,
      lineTotal: 7,
      modifiers: [{ name: "Small", price_delta: 0, quantity: 1 }],
      note: "No olives",
    },
  ],
  subtotal: 7,
  discount: 0,
  total: 7,
  shiftRef: "74192728",
  customerName: "Desktop Level 3A QA",
  customerPhone: "03 111 999",
  deliveryAddress: "QA, Hamra, QA Street 2",
});

// --- printer resolution ------------------------------------------------------

test("the routed printer becomes the target, at its CUSTOM printable width", () => {
  // The reconciliation in one assertion. P2 configured the XP-80 as `custom` +
  // 72; P3-B routed receipts to it. Before this change the same printer was
  // refused as "unsupported paper", because the old resolver accepted 58/80 only.
  const r = resolveReceiptTarget({ route: route(), installed: [installed("Xprinter XP-80")] });
  assert.equal(r.kind, "single");
  if (r.kind !== "single") return;
  assert.equal(r.target.printerName, "Xprinter XP-80 (Customer receipts)");
  assert.equal(r.target.windowsName, "Xprinter XP-80");
  assert.equal(r.target.paperWidth, "custom:72");
  assert.equal(r.target.copies, 1);
  assert.equal(r.target.usedDefault, true);
});

test("the two presets still resolve exactly as they did", () => {
  for (const [width, expected] of [["58mm", "58mm"], ["80mm", "80mm"]] as const) {
    const r = resolveReceiptTarget({
      route: route({ paper_width: width, custom_paper_width: null }),
      installed: [installed("Xprinter XP-80")],
    });
    assert.equal(r.kind === "single" && r.target.paperWidth, expected);
  }
});

test("no route configured is a blocked state, not a fallback to any printer", () => {
  const r = resolveReceiptTarget({ route: unresolved(), installed: [installed("Xprinter XP-80")] });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "no_route");
  assert.match(blockMessage(r.block), /No receipt route is configured/);
  // And it points at the screen that fixes it.
  assert.match(blockMessage(r.block), /Printing & Routing/);
});

test("nothing is ever guessed when the route does not resolve", () => {
  // The failure mode this protects against is paper in the wrong room.
  for (const token of ["is_default", "installed[0]", "printers[0]", "?? installed", "find((p) => p.is_default"]) {
    assert.equal(resolver.includes(token), false, `${token} must not be a fallback`);
  }
});

test("a source-specific route is reported as such, not as the default", () => {
  const r = resolveReceiptTarget({
    route: route({ matched_order_source: "takeaway", used_default: false }),
    installed: [installed("Xprinter XP-80")],
  });
  assert.equal(r.kind === "single" && r.target.usedDefault, false);
});

test("a routed printer missing from this terminal is reported by name", () => {
  const r = resolveReceiptTarget({ route: route(), installed: [installed("Microsoft Print to PDF")] });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "not_installed");
  assert.match(blockMessage(r.block), /Xprinter XP-80 is not installed on this terminal/);
});

test("matching is exact - a near miss is a different device", () => {
  for (const near of ["xprinter xp-80", "XPRINTER XP-80", "Xprinter XP-80 ", "Xprinter"]) {
    const r = resolveReceiptTarget({ route: route(), installed: [installed(near)] });
    assert.equal(r.kind, "blocked", `${near} must not bind`);
  }
});

test("a routed printer with no Windows name recorded is unbound", () => {
  const r = resolveReceiptTarget({
    route: route({ system_printer_name: null }),
    installed: [installed("Xprinter XP-80")],
  });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "unbound");
});

test("usb, network and desktop_connector are still not drivable", () => {
  for (const connection of ["usb", "network", "desktop_connector"]) {
    const r = resolveReceiptTarget({
      route: route({ connection_type: connection }),
      installed: [installed("Xprinter XP-80")],
    });
    assert.equal(r.kind, "blocked", connection);
    assert.equal(r.kind === "blocked" && r.block.reason, "unsupported_connection");
  }
});

test("a width the renderer cannot lay out is refused, never approximated", () => {
  // Still stricter than the web app, which silently falls back to 80mm. What
  // changed is only WHICH widths are layable - custom is now one of them.
  for (const [paper_width, custom_paper_width] of [
    ["a4", null],
    ["custom", null],
    ["custom", 0],
    ["custom", 500],
    [null, null],
  ] as const) {
    const r = resolveReceiptTarget({
      route: route({ paper_width, custom_paper_width }),
      installed: [installed("Xprinter XP-80")],
    });
    assert.equal(r.kind, "blocked", `${paper_width}/${custom_paper_width}`);
    if (r.kind !== "blocked") continue;
    assert.equal(r.block.reason, "unsupported_paper");
  }
});

test("copies come from the ROUTE, bounded to 1..5", () => {
  // The route is where an operator says "two copies of this receipt"; the
  // printer row's default is a device setting the route overrides.
  assert.equal(
    resolveReceiptTarget({ route: route({ copies: 3 }), installed: [installed("Xprinter XP-80")] }).kind === "single" &&
      resolveReceiptTarget({ route: route({ copies: 3 }), installed: [installed("Xprinter XP-80")] }).kind,
    "single",
  );
  for (const [configured, expected] of [[3, 3], [0, 1], [99, 5], [null, 1]] as const) {
    const r = resolveReceiptTarget({
      route: route({ copies: configured }),
      installed: [installed("Xprinter XP-80")],
    });
    assert.equal(r.kind === "single" && r.target.copies, expected, `${configured}`);
  }
});

test("width is read through P2's helper, not a second parser anywhere", () => {
  // RETARGETED BY POS v1. The route-to-destination step moved into
  // `printTarget.ts` so the kitchen ticket resolves through the identical code
  // rather than a second copy. The property is unchanged and now covers both
  // documents at once: ONE width parser, P2's, and no local whitelist in either
  // file. Asserting it against the file that no longer holds the logic would
  // have been asserting nothing.
  const shared = stripComments(readSrc("lib", "pos", "printTarget.ts"));
  assert.match(shared, /effectivePaperWidth\(/);
  for (const src of [shared, resolver]) {
    assert.equal(/"58mm" \|\| .*=== "80mm"/.test(src), false, "no local width whitelist");
  }
  // The receipt file must not have grown its own resolution back.
  assert.equal(resolver.includes("effectivePaperWidth("), false, "one resolver, not two");
  assert.match(resolver, /return resolveRouteTarget\(input\)/);
});

// --- the order source --------------------------------------------------------

test("the routing source comes from the contract field, not the display string", () => {
  assert.equal(receiptOrderSource({ orderSource: "delivery", orderType: "Takeaway" }), "delivery");
  assert.equal(receiptOrderSource({ orderSource: "dine_in" }), "dine_in");
});

test("the display string is a tolerated fallback, and an unknown one is refused", () => {
  // Every route sets `orderSource`; this covers a receipt built before it
  // existed. Guessing a source could match a Takeaway override and put a
  // delivery receipt on the wrong printer, so anything unrecognised is null.
  assert.equal(receiptOrderSource({ orderType: "Delivery" }), "delivery");
  assert.equal(receiptOrderSource({ orderType: "Dine-in" }), "dine_in");
  assert.equal(receiptOrderSource({ orderType: "takeaway" }), "takeaway");
  for (const unknown of ["", "Catering", "e_menu", "kitchen"]) {
    assert.equal(receiptOrderSource({ orderType: unknown }), null, unknown);
  }
});

test("every live receipt builder states its order source", () => {
  for (const [file, expected] of [
    [["lib", "pos", "paymentCompletion.ts"], "takeaway"],
    [["lib", "pos", "tablePaymentCompletion.ts"], "dine_in"],
    [["lib", "pos", "deliveryHistory.ts"], "delivery"],
  ] as const) {
    assert.match(stripComments(readSrc(...file)), new RegExp(`orderSource: "${expected}"`), file.join("/"));
  }
  assert.match(stripJsxComments(readSrc("screens", "pos", "DeliveryWorkspace.tsx")), /orderSource: "delivery"/);
});

// --- the gate ----------------------------------------------------------------

const single = resolveReceiptTarget({ route: route(), installed: [installed("Xprinter XP-80")] });

test("printing needs the native app, the permission, a receipt and a printer", () => {
  const base = { nativeAvailable: true, canPrintReceipts: allow, resolution: single, hasReceipt: true, busy: false };
  assert.equal(receiptPrintGate(base).allowed, true);

  assert.equal(receiptPrintGate({ ...base, nativeAvailable: false }).allowed, false);
  assert.match(receiptPrintGate({ ...base, nativeAvailable: false }).reason ?? "", /installed Desktop app/);

  assert.equal(receiptPrintGate({ ...base, canPrintReceipts: deny }).allowed, false);
  assert.equal(receiptPrintGate({ ...base, hasReceipt: false }).allowed, false);
  assert.equal(receiptPrintGate({ ...base, resolution: null }).allowed, false);
  assert.equal(receiptPrintGate({ ...base, busy: true }).allowed, false);
});

test("a blocked printer state explains itself through the gate", () => {
  const blocked = resolveReceiptTarget({ route: unresolved(), installed: [] });
  const gate = receiptPrintGate({
    nativeAvailable: true,
    canPrintReceipts: allow,
    resolution: blocked,
    hasReceipt: true,
    busy: false,
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /No receipt route is configured/);
});

test("a historical receipt is still printable", () => {
  // A reprint is an ordinary, intentional operator action.
  const gate = receiptPrintGate({
    nativeAvailable: true,
    canPrintReceipts: allow,
    resolution: single,
    hasReceipt: true,
    busy: false,
  });
  assert.equal(gate.allowed, true);
});

// --- the request -------------------------------------------------------------

test("the receipt document carries exactly the fields the renderer needs", () => {
  const doc = toReceiptDoc(receipt());
  assert.deepEqual(Object.keys(doc).sort(), [
    "at", "branchName", "businessName", "change", "currency", "customerName", "customerPhone",
    "deliveryAddress", "discount", "lines", "method", "orderNumber", "orderType", "paid",
    "seats", "shiftRef", "staffName", "subtotal", "tableName", "tenderCurrency", "tenderTotal",
    "tendered", "total",
  ]);
  assert.equal(doc.lines[0].modifiers[0].name, "Small");
  assert.equal(doc.lines[0].note, "No olives");
});

test("live tender and change are carried; a historical receipt omits them", () => {
  const live = toReceiptDoc({ ...receipt(), tenderCurrency: "USD", tendered: 10, change: 3 });
  assert.equal(live.tendered, 10);
  assert.equal(live.change, 3);

  // Level 3D's historical reconstruction sets these null on purpose.
  const historical = toReceiptDoc(receipt());
  assert.equal(historical.tendered, null);
  assert.equal(historical.change, null);
  assert.equal(historical.tenderCurrency, null);
});

test("the document is built field by field, never spread", () => {
  // A spread is how a future UI-only field silently crosses the boundary.
  const fn = client.slice(client.indexOf("export function toReceiptDoc"), client.indexOf("export async function printReceipt"));
  assert.equal(/\.\.\.receipt/.test(fn), false);
  assert.match(fn, /businessName: receipt\.businessName/);
  assert.match(fn, /tendered: receipt\.tendered \?\? null/);
});

test("no raw bytes, path, address or command can reach the receipt command", () => {
  const fn = client.slice(client.indexOf("export async function printReceipt"));
  assert.match(fn, /printerName: input\.printerName/);
  assert.match(fn, /paperWidth: input\.paperWidth/);
  assert.match(fn, /copies: input\.copies/);
  assert.match(fn, /receipt: toReceiptDoc\(input\.receipt\)/);
  for (const token of ["raw_bytes", "file_path", "ip_address", "network_port", "escpos"]) {
    assert.equal(new RegExp(`\\b${token}\\b`).test(fn.toLowerCase()), false, token);
  }
});

test("the client refuses without a Tauri runtime rather than pretending", async () => {
  const result = await printReceipt({
    printerName: "Xprinter XP-80",
    paperWidth: "80mm",
    copies: 1,
    receipt: receipt(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error.code, "native_unavailable");
});

test("copies and width are validated before any invoke", async () => {
  for (const copies of [0, 6]) {
    const r = await printReceipt({ printerName: "P", paperWidth: "80mm", copies, receipt: receipt() });
    assert.equal(r.ok === false && r.error.code, "native_unavailable");
  }
  // (native_unavailable fires first under Node; the ordering itself is asserted
  // in the source so the guard cannot be reordered away.)
  const fn = client.slice(client.indexOf("export async function printReceipt"));
  assert.ok(fn.indexOf("validateCopies") < fn.indexOf("invokeNative"));
  assert.ok(fn.indexOf("isPaperWidth") < fn.indexOf("invokeNative"));
});

// --- the preview -------------------------------------------------------------

test("printing is manual - nothing prints on open, on payment or on a timer", () => {
  // The only effect resolves a PRINTER. It must not print.
  const effect = preview.slice(preview.indexOf("useEffect("), preview.indexOf("const target ="));
  assert.equal(effect.includes("printReceipt"), false);
  assert.match(effect, /listPrinters\(\)/);
  // The destination is ASKED FOR, not decided here.
  assert.match(effect, /resolvePrintRoute\(\{ branchId, purpose: "receipt", orderSource: source \}\)/);
  for (const timer of ["setTimeout", "setInterval"]) {
    assert.equal(preview.includes(timer), false, `${timer} must not drive printing`);
  }
  // Sending happens only from the confirmation.
  assert.match(preview, /onClick=\{\(\) => void send\(\)\}/);
});

test("the preview is a MANUAL surface - automatic printing is not decided here", () => {
  // RETARGETED for POS v1. `auto_print_customer` IS honoured now, and the
  // original assertion ("nothing anywhere reads it") had to change with it. The
  // property that outlives the change is the one that actually kept this file
  // safe: the preview modal decides nothing automatically. It reads no setting,
  // has one send call site, and that site is behind an operator confirmation.
  //
  // Automatic printing lives on the transaction-completion path instead
  // (`lib/pos/autoPrint.ts`), which is where the "did this transaction just
  // succeed exactly once" question is actually answerable. A modal that can be
  // reopened, re-rendered and remounted is the wrong place to reason about
  // duplicate paper.
  assert.equal(preview.includes("auto_print"), false);
  assert.equal(preview.includes("pos_receipt_settings"), false);
  assert.equal(preview.includes("autoPrint"), false);
  const sendSites = preview.match(/void send\(\)/g) ?? [];
  assert.equal(sendSites.length, 1, "sending must have exactly one call site");
});

test("the target printer is shown before anything is sent", () => {
  // Both names: the Breadee alias the operator recognises, and the Windows queue
  // that decides which device it actually is.
  assert.match(preview, /Print to <strong className="text-ink">\{target\.printerName\}<\/strong> \(\{target\.windowsName\}\)/);
  assert.match(preview, /Routed by the/);
});

test("the confirmation names the order, copies, width and printer", () => {
  assert.match(preview, /Order #\{data\.orderNumber\}/);
  assert.match(preview, /\{target\.copies\} cop/);
  // The LABEL, so a custom roll reads "72 mm printable" rather than "custom:72".
  assert.match(preview, /paperWidthLabel\(target\.paperWidth\)/);
  assert.match(preview, /<strong>\{target\.printerName\}<\/strong>/);
});

test("a second click cannot send a second job", () => {
  assert.match(preview, /disabled=\{busy \|\| !target \|\| confirming\}/);
  assert.match(preview, /setBusy\(true\)/);
  assert.match(preview, /\{busy \? "Sending to Windows\.\.\." : "Send"\}/);
});

test("success is acceptance, never paper", () => {
  assert.match(preview, /\{ACCEPTED_MESSAGE\}/);
  assert.equal(ACCEPTED_MESSAGE, "Print job accepted by Windows.");
  assert.equal(/printed successfully/i.test(preview), false);
  assert.match(preview, /Check the printer/);
});

test("an ambiguous transport failure does not invite another tap", () => {
  assert.match(preview, /finish_document_failed" \|\| error\.code === "write_failed"/);
  assert.match(preview, /may already have received the job/);
});

test("there is no automatic retry anywhere on the print path", () => {
  for (const token of ["retry", "attempt++", "while ("]) {
    assert.equal(preview.toLowerCase().includes(token.toLowerCase()), false, token);
  }
});

test("the preview never falls back to the browser print dialog", () => {
  assert.equal(preview.includes("window.print"), false);
  assert.match(preview, /Native printing is available in the installed Desktop app/);
});

test("a reprint is labelled as one", () => {
  assert.match(preview, /const isReprint = data\.tendered == null && data\.paid/);
  assert.match(preview, /isReprint \? "Reprint" : "Print"/);
  assert.match(preview, /isReprint \? "Reprint this receipt\?" : "Print this receipt\?"/);
});

// --- transaction independence ------------------------------------------------

test("the receipt preview performs no POS or financial call at all", () => {
  for (const token of [
    "callPosRpc", "pos_pay_order", "pos_pay_table", "pos_submit_order", "pos_void_order",
    "pos_edit_order", "useCart", "useShift", "refreshCashBox", "print_jobs",
    "printer_diagnostic_logs", "kitchen_log_printer_diagnostic",
  ]) {
    assert.equal(preview.includes(token), false, `${token} must not appear on the print path`);
  }
});

test("the resolver reads the registry and writes nothing", () => {
  for (const write of ["insert", "update", "upsert", "delete", "rpc("]) {
    assert.equal(resolver.includes(write), false, write);
  }
  assert.equal(resolver.includes("localStorage"), false);
  assert.equal(resolver.includes("loadPrinters"), false);
});

test("no kitchen, advanced-routing, network or drawer concept leaks into this phase", () => {
  // RETARGETED. Receipt routing is no longer a leak - it is the mechanism this
  // phase was reconciled onto, and the resolver call is how the target is found.
  // What must still stay out is everything routing does NOT cover here: kitchen
  // tickets, the advanced scopes P5 owns, direct network printing and the drawer.
  // The print path also still writes no routing row - it reads the resolver.
  for (const src of [preview, resolver]) {
    for (const token of [
      "kitchen_print_routes", "station_id", "section_id", "menu_category_id",
      "preparation_component_id", "kitchen ticket", "kitchen_ticket", "escpos",
      "TcpStream", "cash_drawer", "auto_cut", "9100",
    ]) {
      assert.equal(src.toLowerCase().includes(token.toLowerCase()), false, token);
    }
  }
});

test("printing reads routing and never writes it", () => {
  for (const src of [preview, resolver]) {
    for (const write of ["createBasicRoute", "updateBasicRoute", "removeBasicRoute", "createPrinter", "updatePrinter", "setPrinterActive"]) {
      assert.equal(src.includes(write), false, write);
    }
  }
});

// --- the native boundary -----------------------------------------------------

test("the invoke handler exposes exactly the printing commands, and no others", () => {
  // RETARGETED for POS v1. The count was never the property worth defending -
  // the property is that the IPC surface is an explicit, reviewable LIST that
  // both sides agree on, and that nothing outside printing is on it. POS v1
  // added `print_kitchen_ticket` deliberately and in its own edit to lib.rs,
  // which is exactly the visibility this assertion exists to force.
  const expected = ["list_printers", "print_test_page", "print_receipt", "print_kitchen_ticket"];
  const handler = libRs.slice(libRs.indexOf("invoke_handler"), libRs.indexOf("]));"));
  const commands = [...handler.matchAll(/printing::(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(commands, expected);
  assert.deepEqual([...NATIVE_COMMANDS], expected);
});

test("no new capability was granted", () => {
  const parsed = JSON.parse(capabilities) as { permissions: string[] };
  assert.deepEqual(parsed.permissions, ["core:default", "opener:default"]);
});

test("invoke is still reached only through the one adapter", () => {
  assert.equal(preview.includes("@tauri-apps/api/core"), false);
  assert.match(client, /const \{ invoke \} = await import\("@tauri-apps\/api\/core"\)/);
});

test("the permission gate uses the documented key and feature", () => {
  const access = stripComments(readSrc("lib", "pos", "access.ts"));
  assert.match(access, /PRINT_RECEIPTS: "pos\.print_receipts"/);
  assert.match(access, /export function canPrintReceipts/);
  assert.match(access, /FEATURES\.POS_PRINTING/);
  // Not a role check.
  assert.equal(/canPrintReceipts[\s\S]{0,400}role ===/.test(access), false);
});

// --- regression --------------------------------------------------------------

test("the dashboard copy no longer denies printing", () => {
  // RETARGETED BY POS v1. 3E-B deliberately left the tile alone because kitchen
  // printing was still absent, so "Printing is not available yet" was only half
  // wrong. POS v1 ships the other half, and the sentence is now wrong outright -
  // which is the harmful direction: a cashier who reads it never goes looking
  // for the setting that would have worked. The full both-directions assertion
  // lives in `native-printing.test.ts`; this file keeps the half it cares about.
  const modules = stripComments(readSrc("lib", "modules.ts"));
  assert.equal(modules.includes("Printing is not available yet."), false);
  assert.ok(modules.includes("receipts and kitchen tickets"));
});

test("the diagnostic test print is untouched, and never prints a receipt", () => {
  // RETARGETED. P2's Quick Setup rewrote this screen and its confirmation now
  // reads "Send a test page?" rather than "…to this printer?". The wording was
  // never the property - the properties are that the diagnostic path still
  // exists, still confirms before paper, and is still a different document from
  // the cashier receipt.
  const printers = stripJsxComments(readSrc("screens", "settings", "Printers.tsx"));
  assert.match(printers, /printTestPage\(/);
  assert.match(printers, /Send a test page\?/);
  assert.equal(printers.includes("printReceipt"), false);
});

test("all four receipt routes reach paper through this one modal", () => {
  // Takeaway, Dine-in and Delivery present through the store-owned layer, and
  // Level 3D's historical path goes to the same place - so one integration
  // covers them and none can drift.
  const workspace = stripJsxComments(readSrc("screens", "pos", "PosWorkspace.tsx"));
  assert.match(workspace, /<ReceiptModal data=\{receipt as ReceiptData\} onClose=\{hide\} \/>/);
  // RETARGETED BY POS v1. The takeaway path used to call `receiptStore.present`
  // directly. It now goes through `presentReceipt`, which is the SAME store
  // presentation plus the automatic-print attempt - and which dine-in and
  // delivery are handed too, so all three share one call site instead of three.
  // The property was never the name of the function; it is that every route
  // reaches the one store-owned layer rather than presenting for itself.
  assert.match(workspace, /presentReceipt\(completion\.receipt\)/);
  assert.match(workspace, /receiptStore\.present\(receipt\)/);
  assert.equal((workspace.match(/onPresentReceipt: presentReceipt/g) ?? []).length, 2);
  const delivery = stripJsxComments(readSrc("screens", "pos", "DeliveryWorkspace.tsx"));
  assert.match(delivery, /onPresentReceipt/);
  assert.match(delivery, /readHistoricalReceipt\(/);
  // And no route prints for itself.
  for (const file of [["screens", "pos", "PosWorkspace.tsx"], ["screens", "pos", "DeliveryWorkspace.tsx"], ["screens", "pos", "DineInWorkspace.tsx"]]) {
    assert.equal(stripJsxComments(readSrc(...file)).includes("printReceipt"), false, file.join("/"));
  }
});
