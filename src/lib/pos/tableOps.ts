// Dine-In table operations (Level 2C): Move, Close, Clear.
//
// These are the first dine-in actions that change a table's FINANCIAL state, so
// the contracts are worth stating plainly - each was read from the staging
// definition, not inferred:
//
//   pos_move_table(p_from, p_to)   requires `pos.tables.move`. Moves every open
//     unpaid order to the destination, frees the source and occupies the
//     destination. Refuses: same table, different tenants, a destination that
//     already has an open order, a source with no open order.
//
//   pos_close_table(p_table)       requires `pos.tables.close`. REFUSES while any
//     open unpaid order exists ("Pay the table bill first, or clear the table").
//     It only marks already-PAID orders complete and frees the table. Until
//     Level 2D can pay a table, Close is the legitimate path for a bill that was
//     settled elsewhere - not a way to close an unpaid one.
//
//   pos_clear_table(p_table, p_reason)  requires `pos.tables.clear`. DESTRUCTIVE:
//     it VOIDS every open unpaid order on the table, stamps cancelled_by /
//     cancelled_at, appends "[cleared: <reason>]" to the notes and writes a
//     `table_cleared` activity log. It frees the table either way.
//
// DESKTOP POLICY, deliberately stricter than the server and never looser:
//
//   1. A REASON IS MANDATORY for Clear. The server accepts an empty one and
//      writes a bare "[cleared]"; that is an audit row which records that money
//      was voided and nothing about why. A voided bill with no explanation is
//      indistinguishable from theft after the fact, so the desktop refuses to
//      send one.
//
//   2. ALL THREE REQUIRE AN OPEN SHIFT, though none of the RPCs demand it. Each
//      mutates open orders that belong to a shift; performing that with no shift
//      of your own leaves the change attributable to a person but not to a till.
//      This mirrors the Level 2A open-table policy.
//
// Level 2D (`pos_pay_table`) remains absent from `PosRpcName` - Close refusing
// an unpaid bill is the SERVER telling us payment is still missing, and that
// refusal is surfaced, never worked around.

import { asRecord, bool, callPosRpc, num } from "@/lib/pos/rpc";
import type { TableSummary } from "@/types/tables";
import type { Gate } from "@/components/ui";

/** The shortest reason that can still mean something to a manager reading the log. */
export const MIN_CLEAR_REASON_LENGTH = 4;

/** Suggested reasons. Free text is always allowed - these only save typing. */
export const CLEAR_REASON_SUGGESTIONS = [
  "Walked out without paying",
  "Order entered on the wrong table",
  "Duplicate bill",
  "Kitchen could not fulfil the order",
  "Test / verification bill",
];

export class ClearReasonRequiredError extends Error {
  constructor() {
    super("A reason is required to clear a table");
    this.name = "ClearReasonRequiredError";
  }
}

export class SameTableError extends Error {
  constructor() {
    super("Choose a different destination table");
    this.name = "SameTableError";
  }
}

export type TableOpKind = "move" | "close" | "clear";

export type MoveResult = { ok: boolean; orders_moved: number };
export type CloseResult = { ok: boolean; orders_completed: number };
export type ClearResult = { ok: boolean; orders_voided: number };

// --- validation --------------------------------------------------------------

/**
 * Validate a clear reason. Trimmed, because " " is not an explanation, and the
 * server would happily store the padding.
 */
export function validateClearReason(raw: string): { reason: string | null; error: string | null } {
  const reason = raw.trim();
  if (reason === "") return { reason: null, error: "Enter why this table is being cleared." };
  if (reason.length < MIN_CLEAR_REASON_LENGTH) {
    return { reason: null, error: `Give a little more detail (at least ${MIN_CLEAR_REASON_LENGTH} characters).` };
  }
  return { reason, error: null };
}

/** Destinations a bill may be moved to: free, configured, and not the source. */
export function moveDestinations(tables: TableSummary[], source: TableSummary | null): TableSummary[] {
  if (!source) return [];
  return tables.filter((t) => t.id !== source.id && t.orders === 0 && t.status === "available");
}

/**
 * Gate for a table operation, evaluated in the order the server would refuse.
 * `permitted` comes from the permission map - this never reads a role name.
 */
