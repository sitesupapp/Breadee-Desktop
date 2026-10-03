// Phase B1 (staging fast-track) - offline Takeaway + Cash replay engine.
//
// Replays offline-ORIGINATED sales (see `PosOfflineTxn`) against the SAME canonical
// server path an online sale uses: `pos_submit_order` then `pos_pay_order`. It adds
// no new server contract and performs no speculative writes.
//
// EXACTLY-ONCE is inherited from the production server, proven by reading the live
// RPCs:
//   * `pos_submit_order` dedups on `client_op_id` (advisory-locked, replays the
//     stored result) - a replayed order never creates a second order/item/
//     inventory/audit row.
//   * `pos_pay_order` raises `already paid` BEFORE inserting any payment row or
//     posting finance - a replayed payment never duplicates cash/payment/GL. The
//     engine treats `already paid` as settled, so a retry after a lost response is
//     exactly-once WITHOUT a separate re-read: if a prior attempt charged, the
//     retry raises `already paid` (settled); if it did not, the retry charges once.
//
// SAFETY INVARIANTS:
//   * single-flight (module lock) + FIFO by capture time; no concurrent duplicate
//     replay of the same transaction.
//   * live-session guard: a transaction is replayed ONLY when the live tenant,
//     branch and cashier match the values frozen at capture. It is never replayed
//     under a different tenant/branch/cashier.
//   * terminal refusals (shift closed, permission, validation) -> `needs_attention`,
//     never a hot retry loop; the row is retained for a human, never dropped.

import { getPendingShift, listActivePendingShifts, localdb, updatePendingShift, updatePosOfflineTxn, type PosOfflineTxn } from "@/lib/offline/db";
import type { SubmitOrderPayload } from "@/lib/pos/orders";
import type { CurrencyCode } from "@/lib/currency";

export type PosTxnSyncContext = {
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
  /**
   * The live device id. Offline-opened shifts are only ever resolved/replayed when
   * they belong to THIS exact tenant+branch/OU+cashier+device, so a pending shift
   * from a sibling branch/OU, another user, or another device is never opened here.
   */
  deviceId: string | null;
  online: boolean;
};

export type PosTxnSyncReport = {
  startedAt: string;
  finishedAt: string;
  triggeredBy: string;
  synced: string[];
  needsAttention: { id: string; reason: string }[];
  retriable: string[];
  /** Skipped because they belong to a different tenant/branch/cashier than the live session. */
  deferred: string[];
  /** Offline-opened shifts opened/adopted on the server this pass (local ids). */
  shiftsSynced: string[];
  /** Offline-opened shifts parked for a human this pass. */
  shiftsNeedsAttention: { id: string; reason: string }[];
};

/** Module-level single-flight lock so auto + manual sync never run the queue twice at once. */
let syncing = false;

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/**
 * A transport-level failure (no route / connection dropped / fetch aborted): the
 * request may or may not have committed, so it is safe to RETRY (the server is
 * idempotent). Distinct from a definitive server refusal, which must not retry.
 */
export function isTransportFailure(e: unknown): boolean {
  if (e instanceof TypeError) return true; // fetch network error
  const m = errMsg(e).toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network error") ||
    m.includes("load failed") ||
    m.includes("fetch") ||
    m.includes("timeout") ||
    m.includes("aborted")
  );
}

type TerminalKind = "shift_closed" | "permission" | "validation" | null;

/** Classify a DEFINITIVE (non-transport) server refusal. Transport is handled separately. */
function terminalKind(message: string): TerminalKind {
  const m = message.toLowerCase();
  if (
    m.includes("shift is closed") ||
    m.includes("use your own open shift") ||
    m.includes("not attached to an open shift") ||
    m.includes("shift not found")
  ) {
    return "shift_closed";
  }
  if (m.includes("permission")) return "permission";
  if (
    m.includes("not enabled") ||
    m.includes("invalid") ||
    m.includes("cannot") ||
    m.includes("unsupported") ||
    m.includes("exceed") ||
    m.includes("negative")
  ) {
    return "validation";
  }
  return null;
}

function isAlreadyPaid(message: string): boolean {
  return message.toLowerCase().includes("already paid");
}

/**
 * Injectable server calls. Production uses the shipped RPC wrappers; tests pass
 * fakes to prove the exactly-once / guard / classification logic without a network.
 */
