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
    m.includes("changed since it was opened")
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

/** The registry keyed by `${type}@${schemaVersion}`. An operation whose key is absent is
 *  QUARANTINED by the orchestrator (needs_attention / unknown_handler) and never executed. */
export const HANDLERS: Record<string, OperationHandler> = {
  [`${openShiftHandler.type}@${openShiftHandler.schemaVersion}`]: openShiftHandler,
  [`${takeawaySaleHandler.type}@${takeawaySaleHandler.schemaVersion}`]: takeawaySaleHandler,
  [`${dineinOpenTableHandler.type}@${dineinOpenTableHandler.schemaVersion}`]: dineinOpenTableHandler,
  [`${dineinSendRoundHandler.type}@${dineinSendRoundHandler.schemaVersion}`]: dineinSendRoundHandler,
};

export function handlerFor(type: string, schemaVersion: number): OperationHandler | undefined {
  return HANDLERS[`${type}@${schemaVersion}`];
}
