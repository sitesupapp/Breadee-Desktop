// 1.0.42 (P0 2026-11-17) — OFFLINE VOID of a Takeaway / Delivery sale this device captured and NEVER sent.
//
// The one case a void can be decided on this device alone: a sale whose capture was never attempted against
// Breadee (no attempt recorded, no server order id) cannot exist on Breadee — nothing was ever sent — so voiding
// it is a local fact, not a guess. Everything is proven INSIDE the drain lock (withDrainExcluded: no replay can
// read and send it in between) and one Dexie transaction:
//   - same tenant / branch / device / cashier as the operator (never another person's capture);
//   - the operator holds pos.cancel_orders (the authority the server's void enforces);
//   - the sale row is queued, attempts 0, no last attempt, no server order id, not already withdrawn / voided;
//   - its op (if staged) is pending / blocked_dependency, retry_count 0, never attempted, no canonical id;
//   - NOTHING depends on it (an on-account receivable, item edits, a provider…) — those go online after sync.
// Then the op is CANCELLED with an append-only `withdrawal` record (reason voided_before_sync, the operator's
// void reason, the cash handed back) — a never-staged legacy row is staged directly as that cancelled op under
// its deterministic id, which the migration never resurrects. The sale row is kept (review_reason
// SALE_VOIDED_BEFORE_SYNC) and the event goes to Sync history. Nothing is deleted, nothing is marked synced,
// no server call is made. A sale that was ever attempted is refused: its fate on Breadee is unknown, so it is
// voided online once it syncs (pos_void_order), never here.

import { localdb, SALE_VOIDED_BEFORE_SYNC, SALE_WITHDRAWN, type PosOfflineTxn } from "@/lib/offline/db";
import { OPERATION_SCHEMA_VERSION, type OfflineOperation } from "@/lib/offline/operationLog";
import { withDrainExcluded } from "@/lib/offline/orchestrator";
import { appendHistory } from "@/lib/offline/syncHistory";

export const VOID_LOCAL_PERMISSION = "pos.cancel_orders";

export const VOID_LOCAL_NOT_ALLOWED = "You do not have permission to void orders (pos.cancel_orders).";
export const VOID_LOCAL_NOT_YOURS = "Only the cashier who took this sale on this terminal can void it before it syncs.";
export const VOID_LOCAL_ALREADY_SENT =
  "This sale was already sent to Breadee (or a send was attempted), so it cannot be voided on this device. Void it once it shows its Breadee number. Don't hand back or collect any money twice.";
export const VOID_LOCAL_HAS_DEPENDENTS =
  "Other steps recorded on this terminal depend on this sale (on account, item changes or delivery details). Void it once it has synced.";
export const VOID_LOCAL_BUSY = "Breadee is syncing this terminal right now. Try the void again in a moment — nothing was changed.";
export const VOID_LOCAL_NOT_FOUND = "This sale is no longer on this device as an unsent order.";
export const VOID_LOCAL_REASON_REQUIRED = "Enter the reason for the void.";

export type VoidLocalResult =
  | { ok: true; operationId: string; cashReturned: number | null; currency: string | null }
  | { ok: false; reason: string };

class Refused extends Error {
  reasonText: string;
  constructor(reasonText: string) {
    super(reasonText);
    this.reasonText = reasonText;
  }
}

const txnOpId = (localTxnId: string) => `mig:txn:${localTxnId}`;

/** PURE — never attempted against Breadee: a send leaves an attempt count, a last attempt or a server id. */
export function neverSentTxn(t: PosOfflineTxn | undefined): boolean {
  return !!t && t.status === "queued" && (t.attempts ?? 0) === 0 && !t.last_attempt_at && !t.server_order_id && t.review_reason !== SALE_WITHDRAWN && t.review_reason !== SALE_VOIDED_BEFORE_SYNC;
}

/** PURE — the staged op was never handed to a handler. */
export function neverSentOp(o: OfflineOperation | undefined): boolean {
  return !!o && (o.status === "pending" || o.status === "blocked_dependency") && (o.retry_count ?? 0) === 0 && !o.last_attempt_at && !o.canonical_entity_id;
}

