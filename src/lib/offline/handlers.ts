// Phase B — COMPATIBILITY HANDLERS for the existing native-proven offline paths.
//
// Each handler re-expresses a PROVEN path through the generalized operation log WITHOUT
// changing its server-call semantics. They reuse posTxnSync's exact injectable deps and
// error classifiers, so the money/shift path is behaviourally identical to Phase A.
//
// Konan contract honoured: the Takeaway-cash path is an OPAQUE business handler
// (submit -> cash pay, with the server's `already paid` natural-state dedup). It is NOT a
// generic, independently-retryable payment handler — `pos_pay_order` has no client_op_id,
// so its safety still rests on submit idempotency + the server state-guard, exactly as before.

import type { SubmitOrderPayload } from "@/lib/pos/orders";
import type { CurrencyCode } from "@/lib/currency";
import type { OfflineOperation, RetryClass } from "@/lib/offline/operationLog";
import {
  type PosTxnSyncDeps,
  terminalKind,
  errMsg,
  isAlreadyPaid,
} from "@/lib/offline/posTxnSync";

/** A server message that means a concurrency/state CONFLICT the operator must resolve
 *  (never a hot retry, never a silent new bill): the Track-A expected-order guard, or the
 *  entity-version CAS. Maps to needs_attention. */
function isConflictMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("expected_order_mismatch") ||
    m.includes("bill changed") ||
    m.includes("version_conflict") ||
    m.includes("changed since it was loaded") ||
    m.includes("changed since it was opened") ||
    // Phase D — the offline-refund guard + the void state machine. A changed refundable
    // balance, a no-longer-paid order, an order someone else already settled, or a stale
    // version are all CONFLICTS the operator resolves — never a silent second refund.
    m.includes("refund_amount_mismatch") ||
    m.includes("refund_balance_changed") ||
    m.includes("already_settled") ||
    m.includes("already voided") ||
    m.includes("already refunded") ||
    m.includes("refundable amount changed") ||
    m.includes("no longer in a refundable")
  );
}

export type HandlerResult =
  | { ok: true; canonicalId: string | null; resultMeta?: Record<string, unknown> }
  | { ok: false; retryClass: RetryClass; code: string; message: string };

export type HandlerContext = {
  deps: PosTxnSyncDeps;
  /** Canonical server id for a local entity this op depends on, or null if unresolved. */
  canonicalFor: (localEntityId: string) => Promise<string | null>;
  /** Persist mid-replay progress onto the operation (e.g. a resolved order id before payment). */
  update: (patch: Partial<OfflineOperation>) => Promise<void>;
};

export type OperationHandler = {
  type: string;
  schemaVersion: number;
  replay: (op: OfflineOperation, ctx: HandlerContext) => Promise<HandlerResult>;
};

/** Map a definitive (non-transport) refusal to a terminal retry class (mirrors Phase A:
 *  a definitive refusal parks the work for a human, never a hot retry). */
function terminalClass(message: string): { retryClass: RetryClass; code: string } {
  const kind = terminalKind(message);
  if (kind === "permission") return { retryClass: "AUTHORITY_REFUSED", code: "permission" };
  if (kind === "shift_closed") return { retryClass: "CONFLICT", code: "shift_closed" };
  return { retryClass: "VALIDATION_TERMINAL", code: kind ?? "validation" };
}

/** open_shift — open (or adopt) the canonical server shift for a Case-2 offline-opened
 *  shift, exactly once. Payload: { branchId, openingCash }. Reuses deps.openShift
 *  (pos_open_shift single-open/adopt, dedup on client_op_id). */
export const openShiftHandler: OperationHandler = {
  type: "open_shift",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as { branchId: string | null; openingCash: number };
    try {
      const { shiftId } = await ctx.deps.openShift({
        branchId: op.scope.branch_id,
        openingCash: Number(p.openingCash) || 0,
        clientOpId: op.client_op_id,
      });
      return { ok: true, canonicalId: shiftId, resultMeta: { shift_id: shiftId } };
    } catch (e) {
      if (ctx.deps.isTransport(e)) {
        return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "open: transport", message: errMsg(e) };
      }
      const t = terminalClass(errMsg(e));
      return { ok: false, retryClass: t.retryClass, code: t.code, message: errMsg(e) };
    }
  },
};