export type PosTxnSyncDeps = {
  submit: (payload: SubmitOrderPayload) => Promise<{ order_id: string; order_number: string }>;
  pay: (args: { orderId: string; currency: CurrencyCode; discount?: Record<string, unknown> }) => Promise<unknown>;
  /** Open (or adopt) the shift for an offline-opened Case-2 shift, exactly once. */
  openShift: (args: { branchId: string | null; openingCash: number; clientOpId: string }) => Promise<{ shiftId: string; reused: boolean }>;
  isTransport: (e: unknown) => boolean;
  hasSession: () => Promise<boolean>;
};

const defaultDeps: PosTxnSyncDeps = {
  // The network modules are imported LAZILY (they transitively load the Supabase
  // client / Vite env). Tests inject their own deps and never reach these, so the
  // module graph stays importable without a browser env.
  submit: async (payload) => {
    const { submitOrder } = await import("@/lib/pos/orders");
    const saved = await submitOrder(payload);
    return { order_id: saved.order_id, order_number: saved.order_number };
  },
  pay: async (args) => {
    const { payOrder } = await import("@/lib/pos/payments");
    return payOrder({ orderId: args.orderId, method: "cash", currency: args.currency, discount: args.discount });
  },
  openShift: async (args) => {
    const { openShiftWithOp } = await import("@/lib/pos/shifts");
    return openShiftWithOp(args);
  },
  isTransport: isTransportFailure,
  hasSession: async () => {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.auth.getSession();
    return Boolean(data.session);
  },
};

/** Replay ONE transaction. Mutates its row to the resulting state. */
async function replayOne(t: PosOfflineTxn, report: PosTxnSyncReport, d: PosTxnSyncDeps): Promise<void> {
  // --- 1. Order (idempotent on client_op_id) ---------------------------------
  let orderId = t.server_order_id ?? null;
  if (!orderId) {
    try {
      const saved = await d.submit(t.order_payload as SubmitOrderPayload);
      orderId = saved.order_id;
      await updatePosOfflineTxn(t.local_txn_id, {
        server_order_id: saved.order_id,
        server_order_number: saved.order_number,
      });
    } catch (e) {
      if (d.isTransport(e)) {
        // May or may not have committed. Re-submit later is safe (idempotent).
        await updatePosOfflineTxn(t.local_txn_id, { status: "queued", last_error: "order: transport" });
        report.retriable.push(t.local_txn_id);
        return;
      }
      const kind = terminalKind(errMsg(e));
      await updatePosOfflineTxn(t.local_txn_id, {
        status: "needs_attention",
        review_reason: kind ?? "order_failed",
        last_error: errMsg(e),
      });
      report.needsAttention.push({ id: t.local_txn_id, reason: kind ?? "order_failed" });
      return;
    }
  }

  // Defensive: never attempt payment without a concrete order id.
  if (!orderId) {
    await updatePosOfflineTxn(t.local_txn_id, { status: "queued", last_error: "order: no id" });
    report.retriable.push(t.local_txn_id);
    return;
  }

  // --- 2. Cash payment (state-based `already paid` dedup) ---------------------
  // Only when a payment intent exists. A "sent to kitchen" transaction with no
  // payment yet syncs as an unpaid order (exactly what an online Send produces);
  // a later Pay on the SAME client_op_id fills the intent so this branch runs.
  if (t.payment_intent && !t.paid) {
    try {
      await d.pay({
        orderId,
        currency: (t.payment_intent.currency as CurrencyCode) ?? "USD",
        discount: t.payment_intent.discount,
      });
      await updatePosOfflineTxn(t.local_txn_id, { paid: true });
    } catch (e) {
      const msg = errMsg(e);
      if (isAlreadyPaid(msg)) {
        // The server already holds a settled payment for this order (a prior
        // attempt landed). Definitively settled - never charge again.
        await updatePosOfflineTxn(t.local_txn_id, { paid: true });
      } else if (d.isTransport(e)) {
        // Unknown whether it charged. Keep queued; a retry either charges once or
        // gets `already paid` above - exactly-once either way.
        await updatePosOfflineTxn(t.local_txn_id, { status: "queued", last_error: "payment: transport" });
        report.retriable.push(t.local_txn_id);
        return;
      } else {
        const kind = terminalKind(msg);
        await updatePosOfflineTxn(t.local_txn_id, {
          status: "needs_attention",
          review_reason: kind ?? "payment_failed",
          last_error: msg,
        });
        report.needsAttention.push({ id: t.local_txn_id, reason: kind ?? "payment_failed" });
        return;
      }
    }
  }

  // --- 3. Both halves confirmed ---------------------------------------------
  await updatePosOfflineTxn(t.local_txn_id, { status: "synced", last_error: null, review_reason: null });
  report.synced.push(t.local_txn_id);
}

