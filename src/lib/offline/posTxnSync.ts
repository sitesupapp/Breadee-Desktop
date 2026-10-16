// Offline replay — the public drain entry + the shared classifiers/deps.
//
// Phase B: this module NO LONGER owns a drain loop. `syncPosTxns` is now a thin ADAPTER
// over the one replay owner (orchestrator.drainOffline): it stages legacy rows into the
// generalized operation log, drains that log, reconciles legacy status, and maps the
// result back to the historical PosTxnSyncReport shape so existing callers are unchanged.
// There is exactly ONE drainer (the orchestrator); the legacy stores remain only as
// capture adapters that the migration folds into the log.
//
// The error classifiers and injectable server `deps` below are the SAME primitives the
// compat handlers reuse, so the submit/pay/open-shift semantics are byte-identical to
// the native-proven Phase-A path:
//   * `pos_submit_order` dedups on `client_op_id` (server advisory-lock) — exactly-once.
//   * `pos_pay_order` raises `already paid` before any money moves — a retry is
//     exactly-once (treated as settled).

import { updatePosOfflineTxn } from "@/lib/offline/db";
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
  /**
   * The live terminal id — the final dimension of the immutable scope. When supplied
   * (production always does, from the device identity), an operation captured on a
   * different terminal is deferred, never replayed. Optional so tests that model only the
   * device boundary keep working; its absence falls back to the device match.
   */
  terminalId?: string | null;
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
  /** A staging/reconcile fault this pass — surfaced so stranded legacy work is visible
   *  (the rows are intact and the next drain retries); absent on a clean pass. */
  migrateError?: string;
  reconcileError?: string;
};

