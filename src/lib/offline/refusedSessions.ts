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
//     `withdrawal` audit) and marks the session `withdrawn`. RLS hides rows from a caller it does not
//     authorise, so "none" counts only after the same session proved on the server that it is the signed-in
//     operator, in the order's tenant, with access to its branch and pos.cancel_orders. Any receipt, any
//     authority doubt, any read failure → nothing changes (each reported distinctly).

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
    // Hot path (runs before every capture): a live session whose open is not parked can never be refused —
    // decide that from its open op alone, and read the whole log only when some session needs the proof.
    const opens = await localdb.operations.bulkGet(drafts.map((d) => d.open_operation_id));
    if (drafts.every((d, i) => d.status === "open" && opens[i]?.status !== "needs_attention")) return out;
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

/**
 * The server receipt check's outcome. ONLY `none` permits a withdrawal. The receipt tables are read under RLS
 * (tenant = current_tenant_id() AND can_access_branch(branch_id)), and RLS answers a caller it does not
 * authorise with ZERO rows, not an error — so an empty read means "no receipt" only after the same session
 * has proved, on the server, that it would see one: a live signed-in user (the actor), the draft's tenant as
 * its current tenant, access to every branch the ops were captured in, and the cancel-orders permission.
 */
export type ReceiptOutcome =
  | { kind: "none" }
  | { kind: "found"; clientOpIds: string[] }
  | { kind: "unauthorized"; detail: string }
  | { kind: "offline"; detail: string }
  | { kind: "failed"; detail: string };

export type ReceiptCheckInput = {
  tenantId: string;
  branchIds: string[];
  actorUserId: string;
  openClientOpIds: string[];
  roundClientOpIds: string[];
};
export type ReceiptCheck = (input: ReceiptCheckInput) => Promise<ReceiptOutcome>;

/** The permission a withdrawal needs — the same authority as cancelling an order (pos.cancel_orders). */
export const WITHDRAW_PERMISSION = "pos.cancel_orders";

type PgError = { message?: string; code?: string } | null;
type PgResult = { data: unknown; error: PgError; status?: number };
/** The slice of the Supabase client the check uses (injectable for tests). */
export type ReceiptClient = {
  auth: { getUser(): PromiseLike<{ data: { user: { id: string } | null }; error: { message?: string; status?: number } | null }> };
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<PgResult>;
  from(t: string): { select(c: string): { eq(k: string, v: string): { in(k: string, v: string[]): PromiseLike<PgResult> } } };
};

const CHECK_TIMEOUT_MS = 15_000;
const TRANSPORT = /failed to fetch|networkerror|network request failed|load failed|fetch failed|timed? ?out|timeout|aborterror|econn|enotfound|socket/i;
const AUTH_CODES = new Set(["42501", "PGRST301", "PGRST302", "PGRST303"]);

class CheckFault extends Error {
  readonly kind: "unauthorized" | "offline" | "failed";
  constructor(kind: "unauthorized" | "offline" | "failed", detail: string) { super(detail); this.kind = kind; }
}

