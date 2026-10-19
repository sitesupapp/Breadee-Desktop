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
import { resolveEntity } from "@/lib/offline/entityMap";
import { getOperation } from "@/lib/offline/operationLog";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve LOCAL line ids (client_line_id of a locally-sent round / offline order) to canonical
 *  order_item ids: entityMap first, else pull the server's correlation (pos_order_item_map) for the
 *  order and record it scope-exact, then re-check. Shared by split legs and item edits. Returns the
 *  still-unresolved local ids (empty = all mapped) or a transport/blocked failure. */
async function resolveLocalLines(
  op: OfflineOperation,
  ctx: HandlerContext,
  orderId: string,
  lineLocals: string[],
  batchNo: number | null,
): Promise<{ ok: true } | { ok: false; result: HandlerResult }> {
  const unresolved = async () => {
    for (const l of lineLocals) if (!(await ctx.canonicalFor(l))) return true;
    return false;
  };
  if (!(await unresolved())) return { ok: true };
  try {
    const map = await ctx.deps.orderItemMap({ orderId, batchNo });
    for (const m of map) {
      await resolveEntity({
        local_entity_id: m.client_line_id,
        entity_type: "order_item",
        canonical_id: m.order_item_id,
        resolved_at: new Date().toISOString(),
        tenant_id: op.scope.tenant_id,
        branch_id: op.scope.branch_id,
        device_id: op.scope.device_id,
        cashier_user_id: op.scope.cashier_user_id,
        terminal_id: op.scope.terminal_id,
      });
    }
  } catch (e) {
    if (ctx.deps.isTransport(e)) return { ok: false, result: { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "item_map: transport", message: errMsg(e) } };
    return { ok: false, result: { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "item_map_unresolved", message: errMsg(e) } };
  }
  if (await unresolved()) return { ok: false, result: { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "item_unresolved", message: "order items not yet mapped" } };
  return { ok: true };
}

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
  /** Phase E: explicit local-id dependencies to remap into order_payload before submit. Absent on
   *  pre-E migrated ops (whose single shift dep lived only in depends_on_local_entities). */
  shift_local?: string | null;
  customer_local?: string | null;
  address_local?: string | null;
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
    let changed = false;

    // Remap a pending-shift dependency to its canonical server shift id, durably. Prefer the
    // explicit field; fall back to the single legacy dependency id (pre-E ops had only a shift dep).
    const shiftLocalId = p.shift_local !== undefined ? p.shift_local : (op.depends_on_local_entities[0] ?? null);
    if (shiftLocalId) {
      const canonicalShift = await ctx.canonicalFor(shiftLocalId);
      if (!canonicalShift) {
        return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "shift_unresolved", message: "shift not yet synced" };
      }
      if ((payload as { shift_id?: string }).shift_id !== canonicalShift) {
        payload = { ...payload, shift_id: canonicalShift } as SubmitOrderPayload;
        changed = true;
      }
    }

    // Phase E: remap an OFFLINE-CREATED customer / address (local ids) to their canonical server ids
    // before submit. The customer_upsert op resolves them; until then the order stays dependency-blocked
    // (the orchestrator gates on depends_on_local_entities), never submitting with a local id.
    if (p.customer_local) {
      const canonicalCustomer = await ctx.canonicalFor(p.customer_local);
      if (!canonicalCustomer) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "customer_unresolved", message: "customer not yet synced" };
      if ((payload as { customer_id?: string }).customer_id !== canonicalCustomer) {
        payload = { ...payload, customer_id: canonicalCustomer } as SubmitOrderPayload;
        changed = true;
      }
    }
    if (p.address_local) {
      const canonicalAddress = await ctx.canonicalFor(p.address_local);
      if (!canonicalAddress) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "address_unresolved", message: "address not yet synced" };
      if ((payload as { address_id?: string }).address_id !== canonicalAddress) {
        payload = { ...payload, address_id: canonicalAddress } as SubmitOrderPayload;
        changed = true;
      }
    }
    if (changed) await ctx.update({ payload: { ...p, order_payload: payload } });

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
    const p = (op.payload ?? {}) as DineinOpenTablePayload & { version_after_op?: string | null };
    // rc.10 — a table REUSED after a local offline settle: take the expected table version from that
    // settle's server-returned version (our own settle bumped it), so the CAS still protects against a
    // foreign change but never trips on our own settle. Unknown → adopt (null), as for an occupied table.
    let expected = p.expected_version ?? null;
    if (p.version_after_op) {
      const prev = await getOperation(p.version_after_op);
      const v = prev?.status === "synced" ? prev.result_meta?.pos_entity_version : undefined;
      expected = typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    try {
      const r = await ctx.deps.openTable({
        branch_id: op.scope.branch_id,
        name: p.name,
        seats: p.seats ?? null,
        client_op_id: op.client_op_id,
        expected_version: expected,
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
  /** rc.12 — the LOCAL id of a shift opened offline, remapped to the canonical shift id (submit.shift_id). */
  shift_local?: string | null;
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
    // rc.9 — strip a NON-uuid client_line_id (pre-rc.9 rounds carried the cart key "line-N"). The server
    // casts it ::uuid, so it failed the WHOLE submit (22P02 → needs_attention + every dependent settle).
    // Dropping it is lossless for the round itself (it is a correlation tag only) and makes a parked
    // legacy round replayable exactly-once on an operator Retry. A uuid line id is kept verbatim.
    let payload: SubmitOrderPayload = {
      ...p.submit,
      items: (p.submit?.items ?? []).map((it) => {
        if (it.client_line_id === undefined || UUID_RE.test(String(it.client_line_id))) return it;
        const { client_line_id: _drop, ...rest } = it;
        void _drop;
        return rest;
      }),
    };

    // Remap an ad-hoc local table id to its canonical server id (configured tables skip this).
    if (p.table_local) {
      const canonicalTable = await ctx.canonicalFor(p.table_local);
      if (!canonicalTable) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "table_unresolved", message: "table not yet synced" };
      payload = { ...payload, table_id: canonicalTable };
    }

    // rc.12 — a round captured BEFORE rc.12 carries no shift. If its session has since been attached to a
    // shift (provable upgrade backfill at the next send), use that; never create a shift-less order.
    let shiftLocal = p.shift_local ?? null;
    if (!payload.shift_id && !shiftLocal) {
      const sessionId = p.session_local ?? op.local_entity_id;
      const { localdb } = await import("@/lib/offline/db");
      const d = sessionId ? await localdb.dineDrafts.get(sessionId).catch(() => undefined) : undefined;
      if (d?.shift_id) payload = { ...payload, shift_id: d.shift_id };
      else if (d?.shift_local) shiftLocal = d.shift_local;
    }
    // rc.12 — an offline-opened shift: the order is created on its CANONICAL shift (never shift-less).
    if (shiftLocal) {
      const canonicalShift = await ctx.canonicalFor(shiftLocal);
      if (!canonicalShift) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "shift_unresolved", message: "shift not yet synced" };
      payload = { ...payload, shift_id: canonicalShift };
    }
    // FAIL CLOSED: a round that would CREATE a new server order without a shift is parked for review
    // (nothing sent) — the server would accept it and the order could then never be settled/moved/merged.
    // Appends (expected_order_id / a later round) keep the existing order's shift server-side.
    if (!payload.shift_id && !p.session_local && !payload.expected_order_id) {
      return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "shift_missing", message: "Dine-in order captured without a shift (pre-rc.12) — not sent; it would not be attached to an open shift." };
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
      return { ok: true, canonicalId: tableId, resultMeta: { amount: r.amount, idempotent: r.idempotent, pos_entity_version: r.pos_entity_version ?? null } };
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

type SplitAlloc = {
  /** Canonical order_item id (hydrated bill). */
  order_item_id?: string | null;
  /** Local line id (fully-offline session) to resolve to a canonical order_item id via entityMap. */
  line_local?: string | null;
  quantity: number;
};

type SplitSettlePayload = {
  order_id: string | null;
  /** Local order entity id to remap to the canonical order id (offline-created session). */
  order_local: string | null;
  method: string;
  currency: string;
  allocations: SplitAlloc[];
  expected_version: number | null;
  split_seq?: number;
  order_number?: string | null;
  /** The batch to resolve item mappings for (optional; null → whole order). */
  batch_no?: number | null;
};

/** split_settle — settle ONE split leg offline (pos_split_settle), exactly-once on client_op_id.
 *  Item-subset allocations; the server derives the amount + validates remaining qty under its row
 *  lock (so an over-allocation or a changed/paid bill → CONFLICT → needs_attention, never an
 *  overpayment or double settle). Legs replay strictly in order via the capture's dependency chain.
 *  Fully-offline legs carry LOCAL line ids: each is resolved to its canonical order_item_id via the
 *  generic entityMap (populated from pos_order_item_map once the round synced). A leg with any
 *  unresolved mapping stays WAITING_FOR_DEPENDENCY — it NEVER sends a partial allocation. */
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

    // Resolve every allocation to a CANONICAL order_item_id. Hydrated legs already carry it; a
    // fully-offline leg carries a local line id resolved via entityMap. If a local mapping is not
    // yet present, populate entityMap from the server's correlation (pos_order_item_map) for this
    // order, then retry; still-missing → WAITING_FOR_DEPENDENCY (no partial allocation ever sent).
    if (p.allocations.some((a) => !a.order_item_id && !a.line_local)) {
      return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "item_unresolved", message: "allocation item not mapped" };
    }
    const locals = p.allocations.filter((a) => !a.order_item_id && a.line_local).map((a) => a.line_local as string);
    if (locals.length > 0) {
      // Pull the server's client_line_id -> order_item_id correlation and record it scope-exact.
      const r = await resolveLocalLines(op, ctx, orderId, locals, p.batch_no ?? null);
      if (!r.ok) return r.result;
    }

    const resolved: { order_item_id: string; quantity: number }[] = [];
    for (const a of p.allocations) {
      const id = a.order_item_id ?? (a.line_local ? await ctx.canonicalFor(a.line_local) : null);
      if (!id) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "item_unresolved", message: "allocation item not mapped" };
      resolved.push({ order_item_id: id, quantity: a.quantity });
    }

    try {
      const r = await ctx.deps.splitSettle({ orderId, method: p.method, currency: p.currency, allocations: resolved, expectedVersion: p.expected_version ?? null, clientOpId: op.client_op_id });
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

/** A payout refusal that means the linked economic SOURCE drifted since it was hydrated — gone,
 *  voided, deleted, or otherwise no longer valid against the live DB. The source was provable
 *  offline but is not now, so this is a CONFLICT the operator resolves (needs_attention), never a
 *  hot retry and never a blind cash-out. The server re-validates under its row lock; a duplicate of
 *  OUR own op returns the original result (idempotent SUCCESS via the client_op_id replay cache). */
function isPayoutDrift(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("source") ||
    m.includes("not found") ||
    m.includes("does not exist") ||
    m.includes("no longer") ||
    m.includes("voided") ||
    m.includes("deleted") ||
    m.includes("already")
  );
}

