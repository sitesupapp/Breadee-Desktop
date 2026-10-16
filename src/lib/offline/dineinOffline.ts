// Phase C — offline Dine-In capture + local projection glue.
//
// The ONE place that turns Dine-In operator actions into (a) durable Phase-B operations
// and (b) the local `dineDrafts` projection that restores the UI after a restart. It does
// NOT drain or replay — the single Phase-B orchestrator owns that. It only CAPTURES
// (atomically) and READS BACK. Every mutation is written through the operation log +
// dineDrafts in one Dexie transaction, so the UI can never report success for an action
// whose durable record was not committed (and never enqueue an op without the projection
// needed to restore it).
//
// Contracts (certified by Track A): open table -> pos_open_table (dinein_open_table);
// send round -> pos_submit_order (dinein_send_round), with rounds >= 2 pinning
// expected_order_id to the session's canonical order (EXPECTED_ORDER_MISMATCH guard).

import { localdb, type DineDraft, type DineDraftLine, type DineRoundPrintState } from "@/lib/offline/db";
import {
  type OfflineOperation,
  OPERATION_SCHEMA_VERSION,
  getOperation,
} from "@/lib/offline/operationLog";
import type { OperationScope } from "@/lib/offline/operationLog";
import type { SubmitOrderPayload, SubmitOrderItem } from "@/lib/pos/orders";
import type { CartLine, SelectedModifier } from "@/types/pos";
import type { CurrencyCode } from "@/lib/currency";
import { type TableBill, type BillLine, type BillOrder } from "@/types/tables";

const nid = () => crypto.randomUUID();

/** A deterministic uuid derived from stable parts, so a double-tap Send yields the SAME
 *  client_op_id → the server dedups (exactly-once) rather than creating a second round.
 *  128-bit FNV-1a-based digest formatted as an RFC-4122-shaped uuid (v8/custom variant). */
export function deterministicUuid(parts: string[]): string {
  const s = parts.join("\u0001");
  // Four independent 32-bit FNV-1a streams with distinct offsets → 128 bits.
  const seeds = [0x811c9dc5, 0x01000193, 0x9dc5811c, 0x193010001 >>> 0];
  const h = seeds.map((seed) => {
    let x = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
      x ^= s.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
  });
  const hex = h.map((n) => n.toString(16).padStart(8, "0")).join(""); // 32 hex chars
  // RFC-4122-shaped (8-4-4-4-12); version nibble 8 (custom) + variant 8 so it is a valid uuid.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type DineinScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
  shiftId: string | null;
};

function opScope(scope: DineinScope): OperationScope {
  return {
    tenant_id: scope.tenantId,
    branch_id: scope.branchId,
    device_id: scope.deviceId,
    terminal_id: scope.terminalId ?? "",
    cashier_user_id: scope.cashierUserId,
  };
}

function lineToItem(l: DineDraftLine): SubmitOrderItem {
  return {
    menu_item_id: l.menu_item_id ?? "",
    name: l.name,
    base_price: l.base_price,
    quantity: l.quantity,
    kitchen_note: l.kitchen_note,
    ...(l.customization_json ? { customization_json: l.customization_json as SubmitOrderItem["customization_json"] } : {}),
    modifiers: l.modifiers.map((m) => ({ ...m })),
  } as SubmitOrderItem;
}

// ---------------------------------------------------------------------------
// C3 — DINEIN_OFFLINE_READY (deterministic readiness; never a network exception)
// ---------------------------------------------------------------------------

export type OfflineReadyInput = {
  tenantId: string | null;
  branchId: string | null;
  hasFloor: boolean;
  hasTableMap: boolean;
  hasMenu: boolean;
  hasOpenShift: boolean;
  hasPricingConfig: boolean; // tenant currency/rate cached
  needsPrinter: boolean;
  hasPrinterRouting: boolean;
};

