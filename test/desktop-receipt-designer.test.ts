// The receipt designer, the QR, and test printing.
//
// Four properties these tests exist to protect.
//
// ONE, ONE SCHEMA. The templates the desktop edits are the tenant's real
// `pos_receipt_settings.*_template_config` rows, written through the web app's
// own RPC. A desktop-only schema, a local template cache or a second save path
// would be a second source of truth for what a customer's receipt says.
//
// TWO, A DESKTOP SAVE MUST NOT DELETE WHAT THE WEB CONFIGURED. Several web
// blocks have no desktop renderer. Normalising them away would be tidier and
// would also silently drop a tenant's logo and loyalty settings the first time
// somebody touched a checkbox on a till.
//
// THREE, THE PREVIEW IS A PREDICTION. The screen renders the SAME components
// the POS shows after a payment, with the SAME block rules the native renderer
// applies - and on unthemeable paper, because a burgundy preview of a black
// receipt is a preview of a different document.
//
// FOUR, A TEST PRINT IS A PRINTER TEST. No order, no payment, no inventory, no
// consumption, no accounting - and paper that says so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripComments, stripJsxComments } from "./source-helpers.ts";
import {
  BLOCK_BY_KEY,
  BLOCK_CATALOG,
  blockVisible,
  defaultTemplate,
  normalizeTemplate,
  resolveSize,
  setTemplateSize,
  toggleBlock,
  visibleBlocks,
} from "@/lib/pos/receiptTemplate";
import { customerRenderOptions, kitchenRenderOptions, DEFAULT_RENDER_OPTIONS } from "@/lib/pos/receiptRender";
import { unconfiguredDesign } from "@/lib/pos/receiptSettings";
import { PAYMENT_QR_KEY, encodeQr, isQrMatrix, readShowPaymentQr, writeShowPaymentQr } from "@/lib/pos/qrCode";

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

// --- one, one schema ---------------------------------------------------------

test("the block catalog matches the web app's keys and kinds exactly", () => {
  // Transcribed from `src/lib/receipt.ts` BLOCK_CATALOG in the Breadee web
  // repo. These strings ARE the wire format of the shared JSONB, so a typo
  // here is a block that silently stops being honoured on one side.
  const expected: [string, string[]][] = [
    ["logo", ["customer"]],
    ["business_name", ["kitchen", "customer"]],
    ["branch_name", ["kitchen", "customer"]],
    ["address", ["customer"]],
    ["phone", ["customer"]],
    ["welcome", ["customer"]],
    ["order_number", ["kitchen", "customer"]],
    ["order_type", ["kitchen", "customer"]],
    ["table_info", ["kitchen", "customer"]],
    ["customer_info", ["kitchen"]],
    ["customer_name", ["customer"]],
    ["customer_phone", ["customer"]],
    ["customer_address", ["customer"]],
    ["customer_notes", ["customer"]],
    ["staff", ["kitchen", "customer"]],
    ["datetime", ["kitchen", "customer"]],
    ["items", ["kitchen", "customer"]],
    ["subtotal", ["customer"]],
    ["discount", ["customer"]],
    ["total", ["customer"]],
    ["paid", ["customer"]],
    ["balance", ["customer"]],
    ["payment_method", ["customer"]],
    ["loyalty", ["customer"]],
    ["footer", ["kitchen", "customer"]],
  ];
  assert.equal(BLOCK_CATALOG.length, expected.length);
  for (const [key, kinds] of expected) {
    const spec = BLOCK_BY_KEY[key];
    assert.ok(spec, `${key} must exist in the catalog`);
    assert.deepEqual([...spec.kinds].sort(), [...kinds].sort(), `${key} kinds`);
  }
});

test("the desktop writes the shared row through the web app's own RPC", () => {
  const source = stripComments(read("src/lib/pos/receiptSettings.ts"));
  assert.ok(source.includes("save_pos_receipt_settings"), "the web app's RPC, not a desktop one");
  assert.ok(source.includes("pos_receipt_settings"), "the shared table");
  // No desktop-only storage for the template anywhere.
  assert.ok(!source.includes("localStorage"), "the template must not be cached locally");
});

test("the designer holds no template of its own", () => {
  const source = stripJsxComments(read("src/screens/settings/ReceiptDesign.tsx"));
  assert.ok(!source.includes("localStorage.setItem"), "the designer writes templates only to the server");
  assert.ok(source.includes("saveReceiptSettings"), "through the shared helper");
});