export function tableOpGate(input: {
  kind: TableOpKind;
  permitted: Gate;
  table: TableSummary | null;
  hasOpenShift: boolean;
  online: boolean;
}): Gate {
  if (!input.permitted.allowed) return input.permitted;
  if (!input.table) return { allowed: false, reason: "Select a table first." };
  if (!input.online) return { allowed: false, reason: "Table operations need a connection." };
  if (!input.hasOpenShift) {
    return { allowed: false, reason: `Open a shift before you ${input.kind} a table.` };
  }
  // Move and Clear only mean something for a table that HAS an open bill.
  if (input.kind !== "close" && input.table.orders === 0) {
    return { allowed: false, reason: "This table has no open bill." };
  }
  return { allowed: true, reason: null };
}

/**
 * What Close will do, spelled out before it is pressed.
 *
 * Close is the one operation whose outcome depends entirely on server state the
 * operator cannot see: it completes PAID orders and refuses UNPAID ones. Saying
 * so up front turns a refusal into an expectation.
 */
export function closeOutlook(table: TableSummary | null): { willRefuse: boolean; explanation: string } {
  if (!table) return { willRefuse: true, explanation: "Select a table first." };
  if (table.orders > 0) {
    return {
      willRefuse: true,
      explanation:
        "This table still has an unpaid bill. The server will refuse to close it - settle the bill first, or clear the table with a reason.",
    };
  }
  return {
    willRefuse: false,
    explanation: "This marks any settled orders on the table complete and returns it to available.",
  };
}

// --- operations --------------------------------------------------------------

export async function moveTable(input: { fromTableId: string; toTableId: string }): Promise<MoveResult> {
  if (input.fromTableId === input.toTableId) throw new SameTableError();
  const row = asRecord(
    await callPosRpc("pos_move_table", { p_from: input.fromTableId, p_to: input.toTableId }),
  );
  return { ok: bool(row.ok), orders_moved: num(row.orders_moved) };
}

export async function closeTable(input: { tableId: string }): Promise<CloseResult> {
  const row = asRecord(await callPosRpc("pos_close_table", { p_table: input.tableId }));
  return { ok: bool(row.ok), orders_completed: num(row.orders_completed) };
}

/**
 * Clear a table. The reason is validated HERE as well as in the dialog, so the
 * requirement holds no matter which caller reaches it.
 */
export async function clearTable(input: { tableId: string; reason: string }): Promise<ClearResult> {
  const { reason, error } = validateClearReason(input.reason);
  if (error || !reason) throw new ClearReasonRequiredError();
  const row = asRecord(await callPosRpc("pos_clear_table", { p_table: input.tableId, p_reason: reason }));
  return { ok: bool(row.ok), orders_voided: num(row.orders_voided) };
}

// --- presentation ------------------------------------------------------------

export function moveOutcomeMessage(r: MoveResult, from: string, to: string): string {
  return `${from} moved to ${to}${r.orders_moved === 1 ? "" : ` (${r.orders_moved} orders)`}`;
}

export function closeOutcomeMessage(r: CloseResult, name: string): string {
  return r.orders_completed === 0
    ? `${name} is now available`
    : `${name} closed - ${r.orders_completed} order${r.orders_completed === 1 ? "" : "s"} completed`;
}

export function clearOutcomeMessage(r: ClearResult, name: string): string {
  return r.orders_voided === 0
    ? `${name} is now available`
    : `${name} cleared - ${r.orders_voided} order${r.orders_voided === 1 ? "" : "s"} voided`;
}

/**
 * The wording shown on the Clear confirmation. It names the consequence in the
 * server's own terms - the bill is VOIDED, not merely closed or hidden.
 */
export function clearConsequence(table: TableSummary | null): string {
  const orders = table?.orders ?? 0;
  if (orders === 0) return "This table has no open bill. Clearing only returns it to available.";
  return `This VOIDS ${orders === 1 ? "the open bill" : `all ${orders} open bills`} on ${table?.name ?? "this table"}. The money is not collected, the orders are cancelled, and the reason is recorded against your account. This cannot be undone from the desktop.`;
}
