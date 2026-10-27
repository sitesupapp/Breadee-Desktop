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
import type { PosRpcName, RpcClient } from "@/lib/pos/rpc";
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

// --- 1.0.38 (C1) — the ONE replay-error classifier -----------------------------------------------
//
// Through 1.0.37 every non-transport error that was not specifically recognised became
// VALIDATION_TERMINAL (needs_attention): a 5xx, an expired JWT, a deadlock, a serialization failure or
// a read-only failover parked a payment for a human. Every replay RPC is idempotent on client_op_id,
// so a transient server fault is safe to retry; only a STRUCTURED business refusal is definitive.

/** How one replay failure is classified:
 *  - transport: no route / connection dropped (the handler's TRANSPORT_RETRYABLE path).
 *  - transient: a server fault that heals by itself (408/429/5xx, deadlock, serialization, lock, read-only
 *    failover, connection limits, MERGE_SHIFT_BUSY) → bounded retry with backoff.
 *  - auth: the JWT expired / the session must be refreshed → refresh, then bounded retry.
 *  - business: a structured refusal (pos_op_error code, 22xxx/23xxx/42xxx/P0001, a known wording) →
 *    terminal as the handler decided (needs_attention).
 *  - unknown: none of the above (no status/code, unrecognised text) → bounded retry, then needs_attention. */
export type ReplayErrorKind = "transport" | "transient" | "auth" | "business" | "unknown";

/** The HTTP status carried by an error (PosRpcError / PostgREST), or null. */
export function errStatus(e: unknown): number | null {
  if (!e || typeof e !== "object") return null;
  const s = (e as { status?: unknown }).status;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

/** The PostgreSQL / PostgREST error code carried by an error, or null. */
export function errCode(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const c = (e as { code?: unknown }).code;
  return typeof c === "string" && c !== "" ? c : null;
}

const TRANSIENT_PG_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled (statement timeout)
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  "53200", // out_of_memory
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "25006", // read_only_sql_transaction (replica failover)
]);
const AUTH_CODES = new Set(["PGRST301", "PGRST302", "PGRST303"]);
const TRANSIENT_MSG =
  /deadlock detected|could not serialize|read-only transaction|could not obtain lock|lock_not_available|lock not available|too many connections|remaining connection slots|bad gateway|service unavailable|gateway time-?out|upstream connect|upstream request timeout|timed out|connection (?:reset|refused|terminated|closed)|econnreset|server closed the connection|statement timeout|temporarily unavailable|internal server error|merge_shift_busy/i;
const AUTH_MSG = /\bjwt\b|refresh token|auth session missing|not authenticated/i;
/** A structured business code in the message or details (pos_op_error `pos_error_code`, or an
 *  UPPER_SNAKE code such as VERSION_CONFLICT / CUSTOMER_IDENTITY_CONFLICT / EXPECTED_ORDER_MISMATCH). */
const STRUCTURED_MSG = /pos_error_code|\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/;
const BUSINESS_PG_CODE = /^(?:P0001|P0002|P0003|P0004|22[0-9A-Z]{3}|23[0-9A-Z]{3}|42[0-9A-Z]{3}|28[0-9A-Z]{3})$/;

/**
 * Classify one replay failure. Order matters: a permission refusal (42501) is business even when
 * PostgREST answers 401/403; an expired JWT is auth; a transient code/status/wording beats any keyword
 * match ("cannot execute … in a read-only transaction" is NOT a validation refusal); only then is a
 * structured code / known wording a definitive business refusal. Pure.
 */
export function classifyReplayError(e: unknown): ReplayErrorKind {
  if (isTransportFailure(e)) return "transport";
  const status = errStatus(e);
  const code = errCode(e);
  const msg = errMsg(e);
  const details = e && typeof e === "object" ? String((e as { details?: unknown }).details ?? "") : "";
  if (code === "42501") return "business";
  if ((code && AUTH_CODES.has(code)) || AUTH_MSG.test(msg) || (status === 401 && !(code && BUSINESS_PG_CODE.test(code)))) return "auth";
  if (code && (TRANSIENT_PG_CODES.has(code) || code.startsWith("08"))) return "transient";
  if (TRANSIENT_MSG.test(msg)) return "transient";
  if (status != null && (status === 408 || status === 429 || status >= 500) && !(code && BUSINESS_PG_CODE.test(code))) return "transient";
  if (code && BUSINESS_PG_CODE.test(code)) return "business";
  if (STRUCTURED_MSG.test(msg) || STRUCTURED_MSG.test(details)) return "business";
  if (rawTerminalKind(msg) !== null) return "business";
  return "unknown";
}

