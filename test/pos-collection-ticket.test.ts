// The order / collection ticket.
//
// THE WHOLE POINT OF THIS DOCUMENT IS WHAT IS NOT ON IT. It is the customer's
// copy of what they are waiting for, with a number they will be called by, and
// no money of any kind. Two financial documents for one sale invites "why does
// this one say something different", and on a discounted or split bill it
// eventually will.
//
// So the first four tests are all the same test asked four ways: from the type,
// from a built ticket, from the printable document, and from the mapper that
// strips a priced receipt line down to a name and a quantity.
//
// AND IT IS OFF UNTIL SOMEBODY TURNS IT ON. Every existing installation upgrades
// into silence.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { stripJsxComments } from "./source-helpers.ts";
import {
  COLLECTION_DEFAULTS,
  COLLECTION_SOURCES,
  COLLECTION_TICKET_KEY,
  buildCollectionTicket,
  collectionEnabledFor,
  collectionEventKey,
  collectionLinesFromReceipt,
  parseCollectionSettings,
  readCollectionSettings,
  toCollectionReport,
  writeCollectionSettings,
} from "@/lib/pos/collectionTicket";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

const ORDER = {
  businessName: "Dominos Pizza",
  branchName: "Main Branch",
  orderNumber: "260821-1257",
  at: "21 Aug 2026, 7:02 PM",
  lines: [
    { name: "Pizza", qty: 1 },
    { name: "Crepe", qty: 1 },
    { name: "Pepsi", qty: 1 },
    { name: "Coffee", qty: 1 },
  ],
};

// --- no money, asked four ways ------------------------------------------------

test("a built ticket carries no monetary field of any kind", () => {
  const ticket = buildCollectionTicket({ ...ORDER, source: "takeaway" });
  const json = JSON.stringify(ticket).toLowerCase();
  for (const money of ["price", "total", "subtotal", "discount", "currency", "tender", "change", "amount", "paid", "method"]) {
    assert.equal(json.includes(money), false, `a collection ticket must not carry ${money}`);
  }
});

test("the PRINTABLE document carries none either", () => {
  const report = toCollectionReport(buildCollectionTicket({ ...ORDER, source: "takeaway" }));
  const json = JSON.stringify(report).toLowerCase();
  for (const money of ["price", "subtotal", "discount", "currency", "tender", "change", "paid", "method"]) {
    assert.equal(json.includes(money), false, `the printed ticket must not carry ${money}`);
  }
  // `total` deserves its own statement: the renderer HAS a "total" line kind for
  // the shift report, and this document must never ask for one.
  assert.equal(report.lines.some((l) => l.kind === "total"), false, "a collection ticket has no totals line");
});

test("stripping a receipt line drops every amount, by name", () => {
  // The receipt line this is built from carries `lineTotal`, and its modifiers
  // carry `price_delta`. A spread is all it would take for both to survive.
  const stripped = collectionLinesFromReceipt([
    { name: "Pizza", qty: 2, modifiers: [{ name: "Extra cheese", quantity: 1 }], note: "well done" },
  ] as never);
  assert.deepEqual(stripped, [
    { name: "Pizza", qty: 2, modifiers: [{ name: "Extra cheese", quantity: 1 }], note: "well done" },
  ]);
  assert.equal(JSON.stringify(stripped).includes("lineTotal"), false);
  assert.equal(JSON.stringify(stripped).includes("price"), false);
});

test("the source module names no amount in a type of its own", () => {
  const source = stripJsxComments(read("src/lib/pos/collectionTicket.ts"));
  for (const forbidden of ["lineTotal", "subtotal:", "total:", "discount:", "currency:"]) {
    assert.equal(source.includes(forbidden), false, `the collection ticket type must not declare ${forbidden}`);
  }
});

// --- it is the WHOLE order ----------------------------------------------------

test("the ticket lists the whole order, not one station's share", () => {
  const ticket = buildCollectionTicket({ ...ORDER, source: "takeaway" });
  assert.deepEqual(ticket.lines.map((l) => l.name), ["Pizza", "Crepe", "Pepsi", "Coffee"]);
  const report = toCollectionReport(ticket);
  // The order number is the title, because it is what gets called across a room.
  assert.equal(report.title, "ORDER 260821-1257");
  const labels = report.lines.map((l) => l.label);
  for (const name of ["Pizza", "Crepe", "Pepsi", "Coffee"]) assert.ok(labels.includes(name));
  assert.ok(labels.includes("Takeaway"));
  assert.ok(labels.includes("21 Aug 2026, 7:02 PM"));
  // The quantity is the value column, so a customer can count their order.
  assert.equal(report.lines.find((l) => l.label === "Pizza")?.value, "x1");
});

test("a zero-quantity line is dropped rather than listed as something to wait for", () => {
  const ticket = buildCollectionTicket({
    ...ORDER,
    source: "takeaway",
    lines: [{ name: "Pizza", qty: 1 }, { name: "Cancelled", qty: 0 }],
  });
  assert.deepEqual(ticket.lines.map((l) => l.name), ["Pizza"]);
});

test("modifiers and notes travel, because they are what the customer is waiting for", () => {
  const report = toCollectionReport(
    buildCollectionTicket({
      ...ORDER,
      source: "takeaway",
      lines: [{ name: "Pizza", qty: 1, modifiers: [{ name: "No onions" }, { name: "Extra cheese", quantity: 2 }], note: "well done" }],
    }),
  );
  const labels = report.lines.map((l) => l.label);
  assert.ok(labels.includes("  + No onions"));
  assert.ok(labels.includes("  + Extra cheese x2"));
  assert.ok(labels.includes("  well done"));
});

