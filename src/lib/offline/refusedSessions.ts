// 1.0.39 (L4/1) — local Dine-In sessions the server REFUSED before any of them was applied.
//
// The Hush #2124 L4/1 incident: an offline "open table" captured by 1.0.37 replayed into the server's
// table-version CAS (pos_open_table_core → VERSION_CONFLICT, no write) and its round was parked behind it
// (dependency_failed, never sent). Through 1.0.38 that session stayed `open` forever (sessionClosure never
// retires a session with parked work), its round stayed in the projection, and the ONLINE floor showed the
// table occupied with a bill the server never had — "No open bill" and "already has an open bill" at once,
// with Close / Clear succeeding on the server and changing nothing on screen.
//
// What this module does — and does not do:
//   - `reconcileRefusedSessions` moves a session to `refused` ONLY on the op-log proof in
//     operationalProjection.sessionRefusal, and back to `open` the moment that proof stops holding (an
//     operator "Try again" re-queued its open). It never touches an operation: they stay parked and visible
//     in the Sync Center exactly as the server left them (Conflict / Needs attention).
//   - A `refused` session is never the table's bill (every "open session" read skips it), so the floor shows
//     the server's truth and a legitimate server bill is never inflated by it.
//   - It is NOT treated as finished: its round may have been printed and served. `listRefusedSessions` feeds
//     the Sync Center review; nothing is withdrawn automatically.
//   - `withdrawRefusedSession` is the ONE write, and only on an explicit operator action: it re-proves the
//     refusal from durable state, asks the SERVER for a receipt of every op's client_op_id (pos_op_submissions
//     for the open, pos_order_submissions for the rounds — both written in the same transaction as the apply,
//     both tenant-readable), and only when Breadee holds none cancels the ops (kept, with the refusal and a
//     `withdrawal` audit) and marks the session `withdrawn`. Any receipt, any read failure → nothing changes.

import { localdb, type DineDraft } from "@/lib/offline/db";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { appendHistory } from "@/lib/offline/syncHistory";
import { opInScope, sessionRefusal } from "@/lib/offline/operationalProjection";

type Scope = {
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
  deviceId: string | null;
  terminalId?: string | null;
};

const draftScope = (d: DineDraft) => ({
  tenantId: d.tenant_id,
  branchId: d.branch_id,
  cashierUserId: d.cashier_user_id,
  deviceId: d.device_id,
  terminalId: d.terminal_id ?? null,
});

function inScope(d: DineDraft, s: Scope): boolean {
  return (
    d.tenant_id === s.tenantId &&
    (d.branch_id ?? null) === (s.branchId ?? null) &&
    d.cashier_user_id === s.cashierUserId &&
    d.device_id === s.deviceId &&
    (s.terminalId == null || (d.terminal_id ?? null) === s.terminalId)
  );
}

/**
 * Re-derive every open / refused session's refusal state from the durable op log, in ONE Dexie transaction.
 * open → refused when sessionRefusal proves it; refused → open when it no longer does. Called after every
 * drain (reconcileDineDraftsFromOperations) and before a capture picks a table's session.
 */
export async function reconcileRefusedSessions(only?: { tenantId: string | null; branchId: string | null; tableId?: string | null }): Promise<{ refused: string[]; reopened: string[] }> {
  if (only && !only.tenantId) return { refused: [], reopened: [] };
  return localdb.transaction("rw", localdb.dineDrafts, localdb.operations, async () => {
    const drafts = (await localdb.dineDrafts.where("status").anyOf("open", "refused").toArray()).filter(
      (d) => !only || (d.tenant_id === only.tenantId && (d.branch_id ?? null) === (only.branchId ?? null) && (!only.tableId || d.table_id === only.tableId)),
    );
    const out = { refused: [] as string[], reopened: [] as string[] };
    if (drafts.length === 0) return out;
    const all = await localdb.operations.toArray();
    for (const d of drafts) {
      const ev = sessionRefusal(d, all.filter((o) => opInScope(o, draftScope(d))));
      const now = new Date().toISOString();
      if (d.status === "open" && ev) {
        await localdb.dineDrafts.update(d.local_session_id, { status: "refused", closed_reason: "open_refused_unapplied", closed_evidence_op_id: ev.openOpId, closed_at: now, updated_at: now });
        out.refused.push(d.local_session_id);
      } else if (d.status === "refused" && !ev) {
        await localdb.dineDrafts.update(d.local_session_id, { status: "open", closed_reason: null, closed_evidence_op_id: null, closed_at: null, updated_at: now });
        out.reopened.push(d.local_session_id);
      }
    }
    return out;
  });
}

