// Open Tables - the outstanding-bill projection over the canonical table map.
//
// This module invents no financial concept and holds no SECOND definition of an
// "open bill". Every figure comes from `pos_table_map` (see lib/pos/tables.ts),
// whose `total` is the SERVER's sum of a table's open dine-in orders in their own
// snapshot currency. An "outstanding table" is simply a table that carries an
// open bill - `orders > 0` - which is exactly the dine-in open set the map already
// filters to: `order_type='dine_in' and status in ('draft','sent_to_kitchen') and
// payment_status <> 'paid'` (the same predicate `_floor_open_bill` uses).
//
// There is deliberately NO partial/remaining arithmetic here. The three canonical
// settlement flows (`pos_pay_table`, `pos_pay_order`, `pos_complete_table_on_account`)
// each COMPLETE an order in full before/when a payment is recorded, so an open
// dine-in bill is always fully unpaid and the server's `total` IS the amount still
// owed. On-account completion FREES the table (the debt moves to the receivables
// ledger, a separate surface), so it never appears in the open set. Recomputing a
// balance in the client would be a second answer to a question the server already
// answers.

import type { CurrencyCode } from "@/lib/currency";
import { elapsedMinutes } from "@/lib/pos/tables";
import type { TableSummary } from "@/types/tables";

/**
 * The tables that carry an open (unpaid) dine-in bill - the outstanding set.
 *
 * `orders > 0` and not merely `occupied`: a table can be occupied with no open
 * bill (reserved, or manually set occupied), and such a table owes nothing. The
 * map's `orders` counter is the count of open unpaid dine-in orders, so it is the
 * honest predicate for "financially outstanding".
 */
export function selectOpenTables(tables: TableSummary[]): TableSummary[] {
  return tables.filter((t) => t.orders > 0);
}

export type OutstandingBucket = {
  currency: CurrencyCode;
  /** Sum of the tables' own `total`, in this currency. Never cross-currency. */
  amount: number;
  tables: number;
};

/** A stable display order for the currency buckets, independent of the data. */
const CURRENCY_ORDER: CurrencyCode[] = ["USD", "LBP"];

/**
 * Outstanding totals, aggregated INDEPENDENTLY per selling currency.
 *
 * USD and LBP are never summed into one number - a $10 bill and a 350,000 LBP
 * bill are two amounts, not one, and no exchange rate is applied to merge them.
 * A table whose open orders span more than one currency (the server declined to
 * sum it, so `total === null` / `mixed_currency`) is NOT bucketed here; it is
 * surfaced separately by `mixedCurrencyOpenTables` so its money is never silently
 * dropped OR silently converted.
 */
export function outstandingByCurrency(open: TableSummary[]): OutstandingBucket[] {
  const byCcy = new Map<CurrencyCode, { amount: number; tables: number }>();
  for (const t of open) {
    if (t.mixed_currency || t.total === null || t.currency === null) continue;
    const b = byCcy.get(t.currency) ?? { amount: 0, tables: 0 };
    b.amount += t.total;
    b.tables += 1;
    byCcy.set(t.currency, b);
  }
  return [...byCcy.entries()]
    .map(([currency, b]) => ({ currency, amount: b.amount, tables: b.tables }))
    .sort((a, b) => {
      const ia = CURRENCY_ORDER.indexOf(a.currency);
      const ib = CURRENCY_ORDER.indexOf(b.currency);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
}

/**
 * Open tables whose bill the server refused to sum (mixed currency). Listed so
 * the operator can settle each order separately - `pos_pay_table` refuses a
 * mixed-currency table too - rather than having it vanish from the totals.
 */
export function mixedCurrencyOpenTables(open: TableSummary[]): TableSummary[] {
  return open.filter((t) => t.mixed_currency || t.total === null);
}

export type OpenTablesSort = "oldest" | "newest" | "highest";

const openedMs = (t: TableSummary): number | null => {
  const ms = t.opened_at ? Date.parse(t.opened_at) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Sort the outstanding list.
 *
 *  - "oldest"  - longest-open first (opened_at ascending; unknown time last).
 *    The service default: the table that has waited longest to be paid.
 *  - "newest"  - most recently opened first.
 *  - "highest" - largest outstanding first, by the table's own `total`. Within a
 *    single-currency branch this is exactly "who owes the most"; a mixed USD/LBP
 *    branch orders by raw magnitude, which is a rough guide - no FX is invented to
 *    rank one currency against another. A table with no summable total sorts last.
 */
export function sortOpenTables(open: TableSummary[], sort: OpenTablesSort): TableSummary[] {
  const rows = [...open];
  switch (sort) {
    case "newest":
      return rows.sort((a, b) => (openedMs(b) ?? -Infinity) - (openedMs(a) ?? -Infinity));
    case "highest":
      return rows.sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity));
    case "oldest":
    default:
      return rows.sort((a, b) => (openedMs(a) ?? Infinity) - (openedMs(b) ?? Infinity));
  }
}

/** Case-insensitive match on table name OR the open order number. */
export function searchOpenTables(open: TableSummary[], query: string): TableSummary[] {
  const q = query.trim().toLowerCase();
  if (q === "") return open;
  return open.filter(
    (t) => t.name.toLowerCase().includes(q) || (t.order_number ?? "").toLowerCase().includes(q),
  );
}

/** Longest elapsed minutes among the open tables, for the "oldest open" stat. */
export function oldestOpenMinutes(open: TableSummary[], now: number): number | null {
  let max: number | null = null;
  for (const t of open) {
    const m = elapsedMinutes(t.opened_at, now);
    if (m !== null && (max === null || m > max)) max = m;
  }
  return max;
}