export function evaluateDineinOfflineReady(i: OfflineReadyInput): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!i.tenantId) missing.push("tenant context");
  if (!i.branchId) missing.push("operating unit");
  if (!i.hasFloor) missing.push("floor layout");
  if (!i.hasTableMap) missing.push("table list");
  if (!i.hasMenu) missing.push("menu");
  if (!i.hasOpenShift) missing.push("open shift");
  if (!i.hasPricingConfig) missing.push("pricing configuration");
  if (i.needsPrinter && !i.hasPrinterRouting) missing.push("kitchen printer routing");
  return { ready: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// C5 — open table offline (atomic: dinein_open_table op + dineDraft projection)
// ---------------------------------------------------------------------------

export async function openTableOffline(args: {
  scope: DineinScope;
  tableId: string; // canonical table id (configured tables) — known from the cached map/floor
  tableName: string;
  seats: number | null;
  currency: string;
  floorId?: string | null;
  sectionId?: string | null;
  origin?: "offline" | "online";
  baseOrderVersion?: number | null;
}): Promise<DineDraft> {
  const now = new Date().toISOString();
  const localSessionId = nid();
  const openOpId = nid();
  const op: OfflineOperation = {
    operation_id: openOpId,
    operation_type: "dinein_open_table",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(args.scope),
    created_at: now,
    client_op_id: nid(),
    local_entity_id: args.tableId, // canonical for configured tables (identity remap)
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: { name: args.tableName, seats: args.seats, expected_version: args.baseOrderVersion ?? null },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
  const draft: DineDraft = {
    local_session_id: localSessionId,
    tenant_id: args.scope.tenantId,
    branch_id: args.scope.branchId,
    cashier_user_id: args.scope.cashierUserId,
    device_id: args.scope.deviceId,
    terminal_id: args.scope.terminalId ?? null,
    floor_id: args.floorId ?? null,
    section_id: args.sectionId ?? null,
    table_id: args.tableId,
    table_name: args.tableName,
    currency: args.currency,
    open_operation_id: openOpId,
    canonical_order_id: null,
    origin: args.origin ?? "offline",
    base_order_version: args.baseOrderVersion ?? null,
    status: "open",
    lines: [],
    rounds: [],
    draft_revision: 0,
    notes: null,
    created_at: now,
    updated_at: now,
  };
  // ATOMIC: op + projection committed together (C8).
  await localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
    await localdb.operations.add(op);
    await localdb.dineDrafts.add(draft);
  });
  return draft;
}

// ---------------------------------------------------------------------------
// C6 — local bill editing (UNSENT lines only; local-only, no op until "send")
// ---------------------------------------------------------------------------

async function mutateDraft(sessionId: string, fn: (d: DineDraft) => void): Promise<DineDraft> {
  return localdb.transaction("rw", localdb.dineDrafts, async () => {
    const d = await localdb.dineDrafts.get(sessionId);
    if (!d) throw new Error("dine session not found");
    fn(d);
    d.draft_revision += 1;
    d.updated_at = new Date().toISOString();
    await localdb.dineDrafts.put(d);
    return d;
  });
}

export async function addDraftLine(sessionId: string, line: Omit<DineDraftLine, "line_id" | "sent_round"> & { line_id?: string }): Promise<DineDraft> {
  return mutateDraft(sessionId, (d) => {
    d.lines.push({ line_id: line.line_id ?? nid(), sent_round: null, ...line, modifiers: line.modifiers ?? [] });
  });
}

export async function setDraftLineQuantity(sessionId: string, lineId: string, quantity: number): Promise<DineDraft> {
  return mutateDraft(sessionId, (d) => {
    const l = d.lines.find((x) => x.line_id === lineId);
    if (l && l.sent_round === null) l.quantity = quantity;
  });
}

export async function removeDraftLine(sessionId: string, lineId: string): Promise<DineDraft> {
  return mutateDraft(sessionId, (d) => {
    // Only an UNSENT line may be removed locally; a sent line is immutable (server-owned).
    d.lines = d.lines.filter((x) => !(x.line_id === lineId && x.sent_round === null));
  });
}

