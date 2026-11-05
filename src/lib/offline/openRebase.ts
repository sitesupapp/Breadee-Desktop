// 1.0.40 (BUG 03, F3) — an operator Retry that CAN succeed for a table open refused on its table-version CAS.
//
// An offline "open table" captures the table's version from the cached map (or from the settle it follows).
// When another terminal (or this one, online) moved the table forward meanwhile, pos_open_table_core refuses
// it with VERSION_CONFLICT before any write. Through 1.0.39 "Try again" re-sent the SAME frozen version, so the
// server refused it again, forever — and every round / payment / later reopen of that table piled up behind it.
//
// What this does — and only this:
//   - only for a dinein_open_table that is parked on exactly that CAS refusal and was never applied
//     (operationalProjection.isCasRefusedOpen: no server id, never synced);
//   - only while online, after Breadee itself shows (a) the table FREE with NO open bill (pos_table_map row:
//     available, not occupied, 0 open orders) and (b) NO receipt of this op's client_op_id
//     (pos_op_submissions — the receipt pos_open_table records in the same transaction as the open);
//   - then, in one Dexie transaction that re-checks nothing changed, the open's expected_version is set to the
//     table's CURRENT version, an append-only `rebases` audit entry is written, and the op (plus the
//     dependency_failed chain behind it) is re-queued and a drain requested.
//   The client_op_id is KEPT: pos_op_replay keys a receipt on (tenant, client_op_id, op type, branch) — not on
//   the payload — and a CAS refusal records no receipt, so the same id replays exactly once.
//   - a table that is occupied / has a bill on Breadee is a GENUINE conflict: nothing is changed, the operator
//     is told what to do (never an overwrite of someone else's bill).
// Nothing is deleted, acknowledged or marked synced here.

import { localdb } from "@/lib/offline/db";
import { requeueDependents, requestDrain, type OfflineOperation } from "@/lib/offline/operationLog";
import { isCasRefusedOpen } from "@/lib/offline/operationalProjection";
import type { TableSummary } from "@/types/tables";

export type RebaseDeps = {
  /** The table's LIVE pos_table_map row (null when the server does not list it). Throws when unreachable. */
  readTable(branchId: string | null, tableId: string): Promise<TableSummary | null>;
  /** True when Breadee holds a receipt of this client_op_id (pos_op_submissions). Throws when it cannot tell. */
  hasReceipt(tenantId: string, clientOpId: string): Promise<boolean>;
};

export type RebaseOutcome =
  | { kind: "rebased"; fromVersion: number | null; toVersion: number }
  | { kind: "not_applicable" }
  | { kind: "receipt_found" }
  | { kind: "table_busy"; message: string }
  | { kind: "offline"; message: string }
  | { kind: "stale"; message: string };

export const REBASE_TABLE_BUSY =
  "Breadee shows this table occupied (or with an open bill) now, so this offline open cannot be re-sent. Add the items to the table's current bill online, then withdraw the refused order in the Sync Center.";
export const REBASE_RECEIPT_FOUND =
  "Breadee already holds a record of this table open, so it is not re-sent with a new version. It will sync as recorded — contact support with the Sync Center diagnostics if it stays stuck.";
export const REBASE_NEEDS_CONNECTION =
  "Retrying this table open needs a connection to Breadee, to re-check the table first. Try again when this terminal is online.";
export const REBASE_STALE = "This operation changed while it was being retried. Review it again.";

/** PURE — is this op a table open a rebase-retry applies to? */
export function isRebasableOpen(o: OfflineOperation | undefined | null): boolean {
  return !!o && isCasRefusedOpen(o);
}

/** PURE — Breadee's live row proves the table free with no open bill. */
export function tableFreeOnServer(row: TableSummary | null): boolean {
  return row != null && row.status === "available" && !row.occupied && Number(row.orders) === 0;
}

