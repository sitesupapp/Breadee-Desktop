// Dine-In table map and table opening, against the staging contracts.
//
//   * pos_table_map(p_branch)  (m256) - branch-scoped map + aggregate counters.
//     Requires `pos.tables.view` and, for non-owners, assert_branch_access.
//     Open bills are dine-in orders in ('draft','sent_to_kitchen') that are not
//     paid. Free legacy tables are hidden and only counted in `legacy_hidden`.
//
//   * pos_open_table({branch_id,name,seats}) (m256) - requires `pos.tables.open`
//     and pos_assert_operator. The branch is resolved SERVER-side, so the value
//     sent is only a request. On a configured branch an unknown name is refused
//     with 22023; free-text creation is possible only where no configured tables
//     exist. It returns the STORED name, which is what must be displayed.
//
// This module performs no financial arithmetic and never invents a figure: a
// total the server declined to sum (mixed currency) stays null.

import { asRecord, bool, callPosRpc, num, numOrNull, requireId, str, strOrNull } from "@/lib/pos/rpc";
import { isCurrencyCode, type CurrencyCode } from "@/lib/currency";
import {
  type OpenTableResult,
  type TableCardState,
  type TableMap,
  type TableStatus,
  type TableSummary,
} from "@/types/tables";

const TABLE_STATUSES: TableStatus[] = ["available", "occupied", "reserved", "inactive"];

function toStatus(value: unknown): TableStatus {
  const s = str(value);
  return (TABLE_STATUSES as string[]).includes(s) ? (s as TableStatus) : "available";
}

function toCurrency(value: unknown): CurrencyCode | null {
  return isCurrencyCode(value) ? value : null;
}

/** Parse one map row defensively - a malformed row must not break the whole map. */
function toTable(raw: unknown): TableSummary | null {
  const r = asRecord(raw);
  const id = strOrNull(r.id);
  if (!id) return null;
  return {
    id,
    // Verbatim. Never prefixed, never re-derived.
    name: str(r.name),
    seats: numOrNull(r.seats),
    occupied: bool(r.occupied),
    status: toStatus(r.status),
    canonical: bool(r.canonical),
    configured: bool(r.configured),
    sort_order: numOrNull(r.sort_order),
    orders: num(r.orders),
    order_number: strOrNull(r.order_number),
    opened_at: strOrNull(r.opened_at),
    // Null is meaningful: the server refuses to sum a mixed-currency bill.
    total: numOrNull(r.total),
    currency: toCurrency(r.currency),
    mixed_currency: bool(r.mixed_currency),
  };
}

export function parseTableMap(raw: unknown): TableMap {
  const root = asRecord(raw);
  const list = Array.isArray(root.tables) ? root.tables : [];
  const tables = list.map(toTable).filter((t): t is TableSummary => t !== null);
  return {
    tables,
    total: num(root.total, tables.length),
    occupied: num(root.occupied),
    available: num(root.available),
    configured: num(root.configured),
    legacy_hidden: num(root.legacy_hidden),
  };
}

/**
 * Load the table map for a branch. The branch is REQUIRED by the server and is
 * never guessed here - a missing branch is a client bug, not a reason to ask for
 * a different branch's tables.
 */
export async function loadTableMap(branchId: string | null): Promise<TableMap> {
  if (!branchId) throw new Error("A branch is required to load the table map");
  return parseTableMap(await callPosRpc("pos_table_map", { p_branch: branchId }));
}

export type OpenTableInput = {
  branchId: string | null;
  /** The table's own name, exactly as shown on the map (or a bare number). */
  name: string;
  /** Optional; the server stores `coalesce(new, existing)`. */
  seats: number | null;
};

/**
 * Seat validation. Deliberately loose: the server enforces no upper bound, so
 * inventing one here would refuse input the database would accept. Blank is
 * allowed because `seats` is nullable.
 */
export function validateSeats(raw: string): { seats: number | null; error: string | null } {
  const text = raw.trim();
  if (text === "") return { seats: null, error: null };
  if (!/^\d+$/.test(text)) return { seats: null, error: "Seats must be a whole number." };
  const seats = Number(text);
  if (seats < 1) return { seats: null, error: "Seats must be at least 1." };
  return { seats, error: null };
}

export async function openTable(input: OpenTableInput): Promise<OpenTableResult> {
  const name = input.name.trim();
  if (name === "") throw new Error("Enter a table number or name");
  const row = asRecord(
    await callPosRpc("pos_open_table", {
      p_payload: { branch_id: input.branchId, name, seats: input.seats },
    }),
  );
  return {
    table_id: requireId(row.table_id, "pos_open_table", "table_id"),
    // The stored name wins - a bare "5" comes back as the configured "Table 5".
    name: str(row.name, name),
    created: bool(row.created),
  };
}

