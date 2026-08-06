// The pos_table_map reader.
//
// The map is parsed defensively and NEVER embellished. Three properties matter
// most and are pinned here:
//   1. the tenant's table name is used verbatim (the "Table Table 5" defect),
//   2. a total the server declined to sum stays null - it is never shown as 0,
//   3. a malformed row is dropped without taking the whole map down.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  elapsedMinutes,
  filterTables,
  formatElapsed,
  isOpenable,
  parseTableMap,
  tableCardState,
  validateSeats,
} from "@/lib/pos/tables";
import { isMapStale, selectedTable, STALE_AFTER_MS } from "@/state/tables";
import type { TableSummary } from "@/types/tables";

const row = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  name: "Table 5",
  seats: 4,
  occupied: false,
  status: "available",
  canonical: true,
  configured: true,
  sort_order: 5,
  orders: 0,
  order_number: null,
  opened_at: null,
  total: null,
  currency: null,
  mixed_currency: false,
  ...over,
});

const table = (over: Partial<TableSummary> = {}): TableSummary =>
  parseTableMap({ tables: [row(over as Record<string, unknown>)] }).tables[0];

test("a well-formed map is parsed with its aggregate counters", () => {
  const map = parseTableMap({
    tables: [row(), row({ id: "t2", name: "Terrace", status: "occupied", occupied: true, orders: 1, order_number: "A-14" })],
    total: 2,
    occupied: 1,
    available: 1,
    configured: 2,
    legacy_hidden: 3,
  });
  assert.equal(map.tables.length, 2);
  assert.equal(map.total, 2);
  assert.equal(map.occupied, 1);
  assert.equal(map.available, 1);
  assert.equal(map.configured, 2);
  assert.equal(map.legacy_hidden, 3);
});

test("table names are used verbatim - never prefixed or re-derived", () => {
  const map = parseTableMap({ tables: [row({ id: "a", name: "5" }), row({ id: "b", name: "Table 5" }), row({ id: "c", name: "VIP 2" })] });
  assert.deepEqual(map.tables.map((t) => t.name), ["5", "Table 5", "VIP 2"]);
});

test("a row without an id is dropped, and the rest of the map survives", () => {
  const map = parseTableMap({ tables: [row(), { name: "broken" }, row({ id: "t3", name: "T3" })] });
  assert.deepEqual(map.tables.map((t) => t.id), ["t1", "t3"]);
});

test("a non-object or missing payload yields an empty map rather than throwing", () => {
  assert.deepEqual(parseTableMap(null).tables, []);
  assert.deepEqual(parseTableMap({}).tables, []);
  assert.deepEqual(parseTableMap({ tables: "not an array" }).tables, []);
  assert.equal(parseTableMap(null).total, 0);
});

test("total falls back to the row count only when the server omitted it", () => {
  assert.equal(parseTableMap({ tables: [row(), row({ id: "t2" })] }).total, 2);
  assert.equal(parseTableMap({ tables: [row()], total: 9 }).total, 9);
});

test("a total the server refused to sum stays null - it is never rendered as zero", () => {
  const t = table({ total: null, mixed_currency: true, orders: 2 } as Partial<TableSummary>);
  assert.equal(t.total, null);
  assert.equal(t.mixed_currency, true);
});

test("an unrecognised currency is dropped rather than displayed", () => {
  assert.equal(table({ currency: "XXX" } as unknown as Partial<TableSummary>).currency, null);
  assert.equal(table({ currency: "USD" } as unknown as Partial<TableSummary>).currency, "USD");
});

test("an unrecognised status degrades to available rather than crashing the card", () => {
  assert.equal(table({ status: "banana" } as unknown as Partial<TableSummary>).status, "available");
  assert.equal(table({ status: "reserved" } as unknown as Partial<TableSummary>).status, "reserved");
});