// --- two, a desktop save must not delete what the web configured -------------

test("blocks the desktop cannot draw are still carried through a save", () => {
  const stored = {
    blocks: [
      { key: "logo", show: true },
      { key: "loyalty", show: true },
      { key: "total", show: false },
    ],
    size: "large",
  };
  const config = normalizeTemplate("customer", stored);
  const keys = config.blocks.map((b) => b.key);
  // Present, in stored order, with stored visibility.
  assert.ok(keys.includes("logo"), "the web-only logo block survives normalisation");
  assert.ok(keys.includes("loyalty"), "the web-only loyalty block survives normalisation");
  assert.equal(config.blocks.find((b) => b.key === "logo")?.show, true);
  assert.equal(config.blocks.find((b) => b.key === "total")?.show, false);
  assert.equal(config.size, "large");
  // ...and they are excluded from what the RENDERER is asked to draw, because
  // there is nothing to draw. Config and rendering are different questions.
  const visible = visibleBlocks(config);
  assert.ok(!visible.includes("logo"));
  assert.ok(!visible.includes("loyalty"));
});

test("normalisation keeps stored order, drops the wrong kind, and appends new blocks", () => {
  const config = normalizeTemplate("kitchen", {
    blocks: [
      { key: "items", show: true },
      { key: "business_name", show: false },
      // A customer-only block in a kitchen config is meaningless; the web drops
      // it too, so keeping it would put the two sides out of step.
      { key: "total", show: true },
      // A duplicate must not become two rows in the editor.
      { key: "items", show: false },
    ],
  });
  const keys = config.blocks.map((b) => b.key);
  assert.deepEqual(keys.slice(0, 2), ["items", "business_name"], "stored order is preserved");
  assert.ok(!keys.includes("total"), "a customer-only block is not a kitchen block");
  assert.equal(keys.filter((k) => k === "items").length, 1, "no duplicates");
  // Every catalog block for this kind is present, so nothing is hidden from an
  // editor just because a tenant saved before it existed.
  for (const spec of BLOCK_CATALOG.filter((b) => b.kinds.includes("kitchen"))) {
    assert.ok(keys.includes(spec.key), `${spec.key} must be offered`);
  }
});

test("a missing, corrupt or hostile stored config falls back to the defaults", () => {
  for (const bad of [null, undefined, {}, { blocks: null }, { blocks: "x" }, { blocks: [null, 1, { show: true }] }]) {
    const config = normalizeTemplate("customer", bad);
    assert.deepEqual(
      config.blocks.map((b) => b.key),
      defaultTemplate("customer").blocks.map((b) => b.key),
      `${JSON.stringify(bad)}`,
    );
    assert.equal(config.size, "normal");
  }
  assert.equal(resolveSize("HUGE"), "normal");
  assert.equal(resolveSize("Compact"), "compact");
});

test("the web's defaults are reproduced: kitchen footer off, everything else on", () => {
  const kitchen = defaultTemplate("kitchen");
  assert.equal(kitchen.blocks.find((b) => b.key === "footer")?.show, false);
  assert.ok(kitchen.blocks.filter((b) => b.key !== "footer").every((b) => b.show));
  assert.ok(defaultTemplate("customer").blocks.every((b) => b.show));
});

test("toggling a block changes only that block", () => {
  const before = defaultTemplate("customer");
  const after = toggleBlock(before, "discount");
  assert.equal(after.blocks.find((b) => b.key === "discount")?.show, false);
  assert.equal(after.blocks.length, before.blocks.length);
  assert.deepEqual(after.blocks.map((b) => b.key), before.blocks.map((b) => b.key), "order is untouched");
  for (const b of after.blocks) {
    if (b.key !== "discount") {
      assert.equal(b.show, before.blocks.find((x) => x.key === b.key)?.show, `${b.key} must not move`);
    }
  }
  assert.equal(setTemplateSize(before, "large").size, "large");
});

// --- three, the preview is a prediction --------------------------------------

