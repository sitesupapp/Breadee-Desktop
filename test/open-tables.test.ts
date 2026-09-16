// Open Tables - the outstanding projection over the canonical table map.
//
// These tests pin the BUSINESS RULES the feature must never break: what counts
// as outstanding, that USD and LBP are never summed into one number, that a moved
// bill appears once, and that a mixed-currency table is surfaced rather than
// silently dropped or converted. No DOM, no network - pure functions over the
// `pos_table_map` shape the server returns.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mixedCurrencyOpenTables,
  oldestOpenMinutes,
  outstandingByCurrency,
  searchOpenTables,
  selectOpenTables,
  sortOpenTables,
} from "@/lib/pos/openTables";
import { tableSectionMap, type FloorLayout } from "@/lib/pos/floor";
import type { TableSummary } from "@/types/tables";

function tbl(o: Partial<TableSummary> = {}): TableSummary {
  return {
    id: o.id ?? "t1",
    name: o.name ?? "T1",
    seats: o.seats ?? 4,
    occupied: o.occupied ?? false,
    status: o.status ?? "available",
    canonical: o.canonical ?? true,
    configured: o.configured ?? true,
    sort_order: o.sort_order ?? null,
    orders: o.orders ?? 0,
    order_number: o.order_number ?? null,
    opened_at: o.opened_at ?? null,
    total: o.total ?? null,
    currency: o.currency ?? null,
    mixed_currency: o.mixed_currency ?? false,
  };
}

// --- what is outstanding -----------------------------------------------------

test("a free table with no order is excluded", () => {
  const open = selectOpenTables([tbl({ id: "free", orders: 0, status: "available" })]);
  assert.equal(open.length, 0);
});

test("an occupied table with NO open bill is excluded - occupied is not outstanding", () => {
  // The map can report a table occupied (e.g. reserved / manually set) with no
  // open unpaid order. It owes nothing, so Open Tables must not list it.
  const open = selectOpenTables([tbl({ id: "occ", orders: 0, status: "occupied", occupied: true })]);
  assert.equal(open.length, 0);
});

test("an active unpaid table is included", () => {
  const open = selectOpenTables([
    tbl({ id: "a", orders: 1, status: "occupied", order_number: "260101-0001", total: 10, currency: "USD" }),
  ]);
  assert.deepEqual(open.map((t) => t.id), ["a"]);
});

test("a paid / completed table is excluded - the map counts only unpaid open orders", () => {
  // The server's `orders` counter is the count of open UNPAID dine-in orders; a
  // paid or voided table therefore arrives with orders:0 and is excluded.
  const open = selectOpenTables([
    tbl({ id: "paid", orders: 0, status: "available" }),
    tbl({ id: "voided", orders: 0, status: "available" }),
  ]);
  assert.equal(open.length, 0);
});

test("a moved bill appears exactly once, at its current table", () => {
  // A bill moved TR-01 -> LH-04 shows the open order only on the destination; the
  // source is free again. The map is derived from live pos_orders.table_id.
  const map = [
    tbl({ id: "tr1", name: "TR-01", orders: 0, status: "available" }),
    tbl({ id: "lh4", name: "LH-04", orders: 1, order_number: "260101-0002", total: 25, currency: "USD" }),
  ];
  const open = selectOpenTables(map);
  assert.deepEqual(open.map((t) => t.name), ["LH-04"]);
});

// --- currency: never summed --------------------------------------------------

test("USD and LBP outstanding are bucketed independently, never added", () => {
  const open = selectOpenTables([
    tbl({ id: "a", orders: 1, total: 350000, currency: "LBP" }),
    tbl({ id: "b", orders: 1, total: 10, currency: "USD" }),
    tbl({ id: "c", orders: 1, total: 5, currency: "USD" }),
  ]);
  const buckets = outstandingByCurrency(open);
  const usd = buckets.find((b) => b.currency === "USD");
  const lbp = buckets.find((b) => b.currency === "LBP");
  assert.equal(usd?.amount, 15);
  assert.equal(usd?.tables, 2);
  assert.equal(lbp?.amount, 350000);
  assert.equal(lbp?.tables, 1);
  // The two amounts are never merged into a single figure.
  assert.equal(buckets.length, 2);
  assert.ok(!buckets.some((b) => b.amount === 350015));
});

test("a single-currency branch yields one bucket", () => {
  const open = selectOpenTables([
    tbl({ id: "a", orders: 1, total: 10, currency: "USD" }),
    tbl({ id: "b", orders: 1, total: 20, currency: "USD" }),
  ]);
  const buckets = outstandingByCurrency(open);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].currency, "USD");
  assert.equal(buckets[0].amount, 30);
});