/** Outcome of resolving a pending offline-opened shift to a canonical server id. */
type ShiftResolution =
  | { ok: true; serverShiftId: string }
  | { ok: false; retriable: boolean; reason: string };

/**
 * Open (or adopt) the canonical server shift for a shift that was opened offline,
 * EXACTLY ONCE. Idempotent on two independent axes:
 *   * if we already recorded a `server_shift_id`, reuse it (no second open);
 *   * otherwise `openShift` carries the pending shift's `client_op_id`, so the server
 *     front-door dedups a retry AND its single-open rule adopts any shift already
 *     open for this cashier (e.g. opened on another device while this one was offline).
 * A transport failure is retriable; a definitive refusal (permission, prior shift
 * awaiting approval, branch access) parks the pending shift for a human.
 */
async function resolvePendingShiftCanonical(
  localShiftId: string,
  ctx: PosTxnSyncContext,
  d: PosTxnSyncDeps,
): Promise<ShiftResolution> {
  const p = await getPendingShift(localShiftId);
  if (!p) return { ok: false, retriable: false, reason: "shift_missing" };
  // Isolation FIRST, before ANY successful return (including the already-synced
  // fast path below): never resolve a pending shift that is not for THIS exact live
  // context (tenant + branch/OU + cashier + device). A shift's canonical id must
  // never leak into another context's replay, even one already opened on the server.
  if (
    p.tenant_id !== ctx.tenantId ||
    (p.branch_id ?? null) !== (ctx.branchId ?? null) ||
    p.cashier_user_id !== ctx.cashierUserId ||
    p.device_id !== ctx.deviceId
  ) {
    return { ok: false, retriable: false, reason: "shift_scope_mismatch" };
  }
  // Already opened on the server this/a prior pass: reuse its canonical id (no second
  // open). Reached only after the scope check above has confirmed it is ours.
  if (p.status === "synced" && p.server_shift_id) return { ok: true, serverShiftId: p.server_shift_id };
  // A shift already definitively refused (needs_attention) must NOT be re-opened
  // automatically; it awaits explicit human reconciliation.
  if (p.status === "needs_attention") {
    return { ok: false, retriable: false, reason: p.review_reason ?? "needs_attention" };
  }
  try {
    const { shiftId } = await d.openShift({
      branchId: p.branch_id,
      openingCash: p.opening_cash_amount,
      clientOpId: p.client_op_id,
    });
    await updatePendingShift(localShiftId, {
      status: "synced",
      server_shift_id: shiftId,
      attempts: (p.attempts ?? 0) + 1,
      last_error: null,
      review_reason: null,
    });
    return { ok: true, serverShiftId: shiftId };
  } catch (e) {
    if (d.isTransport(e)) {
      await updatePendingShift(localShiftId, { attempts: (p.attempts ?? 0) + 1, last_error: "open: transport" });
      return { ok: false, retriable: true, reason: "shift_open_transport" };
    }
    const kind = terminalKind(errMsg(e)) ?? "shift_open_failed";
    await updatePendingShift(localShiftId, {
      status: "needs_attention",
      review_reason: kind,
      last_error: errMsg(e),
      attempts: (p.attempts ?? 0) + 1,
    });
    return { ok: false, retriable: false, reason: kind };
  }
}

/**
 * Replay all queued offline sales that belong to the LIVE session. Safe to call on
 * reconnect, on POS mount, and from the Sync Center button - single-flight protects
 * against overlap. Returns a structured report.
 */
