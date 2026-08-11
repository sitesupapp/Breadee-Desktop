// Level 3E-A: the native printing boundary.
//
// This is the first time the desktop app can reach the operating system, so the
// tests that matter most are the ones about what CANNOT happen: the frontend
// cannot hand Rust bytes, a path, an address or a command; the page cannot
// carry trading data; nothing prints without an operator pressing a button; and
// no POS or server row is written anywhere on the path.
//
// The UI assertions are static reads of the source, for the reason the delivery
// suites give: "the control is not rendered" is a weaker guarantee than "the
// call site does not exist", and for something that drives hardware the second
// is the one worth having.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ACCEPTED_MESSAGE,
  MAX_COPIES,
  MIN_COPIES,
  NATIVE_COMMANDS,
  PAPER_WIDTHS,
  buildTestPrintRequest,
  isNativeAvailable,
  isPaperWidth,
  listPrinters,
  printTestPage,
  toNativeError,
  validateCopies,
  type InstalledPrinter,
} from "@/lib/nativePrinting";
import {
  bindPrinters,
  bindingLabel,
  unconfiguredPrinters,
  type ServerPrinter,
} from "@/lib/pos/printerRegistry";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");
const readTauri = (...p: string[]) => readFileSync(join(root, "..", "src-tauri", ...p), "utf8");

const client = stripComments(readSrc("lib", "nativePrinting.ts"));
const registry = stripComments(readSrc("lib", "pos", "printerRegistry.ts"));
const screen = stripJsxComments(readSrc("screens", "settings", "Printers.tsx"));
const libRs = readTauri("src", "lib.rs");
const capabilities = readTauri("capabilities", "default.json");
const cargoToml = readTauri("Cargo.toml");

const installed = (name: string, is_default = false): InstalledPrinter => ({
  name,
  is_default,
  status: "unknown",
});

const configured = (over: Partial<ServerPrinter> = {}): ServerPrinter => ({
  id: "p1",
  name: "Cashier",
  printer_type: "cashier",
  connection_type: "system",
  system_printer_name: "Star TSP100",
  paper_width: "80mm",
  default_copy_count: 1,
  auto_cut_enabled: false,
  cash_drawer_enabled: false,
  status: "unknown",
  station_id: null,
  branch_id: "b1",
  ...over,
});

// --- the native client -------------------------------------------------------

// RETARGETED BY LEVEL 3E-B: two -> three, for `print_receipt`. The number is a
// guard against a command arriving unnoticed, so it moves by exactly the one
// that was reviewed - and the whole list is still asserted, not just the count.
test("the client knows exactly three commands", () => {
  assert.deepEqual([...NATIVE_COMMANDS], ["list_printers", "print_test_page", "print_receipt"]);
});

test("the request carries a name, a width and a count - and nothing else", () => {
  const req = buildTestPrintRequest({ printerName: "Star TSP100", paperWidth: "80mm", copies: 2 });
  assert.deepEqual(Object.keys(req).sort(), ["copies", "paper_width", "printer_name"]);
  assert.equal(req.printer_name, "Star TSP100");
  assert.equal(req.paper_width, "80mm");
  assert.equal(req.copies, 2);
});

test("only the two thermal widths are accepted", () => {
  assert.deepEqual([...PAPER_WIDTHS], ["58mm", "80mm"]);
  assert.equal(isPaperWidth("58mm"), true);
  assert.equal(isPaperWidth("80mm"), true);
  // Present in the server registry, but this phase has no layout for them.
  for (const bad of ["a4", "custom", "120mm", "", null, undefined, 80]) {
    assert.equal(isPaperWidth(bad), false, `${String(bad)} must not be a paper width`);
  }
});

test("copies are bounded, and non-integers are refused", () => {
  assert.equal(validateCopies(MIN_COPIES), null);
  assert.equal(validateCopies(MAX_COPIES), null);
  for (const bad of [0, -1, 6, 99, 1.5, Number.NaN, Infinity]) {
    assert.equal(validateCopies(bad)?.code, "invalid_copy_count", `copies=${bad}`);
  }
});

test("without a Tauri runtime the client refuses rather than pretending", async () => {
  // Node has no `__TAURI_INTERNALS__`, which is exactly the browser dev-server
  // case. A fake printer list here would make a broken build look healthy.
  assert.equal(isNativeAvailable(), false);
  const listed = await listPrinters();
  assert.equal(listed.ok, false);
  assert.equal(listed.ok === false && listed.error.code, "native_unavailable");

  const printed = await printTestPage({ printerName: "X", paperWidth: "80mm", copies: 1 });
  assert.equal(printed.ok, false);
  assert.equal(printed.ok === false && printed.error.code, "native_unavailable");
});