type TakeawayPayload = {
  order_payload: SubmitOrderPayload;
  payment_intent: { method: "cash"; currency: string; discount?: Record<string, unknown> } | null;
  paid?: boolean;
};

/** takeaway_sale — the opaque Takeaway/Delivery-cached offline sale: submit the order
 *  (idempotent on client_op_id), then, if a cash payment intent exists, pay it (the
 *  server's `already paid` is treated as settled). Mirrors Phase A replayOne exactly.
 *  Dependency: if captured against an offline-opened shift, its local id is in
 *  depends_on_local_entities; the orchestrator guarantees it is resolved, and here we
 *  remap the payload's shift_id to the canonical server shift before submitting. */
export const takeawaySaleHandler: OperationHandler = {
  type: "takeaway_sale",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as TakeawayPayload;
    let payload = p.order_payload;

    // Remap a pending-shift dependency to its canonical server shift id, durably.
    const shiftLocalId = op.depends_on_local_entities[0];
    if (shiftLocalId) {
      const canonicalShift = await ctx.canonicalFor(shiftLocalId);
      if (!canonicalShift) {
        return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "shift_unresolved", message: "shift not yet synced" };
      }
      if ((payload as { shift_id?: string }).shift_id !== canonicalShift) {
        payload = { ...payload, shift_id: canonicalShift } as SubmitOrderPayload;
        await ctx.update({ payload: { ...p, order_payload: payload } });
      }
    }

    // 1. Order (idempotent on client_op_id). canonical_entity_id holds the server order id once known.
    let orderId = op.canonical_entity_id;
    let orderNumber = (op.result_meta?.order_number as string | undefined) ?? null;
    if (!orderId) {
      try {
        const saved = await ctx.deps.submit(payload);
        orderId = saved.order_id;
        orderNumber = saved.order_number;
        await ctx.update({ canonical_entity_id: orderId, result_meta: { ...(op.result_meta ?? {}), order_number: orderNumber } });
      } catch (e) {
        if (ctx.deps.isTransport(e)) {
          return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "order: transport", message: errMsg(e) };
        }
        const t = terminalClass(errMsg(e));
        return { ok: false, retryClass: t.retryClass, code: t.code, message: errMsg(e) };
      }
    }
    if (!orderId) {
      return { ok: false, retryClass: "SERVER_RETRYABLE", code: "order: no id", message: "no order id returned" };
    }

    // 2. Cash payment (state-based `already paid` dedup). Only when an intent exists.
    let paid = p.paid === true;
    if (p.payment_intent && !paid) {
      try {
        await ctx.deps.pay({
          orderId,
          currency: (p.payment_intent.currency as CurrencyCode) ?? "USD",
          discount: p.payment_intent.discount,
        });
        paid = true;
        await ctx.update({ payload: { ...p, paid: true, order_payload: payload } });
      } catch (e) {
        const msg = errMsg(e);
        if (isAlreadyPaid(msg)) {
          paid = true;
          await ctx.update({ payload: { ...p, paid: true, order_payload: payload } });
        } else if (ctx.deps.isTransport(e)) {
          return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "payment: transport", message: msg };
        } else {
          const t = terminalClass(msg);
          return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
        }
      }
    }

    return { ok: true, canonicalId: orderId, resultMeta: { order_number: orderNumber, paid } };
  },
};

// --- Phase C: offline Dine-In service continuity -----------------------------

type DineinOpenTablePayload = {
  branch_id: string | null;
  name: string;
  seats: number | null;
  expected_version?: number | null;
};

/** dinein_open_table — occupy the table / establish the session on the server via
 *  pos_open_table (op-id dedup + version CAS). canonical_entity_id becomes the canonical
 *  table id. A duplicate replay returns the SAME table (server op-id dedup). A table that
 *  changed since capture surfaces VERSION_CONFLICT → needs_attention. */