test("no template means draw EVERYTHING, on both sides", () => {
  // Deliberately the opposite of the automatic-printing default. A receipt that
  // silently lost its TOTAL because a settings read failed would be far worse
  // than one printing a line somebody had switched off.
  assert.equal(DEFAULT_RENDER_OPTIONS.sections, null);
  assert.equal(customerRenderOptions({ design: null, qr: null }).sections, null);
  assert.equal(kitchenRenderOptions(null).sections, null);
  assert.ok(blockVisible(null, "total"));
  assert.ok(blockVisible(undefined, "anything"));
  assert.ok(!blockVisible(["subtotal"], "total"));
  // The Rust renderer takes the same direction.
  const rust = read("src-tauri/src/printing/receipt.rs");
  assert.ok(rust.includes("None => true"), "receipt.rs draws everything when no template was supplied");
  const kitchenRs = read("src-tauri/src/printing/kitchen.rs");
  assert.ok(kitchenRs.includes("None => true"), "kitchen.rs draws everything when no template was supplied");
});

test("the render options carry the branding the native document now prints", () => {
  const design = {
    ...unconfiguredDesign("b1"),
    headerAddress: "Hamra Street",
    headerPhone: "01 234 567",
    welcomeMessage: "Welcome",
    footerMessage: "See you again",
  };
  const options = customerRenderOptions({ design, qr: null });
  assert.equal(options.address, "Hamra Street");
  assert.equal(options.phone, "01 234 567");
  assert.equal(options.welcome, "Welcome");
  assert.equal(options.footer, "See you again");
  assert.deepEqual(kitchenRenderOptions(design), {
    sections: visibleBlocks(design.kitchen),
    footer: "See you again",
  });
});

test("both previews render on paper the theme cannot reach", () => {
  for (const file of ["src/screens/pos/ReceiptPreview.tsx", "src/screens/pos/KitchenTicketPreview.tsx"]) {
    const source = stripJsxComments(read(file));
    const paper = source.slice(source.indexOf("Paper({"), source.indexOf("Modal({"));
    assert.ok(paper.includes("bg-paper"), `${file}: the paper must use the unthemed surface`);
    assert.ok(paper.includes("text-paper-ink"), `${file}: the ink must be unthemed`);
    // The themed neutrals must not appear inside the paper component, or a dark
    // theme would show a charcoal receipt and print a white one.
    assert.ok(!paper.includes("bg-white"), `${file}: the paper must not use the themed surface`);
    assert.ok(!paper.includes("border-line"), `${file}: the paper must not use the themed hairline`);
  }
});

test("the designer previews with the production components, not a copy", () => {
  const source = stripJsxComments(read("src/screens/settings/ReceiptDesign.tsx"));
  assert.ok(source.includes("ReceiptPaper"), "the same component the POS shows after a payment");
  assert.ok(source.includes("KitchenTicketPaper"), "the same component the POS shows after a commit");
  assert.ok(source.includes("customerRenderOptions"), "and the same block rules");
  assert.ok(source.includes("kitchenRenderOptions"));
});

test("the preview and the print path are handed the SAME options", () => {
  const receipt = stripJsxComments(read("src/screens/pos/ReceiptPreview.tsx"));
  assert.ok(receipt.includes("...(render ?? {})"), "the Print button sends what the panel is showing");
  assert.ok(receipt.includes("render={render}"), "and the panel shows what the Print button would send");
});

test("the native receipt honours every block the desktop claims to support", () => {
  const rust = read("src-tauri/src/printing/receipt.rs");
  const supported = BLOCK_CATALOG.filter((b) => b.kinds.includes("customer") && b.support === "printed");
  for (const spec of supported) {
    assert.ok(rust.includes(`shows("${spec.key}")`), `receipt.rs must gate on ${spec.key}`);
  }
  const kitchenRs = read("src-tauri/src/printing/kitchen.rs");
  for (const spec of BLOCK_CATALOG.filter((b) => b.kinds.includes("kitchen") && b.support === "printed")) {
    assert.ok(kitchenRs.includes(`shows("${spec.key}")`), `kitchen.rs must gate on ${spec.key}`);
  }
});

test("the kitchen ticket still has nowhere to put money", () => {
  // The block list gained no financial key, and the native document still has
  // no field for one - which is the reason a cook cannot be shown a price.
  for (const spec of BLOCK_CATALOG.filter((b) => b.kinds.includes("kitchen"))) {
    assert.ok(
      !["subtotal", "discount", "total", "paid", "balance", "payment_method"].includes(spec.key),
      `${spec.key} must not be a kitchen block`,
    );
  }
  const rust = read("src-tauri/src/printing/kitchen.rs");
  for (const forbidden of ["line_total", "subtotal", "currency", "format_money"]) {
    assert.ok(!rust.includes(`pub ${forbidden}`), `kitchen.rs must have no ${forbidden} field`);
  }
});

// --- the QR ------------------------------------------------------------------