test("the unavailable message names the installed app rather than blaming the printer", () => {
  assert.match(
    stripComments(readSrc("lib", "nativePrinting.ts")),
    /native_unavailable: "Native printing is available only in the installed Desktop app\."/,
  );
});

test("every Rust error code maps to an operator sentence", () => {
  const codes = [
    "printer_enumeration_failed",
    "printer_not_found",
    "invalid_paper_width",
    "invalid_copy_count",
    "render_failed",
    "open_printer_failed",
    "start_document_failed",
    "write_failed",
    "finish_document_failed",
    "unsupported_platform",
  ];
  for (const code of codes) {
    const mapped = toNativeError({ code, printer: "P", detail: "win32 says no" });
    assert.equal(mapped.code, code);
    assert.ok(mapped.message.length > 0, `${code} needs a message`);
    // The technical remainder is preserved for logs, not lost.
    assert.ok(mapped.detail && mapped.detail.includes("win32 says no"));
  }
});

test("an unrecognised failure becomes 'unexpected' rather than being shown raw", () => {
  assert.equal(toNativeError("boom").code, "unexpected");
  assert.equal(toNativeError({ code: "something_new" }).code, "unexpected");
  assert.equal(toNativeError(new Error("kaboom")).code, "unexpected");
  assert.equal(toNativeError(null).code, "unexpected");
  // The raw text survives as detail so a developer can still see it.
  assert.equal(toNativeError("boom").detail, "boom");
});

test("success is worded as acceptance, never as paper", () => {
  assert.equal(ACCEPTED_MESSAGE, "Print job accepted by Windows.");
  for (const src of [client, screen]) {
    assert.equal(/printed successfully/i.test(src), false);
    assert.equal(/print(ed|s)? (ok|fine|correctly)/i.test(src), false);
  }
});

test("the client never falls back to the browser print dialog", () => {
  // Substituting window.print() would report success for a completely
  // different mechanism than the one that was asked for.
  //
  // RETARGETED BY LEVEL 3E-B. This also asserted that `printReceipt(` was
  // absent, aimed at the WEB app's browser-print helper of that name. Level
  // 3E-B introduces a native `printReceipt` command, so the old spelling now
  // matches a legitimate function and proves nothing. `window.print` is the
  // thing that actually distinguishes the two mechanisms, and it is what the
  // assertion keeps.
  for (const src of [client, screen]) {
    assert.equal(src.includes("window.print"), false);
    assert.equal(src.includes("document.execCommand"), false);
  }
});

// --- the registry ------------------------------------------------------------

test("a configured system printer that is installed here is bound", () => {
  const [b] = bindPrinters([configured()], [installed("Star TSP100", true)]);
  assert.equal(b.state, "bound");
  assert.equal(b.installed?.name, "Star TSP100");
  assert.equal(bindingLabel("bound"), "Configured and installed");
});

test("a configured system printer that is absent here is reported missing", () => {
  const [b] = bindPrinters([configured()], [installed("Something Else")]);
  assert.equal(b.state, "missing");
  assert.equal(b.installed, null);
});

test("a NULL system_printer_name is unbound, not an error", () => {
  // This is the actual staging fixture. The screen must render it calmly.
  const [b] = bindPrinters([configured({ system_printer_name: null })], [installed("Star TSP100")]);
  assert.equal(b.state, "unbound");
  assert.equal(bindingLabel("unbound"), "No Windows printer recorded yet");
});