export async function voidUnsyncedLocalSale(input: {
  localTxnId: string;
  scope: { tenantId: string; branchId: string | null; deviceId: string; cashierUserId: string };
  actorUserId: string;
  /** canCancelOrders(pos.access) — the same authority the online void requires. */
  authorized: boolean;
  reason: string;
}): Promise<VoidLocalResult> {
  if (!input.authorized) return { ok: false, reason: VOID_LOCAL_NOT_ALLOWED };
  const why = input.reason.trim();
  if (why === "") return { ok: false, reason: VOID_LOCAL_REASON_REQUIRED };
  const opId = txnOpId(input.localTxnId);
  const at = new Date().toISOString();

  const outcome = await withDrainExcluded(async () => {
    try {
      return await localdb.transaction("rw", localdb.operations, localdb.posOfflineTxns, async () => {
        const t = await localdb.posOfflineTxns.get(input.localTxnId);
        if (!t) throw new Refused(VOID_LOCAL_NOT_FOUND);
        if (
          t.tenant_id !== input.scope.tenantId ||
          (t.branch_id ?? null) !== (input.scope.branchId ?? null) ||
          t.device_id !== input.scope.deviceId ||
          t.cashier_user_id !== input.actorUserId ||
          input.actorUserId !== input.scope.cashierUserId
        ) {
          throw new Refused(VOID_LOCAL_NOT_YOURS);
        }
        if (!neverSentTxn(t)) throw new Refused(VOID_LOCAL_ALREADY_SENT);
        const op = await localdb.operations.get(opId);
        if (op && !neverSentOp(op)) throw new Refused(VOID_LOCAL_ALREADY_SENT);
        // Anything chained behind this sale (on-account, edits, provider, a merge…) — never orphaned by a local void.
        const dependents = await localdb.operations
          .filter((o) => o.status !== "cancelled" && o.operation_id !== opId && ((o.dependency_ids ?? []).includes(opId) || (o.depends_on_local_entities ?? []).includes(input.localTxnId)))
          .count();
        if (dependents > 0) throw new Refused(VOID_LOCAL_HAS_DEPENDENTS);

        const cashReturned = t.payment_intent && typeof t.total === "number" ? t.total : null;
        const withdrawal = {
          at,
          by_user_id: input.actorUserId,
          reason: "voided_before_sync" as const,
          verified_at: at,
          verified_against: ["local:never_attempted", "local:drain_excluded", "local:no_dependents", `authority:${VOID_LOCAL_PERMISSION}`],
          void_reason: why,
          cash_returned: cashReturned,
        };
        if (op) {
          await localdb.operations.update(opId, { status: "cancelled", withdrawal });
        } else {
          // Never staged: stage it directly as the cancelled op (same deterministic id) — the migration skips an
          // existing op and never resurrects a cancelled one, so this sale can never be sent later.
          const staged: OfflineOperation = {
            operation_id: opId,
            operation_type: "takeaway_sale",
            schema_version: OPERATION_SCHEMA_VERSION,
            scope: { tenant_id: t.tenant_id, branch_id: t.branch_id, device_id: t.device_id, terminal_id: t.terminal_id, cashier_user_id: t.cashier_user_id },
            created_at: t.created_at,
            client_op_id: t.client_op_id,
            local_entity_id: t.local_txn_id,
            canonical_entity_id: null,
            dependency_ids: [],
            depends_on_local_entities: [],
            payload: { order_payload: t.order_payload, payment_intent: t.payment_intent, paid: t.paid === true, local_total: t.total ?? null, local_currency: t.currency ?? null },
            status: "cancelled",
            retry_count: 0,
            last_attempt_at: null,
            last_error_code: null,
            last_error_message: null,
            result_meta: null,
            synced_at: null,
            withdrawal,
          } as OfflineOperation;
          await localdb.operations.add(staged);
        }
        await localdb.posOfflineTxns.update(input.localTxnId, { review_reason: SALE_VOIDED_BEFORE_SYNC });
        return { ok: true as const, operationId: opId, cashReturned, currency: t.currency ?? null, scope: t };
      });
    } catch (e) {
      if (e instanceof Refused) return { ok: false as const, reason: e.reasonText };
      throw e;
    }
  });

  if (outcome === "busy") return { ok: false, reason: VOID_LOCAL_BUSY };
  if (!outcome.ok) return outcome;
  const t = outcome.scope;
  await appendHistory({
    at,
    operation_id: outcome.operationId,
    operation_type: "takeaway_sale",
    action_label: outcome.cashReturned != null ? "Takeaway sale voided before sync (cash handed back)" : "Takeaway sale voided before sync",
    tenant_id: t.tenant_id,
    branch_id: t.branch_id,
    device_id: t.device_id,
    cashier_user_id: t.cashier_user_id,
    local_ref: t.local_txn_id,
    canonical_ref: null,
    status: "cancelled",
    retry_count: 0,
    error_summary: `voided on this terminal before it was ever sent — reason: ${why.slice(0, 120)}${outcome.cashReturned != null ? ` · cash handed back: ${outcome.cashReturned} ${outcome.currency ?? ""}`.trimEnd() : ""}`,
    synced_at: null,
  });
  return { ok: true, operationId: outcome.operationId, cashReturned: outcome.cashReturned, currency: outcome.currency };
}