// --- capacity ----------------------------------------------------------------
//
//   * pos_configure_tables({p_branch, p_names}) (m256) - the ONE authoritative
//     table-capacity contract, and the same one the Breadee web app calls. The
//     LENGTH of `p_names` is the branch's configured capacity; a blank entry
//     falls back to the server's own `Table i` default, so raising the count
//     never requires the desktop to invent a name. Requires
//     `pos.settings.manage`, enforced server-side. Legacy (unconfigured) rows
//     are preserved and are deliberately NOT counted as capacity - the server
//     reports them separately as `legacy_active`.
//
// THERE IS NO LOCAL COPY OF THIS SETTING. Capacity is a property of the branch,
// not of a terminal, so nothing here reads or writes localStorage: a number
// typed on this till has to be the number the web app and every other till
// already see, and a second store is how two answers to one question begin.

/** What `pos_configure_tables` reports back. Every figure is the server's. */
export type ConfigureTablesResult = {
  requested: number;
  created: number;
  renamed: number;
  reactivated: number;
  deactivated: number;
  /** Legacy rows parked because a configured table reclaimed their name. */
  legacy_parked: number;
  /** Legacy rows still active. Never part of the configured capacity. */
  legacy_active: number;
};

/**
 * The name list for a requested capacity, preserving what the branch already calls
 * its tables.
 *
 * Position is identity here, exactly as it is server-side: `sort_order` i keeps
 * its name when the count changes, and a position that has never existed is sent
 * BLANK so the server applies its own default rather than the desktop inventing
 * one that the web app would not have chosen. Only CONFIGURED rows are read -
 * a legacy free-text row is not capacity and must not be promoted into it by
 * having its name adopted here.
 */
export function tableNamesForCount(count: number, tables: TableSummary[]): string[] {
  const byPosition = new Map<number, string>();
  for (const t of tables) {
    if (!t.configured || t.sort_order == null) continue;
    if (!byPosition.has(t.sort_order)) byPosition.set(t.sort_order, t.name);
  }
  return Array.from({ length: Math.max(0, count) }, (_, i) => byPosition.get(i + 1) ?? "");
}

/**
 * Validate a typed capacity the way the server will, so an impossible number is
 * refused at the keyboard instead of as a database exception.
 */
export function validateTableCount(raw: string): { count: number | null; error: string | null } {
  const text = raw.trim();
  if (text === "") return { count: null, error: "Enter how many tables this branch has." };
  if (!/^\d+$/.test(text)) return { count: null, error: "The number of tables must be a whole number." };
  const count = Number(text);
  if (count > 500) return { count: null, error: "A branch can have at most 500 tables." };
  return { count, error: null };
}

/**
 * Set this branch's configured tables.
 *
 * A thin call and nothing more: every rule that matters - the permission, the
 * refusal to shrink past an occupied table, name uniqueness, what happens to a
 * legacy row whose name is reclaimed - is the server's, and is deliberately not
 * restated here where it could drift away from the web app's behaviour.
 */
export async function configureTables(input: {
  branchId: string | null;
  names: string[];
}): Promise<ConfigureTablesResult> {
  if (!input.branchId) throw new Error("A branch is required to configure tables");
  const row = asRecord(await callPosRpc("pos_configure_tables", { p_branch: input.branchId, p_names: input.names }));
  return {
    requested: num(row.requested, input.names.length),
    created: num(row.created),
    renamed: num(row.renamed),
    reactivated: num(row.reactivated),
    deactivated: num(row.deactivated),
    legacy_parked: num(row.legacy_parked),
    legacy_active: num(row.legacy_active),
  };
}

// --- presentation helpers ----------------------------------------------------

/**
 * The card state, derived ONLY from what the map returns. There is deliberately
 * no "paid / awaiting close" or "needs clearing" state here: `pos_table_map`
 * only reports UNPAID open bills, so those states are not representable yet and
 * inventing them would show a cashier something the server never said.
 */
export function tableCardState(t: TableSummary): TableCardState {
  if (t.mixed_currency) return "mixed_currency";
  if (t.orders > 0) return t.order_number ? "active_bill" : "occupied";
  if (t.status === "reserved") return "reserved";
  if (t.status === "occupied") return "occupied";
  if (t.status === "available") return "available";
  return "unknown";
}

/** True when this table can be opened as a fresh bill. */
export function isOpenable(t: TableSummary): boolean {
  return t.orders === 0 && t.status === "available";
}

/** Minutes since the bill opened, for the card's elapsed badge. */
export function elapsedMinutes(openedAt: string | null, now: number): number | null {
  if (!openedAt) return null;
  const started = Date.parse(openedAt);
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.floor((now - started) / 60000));
}

export function formatElapsed(minutes: number | null): string | null {
  if (minutes === null) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Case-insensitive name filter for the table search box. */
export function filterTables(tables: TableSummary[], query: string): TableSummary[] {
  const q = query.trim().toLowerCase();
  if (q === "") return tables;
  return tables.filter((t) => t.name.toLowerCase().includes(q));
}