export async function setDraftNotes(sessionId: string, notes: string | null): Promise<DineDraft> {
  return mutateDraft(sessionId, (d) => {
    d.notes = notes;
  });
}

// ---------------------------------------------------------------------------
// C7/C8/C9 — send a round (ATOMIC: dinein_send_round op + mark lines sent + round record)
// ---------------------------------------------------------------------------

/** Serialize sends per session in-process (the Dexie transaction + deterministic op-id are
 *  the durable correctness boundary; this only avoids a redundant concurrent attempt). */
const sendingSessions = new Set<string>();

export async function sendRoundOffline(sessionId: string): Promise<DineDraft> {
  if (sendingSessions.has(sessionId)) {
    const existing = await localdb.dineDrafts.get(sessionId);
    if (existing) return existing;
  }
  sendingSessions.add(sessionId);
  try {
    return await localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
      const d = await localdb.dineDrafts.get(sessionId);
      if (!d) throw new Error("dine session not found");
      const unsent = d.lines.filter((l) => l.sent_round === null);
      if (unsent.length === 0) return d; // nothing to send

      const seq = d.rounds.length + 1;
      const lineIds = unsent.map((l) => l.line_id).sort();
      // Deterministic op-id: a double-tap Send (same session, same revision, same line set)
      // mints the SAME client_op_id → the server dedups rather than creating a second round.
      const clientOpId = deterministicUuid([d.local_session_id, String(d.draft_revision), ...lineIds]);
      const roundLocalId = nid();
      const opId = nid();

      // R1 establishes the session order (local_entity_id = session). Rounds >=2 bind to it.
      const isFirst = seq === 1;
      const scope: OperationScope = {
        tenant_id: d.tenant_id,
        branch_id: d.branch_id,
        device_id: d.device_id,
        terminal_id: d.terminal_id ?? "",
        cashier_user_id: d.cashier_user_id,
      };
      const prevRoundOpId = d.rounds.length > 0 ? d.rounds[d.rounds.length - 1].operation_id : d.open_operation_id;
      const submit: SubmitOrderPayload = {
        branch_id: d.branch_id,
        order_type: "dine_in",
        status: "sent_to_kitchen",
        shift_id: "", // the drain fills nothing here; dine-in append keys on table_id + open order
        client_op_id: clientOpId,
        notes: d.notes,
        table_id: d.table_id,
        items: unsent.map(lineToItem),
      };
      const op: OfflineOperation = {
        operation_id: opId,
        operation_type: "dinein_send_round",
        schema_version: OPERATION_SCHEMA_VERSION,
        scope,
        created_at: new Date().toISOString(),
        client_op_id: clientOpId,
        local_entity_id: isFirst ? d.local_session_id : roundLocalId,
        canonical_entity_id: null,
        // Strict op-completion chain: open -> R1 -> R2 -> ... (acyclic; a failed prereq blocks).
        dependency_ids: [prevRoundOpId],
        // R>=2 depends on the session's canonical order (resolved by R1).
        depends_on_local_entities: isFirst ? [] : [d.local_session_id],
        payload: { submit, table_local: null, session_local: isFirst ? null : d.local_session_id, table_name: d.table_name, round_seq: seq },
        status: "pending",
        retry_count: 0,
        last_attempt_at: null,
        last_error_code: null,
        last_error_message: null,
        result_meta: null,
        synced_at: null,
      };
      await localdb.operations.add(op);

      for (const l of d.lines) if (l.sent_round === null) l.sent_round = seq;
      d.rounds.push({ round_local_id: roundLocalId, operation_id: opId, seq, line_ids: lineIds, print_state: "not_printed", sent_at: new Date().toISOString() });
      d.draft_revision += 1;
      d.updated_at = new Date().toISOString();
      await localdb.dineDrafts.put(d);
      return d;
    });
  } finally {
    sendingSessions.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// C9/C10 — kitchen print state (tracked SEPARATELY from server sync state)
// ---------------------------------------------------------------------------

export async function setRoundPrintState(sessionId: string, roundLocalId: string, state: DineRoundPrintState): Promise<void> {
  await localdb.transaction("rw", localdb.dineDrafts, async () => {
    const d = await localdb.dineDrafts.get(sessionId);
    if (!d) return;
    const r = d.rounds.find((x) => x.round_local_id === roundLocalId);
    if (r) r.print_state = state;
    d.updated_at = new Date().toISOString();
    await localdb.dineDrafts.put(d);
  });
}

// ---------------------------------------------------------------------------
// Phase D — offline SETTLE of a dine-in table (pay_table), captured against the local session.
// The pay_table op DEPENDS on the session's open + every round op, so on reconnect it replays
// only AFTER those orders exist on the server (else "no open order"). Deterministic op id →
// double-tap idempotent. The draft is NOT mutated (the op is the durable record; the bill stays
// open locally until the settle reconciles), mirroring the refund capture.
// ---------------------------------------------------------------------------

const SETTLE_OP_PREFIX = "paytable:";

/** Durably capture an offline dine-in table settle. Atomic; idempotent on a deterministic id
 *  (same session + method + currency → same op). Requires at least one sent round. */
export async function settleTableOffline(input: {
  sessionId: string;
  method: string;
  discount?: { discount_type?: string; discount_value?: number };
  /** Best-effort LOCAL USD amount of the bill, for the drawer projection only (NOT authoritative;
   *  the server derives the real charge). Omitted when the local USD amount is unknowable. */
  cashAmountUsd?: number | null;
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean }> {
  return localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
    const d = await localdb.dineDrafts.get(input.sessionId);
    if (!d) throw new Error("dine session not found");
    if (d.rounds.length === 0) throw new Error("Nothing has been sent to settle on this table.");
    const clientOpId = deterministicUuid([d.local_session_id, "pay_table", input.method, d.currency]);
    const operationId = SETTLE_OP_PREFIX + clientOpId;
    const existing = await localdb.operations.get(operationId);
    if (existing) return { operationId, clientOpId, alreadyCaptured: true };
    const scope: OperationScope = {
      tenant_id: d.tenant_id,
      branch_id: d.branch_id,
      device_id: d.device_id,
      terminal_id: d.terminal_id ?? "",
      cashier_user_id: d.cashier_user_id,
    };
    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "pay_table",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope,
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: d.table_id,
      // Settle only AFTER the table's open + every round has synced (the orders must exist server-side).
      dependency_ids: [d.open_operation_id, ...d.rounds.map((r) => r.operation_id)],
      depends_on_local_entities: [],
      payload: {
        table_id: d.table_id,
        table_local: null,
        method: input.method,
        currency: d.currency,
        table_name: d.table_name,
        ...(input.discount ? { discount: input.discount } : {}),
        ...(input.cashAmountUsd != null && input.cashAmountUsd > 0 ? { cash_amount_usd: input.cashAmountUsd } : {}),
      },
      status: "pending",
      retry_count: 0,
      last_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      result_meta: null,
      synced_at: null,
    };
    await localdb.operations.add(op);
    return { operationId, clientOpId, alreadyCaptured: false };
  });
}