/**
 * Re-arm a CAS-refused, never-applied table open with the table's CURRENT version — see the header.
 * Returns what happened; `rebased` is the only outcome that changes anything.
 */
export async function rebaseRefusedOpen(operationId: string, deps: RebaseDeps, actorUserId: string | null, opts: { drain?: boolean } = {}): Promise<RebaseOutcome> {
  const op = await localdb.operations.get(operationId);
  if (!isRebasableOpen(op)) return { kind: "not_applicable" };
  const o = op as OfflineOperation;
  const tableId = o.local_entity_id ?? "";
  if (!tableId) return { kind: "not_applicable" };
  let row: TableSummary | null;
  let receipt: boolean;
  try {
    receipt = await deps.hasReceipt(o.scope.tenant_id, o.client_op_id);
    row = await deps.readTable(o.scope.branch_id ?? null, tableId);
  } catch (e) {
    return { kind: "offline", message: `${REBASE_NEEDS_CONNECTION}${e instanceof Error && e.message ? ` (${e.message.slice(0, 120)})` : ""}` };
  }
  if (receipt) return { kind: "receipt_found" };
  if (!tableFreeOnServer(row)) return { kind: "table_busy", message: REBASE_TABLE_BUSY };
  const toVersion = Number((row as TableSummary).pos_entity_version);
  if (!Number.isFinite(toVersion)) return { kind: "table_busy", message: REBASE_TABLE_BUSY };
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const fromVersion = typeof p.expected_version === "number" ? p.expected_version : null;
  const at = new Date().toISOString();
  const ok = await localdb.transaction("rw", localdb.operations, async () => {
    const cur = await localdb.operations.get(operationId);
    // Compare-and-swap on everything the decision read: still parked on the same refusal, never attempted since.
    if (!cur || !isCasRefusedOpen(cur) || cur.retry_count !== o.retry_count || cur.last_error_message !== o.last_error_message || cur.client_op_id !== o.client_op_id) return false;
    const { version_after_op: prevAfter, ...rest } = (cur.payload ?? {}) as Record<string, unknown>;
    await localdb.operations.update(operationId, {
      payload: { ...rest, expected_version: toVersion },
      status: "pending",
      last_error_code: null,
      last_error_message: null,
      server_retry_count: 0,
      rebases: [
        ...(cur.rebases ?? []),
        {
          at,
          by_user_id: actorUserId,
          from_version: fromVersion,
          from_version_after_op: typeof prevAfter === "string" ? prevAfter : null,
          to_version: toVersion,
          refusal: cur.last_error_message,
          verified_against: ["pos_table_map", "pos_op_submissions"],
        },
      ],
    });
    return true;
  });
  if (!ok) return { kind: "stale", message: REBASE_STALE };
  await requeueDependents([operationId]).catch(() => undefined);
  if (opts.drain !== false) requestDrain("operator-retry");
  return { kind: "rebased", fromVersion, toVersion };
}

/** Live deps over the app's Supabase client. Read-only: pos_table_map + one RLS read of pos_op_submissions. */
export const liveRebaseDeps: RebaseDeps = {
  async readTable(branchId, tableId) {
    const { loadTableMap } = await import("@/lib/pos/tables");
    const map = await loadTableMap(branchId);
    return map.tables.find((t) => t.id === tableId) ?? null;
  },
  async hasReceipt(tenantId, clientOpId) {
    const { supabase } = await import("@/lib/supabase");
    const db = supabase as unknown as {
      from(t: string): { select(c: string): { eq(k: string, v: string): { eq(k: string, v: string): PromiseLike<{ data: unknown; error: { message?: string } | null }> } } };
    };
    const r = await db.from("pos_op_submissions").select("client_op_id").eq("tenant_id", tenantId).eq("client_op_id", clientOpId);
    if (r.error) throw new Error(r.error.message ?? "receipt check failed");
    if (!Array.isArray(r.data)) throw new Error("receipt check: no rows array");
    return r.data.length > 0;
  },
};
