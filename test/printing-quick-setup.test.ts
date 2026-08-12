// Quick Setup: printer installation at the till.
//
// The property these tests exist to protect is that a support technician can
// finish an install without being lied to. Every state a printer can be in has
// to be distinguishable - configured but not on this PC, on this PC but not
// configured, configured with a width nothing can print - because each has a
// different fix and "it won't print" sends someone to the wrong one.
//
// The second property is that setup cannot become printing. Saving a printer
// writes a row; it does not produce paper. Paper only follows a confirmation
// naming the device.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CUSTOM_PAPER_MAX_MM,
  CUSTOM_PAPER_MIN_MM,
  paperWidthLabel,
  type InstalledPrinter,
} from "@/lib/nativePrinting";
import {
  effectivePaperWidth,
  toStoredPaper,
  type ServerPrinter,
} from "@/lib/pos/printerRegistry";
import {
  PRINTER_PERMISSIONS,
  canManagePrinters,
  canTest,
  canTestPrinters,
  classifyPrinters,
  detectedPrinters,
  draftForDetected,
  draftForExisting,
  duplicateBinding,
  statusHint,
  statusLabel,
  validateDraft,
  type DraftForm,
} from "@/lib/pos/quickSetup";
import { stripComments, stripJsxComments } from "./source-helpers.ts";

const root = dirname(fileURLToPath(import.meta.url));
const readSrc = (...p: string[]) => readFileSync(join(root, "..", "src", ...p), "utf8");
const screen = stripJsxComments(readSrc("screens", "settings", "Printers.tsx"));
const setup = stripComments(readSrc("lib", "pos", "quickSetup.ts"));

const installed = (name: string, is_default = false): InstalledPrinter => ({
  name,
  is_default,
  status: "unknown",
});