const ONACCOUNT_OP_PREFIX = "onaccounttable:";

/** Durably capture an offline dine-in table ON-ACCOUNT (receivable) against a LOCALLY-KNOWN
 *  (cached/canonical) customer. Mirrors settleTableOffline: depends on the session's open + rounds
 *  (so the orders exist server-side first), deterministic id (session + customer + method) →
 *  idempotent, draft unchanged. The customer is canonical today; a future offline-created customer
 *  is carried as customer_local so Phase E can remap it. Requires at least one sent round. */
export async function tableOnAccountOffline(input: {
  sessionId: string;
  customerId: string | null;
  customerLocal?: string | null;
  amount: number;
  method: string;
  discount?: { discount_type?: string; discount_value?: number };
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean }> {
  return localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
    const d = await localdb.dineDrafts.get(input.sessionId);
    if (!d) throw new Error("dine session not found");
    if (d.rounds.length === 0) throw new Error("Nothing has been sent to put on account for this table.");
    if (!input.customerId && !input.customerLocal) throw new Error("A customer is required to put this table on account.");
    const clientOpId = deterministicUuid([d.local_session_id, "on_account_table", input.customerId ?? input.customerLocal ?? "", input.method, String(input.amount)]);
    const operationId = ONACCOUNT_OP_PREFIX + clientOpId;
    const existing = await localdb.operations.get(operationId);
    if (existing) return { operationId, clientOpId, alreadyCaptured: true };
    const scope: OperationScope = { tenant_id: d.tenant_id, branch_id: d.branch_id, device_id: d.device_id, terminal_id: d.terminal_id ?? "", cashier_user_id: d.cashier_user_id };
    const dependsLocal: string[] = input.customerLocal ? [input.customerLocal] : [];
    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "on_account_table",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope,
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: d.table_id,
      dependency_ids: [d.open_operation_id, ...d.rounds.map((r) => r.operation_id)],
      depends_on_local_entities: dependsLocal,
      payload: {
        table_id: d.table_id,
        table_local: null,
        customer_id: input.customerId,
        customer_local: input.customerLocal ?? null,
        amount: input.amount,
        method: input.method,
        table_name: d.table_name,
        ...(input.discount ? { discount: input.discount } : {}),
      },
      status: "pending",
      retry_count: 0,
      last_attempt_at: null,
      last_error_code: null,
      last_error_message: null,
      result_meta: null,
      synced_at: null,
    };
    await localdb.operations.add(op);
    return { operationId, clientOpId, alreadyCaptured: false };
  });
}

