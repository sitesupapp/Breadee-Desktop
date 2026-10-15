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

/** The registry keyed by `${type}@${schemaVersion}`. An operation whose key is absent is
 *  QUARANTINED by the orchestrator (needs_attention / unknown_handler) and never executed. */
export const HANDLERS: Record<string, OperationHandler> = {
  [`${openShiftHandler.type}@${openShiftHandler.schemaVersion}`]: openShiftHandler,
  [`${takeawaySaleHandler.type}@${takeawaySaleHandler.schemaVersion}`]: takeawaySaleHandler,
};

export function handlerFor(type: string, schemaVersion: number): OperationHandler | undefined {
  return HANDLERS[`${type}@${schemaVersion}`];
}
