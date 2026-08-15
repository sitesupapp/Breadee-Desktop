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
  CUSTOM_PAPER_MAX_MM,
  CUSTOM_PAPER_MIN_MM,
  NATIVE_COMMANDS,
  PAPER_PRESETS,
  buildTestPrintRequest,
  customPaperWidth,
  isNativeAvailable,
  isPaperWidth,
  listPrinters,
  paperMillimetres,
  printTestPage,
  toNativeError,
  validateCopies,
  type InstalledPrinter,
} from "@/lib/nativePrinting";
import {
  bindPrinters,
  bindingLabel,
  toStoredPaper,
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

// --- the native client -------------------------------------------------------

// RETARGETED BY LEVEL 3E-B (two -> three, `print_receipt`), by POS v1
// (three -> four, `print_kitchen_ticket`) and by the operations revision
// (four -> five, `print_report`). The number is a guard against a command
// arriving unnoticed, so it moves by exactly the one that was reviewed - and the
// whole list is still asserted, not just the count. The Rust side pins the
// identical list in `EXPOSED_COMMANDS`, so the two ends cannot drift.
test("the client knows exactly five commands", () => {
  assert.deepEqual(
    [...NATIVE_COMMANDS],
    ["list_printers", "print_test_page", "print_receipt", "print_kitchen_ticket", "print_report"],
  );
});

test("the request carries a name, a width, a count and captions - nothing else", () => {
  const req = buildTestPrintRequest({ printerName: "Star TSP100", paperWidth: "80mm", copies: 2 });
  assert.deepEqual(Object.keys(req).sort(), ["context", "copies", "paper_width", "printer_name"]);
  assert.equal(req.printer_name, "Star TSP100");
  assert.equal(req.paper_width, "80mm");
  assert.equal(req.copies, 2);
  assert.equal(req.context, null, "context is opt-in");
});

test("the test-page context carries captions only, never trading data", () => {
  const req = buildTestPrintRequest({
    printerName: "Xprinter XP-80",
    paperWidth: "custom:72",
    copies: 1,
    context: {
      business_name: "Dominos Pizza",
      branch_name: "Main Branch",
      printer_alias: "Front Cashier",
      role: "cashier",
    },
  });
  assert.deepEqual(Object.keys(req.context ?? {}).sort(), [
    "branch_name",
    "business_name",
    "printer_alias",
    "role",
  ]);
});

test("the presets are the two thermal rolls, and custom widths are validated", () => {
  assert.deepEqual([...PAPER_PRESETS], ["58mm", "80mm"]);
  assert.equal(isPaperWidth("58mm"), true);
  assert.equal(isPaperWidth("80mm"), true);
  // The XP-80 case: sold as 80mm, marks 72mm.
  assert.equal(isPaperWidth("custom:72"), true);
  assert.equal(paperMillimetres("custom:72"), 72);
  // A4 is a sheet; a bare `custom` has no width to lay out against; anything
  // outside the printable range is refused rather than clamped.
  for (const bad of ["a4", "custom", "custom:", "custom:0", "custom:39", "custom:121",
                     "custom:72.5", "120mm", "", null, undefined, 80]) {
    assert.equal(isPaperWidth(bad), false, `${String(bad)} must not be a paper width`);
  }
});

test("the custom range matches the web app's, and both ends are inclusive", () => {
  // src/lib/receipt.ts in the Breadee web app declares exactly these.
  assert.equal(CUSTOM_PAPER_MIN_MM, 40);
  assert.equal(CUSTOM_PAPER_MAX_MM, 120);
  assert.equal(customPaperWidth(CUSTOM_PAPER_MIN_MM), "custom:40");
  assert.equal(customPaperWidth(CUSTOM_PAPER_MAX_MM), "custom:120");
  assert.equal(customPaperWidth(CUSTOM_PAPER_MIN_MM - 1), null);
  assert.equal(customPaperWidth(CUSTOM_PAPER_MAX_MM + 1), null);
  assert.equal(customPaperWidth(72.5), null, "whole millimetres only");
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

test("the registry query is scoped, and hides disabled rows unless asked", () => {
  assert.match(registry, /\.eq\("tenant_id", input\.tenantId\)/);
  // Everything that PRINTS still sees active rows only; only setup opts in.
  assert.match(registry, /if \(!input\.includeInactive\) query = query\.eq\("is_active", true\)/);
  // Tenant-wide rows (null branch) apply everywhere; branch rows must match.
  assert.match(registry, /p\.branch_id === null \|\| p\.branch_id === input\.branchId/);
});

test("the registry writes only pos_printer_settings, and never deletes", () => {
  // Quick Setup made this module a writer (Level 3E-A's read-only rule was about
  // owning a second source of truth, not about the desktop being read-only
  // forever). The properties that still matter: one table, no RPC, no delete.
  const tables = [...registry.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ["pos_printer_settings"]);
  assert.equal(registry.includes(".rpc("), false, "no RPC - RLS is the authority");
  assert.equal(registry.includes(".delete("), false, "printers are disabled, never deleted");
  assert.equal(registry.includes(".upsert("), false);
});

test("a write never invents a tenant, a branch or a connection type", () => {
  // tenant/branch come from the session context, and the connection is fixed to
  // the only kind this phase can actually drive.
  assert.match(registry, /tenant_id: input\.tenantId/);
  assert.match(registry, /branch_id: input\.branchId/);
  assert.match(registry, /connection_type: "system" as const/);
  for (const unsupported of ['"usb"', '"network"', '"desktop_connector"']) {
    assert.equal(
      registry.includes(`connection_type: ${unsupported}`),
      false,
      `${unsupported} must not be written by setup`,
    );
  }
});

test("switching to a preset clears any stale custom width", () => {
  // A row that was custom:72 and becomes 80mm must not keep 72 lying in the
  // column for a later reader to mistake for the truth.
  assert.deepEqual(toStoredPaper("80mm"), { paper_width: "80mm", custom_paper_width: null });
  assert.deepEqual(toStoredPaper("58mm"), { paper_width: "58mm", custom_paper_width: null });
  assert.deepEqual(toStoredPaper("custom:72"), { paper_width: "custom", custom_paper_width: 72 });
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

test("the screen shows what is set up and what this PC detected, separately", () => {
  assert.match(screen, /Set up for \{pos\.branch\.name\}/);
  assert.match(screen, /Detected on this PC/);
  assert.match(screen, /loadServerPrinters\(/);
  assert.match(screen, /listPrinters\(\)/);
});

test("detection runs when the screen opens, without a button", () => {
  // The first question a technician has is "does this PC see it" - making them
  // ask for the answer is a step that exists only because it was easier.
  assert.match(screen, /useEffect\(\(\) => \{\s*void refresh\(\);/);
  assert.match(screen, /Refresh printers/);
});

test("nothing prints without an explicit request and a confirmation", () => {
  // Two gates: a printer is chosen by pressing Test on one row, and the
  // confirmation names the physical destination before anything is sent.
  assert.match(screen, /setPendingTest\(\{ entry \}\)/);
  assert.match(screen, /Send a test page\?/);
  assert.match(screen, /onClick=\{\(\) => void runTest\(\)\}/);
  // Saving a printer must never print as a side effect.
  const saveBody = screen.slice(screen.indexOf("const save ="), screen.indexOf("const runTest ="));
  assert.equal(saveBody.includes("printTestPage"), false, "saving must not print");
});

test("the confirmation names the exact printer, width and copy count", () => {
  assert.match(screen, /will be sent to\{" "\}\s*<strong>\{pendingTest\.entry\.installed\?\.name\}<\/strong>/);
  assert.match(screen, /paperWidthLabel\(pendingTest\.entry\.paperWidth\)/);
  assert.match(screen, /pendingTest\.entry\.printer\.default_copy_count\} page/);
});

test("only a printer this PC can actually reach can be tested", () => {
  // `canTest` is the single gate, and it requires status === "ready", which
  // means bound to an installed queue AND a width the renderer supports.
  assert.match(screen, /mayTest && canTest\(entry\)/);
});

test("printing never happens on mount, on a timer, or as a side effect", () => {
  const effects = screen.match(/useEffect\(/g) ?? [];
  assert.equal(effects.length, 1, "one effect only");
  const effectBody = screen.slice(screen.indexOf("useEffect("), screen.indexOf("const entries"));
  assert.equal(effectBody.includes("printTestPage"), false);
  assert.equal(effectBody.includes("runTest"), false);
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

test("the screen states what is genuinely still absent, and nothing more", () => {
  // RETARGETED. This pinned the exact sentence "…and automatic printing are not
  // connected yet. Receipts still print manually." P3-B connected routing and
  // POS v1 connected automatic printing, so that sentence named two shipped
  // capabilities as missing - which is the more harmful direction of the error:
  // an operator who reads that printing is unavailable never looks for the
  // setting that would have worked.
  //
  // The enduring property is that the screen is HONEST in both directions. It
  // must still say network printers are absent, and must no longer say routing
  // or automatic printing are.
  assert.match(screen, /Network printers[\s\S]*?are not connected yet/);
  assert.equal(/automatic printing are not connected/i.test(screen), false);
  assert.equal(/Receipts still print manually/.test(screen), false);
});

// --- POS surfaces --------------------------------------------------------

test("the dashboard tile promises exactly what the desktop has", () => {
  // RETARGETED for the third time - and the repetition is the point. This tile
  // deferred Dine-in months after it landed, called Delivery customers-only
  // after 3B and 3C, and denied printing through 3E-A, P2, P3-B and 3E-B. So the
  // assertion no longer pins a sentence: it pins the rule the sentence keeps
  // breaking, in BOTH directions.
  const modules = stripComments(readSrc("lib", "modules.ts"));
  const desc = modules.slice(modules.indexOf('key: "pos"'), modules.indexOf('key: "inventory"'));

  // It must not deny a capability the desktop ships.
  assert.equal(/Printing is not available yet/.test(desc), false);
  assert.equal(/coming soon|not available|arrives in|deferred/i.test(desc), false);

  // It must name what is actually there, printing included.
  for (const shipped of ["Takeaway", "Dine-in", "Delivery", "shifts", "receipts", "kitchen tickets"]) {
    assert.ok(desc.includes(shipped), `the tile should name ${shipped}`);
  }

  // And it must not promise what the desktop does not have.
  for (const absent of ["reports", "loyalty", "driver", "cash drawer", "network printer"]) {
    assert.equal(desc.toLowerCase().includes(absent), false, `the tile must not promise ${absent}`);
  }
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

// RETARGETED by the operations revision. The rule this enforces has always been
// "a workspace never prints a RECEIPT behind the cashier's back" - every receipt
// and every kitchen ticket goes through the preview modal, which is what makes a
// misprint visible before it reaches paper.
//
// The end-of-shift report is the one reviewed exception, and it does not weaken
// the rule: the report dialog the cashier is reading IS the preview, there is no
// order to re-check, and it is reachable only from a button on that dialog. So
// PosWorkspace may reach `printReport` and nothing else; the receipt, ticket and
// test-page entry points stay off-limits to all three workspaces.
test("no POS workspace prints a receipt or ticket without a preview", () => {
  for (const file of [
    ["screens", "pos", "PosWorkspace.tsx"],
    ["screens", "pos", "DeliveryWorkspace.tsx"],
    ["screens", "pos", "DineInWorkspace.tsx"],
  ]) {
    const name = file.join("/");
    const src = stripJsxComments(readSrc(...file));
    for (const forbidden of ["printReceipt", "printKitchenTicket", "print_test_page", "printTestPage"]) {
      assert.equal(src.includes(forbidden), false, `${name} must not reach ${forbidden} directly`);
    }
    if (name.endsWith("PosWorkspace.tsx")) {
      // The exception, pinned to its exact import so a second one cannot be
      // added on the same line without this assertion changing in review.
      assert.match(src, /import \{ isNativeAvailable, listPrinters, printReport \} from "@\/lib\/nativePrinting"/);
    } else {
      assert.equal(src.includes("nativePrinting"), false, `${name} must not print natively`);
    }
  }
});

// --- the native boundary -----------------------------------------------------

// RETARGETED BY LEVEL 3E-B (two -> three), by POS v1 (three -> four) and by the
// operations revision (four -> five). Still an exact list, which is the whole
// point: a sixth command cannot arrive without this line changing in review.
// `print_report` is the operations addition; like the others it takes a document
// and no device control - see printing/mod.rs for why that does not widen the
// surface.
test("the invoke handler exposes exactly the five printing commands", () => {
  const handler = libRs.slice(libRs.indexOf("invoke_handler"), libRs.indexOf("]));"));
  const commands = [...handler.matchAll(/printing::(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(commands, [
    "list_printers",
    "print_test_page",
    "print_receipt",
    "print_kitchen_ticket",
    "print_report",
  ]);
});

test("the capability grants no shell, filesystem, network or process access", () => {
  // RETARGETED for the fullscreen fix. This pinned the list at exactly
  // ["core:default","opener:default"] - and that pin was doing its job: the
  // packaged Full Screen button silently did nothing on a customer PC precisely
  // BECAUSE `core:default` excludes window setters, so `setFullscreen` was
  // denied and the catch swallowed it. Two narrow window permissions are now
  // granted deliberately. The enduring property is unchanged and still asserted
  // below: nothing dangerous is reachable, and the list stays exact so a third
  // permission cannot arrive unnoticed.
  const parsed = JSON.parse(capabilities) as { permissions: string[] };
  assert.deepEqual(parsed.permissions, [
    "core:default",
    "opener:default",
    "core:window:allow-is-fullscreen",
    "core:window:allow-set-fullscreen",
  ]);
  // Window access is fullscreen ONLY - no move, resize, close or create.
  const windowPerms = parsed.permissions.filter((p) => p.startsWith("core:window:"));
  assert.deepEqual(windowPerms.sort(), ["core:window:allow-is-fullscreen", "core:window:allow-set-fullscreen"]);
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
  assert.deepEqual(fields.sort(), ["context", "copies", "paper_width", "printer_name"]);

  // ...and `context` itself is captions only. Nothing in it addresses a device.
  const contextType = client.slice(
    client.indexOf("export type TestPageContext"),
    client.indexOf("export type TestPrintRequest"),
  );
  const contextFields = [...contextType.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(contextFields.sort(), ["branch_name", "business_name", "printer_alias", "role"]);
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