const printer = (over: Partial<ServerPrinter> = {}): ServerPrinter => ({
  id: "p1",
  name: "Front Cashier",
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

const form = (over: Partial<DraftForm> = {}): DraftForm => ({
  name: "Front Cashier",
  printer_type: "cashier",
  system_printer_name: "Xprinter XP-80",
  paperClass: "80mm",
  customMm: "",
  copies: 1,
  is_active: true,
  ...over,
});

// --- the paper model ---------------------------------------------------------

test("the two stored columns combine into one printable width", () => {
  assert.equal(effectivePaperWidth(printer()), "80mm");
  assert.equal(effectivePaperWidth(printer({ paper_width: "58mm" })), "58mm");
  // The XP-80 on staging: an 80mm printer that marks 72mm.
  assert.equal(
    effectivePaperWidth(printer({ paper_width: "custom", custom_paper_width: 72 })),
    "custom:72",
  );
});

test("an unusable width resolves to null rather than a guess", () => {
  // Guessing 80mm here is exactly how the right-hand column of a total is lost.
  for (const p of [
    printer({ paper_width: "custom", custom_paper_width: null }),
    printer({ paper_width: "custom", custom_paper_width: 0 }),
    printer({ paper_width: "custom", custom_paper_width: CUSTOM_PAPER_MIN_MM - 1 }),
    printer({ paper_width: "custom", custom_paper_width: CUSTOM_PAPER_MAX_MM + 1 }),
    printer({ paper_width: "a4" }),
    printer({ paper_width: null }),
    printer({ paper_width: "letter" }),
  ]) {
    assert.equal(effectivePaperWidth(p), null, `${p.paper_width}/${p.custom_paper_width}`);
  }
});

test("the web app's custom:<mm> spelling is understood directly", () => {
  // Shared vocabulary: pos_receipt_settings.paper_size already stores this form.
  assert.equal(effectivePaperWidth(printer({ paper_width: "custom:72" })), "custom:72");
});

test("storing a width round-trips through the two columns", () => {
  for (const width of ["58mm", "80mm", "custom:72", "custom:40", "custom:120"] as const) {
    const stored = toStoredPaper(width);
    assert.equal(effectivePaperWidth({ ...stored }), width, width);
  }
});

test("the operator sees printable width, not just a roll class", () => {
  assert.equal(paperWidthLabel("80mm"), "80 mm");
  assert.equal(paperWidthLabel("custom:72"), "72 mm printable");
});

// --- status ------------------------------------------------------------------

test("a bound, installed, printable printer is ready", () => {
  const [entry] = classifyPrinters([printer()], [installed("Xprinter XP-80")]);
  assert.equal(entry.status, "ready");
  assert.equal(entry.installed?.name, "Xprinter XP-80");
  assert.equal(entry.paperWidth, "80mm");
  assert.equal(canTest(entry), true);
});

test("every unusable state is distinguishable, and none of them can be tested", () => {
  const cases: [string, ServerPrinter, InstalledPrinter[]][] = [
    ["missing", printer(), [installed("Some Other Printer")]],
    ["unbound", printer({ system_printer_name: null }), [installed("Xprinter XP-80")]],
    [
      "unsupported_paper",
      printer({ paper_width: "custom", custom_paper_width: null }),
      [installed("Xprinter XP-80")],
    ],
    ["unsupported_connection", printer({ connection_type: "network" }), [installed("Xprinter XP-80")]],
    ["disabled", printer({ is_active: false }), [installed("Xprinter XP-80")]],
  ];
  for (const [expected, p, inst] of cases) {
    const [entry] = classifyPrinters([p], inst);
    assert.equal(entry.status, expected, `${expected} misclassified`);
    assert.equal(canTest(entry), false, `${expected} must not be testable`);
    assert.ok(statusLabel(entry.status).length > 0);
    assert.ok(statusHint(entry).length > 0, `${expected} needs a fix-it sentence`);
  }
});

test("binding is exact - a near miss is a different device", () => {
  for (const near of ["xprinter xp-80", "XPRINTER XP-80", "Xprinter XP-80 ", "Xprinter", "Xprinter XP80"]) {
    const [entry] = classifyPrinters([printer()], [installed(near)]);
    assert.equal(entry.status, "missing", `${near} must not bind`);
  }
});

test("a disabled printer stays visible so it can be switched back on", () => {
  // Hiding it would send the technician to create a duplicate instead.
  const [entry] = classifyPrinters([printer({ is_active: false })], [installed("Xprinter XP-80")]);
  assert.equal(entry.status, "disabled");
  assert.match(statusHint(entry), /Turn it back on/);
});

test("the unsupported-paper sentence tells the operator the printable range", () => {
  const [entry] = classifyPrinters(
    [printer({ paper_width: "custom", custom_paper_width: null })],
    [installed("Xprinter XP-80")],
  );
  const hint = statusHint(entry);
  assert.match(hint, new RegExp(String(CUSTOM_PAPER_MIN_MM)));
  assert.match(hint, new RegExp(String(CUSTOM_PAPER_MAX_MM)));
});

// --- detection ---------------------------------------------------------------

test("detection says which Windows printers are already set up", () => {
  const detected = detectedPrinters(
    [installed("Xprinter XP-80"), installed("Microsoft Print to PDF")],
    [printer()],
  );
  assert.equal(detected.length, 2);
  assert.equal(detected[0].configured?.name, "Front Cashier");
  assert.equal(detected[1].configured, null);
});

test("a printer bound by a non-system connection does not claim a Windows queue", () => {
  const detected = detectedPrinters(
    [installed("Xprinter XP-80")],
    [printer({ connection_type: "network" })],
  );
  assert.equal(detected[0].configured, null);
});

// --- the draft ---------------------------------------------------------------

test("setting up a detected printer starts bound to it, with its name as a hint", () => {
  const draft = draftForDetected(installed("Xprinter XP-80"));
  assert.equal(draft.system_printer_name, "Xprinter XP-80");
  assert.equal(draft.name, "Xprinter XP-80");
  assert.equal(draft.printer_type, "cashier");
  assert.equal(draft.is_active, true);
});

test("editing starts from what is stored, including a custom width", () => {
  const draft = draftForExisting(printer({ paper_width: "custom", custom_paper_width: 72 }));
  assert.equal(draft.paperClass, "custom");
  assert.equal(draft.customMm, "72");
  assert.equal(draft.name, "Front Cashier");
  assert.equal(draft.system_printer_name, "Xprinter XP-80");
});

test("a valid draft becomes exactly the row that will be written", () => {
  const result = validateDraft(form({ name: "  Front Cashier  " }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.draft, {
    name: "Front Cashier",
    printer_type: "cashier",
    system_printer_name: "Xprinter XP-80",
    paper_width: "80mm",
    default_copy_count: 1,
    is_active: true,
  });
});

test("a custom width is accepted only as whole millimetres inside the range", () => {
  const ok = validateDraft(form({ paperClass: "custom", customMm: "72" }));
  assert.equal(ok.ok && ok.draft.paper_width, "custom:72");

  for (const bad of ["", "  ", "0", "39", "121", "72.5", "-72", "abc", "72mm"]) {
    const result = validateDraft(form({ paperClass: "custom", customMm: bad }));
    assert.equal(result.ok, false, `${bad} must be refused`);
  }
});

test("an invalid draft is refused with a sentence, never repaired", () => {
  assert.equal(validateDraft(form({ name: "   " })).ok, false);
  for (const copies of [0, 6, 1.5, Number.NaN]) {
    assert.equal(validateDraft(form({ copies })).ok, false, `copies=${copies}`);
  }
  const refusal = validateDraft(form({ name: "" }));
  assert.equal(refusal.ok, false);
  assert.ok(!refusal.ok && refusal.error.length > 0);
});

test("a second row for the same Windows queue is caught before it is written", () => {
  // The commonest way a branch ends up printing every receipt twice.
  const clash = duplicateBinding({
    systemPrinterName: "Xprinter XP-80",
    configured: [printer({ id: "existing" })],
  });
  assert.equal(clash?.id, "existing");

  // Editing that same row is not a duplicate of itself.
  assert.equal(
    duplicateBinding({
      systemPrinterName: "Xprinter XP-80",
      configured: [printer({ id: "existing" })],
      excludeId: "existing",
    }),
    null,
  );

  // An unbound printer claims nothing.
  assert.equal(
    duplicateBinding({ systemPrinterName: null, configured: [printer()] }),
    null,
  );
});

// --- permissions -------------------------------------------------------------

test("management is gated by permission keys, never by a role name", () => {
  assert.equal(canManagePrinters({ [PRINTER_PERMISSIONS.MANAGE]: true }), true);
  assert.equal(canManagePrinters({ [PRINTER_PERMISSIONS.MANAGE_ALT]: true }), true);
  assert.equal(canManagePrinters({}), false);
  assert.equal(canManagePrinters(null), false);
  // Transcribed from the live pos_printer_settings_write policy.
  assert.equal(PRINTER_PERMISSIONS.MANAGE, "kitchen.manage_printers");
  assert.equal(PRINTER_PERMISSIONS.MANAGE_ALT, "pos.settings.manage");
});

test("whoever may configure a printer may prove it works", () => {
  assert.equal(canTestPrinters({ [PRINTER_PERMISSIONS.TEST]: true }), true);
  assert.equal(canTestPrinters({ [PRINTER_PERMISSIONS.MANAGE]: true }), true);
  assert.equal(canTestPrinters({}), false);
});

test("no role name is used as an authorisation check anywhere in setup", () => {
  for (const role of ['"owner"', '"manager"', '"cashier_role"', 'role ===']) {
    assert.equal(setup.includes(role), false, `${role} must not gate setup`);
  }
});

// --- the screen --------------------------------------------------------------

test("the setup form never lets the Windows binding be typed", () => {
  // Renaming inside Breadee must not be able to point the row at another device.
  assert.match(screen, /cannot be renamed from Breadee/);
  assert.equal(
    /onChange=\{\(e\) => patch\(\{ system_printer_name/.test(screen),
    false,
    "the binding is chosen by picking a detected printer, not typed",
  );
});

test("the screen explains printable width in the operator's terms", () => {
  assert.match(screen, /Many .80 mm. printers only mark about 72 mm/);
  assert.match(screen, /right-hand edge of totals is cut off/);
});

test("write actions are hidden without the permission", () => {
  assert.match(screen, /mayManage && \(/);
  assert.match(screen, /!mayManage && \(/);
  assert.match(screen, /canManagePrinters\(perms\)/);
});

test("the screen creates no POS transaction of any kind", () => {
  for (const token of [
    "callPosRpc", "pos_submit_order", "pos_pay_order", "pos_pay_table", "pos_void_order",
    "pos_edit_order", "pos_orders", "pos_payments", "pos_shifts", "useCart", "useShift",
    "openPayment", "buildReceipt",
  ]) {
    assert.equal(screen.includes(token), false, `${token} must not appear on the printers screen`);
  }
});

test("the only table the screen's writes can reach is the printer registry", () => {
  const registry = stripComments(readSrc("lib", "pos", "printerRegistry.ts"));
  const tables = [...registry.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)], ["pos_printer_settings"]);
});

test("setup keeps no local source of truth", () => {
  for (const src of [screen, setup]) {
    assert.equal(src.includes("localStorage"), false);
    assert.equal(src.includes("loadPrinters"), false);
    assert.equal(src.includes("breadee-desktop-printers"), false);
  }
});