/** One refused offline order, as the Sync Center review shows it. Display figures only — never authority. */
export type RefusedOrderSummary = {
  sessionId: string;
  tableId: string;
  tableName: string;
  currency: string;
  capturedAt: string;
  /** Item count and captured value of the rounds that never reached Breadee. */
  items: number;
  total: number;
  rounds: number;
  /** A kitchen ticket was printed for at least one of its rounds on this device (it may have been served). */
  kitchenPrinted: boolean;
  refusal: string;
  openOpId: string;
  workOpIds: string[];
};

/** This scope's refused sessions with their review figures, newest first. Read-only. */
export async function listRefusedSessions(scope: Scope): Promise<RefusedOrderSummary[]> {
  if (!scope.tenantId || !scope.cashierUserId || !scope.deviceId) return [];
  const drafts = (await localdb.dineDrafts.where("[tenant_id+status]").equals([scope.tenantId, "refused"]).toArray()).filter((d) => inScope(d, scope));
  if (drafts.length === 0) return [];
  const all = await localdb.operations.toArray();
  const out: RefusedOrderSummary[] = [];
  for (const d of drafts) {
    const ev = sessionRefusal(d, all.filter((o) => opInScope(o, draftScope(d))));
    if (!ev) continue; // re-derived on the next reconcile; never shown as refusable without its proof
    const sent = d.lines.filter((l) => l.sent_round !== null);
    out.push({
      sessionId: d.local_session_id,
      tableId: d.table_id,
      tableName: d.table_name,
      currency: d.currency,
      capturedAt: d.created_at,
      items: sent.reduce((n, l) => n + (Number(l.quantity) || 0), 0),
      total: sent.reduce((s, l) => s + ((Number(l.base_price) || 0) + (l.modifiers ?? []).reduce((m, x) => m + (Number(x.price_delta) || 0) * (Number(x.quantity) || 1), 0)) * (Number(l.quantity) || 0), 0),
      rounds: d.rounds.length,
      kitchenPrinted: d.rounds.some((r) => r.print_state === "printed"),
      refusal: ev.refusal,
      openOpId: ev.openOpId,
      workOpIds: ev.workOpIds,
    });
  }
  return out.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/** The server receipt check: every client_op_id Breadee holds a receipt for (empty = none was applied). */
export type ReceiptCheck = (input: { tenantId: string; openClientOpIds: string[]; roundClientOpIds: string[] }) => Promise<string[]>;

/** Live receipt check against the two receipt tables (tenant RLS; read-only). Throws on any read failure. */
type ReceiptQuery = {
  select(c: string): { eq(k: string, v: string): { in(k: string, v: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }> } };
};

export const verifyNoServerReceipts: ReceiptCheck = async ({ tenantId, openClientOpIds, roundClientOpIds }) => {
  const { supabase } = await import("@/lib/supabase");
  // The receipt tables are not in the generated types; read them untyped (RLS: tenant + branch access).
  const db = supabase as unknown as { from(t: string): ReceiptQuery };
  const found: string[] = [];
  const read = async (table: string, ids: string[]) => {
    if (ids.length === 0) return;
    const { data, error } = await db.from(table).select("client_op_id").eq("tenant_id", tenantId).in("client_op_id", ids);
    if (error) throw new Error(error.message);
    for (const r of (Array.isArray(data) ? data : []) as { client_op_id: string }[]) found.push(r.client_op_id);
  };
  await read("pos_op_submissions", openClientOpIds);
  await read("pos_order_submissions", roundClientOpIds);
  return found;
};

export const WITHDRAW_NEEDS_CONNECTION =
  "Withdrawing needs a connection to Breadee, to confirm nothing of this order was applied. Try again when this terminal is online.";
export const WITHDRAW_RECEIPT_FOUND =
  "Breadee holds a record of part of this order, so it cannot be withdrawn here. Keep it and contact support with the Sync Center diagnostics.";
export const WITHDRAW_STATE_CHANGED = "This order's sync state changed while it was being reviewed. Review it again.";
export const WITHDRAW_NOT_YOURS = "Only the cashier who captured this order, on this terminal, can withdraw it.";

class StaleWithdrawal extends Error {}

/**
 * Withdraw a refused, never-applied session — an explicit operator action, never automatic.
 * Order: re-prove the refusal from durable state → server receipt check (no receipt for ANY op) → one Dexie
 * transaction that re-checks nothing changed (compare-and-swap on every op's status / error / attempt count)
 * and only then cancels the ops (keeping their refusal + a `withdrawal` audit) and marks the session
 * `withdrawn`. Nothing is sent to the server, printed, charged, posted or deducted.
 */
export async function withdrawRefusedSession(input: {
  sessionId: string;
  scope: Scope;
  actorUserId: string;
  checkReceipts?: ReceiptCheck;
}): Promise<{ ok: true; withdrawn: string[] } | { ok: false; reason: string }> {
  const d = await localdb.dineDrafts.get(input.sessionId);
  if (!d || d.status !== "refused") return { ok: false, reason: WITHDRAW_STATE_CHANGED };
  if (!inScope(d, input.scope) || input.actorUserId !== d.cashier_user_id) return { ok: false, reason: WITHDRAW_NOT_YOURS };
  const scoped = (await localdb.operations.toArray()).filter((o) => opInScope(o, draftScope(d)));
  const ev = sessionRefusal(d, scoped);
  if (!ev) return { ok: false, reason: WITHDRAW_STATE_CHANGED };
  const work = ev.workOpIds.map((id) => scoped.find((o) => o.operation_id === id) as OfflineOperation);

  let receipts: string[];
  try {
    receipts = await (input.checkReceipts ?? verifyNoServerReceipts)({
      tenantId: d.tenant_id,
      openClientOpIds: work.filter((o) => o.operation_type === "dinein_open_table").map((o) => o.client_op_id),
      roundClientOpIds: work.filter((o) => o.operation_type !== "dinein_open_table").map((o) => o.client_op_id),
    });
  } catch {
    return { ok: false, reason: WITHDRAW_NEEDS_CONNECTION };
  }
  if (receipts.length > 0) return { ok: false, reason: WITHDRAW_RECEIPT_FOUND };

  const at = new Date().toISOString();
  try {
    await localdb.transaction("rw", localdb.dineDrafts, localdb.operations, async () => {
      const cur = await localdb.dineDrafts.get(input.sessionId);
      if (!cur || cur.status !== "refused") throw new StaleWithdrawal();
      const curOps = await localdb.operations.bulkGet(ev.workOpIds);
      curOps.forEach((o, i) => {
        const was = work[i];
        if (!o || o.status !== was.status || o.last_error_code !== was.last_error_code || o.retry_count !== was.retry_count || o.canonical_entity_id !== was.canonical_entity_id) throw new StaleWithdrawal();
      });
      // The whole session must still be exactly what was verified (no op added or synced meanwhile).
      const again = sessionRefusal(cur, (await localdb.operations.toArray()).filter((o) => opInScope(o, draftScope(cur))));
      if (!again || again.workOpIds.join() !== ev.workOpIds.join()) throw new StaleWithdrawal();
      for (const o of work) {
        await localdb.operations.update(o.operation_id, {
          status: "cancelled",
          withdrawal: { at, by_user_id: input.actorUserId, reason: "refused_never_applied", verified_at: at, verified_against: o.operation_type === "dinein_open_table" ? ["pos_op_submissions"] : ["pos_order_submissions"] },
        });
      }
      await localdb.dineDrafts.update(input.sessionId, { status: "withdrawn", closed_reason: "refused_withdrawn", withdrawn_at: at, withdrawn_by: input.actorUserId, updated_at: at });
    });
  } catch (e) {
    if (e instanceof StaleWithdrawal) return { ok: false, reason: WITHDRAW_STATE_CHANGED };
    throw e;
  }
  for (const o of work) {
    await appendHistory({
      at,
      operation_id: o.operation_id,
      operation_type: o.operation_type,
      action_label: o.operation_type === "dinein_open_table" ? "Open table" : "Send round",
      tenant_id: o.scope.tenant_id,
      branch_id: o.scope.branch_id,
      device_id: o.scope.device_id,
      cashier_user_id: o.scope.cashier_user_id,
      local_ref: o.local_entity_id,
      canonical_ref: null,
      status: "cancelled",
      retry_count: o.retry_count,
      error_summary: "withdrawn by the operator — Breadee confirmed it was never applied",
      synced_at: null,
    });
  }
  return { ok: true, withdrawn: ev.workOpIds };
}