export const dineinOpenTableHandler: OperationHandler = {
  type: "dinein_open_table",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as DineinOpenTablePayload;
    try {
      const r = await ctx.deps.openTable({
        branch_id: op.scope.branch_id,
        name: p.name,
        seats: p.seats ?? null,
        client_op_id: op.client_op_id,
        expected_version: p.expected_version ?? null,
      });
      return { ok: true, canonicalId: r.table_id, resultMeta: { table_id: r.table_id, pos_entity_version: r.pos_entity_version } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "open_table: transport", message: msg };
      if (isConflictMessage(msg)) return { ok: false, retryClass: "CONFLICT", code: "version_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

type DineinSendRoundPayload = {
  /** The base pos_submit_order payload captured at send time (immutable). */
  submit: SubmitOrderPayload;
  /** Local table entity id to remap to the canonical table id (ad-hoc offline tables); null when
   *  submit.table_id is already a canonical/configured id. */
  table_local: string | null;
  /** For rounds >= 2: the ROUND-1 local entity id whose canonical order id pins expected_order_id;
   *  null for round 1 (which establishes the session order). */
  session_local: string | null;
};

/** dinein_send_round — send a dine-in round to the table's open order via pos_submit_order
 *  (exactly-once on client_op_id). Round 1 establishes the session's canonical order;
 *  rounds >= 2 pin `expected_order_id` to it (Track-A guard) so a remotely closed/replaced
 *  bill is refused (EXPECTED_ORDER_MISMATCH → needs_attention), never a silent new bill.
 *  Dependencies (table_local, session_local) are resolved scope-exact before the call. */
export const dineinSendRoundHandler: OperationHandler = {
  type: "dinein_send_round",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as DineinSendRoundPayload;
    let payload: SubmitOrderPayload = { ...p.submit };

    // Remap an ad-hoc local table id to its canonical server id (configured tables skip this).
    if (p.table_local) {
      const canonicalTable = await ctx.canonicalFor(p.table_local);
      if (!canonicalTable) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "table_unresolved", message: "table not yet synced" };
      payload = { ...payload, table_id: canonicalTable };
    }

    // Rounds >= 2: bind to the session's canonical order (resolved by round 1).
    if (p.session_local) {
      const canonicalOrder = await ctx.canonicalFor(p.session_local);
      if (!canonicalOrder) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "session order not yet synced" };
      payload = { ...payload, expected_order_id: canonicalOrder };
    }

    try {
      const r = await ctx.deps.submitRound(payload);
      return { ok: true, canonicalId: r.order_id, resultMeta: { order_number: r.order_number, batch_no: r.batch_no, appended: r.appended } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "send_round: transport", message: msg };
      if (isConflictMessage(msg)) return { ok: false, retryClass: "CONFLICT", code: "expected_order_mismatch", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

type VoidRefundPayload = {
  /** The CANONICAL server order id. An offline refund is only ever captured against a
   *  locally-hydrated canonical order (policy rule 9), so there is no local-id remap. */
  order_id: string;
  reason: string;
  /** true = refund a paid order (writes the negative payment + refund record); false = cancel. */
  refund: boolean;
  /** The pos_entity_version the order held locally at capture (CAS). */
  expected_version: number | null;
  /** Refund only: the refundable USD balance proven from LOCAL payment data at capture.
   *  The server re-verifies it under the row lock; a drift raises REFUND_AMOUNT_MISMATCH. */
  expected_refund_usd: number | null;
  /** Whether this was a cash refund (the local drawer projection was already reduced at
   *  capture). Audit/reconciliation metadata only — the server amount is authoritative. */
  tender: "cash" | "other";
};

/** void_refund — reverse a PAID (refund) or cancel an UNPAID order via pos_void_order,
 *  exactly-once on client_op_id. The order id is canonical (offline refunds are only allowed
 *  against locally-hydrated orders), so no dependency remap. A duplicate replay of OUR op
 *  returns the original result (idempotent SUCCESS); a balance/version/already-settled drift
 *  is a CONFLICT → needs_attention, never a silent second refund (the local cash-out record
 *  is preserved for reconciliation/audit). */
export const voidRefundHandler: OperationHandler = {
  type: "void_refund",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as VoidRefundPayload;
    try {
      const r = await ctx.deps.voidRefund({
        orderId: p.order_id,
        reason: p.reason,
        refund: p.refund,
        clientOpId: op.client_op_id,
        expectedVersion: p.expected_version ?? null,
        expectedRefundUsd: p.expected_refund_usd ?? null,
      });
      return {
        ok: true,
        canonicalId: r.order_id,
        resultMeta: { status: r.status, refunded: r.refunded, refund_usd: r.refund_usd, refund_id: r.refund_id, idempotent: r.idempotent },
      };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "void_refund: transport", message: msg };
      if (isConflictMessage(msg)) return { ok: false, retryClass: "CONFLICT", code: "refund_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** A settle refusal that means the bill was ALREADY settled by a DIFFERENT action (not our own
 *  replay — our own replay returns idempotent SUCCESS via the server's client_op_id cache). We
 *  collected tender offline against a bill that is now closed another way, so this is a CONFLICT
 *  the operator resolves (needs_attention), never a silent second charge. */
function isSettleConflict(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("already paid") ||
    m.includes("no open order") ||
    m.includes("already settled") ||
    isConflictMessage(message)
  );
}

type PayTablePayload = {
  /** Canonical table id when known (a configured table). */
  table_id: string | null;
  /** Local open-table entity id to remap to the canonical table id (ad-hoc offline tables). */
  table_local: string | null;
  method: string;
  currency: string;
  discount?: { discount_type?: string; discount_value?: number };
  table_name?: string | null;
};

/** pay_table — settle a dine-in TABLE bill offline (pos_pay_table), exactly-once on client_op_id.
 *  An ad-hoc table created offline is remapped from its open-table op; a configured table uses its
 *  canonical id directly. A bill settled another way meanwhile → CONFLICT (needs_attention). */
export const payTableHandler: OperationHandler = {
  type: "pay_table",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as PayTablePayload;
    let tableId = p.table_id;
    if (p.table_local) {
      const canonical = await ctx.canonicalFor(p.table_local);
      if (!canonical) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "table_unresolved", message: "table not yet synced" };
      tableId = canonical;
    }
    if (!tableId) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_table", message: "no table id" };
    try {
      const r = await ctx.deps.payTable({ tableId, method: p.method, currency: (p.currency as CurrencyCode) ?? "USD", discount: p.discount, clientOpId: op.client_op_id });
      return { ok: true, canonicalId: tableId, resultMeta: { amount: r.amount, idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "pay_table: transport", message: msg };
      if (isSettleConflict(msg)) return { ok: false, retryClass: "CONFLICT", code: "settle_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

type PayOrderPayload = {
  order_id: string | null;
  /** Local order entity id to remap to the canonical order id (offline-created order). */
  order_local: string | null;
  method: string;
  currency: string;
  discount?: Record<string, unknown>;
  expected_version?: number | null;
  order_number?: string | null;
};

/** pay_order — settle a single ORDER offline (pos_pay_order), exactly-once on client_op_id. */
export const payOrderHandler: OperationHandler = {
  type: "pay_order",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as PayOrderPayload;
    let orderId = p.order_id;
    if (p.order_local) {
      const canonical = await ctx.canonicalFor(p.order_local);
      if (!canonical) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" };
      orderId = canonical;
    }
    if (!orderId) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_order", message: "no order id" };
    try {
      const r = await ctx.deps.payOrderOp({ orderId, method: p.method, currency: (p.currency as CurrencyCode) ?? "USD", discount: p.discount, clientOpId: op.client_op_id, expectedVersion: p.expected_version ?? null });
      return { ok: true, canonicalId: r.order_id, resultMeta: { amount: r.amount, paid: r.paid, idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "pay_order: transport", message: msg };
      if (isSettleConflict(msg)) return { ok: false, retryClass: "CONFLICT", code: "settle_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

type OnAccountTablePayload = {
  table_id: string | null;
  table_local: string | null;
  customer_id: string | null;
  /** Local customer id to remap once an offline-created customer syncs (Phase E); null = cached. */
  customer_local: string | null;
  amount: number;
  method: string;
  discount?: { discount_type?: string; discount_value?: number };
  table_name?: string | null;
};

/** on_account_table — put a dine-in TABLE bill on a customer's account offline
 *  (pos_complete_table_on_account), exactly-once on client_op_id. Depends on the table's open +
 *  rounds (so the orders exist server-side) and on a LOCALLY-KNOWN customer. */
export const onAccountTableHandler: OperationHandler = {
  type: "on_account_table",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as OnAccountTablePayload;
    let tableId = p.table_id;
    if (p.table_local) {
      const c = await ctx.canonicalFor(p.table_local);
      if (!c) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "table_unresolved", message: "table not yet synced" };
      tableId = c;
    }
    let customerId = p.customer_id;
    if (p.customer_local) {
      const c = await ctx.canonicalFor(p.customer_local);
      if (!c) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "customer_unresolved", message: "customer not yet synced" };
      customerId = c;
    }
    if (!tableId || !customerId) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "missing_ref", message: "no table or customer id" };
    try {
      const r = await ctx.deps.onAccountTable({ tableId, customerId, amount: p.amount, method: p.method, discount: p.discount, clientOpId: op.client_op_id });
      return { ok: true, canonicalId: tableId, resultMeta: { idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "on_account_table: transport", message: msg };
      if (isSettleConflict(msg)) return { ok: false, retryClass: "CONFLICT", code: "settle_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

type OnAccountOrderPayload = {
  order_id: string | null;
  order_local: string | null;
  customer_id: string | null;
  customer_local: string | null;
  amount: number;
  method: string;
  discount?: { discount_type?: string; discount_value?: number };
  order_number?: string | null;
};

/** on_account_order — put a single ORDER on a customer's account offline
 *  (pos_complete_on_account), exactly-once on client_op_id. */
export const onAccountOrderHandler: OperationHandler = {
  type: "on_account_order",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as OnAccountOrderPayload;
    let orderId = p.order_id;
    if (p.order_local) {
      const c = await ctx.canonicalFor(p.order_local);
      if (!c) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" };
      orderId = c;
    }
    let customerId = p.customer_id;
    if (p.customer_local) {
      const c = await ctx.canonicalFor(p.customer_local);
      if (!c) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "customer_unresolved", message: "customer not yet synced" };
      customerId = c;
    }
    if (!orderId || !customerId) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "missing_ref", message: "no order or customer id" };
    try {
      const r = await ctx.deps.onAccountOrder({ orderId, customerId, amount: p.amount, method: p.method, discount: p.discount, clientOpId: op.client_op_id });
      return { ok: true, canonicalId: orderId, resultMeta: { idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "on_account_order: transport", message: msg };
      if (isSettleConflict(msg)) return { ok: false, retryClass: "CONFLICT", code: "settle_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

type EndShiftPayload = {
  shift_id: string | null;
  /** Local open-shift entity id to remap to the canonical shift (offline-opened shift). */
  shift_local: string | null;
  actual_cash_counted: number;
  notes: string | null;
  delivery_fee_cash_treatment?: string;
};

/** end_shift — canonically close a shift offline (pos_end_shift), exactly-once on client_op_id.
 *  The orchestrator's dependency gate (dependency_ids = every prior shift op) guarantees this runs
 *  LAST; here we only remap an offline-opened shift + classify. A shift changed/closed on the
 *  server meanwhile → CONFLICT/shift_closed → needs_attention (never a silent reopen/reclose). */
export const endShiftHandler: OperationHandler = {
  type: "end_shift",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as EndShiftPayload;
    let shiftId = p.shift_id;
    if (p.shift_local) {
      const c = await ctx.canonicalFor(p.shift_local);
      if (!c) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "shift_unresolved", message: "shift not yet synced" };
      shiftId = c;
    }
    if (!shiftId) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_shift", message: "no shift id" };
    try {
      const r = await ctx.deps.endShiftOp({
        shiftId,
        actualCashCounted: p.actual_cash_counted,
        notes: p.notes,
        deliveryFeeCashTreatment: p.delivery_fee_cash_treatment,
        clientOpId: op.client_op_id,
      });
      return { ok: true, canonicalId: r.shift_id, resultMeta: { idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "end_shift: transport", message: msg };
      if (isConflictMessage(msg)) return { ok: false, retryClass: "CONFLICT", code: "shift_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** A split refusal that means the bill changed underneath the captured leg — already allocated
 *  remotely, no longer splittable, a changed/paid order, or a stale version. The operator resolves
 *  it (needs_attention); the server never over-allocates or double-charges (remaining-qty check +
 *  client_op_id dedup under the row lock). */
function isSplitConflict(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not_splittable") ||
    m.includes("version_conflict") ||
    m.includes("only ") && m.includes("remaining") ||
    m.includes("not part of this bill") ||
    m.includes("no longer active") ||
    m.includes("changed since it was loaded") ||
    m.includes("already")
  );
}

type SplitSettlePayload = {
  order_id: string | null;
  /** Local order entity id to remap to the canonical order id (offline-created session). */
  order_local: string | null;
  method: string;
  currency: string;
  allocations: { order_item_id: string; quantity: number }[];
  expected_version: number | null;
  split_seq?: number;
  order_number?: string | null;
};

/** split_settle — settle ONE split leg offline (pos_split_settle), exactly-once on client_op_id.
 *  Item-subset allocations; the server derives the amount + validates remaining qty under its row
 *  lock (so an over-allocation or a changed/paid bill → CONFLICT → needs_attention, never an
 *  overpayment or double settle). Legs replay strictly in order via the capture's dependency chain. */
export const splitSettleHandler: OperationHandler = {
  type: "split_settle",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as SplitSettlePayload;
    let orderId = p.order_id;
    if (p.order_local) {
      const c = await ctx.canonicalFor(p.order_local);
      if (!c) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" };
      orderId = c;
    }
    if (!orderId) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_order", message: "no order id" };
    if (!Array.isArray(p.allocations) || p.allocations.length === 0) {
      return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_allocations", message: "no split allocations" };
    }
    try {
      const r = await ctx.deps.splitSettle({ orderId, method: p.method, currency: p.currency, allocations: p.allocations, expectedVersion: p.expected_version ?? null, clientOpId: op.client_op_id });
      return { ok: true, canonicalId: orderId, resultMeta: { split_no: r.split_no, parent_completed: r.parent_completed, remaining_qty: r.remaining_qty, idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "split_settle: transport", message: msg };
      if (isSplitConflict(msg)) return { ok: false, retryClass: "CONFLICT", code: "split_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** The registry keyed by `${type}@${schemaVersion}`. An operation whose key is absent is
 *  QUARANTINED by the orchestrator (needs_attention / unknown_handler) and never executed. */
export const HANDLERS: Record<string, OperationHandler> = {
  [`${openShiftHandler.type}@${openShiftHandler.schemaVersion}`]: openShiftHandler,
  [`${takeawaySaleHandler.type}@${takeawaySaleHandler.schemaVersion}`]: takeawaySaleHandler,
  [`${dineinOpenTableHandler.type}@${dineinOpenTableHandler.schemaVersion}`]: dineinOpenTableHandler,
  [`${dineinSendRoundHandler.type}@${dineinSendRoundHandler.schemaVersion}`]: dineinSendRoundHandler,
  [`${voidRefundHandler.type}@${voidRefundHandler.schemaVersion}`]: voidRefundHandler,
  [`${payTableHandler.type}@${payTableHandler.schemaVersion}`]: payTableHandler,
  [`${payOrderHandler.type}@${payOrderHandler.schemaVersion}`]: payOrderHandler,
  [`${onAccountTableHandler.type}@${onAccountTableHandler.schemaVersion}`]: onAccountTableHandler,
  [`${onAccountOrderHandler.type}@${onAccountOrderHandler.schemaVersion}`]: onAccountOrderHandler,
  [`${endShiftHandler.type}@${endShiftHandler.schemaVersion}`]: endShiftHandler,
  [`${splitSettleHandler.type}@${splitSettleHandler.schemaVersion}`]: splitSettleHandler,
};

export function handlerFor(type: string, schemaVersion: number): OperationHandler | undefined {
  return HANDLERS[`${type}@${schemaVersion}`];
}