/** Classify a DEFINITIVE (non-transport) server refusal. Transport is handled separately. 1.0.38: a
 *  transient/auth wording ("cannot execute … read-only transaction", "invalid JWT") is never a refusal. */
export function terminalKind(message: string): TerminalKind {
  const k = rawTerminalKind(message);
  if (k === "validation" && (TRANSIENT_MSG.test(message) || AUTH_MSG.test(message))) return null;
  return k;
}

function rawTerminalKind(message: string): TerminalKind {
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

/** 1.0.38 — the exact pos_move_table_v2 request (prod_1038 contract §5.1). Optional keys are OMITTED
 *  (never sent as null) when unknown. */
export type MoveTableV2Request = {
  client_op_id: string;
  from_table_id: string;
  to_table_id: string;
  expected_order_ids: string[];
  expected_paid_settlements?: Record<string, number>;
  expected_from_version?: number;
  expected_to_version?: number;
};
export type MoveTableV2Result = {
  ok: boolean;
  orders_moved: number;
  order_ids: string[];
  table_versions: Record<string, number>;
  idempotent: boolean;
};

/** 1.0.38 — the exact pos_merge_tables_v4 request (prod_1038 contract §5.2). */
export type MergeTablesV4Request = {
  client_op_id: string;
  primary_table_id: string;
  source_table_ids: string[];
  expected_orders: Record<string, string>;
  expected_paid_settlements?: Record<string, number>;
  expected_versions?: Record<string, number>;
};
export type MergeTablesV4Result = {
  ok: boolean;
  merge_id: string;
  primary_order_id: string;
  sources_merged: number;
  /** The primary ORDER version (never a table version — use table_versions for table CAS chaining). */
  pos_entity_version: number | null;
  table_versions: Record<string, number>;
  idempotent: boolean;
};

/** 1.0.38 — the structured business code of a refusal: pos_op_error puts it in `details`
 *  ({"pos_error_code": CODE}); some carry it in the message. Null when none. */
export function posErrorCode(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const details = (e as { details?: unknown }).details;
  if (typeof details === "string" && details.includes("pos_error_code")) {
    try {
      const j = JSON.parse(details) as { pos_error_code?: unknown };
      if (typeof j.pos_error_code === "string" && j.pos_error_code !== "") return j.pos_error_code;
    } catch {
      const m = /"pos_error_code"\s*:\s*"([A-Z0-9_]+)"/.exec(details);
      if (m) return m[1];
    }
  }
  const m = /\b((?:MOVE|MERGE|PAY|ON_ACCOUNT)_[A-Z0-9_]+|VERSION_CONFLICT|ALREADY_SETTLED|ALREADY_PAID|PAYMENT_RESIDUE|SPLIT_DISCOUNT_UNSUPPORTED|IDEMPOTENCY_PAYLOAD_MISMATCH|CROSS_ACTOR_REPLAY_REJECTED|CROSS_OU_REJECTED|OU_ACCESS_DENIED|CROSS_BRANCH_REPLAY_REJECTED|UNSUPPORTED_STATE|SHIFT_ALREADY_OPEN)\b/.exec(errMsg(e));
  return m ? m[1] : null;
}

const numMap = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(x);
      if (x != null && Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
};

export type PosTxnSyncDeps = {
  submit: (payload: SubmitOrderPayload) => Promise<{ order_id: string; order_number: string }>;
  pay: (args: { orderId: string; currency: CurrencyCode; discount?: Record<string, unknown> }) => Promise<unknown>;
  /** Open (or adopt) the shift for an offline-opened Case-2 shift, exactly once. */
  openShift: (args: { branchId: string | null; openingCash: number; clientOpId: string; requireNew?: boolean }) => Promise<{ shiftId: string; reused: boolean }>;
  /** Phase-C: occupy a table / establish the session (pos_open_table, op-id + version CAS). */
  openTable: (payload: OpenTablePayload) => Promise<{ table_id: string; pos_entity_version: number | null }>;
  /** Phase-C: send a dine-in round (pos_submit_order; expected_order_id binds rounds >=2). */
  submitRound: (payload: SubmitOrderPayload) => Promise<{ order_id: string; order_number: string; batch_no: number; appended: boolean; idempotent: boolean }>;
  /** Phase-D (offline split): read the server's {client_line_id, order_item_id} correlation for a
   *  synced round (pos_order_item_map), so local dine-in lines map to canonical order_item rows. */
  orderItemMap: (args: { orderId: string; batchNo: number | null }) => Promise<{ client_line_id: string; order_item_id: string }[]>;
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
   *  method is any ACTIVE catalog key (cash or a dynamic tender); the server derives the amount.
   *  1.0.38 (S5 binding) — `expectedOrderIds` pins the EXACT bill the settle was captured for (set
   *  equality with the table's open orders, under lock): a newer bill on the same table is never paid by
   *  a re-opened parked settle (PAY_BILL_CHANGED; ALREADY_SETTLED when every pinned order is already paid).
   *  `expectedAmount` (order currency, only when known exactly) → PAY_AMOUNT_CHANGED on drift. */
  payTable: (args: {
    tableId: string;
    method: string;
    currency: CurrencyCode;
    discount?: { discount_type?: string; discount_value?: number };
    clientOpId: string;
    expectedOrderIds?: string[] | null;
    expectedAmount?: number | null;
  }) => Promise<{ ok: boolean; amount: number; idempotent: boolean; pos_entity_version?: number | null }>;
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
  /** Phase-D: put a dine-in TABLE bill on a customer's account (pos_complete_table_on_account).
   *  1.0.38 (Bug 9 / S2) — the same bill binding as pay_table: `expectedOrderIds` (set equality with the
   *  table's open orders → ON_ACCOUNT_BILL_CHANGED) and `expectedAmount` = R = T − P in order currency, only
   *  when known exactly (→ ON_ACCOUNT_AMOUNT_CHANGED on drift). Omitted (never null) when unknown. */
  onAccountTable: (args: {
    tableId: string;
    customerId: string;
    amount: number;
    method: string;
    discount?: { discount_type?: string; discount_value?: number };
    clientOpId: string;
    expectedOrderIds?: string[] | null;
    expectedAmount?: number | null;
  }) => Promise<{ ok: boolean; idempotent: boolean }>;
  /** Phase-D: put a single ORDER on a customer's account (pos_complete_on_account). 1.0.38 — same pins. */
  onAccountOrder: (args: {
    orderId: string;
    customerId: string;
    amount: number;
    method: string;
    discount?: { discount_type?: string; discount_value?: number };
    clientOpId: string;
    expectedOrderIds?: string[] | null;
    expectedAmount?: number | null;
  }) => Promise<{ ok: boolean; idempotent: boolean }>;
  /** Phase-D: canonically END a shift (pos_end_shift) — replays LAST, after every shift op. */
  endShiftOp: (args: {
    shiftId: string;
    actualCashCounted: number;
    notes: string | null;
    deliveryFeeCashTreatment?: string;
    clientOpId: string;
  }) => Promise<{ shift_id: string; idempotent: boolean; approval_required?: boolean | null }>;
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
  /** Phase-D: record a cash PAYOUT (pos_payout_create). client_op_id → exactly-once (the RPC
   *  carries the server replay wrapper). The server validates the linked source under its row lock
   *  and prices the cash-out; no currency/USD is sent (the drawer currency is the server's). */
  payout: (args: {
    shiftId: string;
    amount: number;
    sourceType: string;
    sourceId: string;
    note: string | null;
    clientOpId: string;
  }) => Promise<{ payout_id: string; amount: number; amount_usd: number; idempotent: boolean }>;
  /** Phase-E: create/edit a customer (+ optional address) via pos_upsert_customer. client_op_id →
   *  exactly-once (server replay wrapper). A same-OU identity clash surfaces as a CUSTOMER_IDENTITY_
   *  CONFLICT the handler maps to needs_attention (never a silent duplicate / silent re-link). The
   *  payload is the pos_upsert_customer shape (branch_id, optional id/phone/name/notes/address). */
  upsertCustomer: (args: {
    payload: Record<string, unknown>;
    clientOpId: string;
  }) => Promise<{ customer_id: string; address_id: string | null; is_new: boolean }>;
  /** Phase-E: edit one line of an open order (pos_edit_order_line). The payload is the exact
   *  pre-built p_payload (op/line/quantity/modifiers + expected_version + reason + client_op_id);
   *  the dep only re-points order_id to the canonical id when the order was created offline. */
  editOrderLine: (args: { payload: Record<string, unknown> }) => Promise<{ ok: boolean; idempotent: boolean; replacement_order_item_id?: string | null; pos_entity_version?: number | null }>;
  /** Phase-E: add new lines to an open delivery order (pos_add_order_items). Same payload contract. */
  addOrderItems: (args: { payload: Record<string, unknown> }) => Promise<{ ok: boolean; idempotent: boolean; pos_entity_version?: number | null }>;
  /** rc.9: set an order's delivery PROVIDER (+ cost) chosen offline from the cached authorized catalog
   *  (pos_delivery_set_provider, replay-safe on p_client_op_id). Payload: order_id, provider_id, cost,
   *  cost_provided, client_op_id. Internal Breadee record — no external provider call. */
  setDeliveryProviderOp: (args: { payload: Record<string, unknown> }) => Promise<{ ok: boolean; idempotent: boolean }>;
  /** Phase-F (rc.8): set an order's internal delivery ops (pos_set_delivery_ops). Payload carries
   *  order_id + handler_type/delivered_by_user_id/person_ref/cost + client_op_id. Replay-safe. */
  setDeliveryOps: (args: { payload: Record<string, unknown> }) => Promise<{ ok: boolean; idempotent: boolean }>;
  /** Phase-F (rc.8): edit an order's NOTE (pos_edit_order). Payload is the exact p_payload
   *  (order_id + note + client_op_id). Replay-safe; every field is a SET so replay converges. */
  editOrder: (args: { payload: Record<string, unknown> }) => Promise<{ ok: boolean; idempotent: boolean }>;
  /** 1.0.38 (Bugs 5/6) — offline MOVE TABLE replay (pos_move_table_v2, contract §5.1). `payload` is the
   *  FROZEN request (client_op_id + from/to + bill pins + optional versions), sent byte-identically on
   *  every retry so the server fingerprint is stable and a lost response replays the cached result. */
  moveTableV2: (args: { payload: MoveTableV2Request }) => Promise<MoveTableV2Result>;
  /** 1.0.38 (Bugs 5/6) — offline MERGE TABLES replay (pos_merge_tables_v4, contract §5.2). Same frozen-
   *  request rule. `table_versions` in the result chains this device's next table CAS. */
  mergeTablesV4: (args: { payload: MergeTablesV4Request }) => Promise<MergeTablesV4Result>;
  /** Phase-F: collect a payment against ONE on-account order (pos_receivable_collect). Exactly-once
   *  via the server's pos_operation_idempotency on client_op_id; the server re-derives the
   *  outstanding balance under a FOR UPDATE lock and refuses over-collection → a stale/over balance
   *  is a structured conflict. `amount` is in the order's primary currency (the server prices USD). */
  receivableCollect: (args: { orderId: string; amount: number; method: string; clientOpId: string }) => Promise<{ ok: boolean; payment_id: string | null; payment_status: string; idempotent: boolean }>;
  isTransport: (e: unknown) => boolean;
  hasSession: () => Promise<boolean>;
  /** 1.0.38 (C1) — refresh the auth session after a replay failed on an expired/invalid JWT, so the
   *  next attempt carries a fresh token. Resolves true when a session is available afterwards. Optional:
   *  a missing dep simply skips the refresh (the op stays bounded-retryable). */
  refreshSession?: () => Promise<boolean>;
};

/** Offline-first recovery — a PARKED user's own client (their own session): replay of their captured work
 *  never runs on the active user's session. `rpc` for POS RPCs; `auth` for the session checks. */
export type ReplayClient = RpcClient & {
  auth: {
    getSession(): Promise<{ data: { session: unknown } }>;
    refreshSession(): Promise<{ data: { session: unknown }; error: unknown }>;
  };
};

/** The replay deps over an explicit client (a parked user's), or the live session's client (null). */
export function makePosTxnSyncDeps(client: ReplayClient | null): PosTxnSyncDeps {
  const rc = client ?? undefined;
  const callPosRpc = async (name: PosRpcName, args: Record<string, unknown>) => (await import("@/lib/pos/rpc")).callPosRpc(name, args, rc);
  return {
  // The network modules are imported LAZILY (they transitively load the Supabase
  // client / Vite env). Tests inject their own deps and never reach these, so the
  // module graph stays importable without a browser env.
  submit: async (payload) => {
    const { submitOrder } = await import("@/lib/pos/orders");
    const saved = await submitOrder(payload, rc);
    return { order_id: saved.order_id, order_number: saved.order_number };
  },
  pay: async (args) => {
    const { payOrder } = await import("@/lib/pos/payments");
    return payOrder({ orderId: args.orderId, method: "cash", currency: args.currency, discount: args.discount }, rc);
  },
  openShift: async (args) => {
    const { openShiftWithOp } = await import("@/lib/pos/shifts");
    return openShiftWithOp(args, rc);
  },
  openTable: async (payload) => {
    const row = (await callPosRpc("pos_open_table", { p_payload: payload })) as Record<string, unknown>;
    return { table_id: String(row.table_id), pos_entity_version: row.pos_entity_version == null ? null : Number(row.pos_entity_version) };
  },
  submitRound: async (payload) => {
    const { submitOrder } = await import("@/lib/pos/orders");
    const r = await submitOrder(payload, rc);
    return { order_id: r.order_id, order_number: r.order_number, batch_no: r.batch_no ?? 1, appended: r.appended ?? true, idempotent: r.idempotent ?? false };
  },
  orderItemMap: async (args) => {
    const rows = (await callPosRpc("pos_order_item_map", { p_order: args.orderId, p_batch: args.batchNo })) as unknown;
    if (!Array.isArray(rows)) return [];
    return (rows as Record<string, unknown>[])
      .filter((r) => r.client_line_id != null && r.order_item_id != null)
      .map((r) => ({ client_line_id: String(r.client_line_id), order_item_id: String(r.order_item_id) }));
  },
  voidRefund: async (args) => {
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
    const payload: Record<string, unknown> = {
      table_id: args.tableId,
      method: args.method,
      currency_code: args.currency,
      client_op_id: args.clientOpId,
    };
    if (args.discount?.discount_type !== undefined) payload.discount_type = args.discount.discount_type;
    if (args.discount?.discount_value !== undefined) payload.discount_value = args.discount.discount_value;
    // 1.0.38 (S5) — the bill-identity / amount pins; omitted (never null) when unknown, so an older
    // caller's request is unchanged.
    if (args.expectedOrderIds && args.expectedOrderIds.length > 0) payload.expected_order_ids = args.expectedOrderIds;
    if (args.expectedAmount != null && Number.isFinite(args.expectedAmount)) payload.expected_amount = args.expectedAmount;
    const row = (await callPosRpc("pos_pay_table", { p_payload: payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: row.ok === true, amount: row.amount == null ? 0 : Number(row.amount), idempotent, pos_entity_version: row.pos_entity_version == null ? null : Number(row.pos_entity_version) };
  },
  payOrderOp: async (args) => {
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
    const payload: Record<string, unknown> = { table_id: args.tableId, customer_id: args.customerId, amount: args.amount, method: args.method, client_op_id: args.clientOpId };
    if (args.discount?.discount_type !== undefined) payload.discount_type = args.discount.discount_type;
    if (args.discount?.discount_value !== undefined) payload.discount_value = args.discount.discount_value;
    if (args.expectedOrderIds && args.expectedOrderIds.length > 0) payload.expected_order_ids = args.expectedOrderIds;
    if (args.expectedAmount != null && Number.isFinite(args.expectedAmount)) payload.expected_amount = args.expectedAmount;
    const row = (await callPosRpc("pos_complete_table_on_account", { p_payload: payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: true, idempotent };
  },
  onAccountOrder: async (args) => {
    const payload: Record<string, unknown> = { order_id: args.orderId, customer_id: args.customerId, amount: args.amount, method: args.method, client_op_id: args.clientOpId };
    if (args.discount?.discount_type !== undefined) payload.discount_type = args.discount.discount_type;
    if (args.discount?.discount_value !== undefined) payload.discount_value = args.discount.discount_value;
    if (args.expectedOrderIds && args.expectedOrderIds.length > 0) payload.expected_order_ids = args.expectedOrderIds;
    if (args.expectedAmount != null && Number.isFinite(args.expectedAmount)) payload.expected_amount = args.expectedAmount;
    const row = (await callPosRpc("pos_complete_on_account", { p_payload: payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: true, idempotent };
  },
  endShiftOp: async (args) => {
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
    // 1.0.38 (Bug 3) — server truth for the branch's End-Shift approval rule (cached for a chained offline open).
    return { shift_id: String(row.shift_id ?? args.shiftId), idempotent, approval_required: typeof row.approval_required === "boolean" ? row.approval_required : null };
  },
  splitSettle: async (args) => {
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
  payout: async (args) => {
    const { buildPayoutCreatePayload } = await import("@/lib/pos/payouts");
    const row = (await callPosRpc("pos_payout_create", {
      p_payload: buildPayoutCreatePayload({
        shiftId: args.shiftId,
        amount: args.amount,
        sourceType: args.sourceType as import("@/lib/pos/payouts").PayoutSourceType,
        sourceId: args.sourceId,
        note: args.note,
        clientOpId: args.clientOpId,
      }),
    })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return {
      payout_id: String(row.payout_id ?? ""),
      amount: row.amount == null ? 0 : Number(row.amount),
      amount_usd: row.amount_usd == null ? 0 : Number(row.amount_usd),
      idempotent,
    };
  },
  upsertCustomer: async (args) => {
    const row = (await callPosRpc("pos_upsert_customer", {
      p_payload: { ...args.payload, client_op_id: args.clientOpId },
    })) as Record<string, unknown>;
    // A same-OU identity clash returns a conflict envelope, never a customer_id — raise a message
    // the handler classifies as a CONFLICT (needs_attention), never a silent duplicate / re-link.
    if (row.conflict === true || row.code === "CUSTOMER_IDENTITY_CONFLICT") {
      throw new Error(`CUSTOMER_IDENTITY_CONFLICT: ${String(row.reason ?? "a different customer already has this number")}`);
    }
    return {
      customer_id: String(row.customer_id ?? ""),
      address_id: row.address_id == null ? null : String(row.address_id),
      is_new: row.is_new === true,
    };
  },
  editOrderLine: async (args) => {
    const row = (await callPosRpc("pos_edit_order_line", { p_payload: args.payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return {
      ok: row.ok !== false,
      idempotent,
      replacement_order_item_id: row.replacement_order_item_id == null ? null : String(row.replacement_order_item_id),
      pos_entity_version: row.pos_entity_version == null ? null : Number(row.pos_entity_version),
    };
  },
  addOrderItems: async (args) => {
    const row = (await callPosRpc("pos_add_order_items", { p_payload: args.payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: row.ok !== false, idempotent, pos_entity_version: row.pos_entity_version == null ? null : Number(row.pos_entity_version) };
  },
  setDeliveryProviderOp: async (args) => {
    const { setDeliveryProviderReplay } = await import("@/lib/pos/deliveryProviderCapture");
    const p = args.payload;
    const r = await setDeliveryProviderReplay({
      orderId: String(p.order_id),
      providerId: String(p.provider_id),
      cost: { value: p.cost == null ? null : Number(p.cost), provided: p.cost_provided === true },
      clientOpId: String(p.client_op_id),
    }, rc);
    return { ok: true, idempotent: r.idempotent };
  },
  setDeliveryOps: async (args) => {
    const p = args.payload;
    const row = (await callPosRpc("pos_set_delivery_ops", {
      p_order_id: p.order_id,
      p_delivery_handler_type: p.handler_type ?? null,
      p_delivered_by_user_id: p.delivered_by_user_id ?? null,
      p_delivery_person_ref: p.person_ref ?? null,
      p_delivery_cost: p.cost ?? null,
      p_client_op_id: p.client_op_id,
    })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: row.ok !== false, idempotent };
  },
  editOrder: async (args) => {
    const row = (await callPosRpc("pos_edit_order", { p_payload: args.payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return { ok: row.ok !== false, idempotent };
  },
  moveTableV2: async (args) => {
    // REQUEST (rpc.ts, not owned here): add "pos_move_table_v2" to PosRpcName. Until then the name is
    // asserted at this one call site; the wire call is identical.
    const row = (await callPosRpc("pos_move_table_v2" as PosRpcName, { p_payload: args.payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return {
      ok: row.ok !== false,
      orders_moved: row.orders_moved == null ? 0 : Number(row.orders_moved),
      order_ids: Array.isArray(row.order_ids) ? (row.order_ids as unknown[]).map(String) : [],
      table_versions: numMap(row.table_versions),
      idempotent,
    };
  },
  mergeTablesV4: async (args) => {
    // REQUEST (rpc.ts): add "pos_merge_tables_v4" to PosRpcName (see moveTableV2).
    const row = (await callPosRpc("pos_merge_tables_v4" as PosRpcName, { p_payload: args.payload })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return {
      ok: row.ok !== false,
      merge_id: String(row.merge_id ?? ""),
      primary_order_id: String(row.primary_order_id ?? ""),
      sources_merged: row.sources_merged == null ? 0 : Number(row.sources_merged),
      pos_entity_version: row.pos_entity_version == null ? null : Number(row.pos_entity_version),
      table_versions: numMap(row.table_versions),
      idempotent,
    };
  },
  receivableCollect: async (args) => {
    const row = (await callPosRpc("pos_receivable_collect", {
      p_payload: { order_id: args.orderId, amount: args.amount, method: args.method, client_op_id: args.clientOpId },
    })) as Record<string, unknown>;
    const idempotent = row.idempotent === true || row.idempotent_replay === true || row.result_code === "DUPLICATE_REPLAY_RETURNED";
    return {
      ok: row.ok !== false,
      payment_id: row.payment_id == null ? null : String(row.payment_id),
      payment_status: String(row.payment_status ?? ""),
      idempotent,
    };
  },
  isTransport: isTransportFailure,
  hasSession: async () => {
    const auth = client ? client.auth : (await import("@/lib/supabase")).supabase.auth;
    const { data } = await auth.getSession();
    return Boolean(data.session);
  },
  refreshSession: async () => {
    try {
      const auth = client ? client.auth : (await import("@/lib/supabase")).supabase.auth;
      const { data, error } = await auth.refreshSession();
      return !error && Boolean(data.session);
    } catch {
      return false;
    }
  },
  };
}

export const defaultDeps: PosTxnSyncDeps = makePosTxnSyncDeps(null);


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
  // Final Foundation (PERF): ONE bulkGet for every id the report names (was one read per id, incl. every
  // deferred out-of-scope op).
  const ids = [...new Set([...r.drained, ...r.needsAttention.map((n) => n.id), ...r.retryable, ...r.skippedBackoff, ...r.deferred])];
  const { localdb } = await import("@/lib/offline/db");
  const rows = ids.length > 0 ? await localdb.operations.bulkGet(ids) : [];
  const byId = new Map(ids.map((id, i) => [id, rows[i]] as const));
  const ref = async (id: string) => {
    const op = byId.has(id) ? byId.get(id) : await getOperation(id);
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
  const { updateOperation, requeueDependents, requestDrain } = await import("@/lib/offline/operationLog");
  const opId = `mig:txn:${localTxnId}`;
  await updateOperation(opId, {
    status: "pending",
    last_error_code: null,
    last_error_message: null,
    server_retry_count: 0,
  }).catch(() => undefined);
  // 1.0.38 (C2) — an operator retry re-opens the dependency_failed chain behind it and asks for a drain.
  await requeueDependents([opId]).catch(() => undefined);
  requestDrain("operator-retry");
}