test("the QR reuses the tenant's existing public identifier and mints nothing", () => {
  const source = stripComments(read("src/lib/pos/paymentQr.ts"));
  assert.ok(source.includes("qr_menu_settings"), "the one table that owns a tenant's public slug");
  assert.ok(source.includes("public_slug"));
  assert.ok(source.includes("/menu/"), "the same address the web app encodes");
  // Reads only. A desktop that could write this table could change where a
  // tenant's customers are sent.
  for (const forbidden of ["insert", "update(", "upsert", "delete(", "rpc("]) {
    assert.ok(!source.includes(forbidden), `paymentQr.ts must not ${forbidden}`);
  }
});

test("an unpublished public page still yields a valid code", () => {
  // `is_public` is about the PAGE; the identifier is the tenant's either way,
  // and a branch may want the code on paper before switching the page on.
  const source = stripComments(read("src/lib/pos/paymentQr.ts"));
  assert.ok(source.includes("published: bool(row.is_public)"), "is_public is reported");
  assert.ok(!source.includes("eq(\"is_public\""), "and never used to filter the slug out");
});

test("the encoder produces a square binary matrix, or nothing at all", () => {
  const matrix = encodeQr("https://breadee.com/menu/dominos-main");
  assert.ok(matrix, "a normal URL must encode");
  assert.ok(isQrMatrix(matrix));
  assert.equal(matrix!.rows.length, matrix!.size);
  for (const row of matrix!.rows) {
    assert.equal(row.length, matrix!.size);
    assert.match(row, /^[01]+$/);
  }
  // QR versions are 21 + 4n modules. Anything else is not a QR symbol.
  assert.equal((matrix!.size - 21) % 4, 0, `size ${matrix!.size} is not a QR version`);
  // The three finder patterns: a 7x7 ring at each of three corners.
  const dark = (r: number, c: number) => matrix!.rows[r][c] === "1";
  for (const [r0, c0] of [[0, 0], [0, matrix!.size - 7], [matrix!.size - 7, 0]] as const) {
    assert.ok(dark(r0, c0) && dark(r0 + 6, c0) && dark(r0, c0 + 6), "finder pattern corners");
    assert.ok(!dark(r0 + 1, c0 + 1), "finder pattern inner ring");
    assert.ok(dark(r0 + 3, c0 + 3), "finder pattern centre");
  }
});

test("the encoder is deterministic, so the preview and the paper cannot disagree", () => {
  const a = encodeQr("https://breadee.com/menu/x");
  const b = encodeQr("https://breadee.com/menu/x");
  assert.deepEqual(a, b);
});

test("nothing encodable produces null, never a placeholder code", () => {
  // A QR that does not scan is worse than no QR, because a customer will try it.
  assert.equal(encodeQr(""), null);
  assert.equal(encodeQr("   "), null);
  assert.equal(encodeQr(undefined as unknown as string), null);
});

test("a malformed matrix is rejected before it can reach a printer", () => {
  assert.ok(!isQrMatrix(null));
  assert.ok(!isQrMatrix({ size: 3, rows: ["111", "111"] }), "wrong row count");
  assert.ok(!isQrMatrix({ size: 3, rows: ["111", "11", "111"] }), "ragged");
  assert.ok(!isQrMatrix({ size: 3, rows: ["111", "1x1", "111"] }), "not binary");
  assert.ok(!isQrMatrix({ size: 0, rows: [] }));
  assert.ok(isQrMatrix({ size: 2, rows: ["10", "01"] }));
  // And the native side re-checks rather than trusting the boundary.
  const rust = read("src-tauri/src/printing/receipt.rs");
  assert.ok(rust.includes("is_well_formed"), "receipt.rs validates the matrix");
  assert.ok(rust.includes("MAX_QR_MODULES"), "and bounds it, so a caller cannot ask for a page of rectangles");
});

test("the QR switch is off unless somebody switched it on", () => {
  assert.equal(readShowPaymentQr(memoryStorage()), false);
  assert.equal(readShowPaymentQr(memoryStorage({ [PAYMENT_QR_KEY]: "0" })), false);
  assert.equal(readShowPaymentQr(memoryStorage({ [PAYMENT_QR_KEY]: "1" })), true);
  const store = memoryStorage();
  writeShowPaymentQr(true, store);
  assert.equal(store.read()[PAYMENT_QR_KEY], "1");
  assert.equal(readShowPaymentQr({ getItem: () => { throw new Error("no storage"); } }), false);
});