/** Any captured pay_table op for this session's table in its exact scope (for the UI to show a
 *  table as "settling offline" and to avoid offering a second settle). */
export async function findSettleOpForSession(sessionId: string): Promise<OfflineOperation | undefined> {
  const d = await localdb.dineDrafts.get(sessionId);
  if (!d) return undefined;
  const rows = await localdb.operations.where("operation_type").equals("pay_table").toArray();
  return rows.find(
    (o) =>
      (o.payload as { table_id?: string } | null)?.table_id === d.table_id &&
      o.scope.tenant_id === d.tenant_id &&
      (o.scope.branch_id ?? null) === (d.branch_id ?? null) &&
      o.scope.device_id === d.device_id &&
      o.scope.cashier_user_id === d.cashier_user_id &&
      (d.terminal_id == null || (o.scope.terminal_id || null) === d.terminal_id),
  );
}

// ---------------------------------------------------------------------------
// C13 — reconcile the local projection from synced operations (after a drain).
// Fills canonical_order_id once round 1 syncs; NEVER deletes a draft on sync (the bill
// stays open until closed/paid, which is a later phase). Local data is preserved on
// conflict (the op's needs_attention is the operator-facing signal via Sync History).
// ---------------------------------------------------------------------------

export async function reconcileDineDraftsFromOperations(): Promise<void> {
  const drafts = await localdb.dineDrafts.where("status").equals("open").toArray();
  for (const d of drafts) {
    if (d.canonical_order_id) continue;
    const r1 = d.rounds.find((x) => x.seq === 1);
    if (!r1) continue;
    const op = await getOperation(r1.operation_id);
    if (op?.status === "synced" && op.canonical_entity_id) {
      await localdb.dineDrafts.update(d.local_session_id, { canonical_order_id: op.canonical_entity_id, updated_at: new Date().toISOString() });
    }
  }
}

// ---------------------------------------------------------------------------
// UI adapters — map the cart/draft to the shapes the live Dine-In UI already uses,
// so the existing components render offline with NO change to the components.
// ---------------------------------------------------------------------------