test("usb, network and desktop_connector are shown as not supported yet", () => {
  for (const connection of ["usb", "network", "desktop_connector"] as const) {
    const [b] = bindPrinters([configured({ connection_type: connection })], [installed("Star TSP100")]);
    assert.equal(b.state, "not_supported_yet", connection);
    assert.equal(b.installed, null);
  }
  // `desktop_connector` semantics are undocumented in the web app; this phase
  // does not invent them.
  assert.match(registry, /desktop_connector` is named in the schema|desktop_connector/);
});

test("binding never matches fuzzily or case-insensitively", () => {
  for (const near of ["star tsp100", "STAR TSP100", "Star TSP100 ", "Star", "Star TSP-100"]) {
    const [b] = bindPrinters([configured()], [installed(near)]);
    assert.equal(b.state, "missing", `${near} must not bind`);
  }
});

test("installed printers nobody configured are listed as unconfigured", () => {
  const unclaimed = unconfiguredPrinters(
    [configured({ system_printer_name: "Star TSP100" })],
    [installed("Star TSP100"), installed("Microsoft Print to PDF")],
  );
  assert.deepEqual(unclaimed.map((p) => p.name), ["Microsoft Print to PDF"]);
});

test("a printer configured without a Windows name claims nothing", () => {
  const unclaimed = unconfiguredPrinters(
    [configured({ system_printer_name: null })],
    [installed("Star TSP100")],
  );
  assert.deepEqual(unclaimed.map((p) => p.name), ["Star TSP100"]);
});

test("the registry query is scoped, active-only and read-only", () => {
  assert.match(registry, /\.eq\("tenant_id", input\.tenantId\)/);
  assert.match(registry, /\.eq\("is_active", true\)/);
  // Tenant-wide rows (null branch) apply everywhere; branch rows must match.
  assert.match(registry, /p\.branch_id === null \|\| p\.branch_id === input\.branchId/);
  for (const write of ["insert", "update", "upsert", "delete", "rpc("]) {
    assert.equal(registry.includes(write), false, `the registry reader must not ${write}`);
  }
});

test("the native path does not read the legacy localStorage printer config", () => {
  // `lib/printers.ts` predates the server model and disagrees with it - it has
  // a "bar" role the database rejects and no desktop_connector.
  for (const src of [client, registry, screen]) {
    assert.equal(src.includes("loadPrinters"), false);
    assert.equal(src.includes("savePrinters"), false);
    assert.equal(src.includes("breadee-desktop-printers"), false);
    assert.equal(src.includes("localStorage"), false);
  }
});

// --- the screen --------------------------------------------------------------

test("the screen shows the configured list and the installed list separately", () => {
  assert.match(screen, /Configured for this branch/);
  assert.match(screen, /Installed on this Windows terminal/);
  assert.match(screen, /loadServerPrinters\(/);
  assert.match(screen, /listPrinters\(\)/);
});

test("the screen says plainly that configuration lives in the web app", () => {
  assert.match(screen, /Read only here/);
});

test("nothing prints without an explicit selection and a confirmation", () => {
  // Two gates: a printer must be chosen, and the confirmation names it.
  assert.match(screen, /disabled=\{!selected \|\| printing\}/);
  assert.match(screen, /setConfirming\(true\)/);
  assert.match(screen, /Send a test page to this printer\?/);
  assert.match(screen, /onClick=\{\(\) => void runTestPrint\(\)\}/);
});

test("the confirmation names the exact printer, width and copy count", () => {
  assert.match(screen, /will be sent to <strong>\{selected\}<\/strong>/);
  assert.match(screen, /\{copies\} page/);
  assert.match(screen, /at \{paper\}/);
});

test("printing never happens on mount, on a timer, or as a side effect", () => {
  // The only effect on this screen refreshes the two READ-ONLY lists.
  const effects = screen.match(/useEffect\(/g) ?? [];
  assert.equal(effects.length, 1, "one effect only");
  const effectBody = screen.slice(screen.indexOf("useEffect("), screen.indexOf("const bindings"));
  assert.equal(effectBody.includes("printTestPage"), false);
  assert.equal(effectBody.includes("runTestPrint"), false);
  assert.match(effectBody, /void refresh\(\)/);
  for (const timer of ["setTimeout", "setInterval", "requestAnimationFrame"]) {
    assert.equal(screen.includes(timer), false, `${timer} must not drive printing`);
  }
});

test("the screen performs no POS or financial call at all", () => {
  for (const token of [
    "callPosRpc", "pos_submit_order", "pos_pay_order", "pos_pay_table", "pos_void_order",
    "pos_edit_order", "useCart", "useShift", "openPayment", "buildReceipt",
  ]) {
    assert.equal(screen.includes(token), false, `${token} must not appear on the printers screen`);
  }
});

test("no network or USB printing path is exposed by the UI", () => {
  for (const token of ["ip_address", "network_port", "9100", "TcpStream", "socket", "escpos", "ESC/POS"]) {
    assert.equal(screen.toLowerCase().includes(token.toLowerCase()), false, `${token} is not in this phase`);
  }
});

test("the screen states what this phase does not yet do", () => {
  assert.match(screen, /Receipt and kitchen printing, automatic printing, station routing, network printers and the cash drawer are\s*not connected yet/);
});

// --- POS surfaces are untouched ---------------------------------------------

test("the dashboard still says printing is unavailable", () => {
  const modules = stripComments(readSrc("lib", "modules.ts"));
  assert.ok(
    modules.includes(
      "Takeaway, Dine-in and Delivery POS: shifts, tables, customers and addresses, modifiers, discounts, cash payment and on-screen receipts. Printing is not available yet.",
    ),
    "3E-A is a foundation, not POS printing - the tile must not claim otherwise",
  );
});

// RETARGETED BY LEVEL 3E-B. This asserted the preview's Print control was
// disabled and that the preview knew nothing of native printing - true while
// 3E-A was a foundation with no consumer, and the exact thing 3E-B exists to
// change. What must still hold is that the preview prints RECEIPTS and does not
// borrow the diagnostic test page, and that printing is gated rather than free.
test("the receipt preview prints receipts, not the diagnostic page, and is gated", () => {
  const preview = stripJsxComments(readSrc("screens", "pos", "ReceiptPreview.tsx"));
  assert.equal(preview.includes("printTestPage"), false, "the test page is not a receipt");
  assert.match(preview, /printReceipt\(/);
  assert.match(preview, /receiptPrintGate\(/);
  assert.match(preview, /<GatedButton/);
});

test("no POS workspace reaches native printing", () => {
  for (const file of [
    ["screens", "pos", "PosWorkspace.tsx"],
    ["screens", "pos", "DeliveryWorkspace.tsx"],
    ["screens", "pos", "DineInWorkspace.tsx"],
  ]) {
    const src = stripJsxComments(readSrc(...file));
    assert.equal(src.includes("nativePrinting"), false, `${file.join("/")} must not print natively yet`);
    assert.equal(src.includes("print_test_page"), false);
  }
});

// --- the native boundary -----------------------------------------------------

// RETARGETED BY LEVEL 3E-B: two -> three. Still an exact list, so a fourth
// command cannot arrive without this line changing in review.
test("the invoke handler exposes exactly the three printing commands", () => {
  const handler = libRs.slice(libRs.indexOf("invoke_handler"), libRs.indexOf("]));"));
  const commands = [...handler.matchAll(/printing::(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(commands, ["list_printers", "print_test_page", "print_receipt"]);
});

test("the capability grants no shell, filesystem, network or process access", () => {
  const parsed = JSON.parse(capabilities) as { permissions: string[] };
  assert.deepEqual(parsed.permissions, ["core:default", "opener:default"]);
  for (const forbidden of ["shell", "fs:", "http", "process", "dialog", "path:"]) {
    assert.equal(
      parsed.permissions.some((p) => p.includes(forbidden)),
      false,
      `${forbidden} must not be granted`,
    );
  }
});

test("the frontend cannot supply bytes, a path, an address or a command", () => {
  // There is no field on the request for any of them, and the client builds the
  // request field by field rather than spreading a caller-supplied object.
  assert.match(client, /printer_name: input\.printerName/);
  assert.match(client, /paper_width: input\.paperWidth/);
  assert.match(client, /copies: input\.copies/);
  assert.equal(/\.\.\.input/.test(client), false, "a spread could carry an unintended field");
  // Matched as whole identifiers: a bare substring search would trip over
  // "port" inside "import" and prove nothing.
  for (const token of ["raw_bytes", "file_path", "ip_address", "network_port", "escpos", "device_path"]) {
    assert.equal(
      new RegExp(`\\b${token}\\b`).test(client.toLowerCase()),
      false,
      `${token} must not be sendable`,
    );
  }
  // The only fields that exist on the wire.
  const requestType = client.slice(client.indexOf("export type TestPrintRequest"), client.indexOf("export type PrintOutcome"));
  const fields = [...requestType.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(fields.sort(), ["copies", "paper_width", "printer_name"]);
});

test("invoke is reached through this adapter only", () => {
  // One door. Scattered invoke() calls would each be a new boundary to review.
  assert.match(client, /const \{ invoke \} = await import\("@tauri-apps\/api\/core"\)/);
  for (const file of [
    ["screens", "settings", "Printers.tsx"],
    ["screens", "pos", "PosWorkspace.tsx"],
    ["screens", "Dashboard.tsx"],
  ]) {
    const src = stripJsxComments(readSrc(...file));
    assert.equal(src.includes("@tauri-apps/api/core"), false, `${file.join("/")} must not invoke directly`);
  }
});

test("the windows crate is reused at its locked version with minimal features", () => {
  assert.match(cargoToml, /windows = \{ version = "0\.61\.3"/);
  // Only what the printer path needs.
  const features = [...cargoToml.matchAll(/"(Win32_[A-Za-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(features, [
    "Win32_Foundation",
    "Win32_Graphics_Gdi",
    "Win32_Graphics_Printing",
    "Win32_Security",
    "Win32_Storage_Xps",
  ]);
  // No third-party printing crate, and Tauri is untouched.
  for (const forbidden of ["escpos", "winspool", "printer-rs", "cups"]) {
    assert.equal(cargoToml.includes(forbidden), false, `${forbidden} must not be a dependency`);
  }
  assert.match(cargoToml, /tauri = \{ version = "2"/);
  assert.match(cargoToml, /tauri-build = \{ version = "2"/);
});

test("the windows dependency is scoped to windows targets", () => {
  assert.match(cargoToml, /\[target\.'cfg\(target_os = "windows"\)'\.dependencies\]\s*[\s\S]{0,80}windows = /);
});
