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
  cashierCandidates,
  receiptPrintGate,
  resolveCashierTarget,
} from "@/lib/pos/cashierPrinter";
import type { ServerPrinter } from "@/lib/pos/printerRegistry";
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

const BRANCH = "b1";

const installed = (name: string): InstalledPrinter => ({ name, is_default: false, status: "unknown" });

const printer = (over: Partial<ServerPrinter> = {}): ServerPrinter => ({
  id: "p1",
  name: "Front counter",
  printer_type: "cashier",
  connection_type: "system",
  system_printer_name: "Xprinter XP-80",
  paper_width: "80mm",
  default_copy_count: 1,
  auto_cut_enabled: false,
  cash_drawer_enabled: false,
  status: "unknown",
  station_id: null,
  branch_id: BRANCH,
  ...over,
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

test("one eligible cashier printer resolves to a single preselected target", () => {
  const r = resolveCashierTarget({
    printers: [printer()],
    installed: [installed("Xprinter XP-80")],
    branchId: BRANCH,
  });
  assert.equal(r.kind, "single");
  if (r.kind !== "single") return;
  assert.equal(r.target.windowsName, "Xprinter XP-80");
  assert.equal(r.target.paperWidth, "80mm");
  assert.equal(r.target.copies, 1);
});

test("two eligible printers require an explicit choice - nothing is picked silently", () => {
  // Nothing in the schema or the web app ranks cashier printers, so inventing a
  // winner here would mean paper appearing in a room nobody chose.
  const r = resolveCashierTarget({
    printers: [printer(), printer({ id: "p2", name: "Back office", system_printer_name: "Star TSP100" })],
    installed: [installed("Xprinter XP-80"), installed("Star TSP100")],
    branchId: BRANCH,
  });
  assert.equal(r.kind, "choice");
  if (r.kind !== "choice") return;
  assert.equal(r.targets.length, 2);
});

test("no configured cashier printer is a blocked state, not a fallback to the Windows default", () => {
  const r = resolveCashierTarget({ printers: [], installed: [installed("Xprinter XP-80")], branchId: BRANCH });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "none_configured");
  assert.match(blockMessage(r.block), /No cashier printer is configured for this branch/);
});

test("a kitchen printer is never treated as a cashier printer", () => {
  // The current staging fixture is exactly this: kitchen, system, NULL name.
  const r = resolveCashierTarget({
    printers: [printer({ printer_type: "kitchen", system_printer_name: null })],
    installed: [installed("Xprinter XP-80")],
    branchId: BRANCH,
  });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "none_configured");
});

test("an inactive row is excluded by the reader, not resurrected here", () => {
  // `loadServerPrinters` filters `is_active`; eligibility assumes that.
  assert.match(stripComments(readSrc("lib", "pos", "printerRegistry.ts")), /\.eq\("is_active", true\)/);
});

test("another branch's printer is never eligible", () => {
  const r = resolveCashierTarget({
    printers: [printer({ branch_id: "other-branch" })],
    installed: [installed("Xprinter XP-80")],
    branchId: BRANCH,
  });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "none_configured");
});

test("a tenant-wide NULL-branch row is not eligible either", () => {
  // The web app filters `.eq("branch_id", …)` and always writes a branch, so a
  // NULL-branch printer is not a product concept. Treating it as "every branch"
  // would be inventing a rule whose failure mode is remote paper.
  const r = resolveCashierTarget({
    printers: [printer({ branch_id: null })],
    installed: [installed("Xprinter XP-80")],
    branchId: BRANCH,
  });
  assert.equal(r.kind, "blocked");
  // Enforced by strict equality in the filter, not by a comment.
  assert.match(resolver, /p\.branch_id === branchId/);
});