test("the QR sits after the total and before the footer, on both sides", () => {
  const rust = read("src-tauri/src/printing/receipt.rs");
  const qrAt = rust.indexOf("PageLine::qr(");
  const totalAt = rust.indexOf('"TOTAL"');
  const footerAt = rust.indexOf('shows("footer")');
  assert.ok(totalAt > 0 && qrAt > totalAt, "the QR follows the total");
  assert.ok(footerAt > qrAt, "and precedes the footer");
});

// --- four, a test print is a printer test ------------------------------------

test("a test print creates no order, payment, inventory or accounting movement", () => {
  const source = stripJsxComments(read("src/screens/settings/ReceiptDesign.tsx"));
  // Checked as CODE, not as prose: the screen's own copy legitimately contains
  // the words "inventory" and "accounting" - it is the promise being made to
  // the operator - so the assertion has to name things that would actually
  // create a movement.
  for (const forbidden of [
    "pos_submit_order",
    "pos_pay_order",
    "pos_pay_table",
    "pos_save_order",
    "callPosRpc",
    "supabase",
    ".rpc(",
    "pos_order_items",
    "cost_",
  ]) {
    assert.ok(!source.includes(forbidden), `a test print must not reference ${forbidden}`);
  }
  // The only two things it may send.
  assert.ok(source.includes("printReceipt("));
  assert.ok(source.includes("printKitchenTicket("));
});

test("test print uses sample data and marks the paper", () => {
  const source = read("src/screens/settings/ReceiptDesign.tsx");
  assert.ok(source.includes("sampleReceipt("), "sample data, never a real order");
  assert.ok(source.includes("sampleTicket("), "sample data, never a real ticket");
  assert.ok(source.includes('"TEST PRINT"'), "the customer receipt is marked");
  assert.ok(source.includes("test: true"), "the kitchen ticket sets the native TEST banner");
  const rust = read("src-tauri/src/printing/kitchen.rs");
  assert.ok(rust.includes("NOT_A_REAL_ORDER"), "and the native renderer prints it");
});

test("test print goes to the configured destination and asks first", () => {
  const source = stripJsxComments(read("src/screens/settings/ReceiptDesign.tsx"));
  assert.ok(source.includes("resolvePrintRoute"), "the destination is the branch's routing answer");
  assert.ok(source.includes("resolveRouteTarget"), "checked against what this terminal can reach");
  // A confirmation that NAMES the device, because paper is a physical event in
  // somebody's restaurant.
  assert.ok(source.includes('kind: "confirm"'));
  assert.ok(source.includes("target.windowsName"));
  // Both documents get a button.
  assert.ok(source.includes("Test Customer Receipt"));
  assert.ok(source.includes("Test Kitchen Ticket"));
});

test("nothing prints on mount, on tab change or on a save", () => {
  const source = stripJsxComments(read("src/screens/settings/ReceiptDesign.tsx"));
  // Every CALL of the two test entry points must sit inside a click handler.
  // Counting call sites and requiring each to be preceded by `onClick` is
  // stronger than scanning a slice of the file: it cannot be defeated by
  // moving a function, and it fails loudly if a new call site appears.
  for (const fn of ["beginTest", "sendTest"]) {
    const calls = [...source.matchAll(new RegExp(`(.{0,40})void ${fn}\\(`, "g"))];
    assert.ok(calls.length > 0, `${fn} must be called somewhere`);
    for (const call of calls) {
      assert.ok(
        call[1].includes("onClick={() =>"),
        `every ${fn} call must come from a click, found: ${call[1].trim()}`,
      );
    }
  }
  // And each native print command is CALLED exactly once, from inside
  // `sendTest` - never from the component body, an effect or a render path.
  // `sendEnd` anchors on the first thing after the callback block, so the
  // window really is the callback rather than "the rest of the file".
  const sendAt = source.indexOf("const sendTest = useCallback(");
  const sendEnd = source.indexOf('"No business linked"');
  assert.ok(sendAt > 0 && sendEnd > sendAt, "the sendTest callback must be locatable");
  for (const fn of ["printReceipt(", "printKitchenTicket("]) {
    const calls = [...source.matchAll(new RegExp(fn.replace("(", "\\("), "g"))].map((m) => m.index ?? -1);
    assert.equal(calls.length, 1, `${fn} must have exactly one call site`);
    assert.ok(calls[0] > sendAt && calls[0] < sendEnd, `${fn} is only reachable from sendTest`);
  }
});