// --- what belongs on which route ---------------------------------------------

test("a table number is on a dine-in docket and nowhere else", () => {
  assert.equal(buildCollectionTicket({ ...ORDER, source: "dine_in", tableName: "Table 4" }).tableName, "Table 4");
  assert.equal(buildCollectionTicket({ ...ORDER, source: "takeaway", tableName: "Table 4" }).tableName, null);
  assert.equal(buildCollectionTicket({ ...ORDER, source: "delivery", tableName: "Table 4" }).tableName, null);
});

test("a delivery ticket carries the NAME and never the address or the phone", () => {
  const ticket = buildCollectionTicket({
    ...ORDER,
    source: "delivery",
    customerName: "Sara",
    // Deliberately passed nothing else: there is no field for an address on this
    // type, and a docket left on a counter must not carry somebody's home.
  });
  assert.equal(ticket.customerName, "Sara");
  const json = JSON.stringify(toCollectionReport(ticket)).toLowerCase();
  for (const private_ of ["address", "phone", "street", "building"]) {
    assert.equal(json.includes(private_), false, `a collection ticket must not carry a ${private_}`);
  }
  assert.equal(buildCollectionTicket({ ...ORDER, source: "takeaway", customerName: "Sara" }).customerName, null);
});

// --- off by default -----------------------------------------------------------

test("every route is OFF until somebody turns it on", () => {
  assert.deepEqual(COLLECTION_DEFAULTS.enabled, { takeaway: false, dine_in: false, delivery: false });
  assert.equal(COLLECTION_DEFAULTS.printerId, null);
  for (const source of COLLECTION_SOURCES) {
    assert.equal(collectionEnabledFor(COLLECTION_DEFAULTS, source), false);
  }
});

test("a terminal with no stored settings prints nothing automatically", () => {
  assert.deepEqual(readCollectionSettings(memoryStorage()), COLLECTION_DEFAULTS);
});

test("only an explicit true enables a route - a truthy stray does not", () => {
  const parsed = parseCollectionSettings(
    JSON.stringify({ enabled: { takeaway: "yes", dine_in: 1, delivery: true }, copies: 2 }),
  );
  assert.deepEqual(parsed.enabled, { takeaway: false, dine_in: false, delivery: true });
  assert.equal(parsed.copies, 2);
});

test("unreadable settings resolve to off rather than to paper nobody asked for", () => {
  for (const raw of ["", "{", "null", "[]", '"x"']) {
    assert.deepEqual(parseCollectionSettings(raw), COLLECTION_DEFAULTS);
  }
});

test("settings round-trip, and copies are bounded on the way in and out", () => {
  const store = memoryStorage();
  writeCollectionSettings({ enabled: { takeaway: true, dine_in: false, delivery: false }, printerId: "p1", copies: 99 }, store);
  const back = readCollectionSettings(store);
  assert.equal(back.enabled.takeaway, true);
  assert.equal(back.printerId, "p1");
  assert.equal(back.copies, 5, "the native layer's maximum, applied before it is asked for");
  assert.equal(parseCollectionSettings(JSON.stringify({ copies: 0 })).copies, 1);
});

test("it is stored on THIS terminal, in the desktop namespace, not in the shared receipt settings", () => {
  // Deliberately not `pos_receipt_settings`: the web app's normaliser drops keys
  // its catalog does not know, so a desktop-only block in that shared JSONB
  // would vanish the next time a manager saved receipt design in a browser.
  assert.match(COLLECTION_TICKET_KEY, /^breadee\.desktop\./);
  const source = stripJsxComments(read("src/lib/pos/collectionTicket.ts"));
  assert.equal(source.includes("save_pos_receipt_settings"), false);
  assert.equal(source.includes("pos_receipt_settings"), false);
});

// --- duplicate protection, and the deliberate exception ----------------------

test("one automatic ticket per settlement, keyed on the order and the moment", () => {
  const a = collectionEventKey({ orderNumber: "260821-1257", paidAt: "7:02 PM" });
  assert.equal(a, collectionEventKey({ orderNumber: "260821-1257", paidAt: "7:02 PM" }));
  assert.notEqual(a, collectionEventKey({ orderNumber: "260821-1258", paidAt: "7:02 PM" }));
  // Distinct from the receipt's own key, so the two documents cannot cancel
  // each other out.
  assert.match(a, /^collection:/);
});

test("the MANUAL reprint is deliberately unlatched, and says so", () => {
  const source = read("src/lib/pos/collectionTicket.ts");
  assert.match(source, /DELIBERATELY UNLATCHED/);
  // A cashier asking for another copy has looked at the printer and decided.
  const manual = source.slice(source.indexOf("export async function printCollectionTicketNow"));
  assert.equal(manual.includes("autoPrintLatch"), false, "the manual path must never refuse a second copy");
});

test("nothing on this path can reach a sale", () => {
  const source = stripJsxComments(read("src/lib/pos/collectionTicket.ts"));
  for (const forbidden of ["pos_submit_order", "pos_pay_order", "pos_pay_table", "useCart", "submitOrder", "payOrder"]) {
    assert.equal(source.includes(forbidden), false, `the collection ticket must not reach ${forbidden}`);
  }
});

test("it reuses the existing generic document path - there is no second printer layer", () => {
  const source = stripJsxComments(read("src/lib/pos/collectionTicket.ts"));
  assert.match(source, /printReport/, "it renders through the report document the shift report already uses");
  assert.equal(source.includes("invoke("), false, "the native boundary has exactly one door");
});