export function errMsg(e: unknown): string {
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

export type TerminalKind = "shift_closed" | "permission" | "validation" | null;

/** Classify a DEFINITIVE (non-transport) server refusal. Transport is handled separately. */
export function terminalKind(message: string): TerminalKind {
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

export function isAlreadyPaid(message: string): boolean {
  return message.toLowerCase().includes("already paid");
}

/**
 * Injectable server calls. Production uses the shipped RPC wrappers; tests pass
 * fakes to prove the exactly-once / guard / classification logic without a network.
 */
/** Payload for pos_open_table (Phase-C dine-in open). client_op_id enables op-id dedup. */
export type OpenTablePayload = {
  branch_id: string | null;
  name: string;
  seats: number | null;
  client_op_id: string;
  expected_version?: number | null;
};

export type PosTxnSyncDeps = {
  submit: (payload: SubmitOrderPayload) => Promise<{ order_id: string; order_number: string }>;
  pay: (args: { orderId: string; currency: CurrencyCode; discount?: Record<string, unknown> }) => Promise<unknown>;
  /** Open (or adopt) the shift for an offline-opened Case-2 shift, exactly once. */
  openShift: (args: { branchId: string | null; openingCash: number; clientOpId: string }) => Promise<{ shiftId: string; reused: boolean }>;
  /** Phase-C: occupy a table / establish the session (pos_open_table, op-id + version CAS). */
  openTable: (payload: OpenTablePayload) => Promise<{ table_id: string; pos_entity_version: number | null }>;
  /** Phase-C: send a dine-in round (pos_submit_order; expected_order_id binds rounds >=2). */
  submitRound: (payload: SubmitOrderPayload) => Promise<{ order_id: string; order_number: string; batch_no: number; appended: boolean; idempotent: boolean }>;
  /** Phase-D: void/refund a LOCALLY-HYDRATED canonical order (pos_void_order). client_op_id gives
   *  exactly-once; expectedVersion is the entity-version CAS; expectedRefundUsd (refund only) is the
   *  locally-proven refundable USD balance the server re-verifies under the row lock. A changed
   *  balance/version/state surfaces a structured conflict the handler maps to needs_attention. */
  voidRefund: (args: {
    orderId: string;
    reason: string;
    refund: boolean;
    clientOpId: string;
    expectedVersion: number | null;
    expectedRefundUsd: number | null;
  }) => Promise<{ order_id: string; status: string; refunded: boolean; refund_usd: number; refund_id: string | null; idempotent: boolean }>;
  /** Phase-D: settle a dine-in TABLE bill (pos_pay_table). client_op_id → exactly-once. The
   *  method is any ACTIVE catalog key (cash or a dynamic tender); the server derives the amount. */
  payTable: (args: {
    tableId: string;
    method: string;
    currency: CurrencyCode;
    discount?: { discount_type?: string; discount_value?: number };
    clientOpId: string;
  }) => Promise<{ ok: boolean; amount: number; idempotent: boolean }>;
  /** Phase-D: settle a single ORDER (pos_pay_order) offline. client_op_id → exactly-once;
   *  expectedVersion pins the order when known. */
  payOrderOp: (args: {
    orderId: string;
    method: string;
    currency: CurrencyCode;
    discount?: Record<string, unknown>;
    clientOpId: string;
    expectedVersion: number | null;
  }) => Promise<{ order_id: string; paid: boolean; amount: number; idempotent: boolean }>;
  /** Phase-D: put a dine-in TABLE bill on a customer's account (pos_complete_table_on_account). */
  onAccountTable: (args: {
    tableId: string;
    customerId: string;
    amount: number;
    method: string;
    discount?: { discount_type?: string; discount_value?: number };
    clientOpId: string;
  }) => Promise<{ ok: boolean; idempotent: boolean }>;
  /** Phase-D: put a single ORDER on a customer's account (pos_complete_on_account). */
  onAccountOrder: (args: {
    orderId: string;
    customerId: string;
    amount: number;
    method: string;
    discount?: { discount_type?: string; discount_value?: number };
    clientOpId: string;
  }) => Promise<{ ok: boolean; idempotent: boolean }>;
  /** Phase-D: canonically END a shift (pos_end_shift) — replays LAST, after every shift op. */
  endShiftOp: (args: {
    shiftId: string;
    actualCashCounted: number;
    notes: string | null;
    deliveryFeeCashTreatment?: string;
    clientOpId: string;
  }) => Promise<{ shift_id: string; idempotent: boolean }>;
  /** Phase-D: settle one SPLIT leg (pos_split_settle). Item-subset allocations; the server derives
   *  the amount. expectedVersion is optional (NULL offline). client_op_id → exactly-once per leg. */
  splitSettle: (args: {
    orderId: string;
    method: string;
    currency: string;
    allocations: { order_item_id: string; quantity: number }[];
    expectedVersion: number | null;
    clientOpId: string;
  }) => Promise<{ ok: boolean; split_no: number; parent_completed: boolean; remaining_qty: number; idempotent: boolean }>;
  isTransport: (e: unknown) => boolean;
  hasSession: () => Promise<boolean>;
};

export const defaultDeps: PosTxnSyncDeps = {
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
  openTable: async (payload) => {
    const { callPosRpc } = await import("@/lib/pos/rpc");
    const row = (await callPosRpc("pos_open_table", { p_payload: payload })) as Record<string, unknown>;
    return { table_id: String(row.table_id), pos_entity_version: row.pos_entity_version == null ? null : Number(row.pos_entity_version) };
  },
  submitRound: async (payload) => {
    const { submitOrder } = await import("@/lib/pos/orders");
    const r = await submitOrder(payload);
    return { order_id: r.order_id, order_number: r.order_number, batch_no: r.batch_no ?? 1, appended: r.appended ?? true, idempotent: r.idempotent ?? false };
  },
  voidRefund: async (args) => {
    const { callPosRpc } = await import("@/lib/pos/rpc");
    const row = (await callPosRpc("pos_void_order", {
      p_order: args.orderId,
      p_reason: args.reason,
      p_refund: args.refund,
      p_client_op_id: args.clientOpId,
      p_expected_version: args.expectedVersion,
      // Refund-only guard; null for a cancel (unpaid) so the server's guard stays inert.
      p_expected_refund_usd: args.refund ? args.expectedRefundUsd : null,
    })) as Record<string, unknown>;
    const idempotent =
      row.idempotent === true ||
      row.idempotent_replay === true ||
      row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return {
      order_id: String(row.order_id ?? args.orderId),
      status: String(row.status ?? ""),
      refunded: row.refunded === true,
      refund_usd: row.refund_usd == null ? 0 : Number(row.refund_usd),
      refund_id: row.refund_id == null ? null : String(row.refund_id),
      idempotent,
    };
  },
  payTable: async (args) => {
    const { callPosRpc } = await import("@/lib/pos/rpc");
    const payload: Record<string, unknown> = {
      table_id: args.tableId,
      method: args.method,
      currency_code: args.currency,
      client_op_id: args.clientOpId,
    };
    if (args.discount?.discount_type !== undefined) payload.discount_type = args.discount.discount_type;
    if (args.discount?.discount_value !== undefined) payload.discount_value = args.discount.discount_value;
    const row = (await callPosRpc("pos_pay_table", { p_payload: payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: row.ok === true, amount: row.amount == null ? 0 : Number(row.amount), idempotent };
  },
  payOrderOp: async (args) => {
    const { callPosRpc } = await import("@/lib/pos/rpc");
    const row = (await callPosRpc("pos_pay_order", {
      p_payload: {
        order_id: args.orderId,
        method: args.method,
        currency_code: args.currency,
        client_op_id: args.clientOpId,
        ...(args.expectedVersion == null ? {} : { expected_version: args.expectedVersion }),
        ...(args.discount ?? {}),
      },
    })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { order_id: String(row.order_id ?? args.orderId), paid: row.paid === true, amount: row.amount == null ? 0 : Number(row.amount), idempotent };
  },
  onAccountTable: async (args) => {
    const { callPosRpc } = await import("@/lib/pos/rpc");
    const payload: Record<string, unknown> = { table_id: args.tableId, customer_id: args.customerId, amount: args.amount, method: args.method, client_op_id: args.clientOpId };
    if (args.discount?.discount_type !== undefined) payload.discount_type = args.discount.discount_type;
    if (args.discount?.discount_value !== undefined) payload.discount_value = args.discount.discount_value;
    const row = (await callPosRpc("pos_complete_table_on_account", { p_payload: payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: true, idempotent };
  },
  onAccountOrder: async (args) => {
    const { callPosRpc } = await import("@/lib/pos/rpc");
    const payload: Record<string, unknown> = { order_id: args.orderId, customer_id: args.customerId, amount: args.amount, method: args.method, client_op_id: args.clientOpId };
    if (args.discount?.discount_type !== undefined) payload.discount_type = args.discount.discount_type;
    if (args.discount?.discount_value !== undefined) payload.discount_value = args.discount.discount_value;
    const row = (await callPosRpc("pos_complete_on_account", { p_payload: payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: true, idempotent };
  },
  endShiftOp: async (args) => {
    const { callPosRpc } = await import("@/lib/pos/rpc");
    const row = (await callPosRpc("pos_end_shift", {
      p_payload: {
        shift_id: args.shiftId,
        actual_cash_counted: Number(args.actualCashCounted) || 0,
        notes: args.notes && args.notes.trim() !== "" ? args.notes.trim() : null,
        delivery_fee_cash_treatment: args.deliveryFeeCashTreatment ?? "included",
        client_op_id: args.clientOpId,
      },
    })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { shift_id: String(row.shift_id ?? args.shiftId), idempotent };
  },
  splitSettle: async (args) => {
    const { callPosRpc } = await import("@/lib/pos/rpc");
    const row = (await callPosRpc("pos_split_settle", {
      p_payload: {
        order_id: args.orderId,
        method: args.method,
        currency_code: args.currency,
        allocations: args.allocations,
        client_op_id: args.clientOpId,
        ...(args.expectedVersion == null ? {} : { expected_version: args.expectedVersion }),
      },
    })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return {
      ok: row.ok === true,
      split_no: row.split_no == null ? 0 : Number(row.split_no),
      parent_completed: row.parent_completed === true,
      remaining_qty: row.remaining_qty == null ? 0 : Number(row.remaining_qty),
      idempotent,
    };
  },
  isTransport: isTransportFailure,
  hasSession: async () => {
    const { supabase } = await import("@/lib/supabase");
    const { data } = await supabase.auth.getSession();
    return Boolean(data.session);
  },
};

/**
 * Replay all offline work that belongs to the LIVE session. ADAPTER over the single
 * orchestrator: stage legacy rows into the operation log, drain the log, reconcile legacy
 * status, then map the orchestrator's report to the historical shape. Safe to call on
 * reconnect, on POS mount, and from a manual retry — the orchestrator's single-flight
 * protects against overlap.
 */
export async function syncPosTxns(
  ctx: PosTxnSyncContext,
  triggeredBy = "auto",
  deps?: Partial<PosTxnSyncDeps>,
): Promise<PosTxnSyncReport> {
  const { drainOffline } = await import("@/lib/offline/orchestrator");
  const { getOperation } = await import("@/lib/offline/operationLog");
  const r = await drainOffline(ctx, triggeredBy, deps);

  const report: PosTxnSyncReport = {
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    triggeredBy: r.triggeredBy,
    synced: [],
    needsAttention: [],
    retriable: [],
    deferred: [],
    shiftsSynced: [],
    shiftsNeedsAttention: [],
  };

  // Map operation ids back to the operator-facing LOCAL entity ids the historical report
  // used, split by operation type (open_shift vs sale), so existing callers/tests read the
  // same shape. Unknown/legacy types fall into the generic needsAttention bucket.
  const ref = async (id: string) => {
    const op = await getOperation(id);
    return { local: op?.local_entity_id ?? id, type: op?.operation_type ?? "" };
  };
  for (const id of r.drained) {
    const { local, type } = await ref(id);
    if (type === "open_shift") report.shiftsSynced.push(local);
    else report.synced.push(local);
  }
  for (const na of r.needsAttention) {
    const { local, type } = await ref(na.id);
    if (type === "open_shift") report.shiftsNeedsAttention.push({ id: local, reason: na.reason });
    else report.needsAttention.push({ id: local, reason: na.reason });
  }
  for (const id of [...r.retryable, ...r.skippedBackoff]) {
    const { local } = await ref(id);
    if (!report.retriable.includes(local)) report.retriable.push(local);
  }
  for (const id of r.deferred) {
    const { local } = await ref(id);
    report.deferred.push(local);
  }
  if (r.migrateError) report.migrateError = r.migrateError;
  if (r.reconcileError) report.reconcileError = r.reconcileError;
  return report;
}

/** Move a `needs_attention` item back into the drain queue for an explicit operator
 *  retry. Resets BOTH the operation-log row (the orchestrator only drains unsettled,
 *  non-needs_attention ops) and its legacy mirror, keyed by the local entity id. */
export async function requeueForAttention(localTxnId: string): Promise<void> {
  await updatePosOfflineTxn(localTxnId, { status: "queued", review_reason: null, last_error: null });
  const { updateOperation } = await import("@/lib/offline/operationLog");
  await updateOperation(`mig:txn:${localTxnId}`, {
    status: "pending",
    last_error_code: null,
    last_error_message: null,
  }).catch(() => undefined);
}