type PayoutPayload = {
  shift_id: string | null;
  /** Local open-shift entity id to remap to the canonical shift (offline-opened shift). */
  shift_local: string | null;
  amount: number;
  source_type: string;
  source_id: string;
  note: string | null;
};

/** payout — record a cash PAYOUT offline (pos_payout_create), exactly-once on client_op_id. The
 *  server validates + snapshots the linked source and prices the cash-out (no second economic
 *  event). An offline-opened shift is remapped from its open op before the call; a source that
 *  drifted since hydration → CONFLICT → needs_attention; the local drawer was already reduced at
 *  capture and is preserved for reconciliation regardless. */
export const payoutHandler: OperationHandler = {
  type: "payout",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as PayoutPayload;
    let shiftId = p.shift_id;
    if (p.shift_local) {
      const c = await ctx.canonicalFor(p.shift_local);
      if (!c) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "shift_unresolved", message: "shift not yet synced" };
      shiftId = c;
    }
    if (!shiftId) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_shift", message: "no shift id" };
    if (!p.source_id || !p.source_type) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_source", message: "no payout source" };
    try {
      const r = await ctx.deps.payout({
        shiftId,
        amount: p.amount,
        sourceType: p.source_type,
        sourceId: p.source_id,
        note: p.note,
        clientOpId: op.client_op_id,
      });
      return { ok: true, canonicalId: r.payout_id || null, resultMeta: { payout_id: r.payout_id, amount: r.amount, amount_usd: r.amount_usd, idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "payout: transport", message: msg };
      // Shift/permission refusals are classified first (a closed shift is a CONFLICT, not source drift).
      const t = terminalKind(msg);
      if (t === "shift_closed") return { ok: false, retryClass: "CONFLICT", code: "shift_closed", message: msg };
      if (t === "permission") return { ok: false, retryClass: "AUTHORITY_REFUSED", code: "permission", message: msg };
      if (isPayoutDrift(msg)) return { ok: false, retryClass: "CONFLICT", code: "payout_source_drift", message: msg };
      return { ok: false, retryClass: "VALIDATION_TERMINAL", code: t ?? "validation", message: msg };
    }
  },
};