/** Map a live cart line to a draft line (captured prices preserved). */
export function draftLineFromCart(c: CartLine): Omit<DineDraftLine, "line_id" | "sent_round"> & { line_id: string } {
  return {
    line_id: c.key,
    menu_item_id: c.menu_item_id,
    name: c.name,
    base_price: c.base_price,
    quantity: c.quantity,
    kitchen_note: c.kitchen_note,
    modifiers: (c.modifiers as SelectedModifier[]).map((m) => ({
      group_id: (m as { group_id?: string | null }).group_id ?? null,
      option_id: (m as { option_id?: string | null }).option_id ?? null,
      name: m.name,
      price_delta: (m as { price_delta?: number }).price_delta ?? 0,
      quantity: (m as { quantity?: number }).quantity ?? 1,
    })),
    ...(c.removed_ingredients && c.removed_ingredients.length > 0 ? { customization_json: { removed_menu_ingredients: c.removed_ingredients } } : {}),
  };
}

/**
 * A PROVISIONAL local TableBill derived from a draft's SENT rounds, so the existing bill
 * panel / check-bill render offline from the local projection. It is explicitly provisional:
 * the order number is the canonical one once resolved, else a local "OFFLINE" marker, and
 * the authoritative bill (with server modifiers/finance) replaces it on reconnect. Modifiers
 * are folded into the unit price (shown as a total), not itemised, in this provisional view.
 */
export function billFromDraft(draft: DineDraft): TableBill {
  const sent = draft.lines.filter((l) => l.sent_round !== null);
  const ccy = draft.currency as CurrencyCode;
  const lines: BillLine[] = sent.map((l) => {
    const modTotal = l.modifiers.reduce((s, m) => s + m.price_delta * m.quantity, 0);
    const unit = l.base_price + modTotal;
    return {
      id: l.line_id,
      menu_item_id: l.menu_item_id,
      name: l.name,
      quantity: l.quantity,
      base_price: l.base_price,
      modifiers_total: modTotal,
      final_unit_price: unit,
      line_total: unit * l.quantity,
      kitchen_note: l.kitchen_note,
      batch_no: l.sent_round ?? 1,
      modifiers: [],
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const order: BillOrder = {
    id: draft.canonical_order_id ?? draft.local_session_id,
    order_number: draft.canonical_order_id ? "" : "OFFLINE",
    status: "sent_to_kitchen",
    payment_status: "unpaid",
    pos_entity_version: 0,
    shift_id: null,
    branch_id: draft.branch_id,
    tenant_id: draft.tenant_id,
    subtotal,
    discount_amount: 0,
    total_amount: subtotal,
    currency: ccy,
    exchange_rate: null,
    created_at: draft.created_at,
    lines,
  };
  return {
    tableId: draft.table_id,
    orders: lines.length > 0 ? [order] : [],
    subtotal: lines.length > 0 ? subtotal : null,
    total: lines.length > 0 ? subtotal : null,
    currency: lines.length > 0 ? ccy : null,
    mixedCurrency: false,
    splitShift: false,
    batches: Array.from(new Set(sent.map((l) => l.sent_round ?? 1))).sort((a, b) => a - b),
  };
}

/** Find the OPEN local session for a table in the given scope (offline bill/selection). */
export async function getDineDraftForTable(scope: {
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
  deviceId: string | null;
  terminalId?: string | null;
}, tableId: string): Promise<DineDraft | null> {
  if (!scope.tenantId || !tableId) return null;
  const all = await localdb.dineDrafts.where("tenant_id").equals(scope.tenantId).toArray();
  return (
    all.find(
      (d) =>
        d.table_id === tableId &&
        d.status === "open" &&
        (d.branch_id ?? null) === (scope.branchId ?? null) &&
        d.cashier_user_id === scope.cashierUserId &&
        d.device_id === scope.deviceId &&
        (scope.terminalId == null || (d.terminal_id ?? null) === scope.terminalId),
    ) ?? null
  );
}