/** Classify one failed server read. Pure; exported for tests. */
export function receiptFaultKind(e: unknown, status?: number): "unauthorized" | "offline" | "failed" {
  if (e instanceof CheckFault) return e.kind;
  if (e instanceof TypeError || (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError"))) return "offline";
  const code = e && typeof e === "object" ? String((e as { code?: unknown }).code ?? "") : "";
  const msg = e && typeof e === "object" ? String((e as { message?: unknown }).message ?? "") : String(e ?? "");
  if (AUTH_CODES.has(code) || status === 401 || status === 403 || /jwt|not signed in|no tenant context|permission denied/i.test(msg)) return "unauthorized";
  if (status === 0 || (!code && TRANSPORT.test(msg))) return "offline";
  return "failed";
}

function bounded<T>(p: PromiseLike<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new CheckFault("offline", `${what}: no answer within ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** A failed PostgREST answer → CheckFault of the right kind. */
function fault(what: string, r: PgResult): CheckFault {
  return new CheckFault(receiptFaultKind(r.error, r.status), `${what}: ${r.error?.message ?? `status ${r.status ?? "?"}`}`);
}

/** Build the live receipt check over a Supabase client. Read-only: three STABLE RPCs and two RLS reads. */
export function makeReceiptCheck(client: () => Promise<ReceiptClient>): ReceiptCheck {
  return async ({ tenantId, branchIds, actorUserId, openClientOpIds, roundClientOpIds }) => {
    try {
      const db = await client();
      // 1. Authority first. Any doubt → not "none".
      const u = await bounded(db.auth.getUser(), "sign-in check");
      if (u.error) throw new CheckFault(receiptFaultKind(u.error, u.error.status), `sign-in check: ${u.error.message ?? "refused"}`);
      if (!u.data.user) throw new CheckFault("unauthorized", "no signed-in user");
      if (u.data.user.id !== actorUserId) throw new CheckFault("unauthorized", "the signed-in user is not the operator");
      const t = await bounded(db.rpc("current_tenant_id"), "tenant check");
      if (t.error) throw fault("tenant check", t);
      if (t.data !== tenantId) throw new CheckFault("unauthorized", "this session's current tenant is not the order's tenant");
      for (const b of branchIds) {
        const a = await bounded(db.rpc("can_access_branch", { p_branch: b }), "branch check");
        if (a.error) throw fault("branch check", a);
        if (a.data !== true) throw new CheckFault("unauthorized", "no access to the order's branch");
      }
      const p = await bounded(db.rpc("pos_current_user_has_perm", { p_key: WITHDRAW_PERMISSION }), "permission check");
      if (p.error) throw fault("permission check", p);
      if (p.data !== true) throw new CheckFault("unauthorized", `missing ${WITHDRAW_PERMISSION}`);
      // 2. The receipts (written in the same transaction as any apply, never garbage-collected).
      const asked = new Set([...openClientOpIds, ...roundClientOpIds]);
      const found: string[] = [];
      const read = async (table: string, ids: string[]) => {
        if (ids.length === 0) return;
        const r = await bounded(db.from(table).select("client_op_id").eq("tenant_id", tenantId).in("client_op_id", ids), `${table} read`);
        if (r.error) throw fault(`${table} read`, r);
        if (!Array.isArray(r.data)) throw new CheckFault("failed", `${table} read: no rows array`);
        for (const row of r.data as { client_op_id?: unknown }[]) if (typeof row?.client_op_id === "string" && asked.has(row.client_op_id)) found.push(row.client_op_id);
      };
      await read("pos_op_submissions", openClientOpIds);
      await read("pos_order_submissions", roundClientOpIds);
      return found.length > 0 ? { kind: "found", clientOpIds: found } : { kind: "none" };
    } catch (e) {
      const kind = receiptFaultKind(e);
      return { kind, detail: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** Live check over the app's Supabase client. The receipt tables are not in the generated types (untyped). */
export const verifyNoServerReceipts: ReceiptCheck = makeReceiptCheck(async () => {
  const { supabase } = await import("@/lib/supabase");
  return supabase as unknown as ReceiptClient;
});

export const WITHDRAW_NEEDS_CONNECTION =
  "Withdrawing needs a connection to Breadee, to confirm nothing of this order was applied. Try again when this terminal is online.";
export const WITHDRAW_RECEIPT_FOUND =
  "Breadee holds a record of part of this order, so it cannot be withdrawn here. Keep it and contact support with the Sync Center diagnostics.";
export const WITHDRAW_STATE_CHANGED = "This order's sync state changed while it was being reviewed. Review it again.";
export const WITHDRAW_NOT_YOURS = "Only the cashier who captured this order, on this terminal, can withdraw it.";
export const WITHDRAW_NOT_AUTHORIZED =
  "Breadee could not confirm that you may withdraw this order here (sign-in, branch access, or the Cancel orders permission). Nothing was changed. Ask your manager, or contact support with the Sync Center diagnostics.";
export const WITHDRAW_CHECK_FAILED =
  "Breadee could not complete the check that nothing of this order was applied. Nothing was changed. Try again; if it keeps failing, contact support with the Sync Center diagnostics.";

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

  let outcome: ReceiptOutcome;
  try {
    outcome = await (input.checkReceipts ?? verifyNoServerReceipts)({
      tenantId: d.tenant_id,
      branchIds: [...new Set([d.branch_id, ...work.map((o) => o.scope.branch_id)].filter((b): b is string => typeof b === "string" && b.length > 0))],
      actorUserId: input.actorUserId,
      openClientOpIds: work.filter((o) => o.operation_type === "dinein_open_table").map((o) => o.client_op_id),
      roundClientOpIds: work.filter((o) => o.operation_type !== "dinein_open_table").map((o) => o.client_op_id),
    });
  } catch (e) {
    outcome = { kind: receiptFaultKind(e), detail: e instanceof Error ? e.message : String(e) };
  }
  // Only a server-authorised "no receipt for any op" withdraws. Everything else changes nothing.
  if (outcome.kind === "found") return { ok: false, reason: WITHDRAW_RECEIPT_FOUND };
  if (outcome.kind === "offline") return { ok: false, reason: WITHDRAW_NEEDS_CONNECTION };
  if (outcome.kind === "unauthorized") return { ok: false, reason: WITHDRAW_NOT_AUTHORIZED };
  if (outcome.kind !== "none") return { ok: false, reason: WITHDRAW_CHECK_FAILED };

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
          withdrawal: { at, by_user_id: input.actorUserId, reason: "refused_never_applied", verified_at: at, verified_against: [o.operation_type === "dinein_open_table" ? "pos_op_submissions" : "pos_order_submissions", `authority:${WITHDRAW_PERMISSION}`] },
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