test("a mixed-currency table is kept OUT of the buckets and surfaced separately", () => {
  const open = selectOpenTables([
    tbl({ id: "a", orders: 1, total: 10, currency: "USD" }),
    tbl({ id: "m", orders: 2, total: null, currency: null, mixed_currency: true }),
  ]);
  const buckets = outstandingByCurrency(open);
  // The mixed table's money is neither dropped into a bucket nor converted.
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].currency, "USD");
  assert.equal(buckets[0].amount, 10);
  const mixed = mixedCurrencyOpenTables(open);
  assert.deepEqual(mixed.map((t) => t.id), ["m"]);
});

// --- sorting -----------------------------------------------------------------

const T0 = "2026-01-01T10:00:00.000Z";
const T1 = "2026-01-01T11:00:00.000Z";
const T2 = "2026-01-01T12:00:00.000Z";

test("oldest-first orders by opened_at ascending", () => {
  const open = [
    tbl({ id: "new", opened_at: T2, orders: 1, total: 1, currency: "USD" }),
    tbl({ id: "old", opened_at: T0, orders: 1, total: 1, currency: "USD" }),
    tbl({ id: "mid", opened_at: T1, orders: 1, total: 1, currency: "USD" }),
  ];
  assert.deepEqual(sortOpenTables(open, "oldest").map((t) => t.id), ["old", "mid", "new"]);
  assert.deepEqual(sortOpenTables(open, "newest").map((t) => t.id), ["new", "mid", "old"]);
});

test("highest-first orders by the table's own total descending", () => {
  const open = [
    tbl({ id: "small", orders: 1, total: 5, currency: "USD" }),
    tbl({ id: "big", orders: 1, total: 50, currency: "USD" }),
    tbl({ id: "mid", orders: 1, total: 20, currency: "USD" }),
  ];
  assert.deepEqual(sortOpenTables(open, "highest").map((t) => t.id), ["big", "mid", "small"]);
});

// --- search ------------------------------------------------------------------

test("search matches table name and order number, case-insensitively", () => {
  const open = [
    tbl({ id: "a", name: "TR-01", order_number: "260101-0009", orders: 1 }),
    tbl({ id: "b", name: "Lounge 3", order_number: "260101-0042", orders: 1 }),
  ];
  assert.deepEqual(searchOpenTables(open, "tr-01").map((t) => t.id), ["a"]);
  assert.deepEqual(searchOpenTables(open, "0042").map((t) => t.id), ["b"]);
  assert.deepEqual(searchOpenTables(open, "lounge").map((t) => t.id), ["b"]);
  assert.equal(searchOpenTables(open, "zzzz").length, 0);
  assert.equal(searchOpenTables(open, "").length, 2);
});

// --- oldest-open stat --------------------------------------------------------

test("oldestOpenMinutes returns the longest elapsed, ignoring tables with no time", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  const open = [
    tbl({ id: "a", opened_at: T1, orders: 1 }), // 60 min
    tbl({ id: "b", opened_at: T0, orders: 1 }), // 120 min
    tbl({ id: "c", opened_at: null, orders: 1 }),
  ];
  assert.equal(oldestOpenMinutes(open, now), 120);
  assert.equal(oldestOpenMinutes([], now), null);
});

// --- section context ---------------------------------------------------------

test("tableSectionMap maps placed tables to their section name, ignoring non-tables", () => {
  const layout: FloorLayout = {
    hasPublished: true,
    revisionId: "r1",
    revisionNo: 1,
    publishedAt: null,
    sections: [
      { id: "s-main", name: "Main Dining", sort: 1, w: null, h: null },
      { id: "s-terr", name: "Terrace", sort: 2, w: null, h: null },
    ],
    elements: [
      { id: "e1", sectionId: "s-main", type: "table", x: 0, y: 0, w: 1, h: 1, rotation: 0, shape: "sq", tableId: "t-main", label: null },
      { id: "e2", sectionId: "s-terr", type: "table", x: 0, y: 0, w: 1, h: 1, rotation: 0, shape: "round", tableId: "t-terr", label: null },
      { id: "e3", sectionId: "s-main", type: "wall", x: 0, y: 0, w: 1, h: 1, rotation: 0, shape: null, tableId: null, label: null },
    ],
  };
  const m = tableSectionMap(layout);
  assert.equal(m.get("t-main"), "Main Dining");
  assert.equal(m.get("t-terr"), "Terrace");
  assert.equal(m.size, 2);
  assert.equal(m.get("t-unknown"), undefined);
});
