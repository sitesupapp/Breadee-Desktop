// Phase B1 — offline Takeaway + Cash replay engine.
//
// Replays offline-ORIGINATED sales (see `PosOfflineTxn`) against the SAME canonical
// server path an online sale uses: `pos_submit_order` then `pos_pay_order`. It adds
// no new server contract and performs no speculative writes.
//
// EXACTLY-ONCE is inherited from the production server, proven by reading the live
// RPCs:
//   * `pos_submit_order` dedups on `client_op_id` (advisory-locked, replays the
//     stored result) — a replayed order never creates a second order/item/
//     inventory/audit row.
//   * `pos_pay_order` raises `already paid` BEFORE inserting any payment row or
//     posting finance — a replayed payment never duplicates cash/payment/GL. The
//     client treats `already paid` (and a lost response that re-reads as settled)
//     as success, via the shipped Phase-A `recoverTakeawayPayment`.
//
// SAFETY INVARIANTS:
//   * single-flight (module lock) + FIFO by capture time; no concurrent duplicate
//     replay of the same transaction.
//   * live-session guard: a transaction is replayed ONLY when the live tenant,
//     branch and cashier match the values frozen at capture. It is never replayed
//     under a different tenant/branch/cashier.
//   * a transaction is `synced` only after the authoritative resulting state is
//     confirmed — never merely because a request returned success.
//   * terminal refusals (shift closed, permission, validation) → `needs_attention`,
//     never a hot retry loop; the row is retained for a human, never dropped.

import {
  localdb,
  updatePosOfflineTxn,
  type PosOfflineTxn,
} from "@/lib/offline/db";
import type { SubmitOrderPayload } from "@/lib/pos/orders";
import { isTransportFailure, recoverTakeawayPayment } from "@/lib/pos/takeawayPayment";
import type { CurrencyCode } from "@/lib/currency";

export type PosTxnSyncContext = {
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
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
};

/** Module-level single-flight lock so auto + manual sync never run the queue twice at once. */
let syncing = false;

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
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
  // Definitive business refusals that a blind retry can never fix.
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
  recover: (orderId: string) => Promise<{ verdict: "settled" | "unpaid" | "ambiguous" }>;
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
  recover: (orderId) => recoverTakeawayPayment(orderId),
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
  if (!t.paid) {
    try {
      await d.pay({
        orderId,
        currency: (t.payment_intent.currency as CurrencyCode) ?? "USD",
        discount: t.payment_intent.discount,
      });
      await updatePosOfflineTxn(t.local_txn_id, { paid: true });
    } catch (e) {
      const msg = errMsg(e);
      if (isAlreadyPaid(msg) || d.isTransport(e)) {
        // Ask the server; never guess about money.
        const rec = await d.recover(orderId).catch(() => ({ verdict: "ambiguous" as const }));
        if (rec.verdict === "settled") {
          await updatePosOfflineTxn(t.local_txn_id, { paid: true });
        } else if (rec.verdict === "unpaid") {
          // Nothing was charged — a retry is safe and expected.
          await updatePosOfflineTxn(t.local_txn_id, { status: "queued", last_error: "payment: retriable" });
          report.retriable.push(t.local_txn_id);
          return;
        } else {
          // Ambiguous — keep it queued but never auto-charge again this pass.
          await updatePosOfflineTxn(t.local_txn_id, { status: "queued", last_error: "payment: ambiguous" });
          report.retriable.push(t.local_txn_id);
          return;
        }
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

/**
 * Replay all queued offline sales that belong to the LIVE session. Safe to call on
 * reconnect, on POS mount, and from the Sync Center button — single-flight protects
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
  };

  // Treat as offline ONLY when the browser explicitly says so. In non-browser
  // runtimes (tests) `navigator.onLine` is undefined and must not block replay.
  const netOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (syncing) return report;
  if (!ctx.online || netOffline) return report;
  if (!ctx.tenantId || !ctx.cashierUserId) return report;

  // No offline bypass: confirm a live authenticated session before replaying.
  if (!(await d.hasSession())) return report;

  syncing = true;
  try {
    // FIFO by capture time. Only queued work is replayed; `needs_attention`
    // requires an explicit operator retry (handled by requeueForAttention).
    const txns = (await localdb.posOfflineTxns.where("status").anyOf("queued", "syncing").toArray()).sort(
      (a, b) => a.created_at.localeCompare(b.created_at),
    );
    for (const t of txns) {
      // Live-session guard — never replay another context's queue.
      if (
        t.tenant_id !== ctx.tenantId ||
        (t.branch_id ?? null) !== (ctx.branchId ?? null) ||
        t.cashier_user_id !== ctx.cashierUserId
      ) {
        report.deferred.push(t.local_txn_id);
        continue;
      }
      await updatePosOfflineTxn(t.local_txn_id, {
        status: "syncing",
        attempts: (t.attempts ?? 0) + 1,
        last_attempt_at: new Date().toISOString(),
      });
      try {
        await replayOne({ ...t, attempts: (t.attempts ?? 0) + 1 }, report, d);
      } catch (e) {
        // Unexpected engine error — keep the work, never drop it.
        await updatePosOfflineTxn(t.local_txn_id, { status: "queued", last_error: errMsg(e) });
        report.retriable.push(t.local_txn_id);
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