test("a configured printer missing from this terminal is reported by name", () => {
  const r = resolveCashierTarget({
    printers: [printer()],
    installed: [installed("Microsoft Print to PDF")],
    branchId: BRANCH,
  });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "not_installed");
  assert.match(blockMessage(r.block), /Xprinter XP-80 is configured for this branch but is not installed/);
});

test("matching is exact - a near miss is a different device", () => {
  for (const near of ["xprinter xp-80", "XPRINTER XP-80", "Xprinter XP-80 ", "Xprinter"]) {
    const r = resolveCashierTarget({ printers: [printer()], installed: [installed(near)], branchId: BRANCH });
    assert.equal(r.kind, "blocked", `${near} must not bind`);
  }
});

test("a configured printer with no Windows name recorded is unbound", () => {
  const r = resolveCashierTarget({
    printers: [printer({ system_printer_name: null })],
    installed: [installed("Xprinter XP-80")],
    branchId: BRANCH,
  });
  assert.equal(r.kind, "blocked");
  if (r.kind !== "blocked") return;
  assert.equal(r.block.reason, "unbound");
});

test("usb, network and desktop_connector are not eligible in this phase", () => {
  for (const connection of ["usb", "network", "desktop_connector"] as const) {
    const r = resolveCashierTarget({
      printers: [printer({ connection_type: connection })],
      installed: [installed("Xprinter XP-80")],
      branchId: BRANCH,
    });
    assert.equal(r.kind, "blocked", connection);
  }
});

test("a4 and custom paper are refused rather than approximated to 80mm", () => {
  // The web app silently falls back to 80mm. That is survivable for a browser
  // preview and is not survivable when it clips a total off a real roll.
  for (const width of ["a4", "custom", null]) {
    const r = resolveCashierTarget({
      printers: [printer({ paper_width: width })],
      installed: [installed("Xprinter XP-80")],
      branchId: BRANCH,
    });
    assert.equal(r.kind, "blocked", `${width}`);
    if (r.kind !== "blocked") continue;
    assert.equal(r.block.reason, "unsupported_paper");
    assert.match(blockMessage(r.block), /supports 58mm and 80mm only/);
  }
});

test("58mm resolves, and copies come from the printer row bounded to 1..5", () => {
  const r = resolveCashierTarget({
    printers: [printer({ paper_width: "58mm", default_copy_count: 3 })],
    installed: [installed("Xprinter XP-80")],
    branchId: BRANCH,
  });
  assert.equal(r.kind, "single");
  if (r.kind !== "single") return;
  assert.equal(r.target.paperWidth, "58mm");
  assert.equal(r.target.copies, 3);

  for (const [configured, expected] of [[0, 1], [99, 5], [-4, 1]] as const) {
    const bounded = resolveCashierTarget({
      printers: [printer({ default_copy_count: configured })],
      installed: [installed("Xprinter XP-80")],
      branchId: BRANCH,
    });
    assert.equal(bounded.kind === "single" && bounded.target.copies, expected);
  }
});

test("candidates are filtered by type, connection and branch together", () => {
  const rows = [
    printer(),
    printer({ id: "k", printer_type: "kitchen" }),
    printer({ id: "n", connection_type: "network" }),
    printer({ id: "b", branch_id: "elsewhere" }),
  ];
  assert.deepEqual(cashierCandidates(rows, BRANCH).map((p) => p.id), ["p1"]);
});

// --- the gate ----------------------------------------------------------------

const single = resolveCashierTarget({
  printers: [printer()],
  installed: [installed("Xprinter XP-80")],
  branchId: BRANCH,
});

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
  const blocked = resolveCashierTarget({ printers: [], installed: [], branchId: BRANCH });
  const gate = receiptPrintGate({
    nativeAvailable: true,
    canPrintReceipts: allow,
    resolution: blocked,
    hasReceipt: true,
    busy: false,
  });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? "", /No cashier printer is configured/);
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
  assert.match(effect, /loadServerPrinters\(/);
  for (const timer of ["setTimeout", "setInterval"]) {
    assert.equal(preview.includes(timer), false, `${timer} must not drive printing`);
  }
  // Sending happens only from the confirmation.
  assert.match(preview, /onClick=\{\(\) => void send\(\)\}/);
});