type CustomerUpsertPayload = {
  /** The exact pos_upsert_customer payload (branch_id + optional id/phone/name/notes/address). */
  upsert: Record<string, unknown>;
  /** Local address id to resolve to the canonical address_id on success (create-with-address), or
   *  null. Lets a later offline delivery order chain to this address via entityMap. */
  local_address_id: string | null;
};

/** customer_upsert — create/edit a customer (+ optional address) offline via pos_upsert_customer,
 *  exactly-once on client_op_id. A CREATE resolves its local customer id → canonical (orchestrator)
 *  and this handler ALSO records the local address id → canonical address_id so a dependent delivery
 *  order can remap both. A same-OU identity clash (a DIFFERENT customer already holds the number) is
 *  a CONFLICT the operator resolves (needs_attention) — never a silent duplicate, never a silent
 *  re-link to the matched customer. */
export const customerUpsertHandler: OperationHandler = {
  type: "customer_upsert",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as CustomerUpsertPayload & { customer_local?: string | null };
    if (!p.upsert || typeof p.upsert !== "object") {
      return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_payload", message: "no customer payload" };
    }
    // rc.11 — an edit of an OFFLINE-CREATED customer: remap its local id to the canonical id (resolved
    // by the create op), never send the local id to the server.
    let upsert = p.upsert;
    if (p.customer_local) {
      const canonical = await ctx.canonicalFor(p.customer_local);
      if (!canonical) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "customer_unresolved", message: "customer not yet synced" };
      upsert = { ...upsert, id: canonical };
    }
    try {
      const r = await ctx.deps.upsertCustomer({ payload: upsert, clientOpId: op.client_op_id });
      if (!r.customer_id) return { ok: false, retryClass: "SERVER_RETRYABLE", code: "no_customer_id", message: "no customer id returned" };
      // rc.12 — ONE logical customer: the pending-local picker row is PROMOTED to the canonical id
      // (local address ids remapped), atomically — still searchable offline, never listed twice. rc.11
      // deleted it and nothing re-cached the canonical customer (F5). The entity map keeps the
      // local→canonical alias for any not-yet-replayed dependent. Best-effort (cache, not authority).
      const addrMap: Record<string, string> = p.local_address_id && r.address_id ? { [p.local_address_id]: r.address_id } : {};
      if (op.local_entity_id) {
        const { promotePendingLocalCustomer } = await import("@/lib/offline/db");
        await promotePendingLocalCustomer(op.local_entity_id, r.customer_id, addrMap).catch(() => undefined);
      } else if (p.local_address_id && r.address_id) {
        const { remapCachedCustomerAddress } = await import("@/lib/offline/db");
        await remapCachedCustomerAddress(r.customer_id, p.local_address_id, r.address_id).catch(() => undefined);
      }
      // Record the address mapping (create-with-address) so a dependent order resolves address_local.
      if (p.local_address_id && r.address_id) {
        await resolveEntity({
          local_entity_id: p.local_address_id,
          entity_type: "address",
          canonical_id: r.address_id,
          resolved_at: new Date().toISOString(),
          tenant_id: op.scope.tenant_id,
          branch_id: op.scope.branch_id,
          device_id: op.scope.device_id,
          cashier_user_id: op.scope.cashier_user_id,
          terminal_id: op.scope.terminal_id,
        });
      }
      return { ok: true, canonicalId: r.customer_id, resultMeta: { customer_id: r.customer_id, address_id: r.address_id, is_new: r.is_new } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "customer_upsert: transport", message: msg };
      if (msg.toLowerCase().includes("customer_identity_conflict")) {
        return { ok: false, retryClass: "CONFLICT", code: "customer_identity_conflict", message: msg };
      }
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** rc.9 — which line an offline item edit targets, resolved to a canonical order_item id AT REPLAY:
 *  canonical = a hydrated server line; local = a line of a locally-sent round / offline order (its
 *  client_line_id, mapped via pos_order_item_map); after = the replacement/delta line produced by an
 *  EARLIER offline edit of this order (that op's result_meta.replacement_order_item_id). */
export type EditTargetRef =
  | { kind: "canonical"; order_item_id: string }
  | { kind: "local"; line_local: string; batch_no?: number | null }
  | { kind: "after"; op_id: string };

type ItemEditPayload = {
  /** The exact pre-built p_payload for the RPC (carries expected_version + client_op_id + reason). */
  payload: Record<string, unknown>;
  /** Local order entity id to remap to the canonical order id (an offline-created order); null when
   *  payload.order_id is already canonical (a hydrated order). */
  order_local: string | null;
  /** rc.9 — the line target, resolved at replay (absent on pre-rc.9 ops: payload.target_item_id as-is). */
  target_ref?: EditTargetRef | null;
  /** rc.9 — the previous version-bumping op of this order captured on this device: when it synced with
   *  a server-returned pos_entity_version, THAT is the exact expected_version (else the captured one). */
  version_after_op?: string | null;
};

/** Resolve an edit's target line + exact expected_version (rc.9). */
async function resolveEditTarget(
  op: OfflineOperation,
  p: ItemEditPayload,
  payload: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<{ payload: Record<string, unknown> } | { result: HandlerResult }> {
  let out = payload;
  if (p.version_after_op) {
    const prev = await getOperation(p.version_after_op);
    const v = prev?.status === "synced" ? prev.result_meta?.pos_entity_version : undefined;
    if (typeof v === "number" && Number.isFinite(v)) out = { ...out, expected_version: v };
  }
  const ref = p.target_ref;
  if (!ref) return { payload: out };
  if (ref.kind === "canonical") return { payload: { ...out, target_item_id: ref.order_item_id } };
  if (ref.kind === "after") {
    const prev = await getOperation(ref.op_id);
    const id = prev?.status === "synced" ? prev.result_meta?.replacement_order_item_id : undefined;
    if (typeof id !== "string" || id === "") {
      return { result: { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "item_unresolved", message: "edited line not yet synced" } };
    }
    return { payload: { ...out, target_item_id: id } };
  }
  const orderId = String(out.order_id ?? "");
  if (!orderId) return { result: { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" } };
  const r = await resolveLocalLines(op, ctx, orderId, [ref.line_local], ref.batch_no ?? null);
  if (!r.ok) return { result: r.result };
  const id = await ctx.canonicalFor(ref.line_local);
  if (!id) return { result: { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "item_unresolved", message: "line not yet mapped" } };
  return { payload: { ...out, target_item_id: id } };
}

/** Resolve the target order id for an item-edit op: remap order_local → canonical when the order was
 *  created offline, else use the payload's canonical order_id. Returns null when still unresolved. */
async function resolveEditOrder(p: ItemEditPayload, ctx: HandlerContext): Promise<{ payload: Record<string, unknown> } | { blocked: true }> {
  if (p.order_local) {
    const canonical = await ctx.canonicalFor(p.order_local);
    if (!canonical) return { blocked: true };
    return { payload: { ...p.payload, order_id: canonical } };
  }
  return { payload: p.payload };
}

/** edit_order_line — edit one line of an open order offline (pos_edit_order_line), exactly-once on
 *  client_op_id. CAS (expected_version) + reason are baked into the captured payload; a bill that
 *  changed since it was loaded → CONFLICT → needs_attention, never a blind re-apply. */
export const editOrderLineHandler: OperationHandler = {
  type: "edit_order_line",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as ItemEditPayload;
    if (!p.payload || typeof p.payload !== "object") return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_payload", message: "no edit payload" };
    const resolved = await resolveEditOrder(p, ctx);
    if ("blocked" in resolved) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" };
    const target = await resolveEditTarget(op, p, resolved.payload, ctx);
    if ("result" in target) return target.result;
    try {
      const r = await ctx.deps.editOrderLine({ payload: target.payload });
      return {
        ok: true,
        canonicalId: (target.payload.order_id as string) ?? null,
        // rc.9 — the replacement line + the new version chain the NEXT offline edit of this order/line.
        resultMeta: { idempotent: r.idempotent, replacement_order_item_id: r.replacement_order_item_id ?? null, pos_entity_version: r.pos_entity_version ?? null },
      };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "edit_order_line: transport", message: msg };
      if (isConflictMessage(msg)) return { ok: false, retryClass: "CONFLICT", code: "edit_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** add_order_items — add new lines to an open delivery order offline (pos_add_order_items),
 *  exactly-once on client_op_id. CAS (expected_version) in the captured payload; a version drift →
 *  CONFLICT → needs_attention. The server resolves every price (the payload carries none). */
export const addOrderItemsHandler: OperationHandler = {
  type: "add_order_items",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as ItemEditPayload;
    if (!p.payload || typeof p.payload !== "object") return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_payload", message: "no add payload" };
    const resolved = await resolveEditOrder(p, ctx);
    if ("blocked" in resolved) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" };
    // rc.9 — exact expected_version from the previous offline mutation of this order (no target line).
    const target = await resolveEditTarget(op, { ...p, target_ref: null }, resolved.payload, ctx);
    if ("result" in target) return target.result;
    try {
      const r = await ctx.deps.addOrderItems({ payload: target.payload });
      return { ok: true, canonicalId: (target.payload.order_id as string) ?? null, resultMeta: { idempotent: r.idempotent, pos_entity_version: r.pos_entity_version ?? null } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "add_order_items: transport", message: msg };
      if (isConflictMessage(msg)) return { ok: false, retryClass: "CONFLICT", code: "add_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** delivery_ops — edit an open order's internal delivered-by / handler / cost offline
 *  (pos_set_delivery_ops), exactly-once on client_op_id. No money, no external coordination; the
 *  server resolves fee/margin. order_local → canonical remap when the order was created offline. */
export const deliveryOpsHandler: OperationHandler = {
  type: "delivery_ops",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as ItemEditPayload;
    if (!p.payload || typeof p.payload !== "object") return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_payload", message: "no delivery-ops payload" };
    const resolved = await resolveEditOrder(p, ctx);
    if ("blocked" in resolved) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" };
    try {
      const r = await ctx.deps.setDeliveryOps({ payload: resolved.payload });
      return { ok: true, canonicalId: (resolved.payload.order_id as string) ?? null, resultMeta: { idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "delivery_ops: transport", message: msg };
      if (isConflictMessage(msg)) return { ok: false, retryClass: "CONFLICT", code: "delivery_ops_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** delivery_set_provider (rc.9) — record the order's delivery PROVIDER (+ optional cost) chosen offline
 *  from the cached, previously-synced AUTHORIZED operational catalog, via pos_delivery_set_provider —
 *  replay-safe on p_client_op_id (pos_op_replay + pos_op_record). This is an internal Breadee record: it
 *  calls no external provider. The server re-validates the provider (active, same OU) + permission at
 *  replay; a provider that became invalid meanwhile → CONFLICT → needs_attention (never silently
 *  dropped, never a different provider). order_local → canonical when the order was created offline. */
export const deliverySetProviderHandler: OperationHandler = {
  type: "delivery_set_provider",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as ItemEditPayload;
    if (!p.payload || typeof p.payload !== "object") return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_payload", message: "no provider payload" };
    const resolved = await resolveEditOrder(p, ctx);
    if ("blocked" in resolved) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" };
    try {
      const r = await ctx.deps.setDeliveryProviderOp({ payload: resolved.payload });
      return { ok: true, canonicalId: (resolved.payload.order_id as string) ?? null, resultMeta: { idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "delivery_set_provider: transport", message: msg };
      const t = terminalKind(msg);
      if (t === "permission") return { ok: false, retryClass: "AUTHORITY_REFUSED", code: "permission", message: msg };
      // Provider no longer active / not in this OU / order no longer open → the operator re-chooses.
      return { ok: false, retryClass: "CONFLICT", code: "provider_invalid", message: msg };
    }
  },
};

/** edit_order — edit an open order's NOTE offline (pos_edit_order), exactly-once on client_op_id.
 *  NOTE ONLY (a discount change is never captured offline). Every field is a SET so replay converges.
 *  order_local → canonical remap when the order was created offline. */
export const editOrderHandler: OperationHandler = {
  type: "edit_order",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as ItemEditPayload;
    if (!p.payload || typeof p.payload !== "object") return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_payload", message: "no edit payload" };
    const resolved = await resolveEditOrder(p, ctx);
    if ("blocked" in resolved) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "order not yet synced" };
    try {
      const r = await ctx.deps.editOrder({ payload: resolved.payload });
      return { ok: true, canonicalId: (resolved.payload.order_id as string) ?? null, resultMeta: { idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "edit_order: transport", message: msg };
      if (isConflictMessage(msg)) return { ok: false, retryClass: "CONFLICT", code: "edit_order_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** A table-restructure refusal that means the floor changed since it was loaded — a stale version,
 *  a source no longer occupied / already settled / split / on-account, or a bill that moved. All are
 *  CONFLICTS the operator resolves (reload the floor + redo), never a hot retry and never a silent
 *  destructive move/merge; the server's locked re-read + client_op_id replay guarantee exactly-once. */
function isTableOpConflict(message: string): boolean {
  const m = message.toLowerCase();
  return (
    isConflictMessage(message) ||
    m.includes("no open bill") ||
    m.includes("no open order") ||
    m.includes("not occupied") ||
    m.includes("not eligible") ||
    m.includes("already") ||
    m.includes("not part of") ||
    m.includes("same table")
  );
}

type MoveTablePayload = { from_table_id: string; to_table_id: string; expected_version: number | null };

/** move_table — move an open bill between CANONICAL tables offline (pos_move_table), exactly-once on
 *  client_op_id. CAS on the from-table; a floor drift → CONFLICT → needs_attention. */
export const moveTableHandler: OperationHandler = {
  type: "move_table",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as MoveTablePayload;
    if (!p.from_table_id || !p.to_table_id) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_table", message: "no table id" };
    try {
      const r = await ctx.deps.moveTable({ fromTableId: p.from_table_id, toTableId: p.to_table_id, expectedVersion: p.expected_version ?? null, clientOpId: op.client_op_id });
      return { ok: true, canonicalId: p.to_table_id, resultMeta: { orders_moved: r.orders_moved, idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "move_table: transport", message: msg };
      if (isTableOpConflict(msg)) return { ok: false, retryClass: "CONFLICT", code: "move_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

type MergeTablesPayload = { primary_table_id: string; source_table_ids: string[]; expected: Record<string, number> };

/** merge_tables — fold source table bills into a primary offline (pos_merge_tables_v3), exactly-once
 *  on client_op_id, atomic server-side. CAS version-map on every table; any drift → CONFLICT →
 *  needs_attention, never a silent destructive merge. */
export const mergeTablesHandler: OperationHandler = {
  type: "merge_tables",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as MergeTablesPayload;
    if (!p.primary_table_id || !Array.isArray(p.source_table_ids) || p.source_table_ids.length === 0) {
      return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_merge_target", message: "no primary or sources" };
    }
    try {
      const r = await ctx.deps.mergeTables({ primaryTableId: p.primary_table_id, sourceTableIds: p.source_table_ids, expected: p.expected ?? {}, clientOpId: op.client_op_id });
      return { ok: true, canonicalId: p.primary_table_id, resultMeta: { merge_id: r.merge_id, sources_merged: r.sources_merged, idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "merge_tables: transport", message: msg };
      if (isTableOpConflict(msg)) return { ok: false, retryClass: "CONFLICT", code: "merge_conflict", message: msg };
      const t = terminalClass(msg);
      return { ok: false, retryClass: t.retryClass, code: t.code, message: msg };
    }
  },
};

/** A receivable-collection refusal that means the outstanding balance/state drifted since it was
 *  proven locally — already settled, over the outstanding balance, or no longer an outstanding
 *  receivable. A CONFLICT the operator resolves (needs_attention); the server re-derives the balance
 *  under its row lock + idempotency, so a duplicate replay returns the cached result (exactly-once)
 *  and a genuine drift never over-collects. */
function isReceivableConflict(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("already settled") ||
    m.includes("exceeds the outstanding") ||
    m.includes("no outstanding receivable") ||
    m.includes("outstanding") ||
    m.includes("not found") ||
    isConflictMessage(message)
  );
}

type ReceivableCollectPayload = {
  order_id: string | null;
  /** Local order entity id to remap to the canonical order id (a receivable created offline). */
  order_local: string | null;
  amount: number;
  method: string;
};

/** receivable_collect — book a payment against ONE on-account order offline (pos_receivable_collect),
 *  exactly-once (server idempotency on client_op_id). An offline-created receivable is remapped
 *  order_local → canonical first. A stale/over balance → CONFLICT → needs_attention; the local
 *  customer-payment event is retained for reconciliation. */
export const receivableCollectHandler: OperationHandler = {
  type: "receivable_collect",
  schemaVersion: 1,
  async replay(op, ctx) {
    const p = (op.payload ?? {}) as ReceivableCollectPayload;
    let orderId = p.order_id;
    if (p.order_local) {
      const c = await ctx.canonicalFor(p.order_local);
      if (!c) return { ok: false, retryClass: "DEPENDENCY_BLOCKED", code: "order_unresolved", message: "receivable not yet synced" };
      orderId = c;
    }
    if (!orderId) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "no_order", message: "no receivable order id" };
    if (!(p.amount > 0)) return { ok: false, retryClass: "VALIDATION_TERMINAL", code: "bad_amount", message: "no collection amount" };
    try {
      const r = await ctx.deps.receivableCollect({ orderId, amount: p.amount, method: p.method, clientOpId: op.client_op_id });
      return { ok: true, canonicalId: orderId, resultMeta: { payment_id: r.payment_id, payment_status: r.payment_status, idempotent: r.idempotent } };
    } catch (e) {
      const msg = errMsg(e);
      if (ctx.deps.isTransport(e)) return { ok: false, retryClass: "TRANSPORT_RETRYABLE", code: "receivable_collect: transport", message: msg };
      const t = terminalKind(msg);
      if (t === "permission") return { ok: false, retryClass: "AUTHORITY_REFUSED", code: "permission", message: msg };
      if (t === "shift_closed") return { ok: false, retryClass: "CONFLICT", code: "shift_closed", message: msg };
      if (isReceivableConflict(msg)) return { ok: false, retryClass: "CONFLICT", code: "receivable_conflict", message: msg };
      return { ok: false, retryClass: "VALIDATION_TERMINAL", code: t ?? "validation", message: msg };
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
  [`${payoutHandler.type}@${payoutHandler.schemaVersion}`]: payoutHandler,
  [`${customerUpsertHandler.type}@${customerUpsertHandler.schemaVersion}`]: customerUpsertHandler,
  [`${editOrderLineHandler.type}@${editOrderLineHandler.schemaVersion}`]: editOrderLineHandler,
  [`${addOrderItemsHandler.type}@${addOrderItemsHandler.schemaVersion}`]: addOrderItemsHandler,
  [`${moveTableHandler.type}@${moveTableHandler.schemaVersion}`]: moveTableHandler,
  [`${mergeTablesHandler.type}@${mergeTablesHandler.schemaVersion}`]: mergeTablesHandler,
  [`${receivableCollectHandler.type}@${receivableCollectHandler.schemaVersion}`]: receivableCollectHandler,
  [`${deliveryOpsHandler.type}@${deliveryOpsHandler.schemaVersion}`]: deliveryOpsHandler,
  [`${editOrderHandler.type}@${editOrderHandler.schemaVersion}`]: editOrderHandler,
  [`${deliverySetProviderHandler.type}@${deliverySetProviderHandler.schemaVersion}`]: deliverySetProviderHandler,
};

export function handlerFor(type: string, schemaVersion: number): OperationHandler | undefined {
  return HANDLERS[`${type}@${schemaVersion}`];
}