test("card state is derived only from what the map returned", () => {
  assert.equal(tableCardState(table()), "available");
  assert.equal(tableCardState(table({ status: "reserved" } as Partial<TableSummary>)), "reserved");
  assert.equal(tableCardState(table({ status: "occupied", occupied: true } as Partial<TableSummary>)), "occupied");
  assert.equal(tableCardState(table({ orders: 1, order_number: "A-14" } as Partial<TableSummary>)), "active_bill");
  // No order number yet (the bill exists but the map did not name it).
  assert.equal(tableCardState(table({ orders: 1 } as Partial<TableSummary>)), "occupied");
  assert.equal(tableCardState(table({ status: "inactive" } as Partial<TableSummary>)), "unknown");
});

test("mixed currency outranks every other card state", () => {
  const t = table({ mixed_currency: true, orders: 2, order_number: "A-14", status: "occupied" } as Partial<TableSummary>);
  assert.equal(tableCardState(t), "mixed_currency");
});

test("only a free, available table is openable", () => {
  assert.equal(isOpenable(table()), true);
  assert.equal(isOpenable(table({ orders: 1 } as Partial<TableSummary>)), false);
  assert.equal(isOpenable(table({ status: "occupied" } as Partial<TableSummary>)), false);
  assert.equal(isOpenable(table({ status: "reserved" } as Partial<TableSummary>)), false);
});

test("seat validation accepts blank, rejects nonsense, and invents no upper bound", () => {
  assert.deepEqual(validateSeats(""), { seats: null, error: null });
  assert.deepEqual(validateSeats("   "), { seats: null, error: null });
  assert.deepEqual(validateSeats("4"), { seats: 4, error: null });
  // The server enforces no maximum, so neither does the desktop.
  assert.deepEqual(validateSeats("500"), { seats: 500, error: null });
  assert.equal(validateSeats("4.5").error, "Seats must be a whole number.");
  assert.equal(validateSeats("abc").error, "Seats must be a whole number.");
  assert.equal(validateSeats("-2").error, "Seats must be a whole number.");
  assert.equal(validateSeats("0").error, "Seats must be at least 1.");
});

test("elapsed time is derived from the server timestamp, and refuses to guess", () => {
  const opened = "2026-01-01T10:00:00.000Z";
  const now = Date.parse("2026-01-01T11:23:00.000Z");
  assert.equal(elapsedMinutes(opened, now), 83);
  assert.equal(formatElapsed(83), "1h 23m");
  assert.equal(formatElapsed(7), "7m");
  assert.equal(elapsedMinutes(null, now), null);
  assert.equal(elapsedMinutes("not a date", now), null);
  assert.equal(formatElapsed(null), null);
  // A clock skew must never render a negative age.
  assert.equal(elapsedMinutes(opened, Date.parse("2026-01-01T09:00:00.000Z")), 0);
});

test("the search box filters by name, case-insensitively, without reordering", () => {
  const tables = parseTableMap({
    tables: [row({ id: "a", name: "Table 5" }), row({ id: "b", name: "Terrace" }), row({ id: "c", name: "VIP 2" })],
  }).tables;
  assert.deepEqual(filterTables(tables, "t").map((t) => t.id), ["a", "b"]);
  assert.deepEqual(filterTables(tables, "vip").map((t) => t.id), ["c"]);
  assert.deepEqual(filterTables(tables, "  ").map((t) => t.id), ["a", "b", "c"]);
  assert.deepEqual(filterTables(tables, "zzz"), []);
});

test("a map is only flagged stale after the freshness window, and never before it loads", () => {
  const t0 = 1_000_000;
  assert.equal(isMapStale(null, t0), false, "a map that never loaded is not stale, it is absent");
  assert.equal(isMapStale(t0, t0 + STALE_AFTER_MS), false);
  assert.equal(isMapStale(t0, t0 + STALE_AFTER_MS + 1), true);
});

test("the selected table resolves against the CURRENT map, so a vanished row reads as null", () => {
  const map = parseTableMap({ tables: [row({ id: "a" }), row({ id: "b" })] });
  assert.equal(selectedTable({ map, selectedTableId: "b" })?.id, "b");
  assert.equal(selectedTable({ map, selectedTableId: "gone" }), null);
  assert.equal(selectedTable({ map, selectedTableId: null }), null);
});