test("auto_print_customer is deliberately not honoured yet", () => {
  // The setting exists on the server and defaults to true. Nothing in the
  // desktop print path reads it, and no effect sends - so no paper can appear
  // without an operator pressing Print and confirming.
  assert.equal(preview.includes("auto_print"), false);
  assert.equal(preview.includes("pos_receipt_settings"), false);
  const sendSites = preview.match(/void send\(\)/g) ?? [];
  assert.equal(sendSites.length, 1, "sending must have exactly one call site");
});

test("the target printer is shown before anything is sent", () => {
  assert.match(preview, /Print to <strong className="text-ink">\{target\.windowsName\}<\/strong>/);
});

test("the confirmation names the order, copies, width and printer", () => {
  assert.match(preview, /Order #\{data\.orderNumber\}/);
  assert.match(preview, /\{target\.copies\} cop/);
  assert.match(preview, /\{target\.paperWidth\}/);
  assert.match(preview, /<strong>\{target\.windowsName\}<\/strong>/);
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

test("no kitchen, routing, network or drawer concept leaks into this phase", () => {
  for (const src of [preview, resolver]) {
    for (const token of [
      "kitchen_print_routes", "station_id", "kitchen ticket", "escpos", "TcpStream",
      "cash_drawer", "auto_cut", "9100",
    ]) {
      assert.equal(src.toLowerCase().includes(token.toLowerCase()), false, token);
    }
  }
});

// --- the native boundary -----------------------------------------------------

test("the invoke handler exposes exactly three printing commands", () => {
  const handler = libRs.slice(libRs.indexOf("invoke_handler"), libRs.indexOf("]));"));
  const commands = [...handler.matchAll(/printing::(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(commands, ["list_printers", "print_test_page", "print_receipt"]);
  assert.deepEqual([...NATIVE_COMMANDS], ["list_printers", "print_test_page", "print_receipt"]);
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

test("the dashboard copy is untouched by this phase", () => {
  // POS receipts can now print, but the tile's claim is about the product as a
  // whole and kitchen printing is still absent - changing it is 3E-C's call.
  const modules = stripComments(readSrc("lib", "modules.ts"));
  assert.ok(modules.includes("Printing is not available yet."));
});

test("Level 3E-A's test print is untouched", () => {
  const printers = stripJsxComments(readSrc("screens", "settings", "Printers.tsx"));
  assert.match(printers, /printTestPage\(/);
  assert.match(printers, /Send a test page to this printer\?/);
  assert.equal(printers.includes("printReceipt"), false);
});

test("all four receipt routes reach paper through this one modal", () => {
  // Takeaway, Dine-in and Delivery present through the store-owned layer, and
  // Level 3D's historical path goes to the same place - so one integration
  // covers them and none can drift.
  const workspace = stripJsxComments(readSrc("screens", "pos", "PosWorkspace.tsx"));
  assert.match(workspace, /<ReceiptModal data=\{receipt as ReceiptData\} onClose=\{hide\} \/>/);
  assert.match(workspace, /receiptStore\.present\(completion\.receipt\)/);
  const delivery = stripJsxComments(readSrc("screens", "pos", "DeliveryWorkspace.tsx"));
  assert.match(delivery, /onPresentReceipt/);
  assert.match(delivery, /readHistoricalReceipt\(/);
  // And no route prints for itself.
  for (const file of [["screens", "pos", "PosWorkspace.tsx"], ["screens", "pos", "DeliveryWorkspace.tsx"], ["screens", "pos", "DineInWorkspace.tsx"]]) {
    assert.equal(stripJsxComments(readSrc(...file)).includes("printReceipt"), false, file.join("/"));
  }
});