export async function syncPosTxns(
  ctx: PosTxnSyncContext,
  triggeredBy = "auto",
  deps?: Partial<PosTxnSyncDeps>,
): Promise<PosTxnSyncReport> {
  const d: PosTxnSyncDeps = { ...defaultDeps, ...deps };
  const report: PosTxnSyncReport = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    triggeredBy,
    synced: [],
    needsAttention: [],
    retriable: [],
    deferred: [],
    shiftsSynced: [],
    shiftsNeedsAttention: [],
  };

  // Treat as offline ONLY when the browser explicitly says so. In non-browser
  // runtimes (tests) navigator.onLine is undefined and must not block replay.
  const netOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (syncing) return report;
  if (!ctx.online || netOffline) return report;
  if (!ctx.tenantId || !ctx.cashierUserId) return report;

  // No offline bypass: confirm a live authenticated session before replaying.
  if (!(await d.hasSession())) return report;

  syncing = true;
  // Resolve each referenced pending shift at most once per pass (open-exactly-once).
  const shiftResolutions = new Map<string, ShiftResolution>();
  try {
    // Reconnect reconcile: open EVERY in-scope offline-opened shift exactly once,
    // independent of whether a sale depends on it. A shift opened offline with no
    // order must still be opened on the server on reconnect (and the result cached so
    // the dependent-order loop below reuses it). Scope-filtered to this exact
    // tenant+branch/OU+cashier+device, pending_sync only.
    const scopedPending = await listActivePendingShifts(
      ctx.tenantId,
      ctx.cashierUserId,
      ctx.branchId,
      ctx.deviceId,
    );
    for (const p of scopedPending) {
      const r = await resolvePendingShiftCanonical(p.local_shift_id, ctx, d);
      shiftResolutions.set(p.local_shift_id, r);
      if (r.ok) report.shiftsSynced.push(p.local_shift_id);
      else if (!r.retriable) report.shiftsNeedsAttention.push({ id: p.local_shift_id, reason: r.reason });
    }

    // FIFO by capture time. Only queued work is replayed; `needs_attention`
    // requires an explicit operator retry (handled by requeueForAttention).
    const txns = (await localdb.posOfflineTxns.where("status").anyOf("queued", "syncing").toArray()).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    for (const t of txns) {
      // Live-session guard - never replay another context's queue.
      if (
        t.tenant_id !== ctx.tenantId ||
        (t.branch_id ?? null) !== (ctx.branchId ?? null) ||
        t.cashier_user_id !== ctx.cashierUserId
      ) {
        report.deferred.push(t.local_txn_id);
        continue;
      }

      // Dependency (Phase F): a sale captured against an OFFLINE-opened shift must
      // first have that shift opened on the server, then its frozen `shift_id`
      // remapped to the canonical id - BEFORE the order is submitted.
      let txn = t;
      if (t.pending_shift_local_id) {
        const localId = t.pending_shift_local_id;
        let r = shiftResolutions.get(localId);
        if (!r) {
          r = await resolvePendingShiftCanonical(localId, ctx, d);
          shiftResolutions.set(localId, r);
        }
        if (!r.ok) {
          if (r.retriable) {
            await updatePosOfflineTxn(t.local_txn_id, { status: "queued", last_error: "shift: " + r.reason });
            report.retriable.push(t.local_txn_id);
          } else {
            await updatePosOfflineTxn(t.local_txn_id, {
              status: "needs_attention",
              review_reason: r.reason,
              last_error: "shift: " + r.reason,
            });
            report.needsAttention.push({ id: t.local_txn_id, reason: r.reason });
          }
          continue;
        }
        // Remap the frozen payload's shift_id to the canonical server shift, durably
        // (so any later retry carries the real id and never re-reads the local one).
        const remapped = { ...(t.order_payload as SubmitOrderPayload), shift_id: r.serverShiftId };
        await updatePosOfflineTxn(t.local_txn_id, {
          order_payload: remapped,
          shift_id: r.serverShiftId,
          pending_shift_local_id: null,
        });
        txn = { ...t, order_payload: remapped, shift_id: r.serverShiftId, pending_shift_local_id: null };
      }

      await updatePosOfflineTxn(txn.local_txn_id, {
        status: "syncing",
        attempts: (txn.attempts ?? 0) + 1,
        last_attempt_at: new Date().toISOString(),
      });
      try {
        await replayOne({ ...txn, attempts: (txn.attempts ?? 0) + 1 }, report, d);
      } catch (e) {
        // Unexpected engine error - keep the work, never drop it.
        await updatePosOfflineTxn(txn.local_txn_id, { status: "queued", last_error: errMsg(e) });
        report.retriable.push(txn.local_txn_id);
      }
    }
  } finally {
    syncing = false;
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/** Move a `needs_attention` transaction back to `queued` for an explicit operator retry. */
export async function requeueForAttention(localTxnId: string): Promise<void> {
  await updatePosOfflineTxn(localTxnId, { status: "queued", review_reason: null, last_error: null });
}
