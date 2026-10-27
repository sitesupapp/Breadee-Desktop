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

import { localdb, readCachedBill, readCachedTableMap, type DineDraft, type DineDraftLine, type DineRoundPrintState } from "@/lib/offline/db";
import {
  type OfflineOperation,
  OPERATION_SCHEMA_VERSION,
  getOperation,
  normalizeCustomerRef,
} from "@/lib/offline/operationLog";
import type { OperationScope } from "@/lib/offline/operationLog";
import { opInScope, sessionClosure, settleHeldByRefusedStructural, settleStillCovers, structuralRefusedByServer } from "@/lib/offline/operationalProjection";
import { resolveOperationalShift } from "@/lib/offline/shiftIdentity";
import type { SubmitOrderPayload, SubmitOrderItem } from "@/lib/pos/orders";
import type { CartLine, SelectedModifier } from "@/types/pos";
import type { CurrencyCode } from "@/lib/currency";
import { type TableBill, type BillLine, type BillOrder, type TableSummary } from "@/types/tables";

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

/** True for an RFC-4122-shaped uuid. `_pos_insert_order_items` casts client_line_id to ::uuid, so a
 *  non-uuid value (the pre-rc.9 cart key "line-N") makes the WHOLE round submit fail (22P02) — the
 *  rc.8 dine-in replay bug. Only a uuid line id is ever sent; anything else is omitted (the round
 *  still replays; that legacy line simply cannot be correlated for a later offline split/edit). */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function lineToItem(l: DineDraftLine): SubmitOrderItem {
  return {
    menu_item_id: l.menu_item_id ?? "",
    name: l.name,
    base_price: l.base_price,
    quantity: l.quantity,
    kitchen_note: l.kitchen_note,
    // Phase D — the stable local line id travels as client_line_id so the server can correlate the
    // inserted canonical order_item back to this local line (pos_order_item_map), enabling offline
    // split/edit of a locally-sent round. Online/other callers omit it (server stores NULL).
    ...(isUuid(l.line_id) ? { client_line_id: l.line_id } : {}),
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

/**
 * rc.12 — the shift reference a dine-in session's orders are created under. The active shift id is
 * either canonical, or the LOCAL id of a shift opened offline (a pendingShifts row): the local one
 * travels as `shift_local` and is remapped to the canonical shift at replay (exactly like an offline
 * takeaway/delivery sale), so the server never creates a shift-less dine-in order.
 */
export async function resolveShiftRef(shiftId: string | null | undefined): Promise<{ shift_id: string | null; shift_local: string | null }> {
  // rc.14 — delegates to the ONE shift-identity contract (Takeaway / Delivery / Dine-In never diverge).
  return resolveOperationalShift(shiftId);
}

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
  /** rc.9 — the table's ALREADY-OPEN canonical order (from the cached bill), when this local session
   *  continues an occupied table. The session is then BOUND to it: round 1 pins expected_order_id to
   *  it (a remotely closed/replaced bill is refused → needs_attention, never a silent second bill), and
   *  the open op adopts the occupied table (no table-version CAS, which a stale cached map would trip
   *  for a table that is already occupied — the order pin is the precise guard). */
  canonicalOrderId?: string | null;
  /** rc.10 — the table was SETTLED locally (offline) and is being reused for a NEW order: the new open
   *  replays only AFTER that settle (dependency) and takes its expected table version from the settle's
   *  server-returned version (pos_pay_table bumps it) — so the new bill can never join the old one and
   *  our own settle never trips the new open's CAS. */
  afterSettleOpId?: string | null;
}): Promise<DineDraft> {
  const now = new Date().toISOString();
  const localSessionId = nid();
  const openOpId = nid();
  const bound = typeof args.canonicalOrderId === "string" && args.canonicalOrderId !== "";
  const afterSettle = typeof args.afterSettleOpId === "string" && args.afterSettleOpId !== "" ? args.afterSettleOpId : null;
  const op: OfflineOperation = {
    operation_id: openOpId,
    operation_type: "dinein_open_table",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(args.scope),
    created_at: now,
    client_op_id: nid(),
    local_entity_id: args.tableId, // canonical for configured tables (identity remap)
    canonical_entity_id: null,
    dependency_ids: afterSettle ? [afterSettle] : [],
    depends_on_local_entities: [],
    payload: {
      name: args.tableName,
      seats: args.seats,
      expected_version: bound || afterSettle ? null : (args.baseOrderVersion ?? null),
      ...(afterSettle ? { version_after_op: afterSettle } : {}),
    },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
  const shiftRef = await resolveShiftRef(args.scope.shiftId);
  const draft: DineDraft = {
    local_session_id: localSessionId,
    ...shiftRef,
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
    canonical_order_id: bound ? (args.canonicalOrderId as string) : null,
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

/**
 * 1.0.38 — stage the cart as EXACTLY the session's unsent round: the draft's UNSENT lines are replaced by
 * `lines` (sent lines are untouched). The cart is the only producer of unsent draft lines and stays the
 * source of truth until the round is durably sent, so a Send that failed AFTER staging (e.g. a refused
 * shift check) and is retried never stages the same cart lines twice — the duplicate-items path the
 * Hush 261024-0045 review looked for (an append-then-send retry used to re-append every line).
 */
export async function stageUnsentDraftLines(sessionId: string, lines: (Omit<DineDraftLine, "line_id" | "sent_round"> & { line_id?: string })[]): Promise<DineDraft> {
  return mutateDraft(sessionId, (d) => {
    d.lines = [
      ...d.lines.filter((x) => x.sent_round !== null),
      ...lines.map((line) => ({ line_id: line.line_id ?? nid(), sent_round: null, ...line, modifiers: line.modifiers ?? [] })),
    ];
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

/** rc.12 — refused send of a NEW dine-in order with no provable shift (never a shift-less server order). */
export const SHIFT_MISSING_MESSAGE =
  "This table's bill was started by an earlier build without a shift, so it cannot be sent offline safely. Reconnect and send it online, or open the table again on this shift.";

/** 1.0.38 (G1) — a round may never join a bill that is closed (settled here, or closed elsewhere: paid online,
 *  fully split, closed remotely). The caller opens a NEW session for the table instead (getDineDraftForTable). */
export const SESSION_CLOSED_MESSAGE = "This table's previous bill is already closed. Send the round again to start a new bill.";

export async function sendRoundOffline(
  sessionId: string,
  /** rc.12 — the cashier's CURRENT shift. A pre-rc.12 session (no shift reference) is attached to it only
   *  when PROVABLY its own: the session was opened at/after this shift opened (same 5-D scope). */
  opts: { currentShift?: { id: string; openedAt: string | null } | null } = {},
): Promise<DineDraft> {
  if (sendingSessions.has(sessionId)) {
    const existing = await localdb.dineDrafts.get(sessionId);
    if (existing) return existing;
  }
  sendingSessions.add(sessionId);
  try {
    // Upgrade backfill (resolved OUTSIDE the transaction: it reads pendingShifts).
    let backfill: { shift_id: string | null; shift_local: string | null } | null = null;
    let pre = await localdb.dineDrafts.get(sessionId);
    // 1.0.38 (G1) — first retire the session if its bill is authoritatively closed (never a round N+1 of it).
    if (pre && pre.status === "open") {
      await retireClosedSessions({ tenantId: pre.tenant_id, branchId: pre.branch_id, tableId: pre.table_id });
      pre = await localdb.dineDrafts.get(sessionId);
    }
    const cur = opts.currentShift ?? null;
    if (pre && !pre.shift_id && !pre.shift_local && cur?.id && cur.openedAt) {
      const created = Date.parse(pre.created_at);
      const opened = Date.parse(cur.openedAt);
      if (Number.isFinite(created) && Number.isFinite(opened) && created >= opened - 1000) backfill = await resolveShiftRef(cur.id);
    }
    return await localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
      const d = await localdb.dineDrafts.get(sessionId);
      if (!d) throw new Error("dine session not found");
      const unsent = d.lines.filter((l) => l.sent_round === null);
      if (unsent.length === 0) return d; // nothing to send
      if (d.status !== "open") throw new Error(SESSION_CLOSED_MESSAGE);
      if (!d.shift_id && !d.shift_local && backfill) Object.assign(d, backfill);
      // FAIL CLOSED: a round that would CREATE a new server order (round 1 of an unbound session) is
      // never sent without a shift — that is exactly the rc.4–rc.11 shift-less order the server can then
      // never settle. Appends (bound session / later rounds) keep the order's own shift server-side.
      if (!d.shift_id && !d.shift_local && d.rounds.length === 0 && !d.canonical_order_id) throw new Error(SHIFT_MISSING_MESSAGE);

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
        // rc.12 — the session's shift (canonical now, or remapped from shift_local at replay). It was ""
        // through rc.11, which created every offline dine-in order SHIFT-LESS on the server.
        shift_id: d.shift_id ?? "",
        client_op_id: clientOpId,
        notes: d.notes,
        table_id: d.table_id,
        // rc.9 — a session that CONTINUES an occupied table's canonical bill pins round 1 to it (rounds
        // >= 2 pin via session_local at replay). Absent for a table opened fresh offline (unchanged).
        ...(isFirst && d.canonical_order_id ? { expected_order_id: d.canonical_order_id } : {}),
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
        // 1.0.38 — plus the offline move / merge that brought this bill to its table (barrier): the round
        // targets the table the bill is on AFTER it (submit.table_id), so it must never replay before it.
        dependency_ids: Array.from(new Set([prevRoundOpId, ...(d.structural_op_id ? [d.structural_op_id] : [])])),
        // R>=2 depends on the session's canonical order (resolved by R1); an offline-opened shift
        // must resolve before any round (the order is created ON that shift).
        depends_on_local_entities: [...(isFirst ? [] : [d.local_session_id]), ...(d.shift_local ? [d.shift_local] : [])],
        payload: { submit, table_local: null, session_local: isFirst ? null : d.local_session_id, shift_local: d.shift_local ?? null, table_name: d.table_name, round_seq: seq },
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

/** rc.13 — a repeat of a settle / on-account the server already REFUSED (the bill is still unpaid). */
export const SETTLE_REFUSED_MESSAGE =
  "This table's earlier payment was refused by the server, so the bill is still unpaid. Review it in the Sync Center, or settle it online.";

/** Durably capture an offline dine-in table settle. Atomic; idempotent on a deterministic id
 *  (same session + method + currency → same op). Requires at least one sent round. */
/** rc.9 — the settle/on-account target when the table has NO local session: an occupied CANONICAL
 *  table whose bill is known on this device only from the cached bill (no offline round yet). */
export type CanonicalTableTarget = {
  scope: DineinScope;
  tableId: string;
  tableName: string;
  currency: string;
  /** The cached bill's canonical order ids — part of the idempotency key so a later, different bill on
   *  the same table is never deduped against an earlier settle. */
  orderIds: string[];
};

function canonicalTableScope(t: CanonicalTableTarget): OperationScope {
  return opScope(t.scope);
}

/** Deterministic op id for a canonical-only table action: full 5-D scope + table + the exact bill
 *  (its canonical order ids) + the action parts — a double-tap / restart is exactly-once. */
function canonicalTableOpId(t: CanonicalTableTarget, parts: string[]): string {
  const s = t.scope;
  return deterministicUuid([s.tenantId, s.branchId ?? "", s.cashierUserId, s.deviceId, s.terminalId ?? "", t.tableId, ...[...t.orderIds].sort(), ...parts]);
}

export async function settleTableOffline(input: {
  sessionId: string | null;
  /** Used only when sessionId is null (a canonical-only occupied table). */
  table?: CanonicalTableTarget;
  method: string;
  discount?: { discount_type?: string; discount_value?: number };
  /** Best-effort LOCAL USD amount of the bill, for the drawer projection only (NOT authoritative;
   *  the server derives the real charge). Omitted when the local USD amount is unknowable. */
  cashAmountUsd?: number | null;
  /** rc.9 — every still-unsynced mutation of this bill (item edits / split legs) from the operational
   *  projection: the settle replays only AFTER them, so the server never charges a pre-edit total. */
  extraDependencyIds?: string[];
  /** rc.10 — exactly what this settle covers: the canonical order ids of the ACTIVE bill and whether a
   *  canonical SUMMARY (no cached lines) is part of it. Recorded on the op so the operational projection
   *  can close exactly that bill locally (the table becomes reusable) without guessing. */
  covers?: { orderIds: string[]; summary: boolean };
  /** 1.0.38 (S5, G3) — the amount THIS DEVICE collected, in ORDER currency (R_local after the discount, see
   *  offlineSettleAmount / offlineSettlePin). Always recorded when known; replayed as pos_pay_table
   *  expected_amount, so a bill another terminal changed meanwhile is refused (PAY_AMOUNT_CHANGED). */
  expectedAmount?: number | null;
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean }> {
  return localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
    const d = input.sessionId ? await localdb.dineDrafts.get(input.sessionId) : undefined;
    if (input.sessionId && !d) throw new Error("dine session not found");
    if (!d && !input.table) throw new Error("This table isn't available offline. Reconnect to settle it.");
    if (d && d.rounds.length === 0 && !input.table) throw new Error("Nothing has been sent to settle on this table.");
    const tableId = d ? d.table_id : (input.table as CanonicalTableTarget).tableId;
    const currency = d ? d.currency : (input.table as CanonicalTableTarget).currency;
    const tableName = d ? d.table_name : (input.table as CanonicalTableTarget).tableName;
    const clientOpId = d
      ? deterministicUuid([d.local_session_id, "pay_table", input.method, d.currency])
      : canonicalTableOpId(input.table as CanonicalTableTarget, ["pay_table", input.method, currency]);
    const operationId = SETTLE_OP_PREFIX + clientOpId;
    const existing = await localdb.operations.get(operationId);
    if (existing) {
      // rc.13 — the SAME settle was already refused by the server (SETTLEMENT_CONFLICT): re-tapping Pay must
      // never mark the bill paid again on top of a refusal (LOCAL SUCCESS RULE). The operator resolves it
      // in the Sync Center (retry once the cause is fixed) or online.
      if (!settleStillCovers(existing)) throw new Error(SETTLE_REFUSED_MESSAGE);
      if (d && d.status === "open") await markDraftSettled(d, operationId);
      return { operationId, clientOpId, alreadyCaptured: true };
    }
    const scope: OperationScope = d
      ? {
          tenant_id: d.tenant_id,
          branch_id: d.branch_id,
          device_id: d.device_id,
          terminal_id: d.terminal_id ?? "",
          cashier_user_id: d.cashier_user_id,
        }
      : canonicalTableScope(input.table as CanonicalTableTarget);
    const sessionDeps = d ? sessionBarrier(d) : [];
    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "pay_table",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope,
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: tableId,
      // Settle only AFTER the table's open + every round + every pending item edit/split leg has synced.
      dependency_ids: Array.from(new Set([...sessionDeps, ...(input.extraDependencyIds ?? [])])),
      depends_on_local_entities: [],
      payload: {
        table_id: tableId,
        table_local: null,
        method: input.method,
        currency,
        table_name: tableName,
        ...(input.discount ? { discount: input.discount } : {}),
        ...(input.cashAmountUsd != null && input.cashAmountUsd > 0 ? { cash_amount_usd: input.cashAmountUsd } : {}),
        ...(input.expectedAmount != null && Number.isFinite(input.expectedAmount) ? { expected_amount: input.expectedAmount } : {}),
        // What this settle covers: projection metadata, AND (1.0.38 S5) the bill pins the handler resolves
        // to expected_order_ids at replay — a re-opened settle can never pay a newer bill on the table.
        covers: settleCovers(d, input.covers, input.table),
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
    // rc.10 — LOCAL SETTLEMENT: the session is no longer the table's ACTIVE bill (atomic with the op).
    if (d) await markDraftSettled(d, operationId);
    return { operationId, clientOpId, alreadyCaptured: false };
  });
}

/** What any later capture against a session's bill must replay AFTER: its open, every round and — 1.0.38 —
 *  the offline move / merge that brought the bill to its table (a carrier session's open IS that op). */
export function sessionBarrier(d: DineDraft): string[] {
  return Array.from(new Set([d.open_operation_id, ...d.rounds.map((r) => r.operation_id), ...(d.structural_op_id ? [d.structural_op_id] : [])]));
}

/** The projection-only record of exactly which bill a settle covers. */
function settleCovers(d: DineDraft | undefined, covers: { orderIds: string[]; summary: boolean } | undefined, table: CanonicalTableTarget | undefined) {
  return {
    session_local: d?.local_session_id ?? null,
    order_ids: Array.from(new Set([...(covers?.orderIds ?? []), ...(table?.orderIds ?? []), ...(d?.canonical_order_id ? [d.canonical_order_id] : [])])),
    summary: covers?.summary === true,
  };
}

/** rc.10 — LOCAL SETTLEMENT transition: OPEN → SETTLED (pending sync). The draft is kept durably
 *  (lines, rounds, the settle op) for receipt / Sync History / audit, but is never again returned as
 *  the table's active session, so the next order on the table opens a NEW session. Must run inside a
 *  transaction that includes `dineDrafts`. */
async function markDraftSettled(d: DineDraft, settleOpId: string): Promise<void> {
  const now = new Date().toISOString();
  await localdb.dineDrafts.update(d.local_session_id, { status: "settled", settled_operation_id: settleOpId, settled_at: now, updated_at: now });
}

const ONACCOUNT_OP_PREFIX = "onaccounttable:";

/** Durably capture an offline dine-in table ON-ACCOUNT (receivable) against a LOCALLY-KNOWN
 *  (cached/canonical) customer. Mirrors settleTableOffline: depends on the session's open + rounds
 *  (so the orders exist server-side first), deterministic id (session + customer + method) →
 *  idempotent, draft unchanged. The customer is canonical today; a future offline-created customer
 *  is carried as customer_local so Phase E can remap it. Requires at least one sent round. */
export async function tableOnAccountOffline(input: {
  sessionId: string | null;
  /** Used only when sessionId is null (a canonical-only occupied table). */
  table?: CanonicalTableTarget;
  customerId: string | null;
  customerLocal?: string | null;
  amount: number;
  method: string;
  discount?: { discount_type?: string; discount_value?: number };
  /** rc.9 — still-unsynced item edits / split legs of this bill (replay after them). */
  extraDependencyIds?: string[];
  /** rc.10 — the exact bill this on-account closes (see settleTableOffline). */
  covers?: { orderIds: string[]; summary: boolean };
  /** 1.0.38 (Bug 9, G3) — the remaining obligation R = T − P (order currency) THIS DEVICE presented (after the
   *  discount, see offlineSettlePin). Always recorded when known; replayed as expected_amount
   *  (ON_ACCOUNT_AMOUNT_CHANGED when the server's R differs). */
  expectedAmount?: number | null;
}): Promise<{ operationId: string; clientOpId: string; alreadyCaptured: boolean }> {
  // rc.10 — an offline-created customer travels as customer_local (waits for + remaps to canonical).
  input = { ...input, ...(await normalizeCustomerRef(input.customerId, input.customerLocal)) };
  return localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
    const d = input.sessionId ? await localdb.dineDrafts.get(input.sessionId) : undefined;
    if (input.sessionId && !d) throw new Error("dine session not found");
    if (!d && !input.table) throw new Error("This table isn't available offline. Reconnect to put it on account.");
    if (d && d.rounds.length === 0 && !input.table) throw new Error("Nothing has been sent to put on account for this table.");
    if (!input.customerId && !input.customerLocal) throw new Error("A customer is required to put this table on account.");
    const who = input.customerId ?? input.customerLocal ?? "";
    const clientOpId = d
      ? deterministicUuid([d.local_session_id, "on_account_table", who, input.method, String(input.amount)])
      : canonicalTableOpId(input.table as CanonicalTableTarget, ["on_account_table", who, input.method, String(input.amount)]);
    const operationId = ONACCOUNT_OP_PREFIX + clientOpId;
    const existing = await localdb.operations.get(operationId);
    if (existing) {
      if (!settleStillCovers(existing)) throw new Error(SETTLE_REFUSED_MESSAGE);
      if (d && d.status === "open") await markDraftSettled(d, operationId);
      return { operationId, clientOpId, alreadyCaptured: true };
    }
    const scope: OperationScope = d
      ? { tenant_id: d.tenant_id, branch_id: d.branch_id, device_id: d.device_id, terminal_id: d.terminal_id ?? "", cashier_user_id: d.cashier_user_id }
      : canonicalTableScope(input.table as CanonicalTableTarget);
    const tableId = d ? d.table_id : (input.table as CanonicalTableTarget).tableId;
    const tableName = d ? d.table_name : (input.table as CanonicalTableTarget).tableName;
    const dependsLocal: string[] = input.customerLocal ? [input.customerLocal] : [];
    const sessionDeps = d ? sessionBarrier(d) : [];
    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "on_account_table",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope,
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: tableId,
      dependency_ids: Array.from(new Set([...sessionDeps, ...(input.extraDependencyIds ?? [])])),
      depends_on_local_entities: dependsLocal,
      payload: {
        table_id: tableId,
        table_local: null,
        customer_id: input.customerId,
        customer_local: input.customerLocal ?? null,
        amount: input.amount,
        method: input.method,
        table_name: tableName,
        ...(input.discount ? { discount: input.discount } : {}),
        ...(input.expectedAmount != null && Number.isFinite(input.expectedAmount) ? { expected_amount: input.expectedAmount } : {}),
        // Projection metadata AND (1.0.38, Bug 9) the bill pins the handler resolves to expected_order_ids.
        covers: settleCovers(d, input.covers, input.table),
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
    // rc.10 — the table's bill is closed into a receivable: LOCALLY SETTLED, table reusable.
    if (d) await markDraftSettled(d, operationId);
    return { operationId, clientOpId, alreadyCaptured: false };
  });
}

const SPLIT_OP_PREFIX = "dineinsplit:";

/** Split legs captured for a session's order, in capture order (for chaining + projection).
 *  1.0.38 (C3) — a leg PARKED in needs_attention was never applied by the server: it allocates nothing
 *  and is never chained onto (a new leg depending on it would be dead at capture). */
async function sessionSplitLegs(d: DineDraft): Promise<OfflineOperation[]> {
  const rows = await localdb.operations.where("operation_type").equals("split_settle").toArray();
  return rows
    .filter((o) => o.status !== "cancelled" && o.status !== "needs_attention" && (o.payload as { order_local?: string } | null)?.order_local === d.local_session_id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export type DineSplitRemainingLine = { line_id: string; name: string; sent_qty: number; allocated: number; remaining: number; final_unit_price: number };

/** Restart-safe local split projection for a fully-offline dine-in session: for each SENT line,
 *  remaining = sent qty − already-allocated across captured split legs. Only sent lines are
 *  splittable (an unsent line is not yet on any order). */
export async function splitDineDraftRemaining(sessionId: string): Promise<DineSplitRemainingLine[] | null> {
  const d = await localdb.dineDrafts.get(sessionId);
  if (!d) return null;
  const legs = await sessionSplitLegs(d);
  const allocByLine = new Map<string, number>();
  for (const leg of legs) {
    const allocs = ((leg.payload as { allocations?: { line_local?: string; quantity: number }[] } | null)?.allocations) ?? [];
    for (const a of allocs) if (a.line_local) allocByLine.set(a.line_local, (allocByLine.get(a.line_local) ?? 0) + Number(a.quantity));
  }
  // Collapse sent lines by line_id (each DineDraftLine is one line with a quantity).
  return d.lines
    .filter((l) => l.sent_round !== null)
    .map((l) => {
      const allocated = allocByLine.get(l.line_id) ?? 0;
      return { line_id: l.line_id, name: l.name, sent_qty: l.quantity, allocated, remaining: Math.max(0, l.quantity - allocated), final_unit_price: l.base_price };
    });
}

export type DineSplitCaptureResult =
  | { ok: true; operationId: string; clientOpId: string; alreadyCaptured: boolean }
  | { ok: false; reason: string };

/**
 * Capture ONE offline split leg for a fully-offline Dine-In session. Allocations reference LOCAL
 * line ids (line_local); at replay the split handler resolves them to canonical order_item_ids via
 * pos_order_item_map + entityMap. The op depends on the session's open + every round op (so the
 * order + items exist and are mapped) and on the previous split leg (strict order). Validates
 * against the local remaining projection (never locally over-allocates). Deterministic/idempotent.
 */
export async function splitDineDraftOffline(input: {
  sessionId: string;
  allocations: { line_id: string; quantity: number }[];
  method: string;
}): Promise<DineSplitCaptureResult> {
  const allocs = input.allocations.filter((a) => Number(a.quantity) > 0);
  if (allocs.length === 0) return { ok: false, reason: "Select at least one item to split." };
  return localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
    const d = await localdb.dineDrafts.get(input.sessionId);
    if (!d) return { ok: false, reason: "This table isn't available offline. Reconnect to split it." };
    if (d.rounds.length === 0) return { ok: false, reason: "Nothing has been sent to split on this table." };
    const remaining = await splitDineDraftRemaining(input.sessionId);
    const remByLine = new Map((remaining ?? []).map((r) => [r.line_id, r]));
    for (const a of allocs) {
      const line = remByLine.get(a.line_id);
      if (!line) return { ok: false, reason: "A selected line is not a sent part of this bill." };
      if (Number(a.quantity) > line.remaining) return { ok: false, reason: `Only ${line.remaining} of "${line.name}" remain to split.` };
    }
    const sorted = [...allocs].sort((x, y) => x.line_id.localeCompare(y.line_id));
    const allocKey = sorted.map((a) => `${a.line_id}:${a.quantity}`).join(",");
    const clientOpId = deterministicUuid([d.tenant_id, d.branch_id ?? "", d.cashier_user_id, d.device_id, d.terminal_id ?? "", "split_settle", d.local_session_id, input.method, allocKey]);
    const operationId = SPLIT_OP_PREFIX + clientOpId;
    const existing = await getOperation(operationId);
    if (existing) return { ok: true, operationId, clientOpId, alreadyCaptured: true };
    const legs = await sessionSplitLegs(d);
    const prevLeg = legs.length > 0 ? legs[legs.length - 1].operation_id : null;
    const scope: OperationScope = { tenant_id: d.tenant_id, branch_id: d.branch_id, device_id: d.device_id, terminal_id: d.terminal_id ?? "", cashier_user_id: d.cashier_user_id };
    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "split_settle",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope,
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: null,
      // Needs the order + its items on the server first (open + every round), plus strict leg order.
      dependency_ids: Array.from(new Set([...sessionBarrier(d), ...(prevLeg ? [prevLeg] : [])])),
      depends_on_local_entities: [d.local_session_id],
      payload: {
        order_id: null,
        order_local: d.local_session_id,
        method: input.method,
        currency: d.currency,
        allocations: sorted.map((a) => ({ line_local: a.line_id, quantity: a.quantity })),
        expected_version: null,
        batch_no: null,
        split_seq: legs.length + 1,
        table_name: d.table_name,
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
    return { ok: true, operationId, clientOpId, alreadyCaptured: false };
  });
}

/**
 * rc.9 — capture ONE offline split leg against the table's OPERATIONAL bill (a canonical order and/or
 * its locally-sent round lines), reusing the SAME split_settle op + handler. Allocations reference a
 * canonical order_item_id (hydrated line) or a local line id (a locally-sent round line, resolved via
 * pos_order_item_map at replay). The caller validates remaining quantities against the operational
 * projection; `dependencyIds` = the session open + rounds + every pending item edit of that order + the
 * previous leg, so a leg never replays before the lines it pays for exist. Deterministic/idempotent.
 */
export async function splitOperationalBillOffline(input: {
  scope: DineinScope;
  orderId: string | null;
  orderLocal: string | null;
  allocations: { order_item_id?: string | null; line_local?: string | null; quantity: number }[];
  method: string;
  currency: string;
  tableName: string;
  orderNumber?: string | null;
  dependencyIds: string[];
  /** 1.0.38 (G1) — this leg pays EVERYTHING still open on the table's bill (operationalProjection
   *  .splitCompletesBill): it then CLOSES the bill locally like a settle — the leg records the table + exactly
   *  what it covers, and the session is settled atomically with it — so the next customer on the table opens
   *  a NEW session (never round N+1 of this paid order). Omitted → a partial leg (unchanged). */
  completes?: { tableId: string; sessionLocal: string | null; orderIds: string[] } | null;
}): Promise<DineSplitCaptureResult> {
  const allocs = input.allocations.filter((a) => Number(a.quantity) > 0 && (a.order_item_id || a.line_local));
  if (allocs.length === 0) return { ok: false, reason: "Select at least one item to split." };
  if (!input.orderId && !input.orderLocal) return { ok: false, reason: "This bill isn't available offline. Reconnect to split it." };
  const keyOf = (a: { order_item_id?: string | null; line_local?: string | null }) => a.order_item_id ?? `L:${a.line_local}`;
  const sorted = [...allocs].sort((x, y) => keyOf(x).localeCompare(keyOf(y)));
  const allocKey = sorted.map((a) => `${keyOf(a)}:${a.quantity}`).join(",");
  const orderRef = input.orderId ?? (input.orderLocal as string);
  const s = input.scope;
  const clientOpId = deterministicUuid([s.tenantId, s.branchId ?? "", s.cashierUserId, s.deviceId, s.terminalId ?? "", "split_settle", orderRef, input.method, allocKey]);
  const operationId = SPLIT_OP_PREFIX + clientOpId;
  const completes = input.completes ?? null;
  return localdb.transaction("rw", localdb.operations, localdb.dineDrafts, async () => {
    const existing = await getOperation(operationId);
    if (existing) return { ok: true, operationId, clientOpId, alreadyCaptured: true };
    const rows = await localdb.operations.where("operation_type").equals("split_settle").toArray();
    const legs = rows
      .filter((o) => {
        if (o.status === "cancelled") return false;
        const p = (o.payload ?? {}) as { order_id?: string | null; order_local?: string | null };
        return (input.orderId != null && p.order_id === input.orderId) || (input.orderLocal != null && p.order_local === input.orderLocal);
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    // 1.0.38 (C3) — strict leg order chains onto the last leg the server can still apply, never onto a
    // PARKED (needs_attention) one: that dependency would make this leg dead at capture.
    const chainable = legs.filter((o) => o.status !== "needs_attention");
    const prevLeg = chainable.length > 0 ? chainable[chainable.length - 1].operation_id : null;
    const op: OfflineOperation = {
      operation_id: operationId,
      operation_type: "split_settle",
      schema_version: OPERATION_SCHEMA_VERSION,
      scope: opScope(s),
      created_at: new Date().toISOString(),
      client_op_id: clientOpId,
      local_entity_id: null,
      canonical_entity_id: input.orderId,
      dependency_ids: Array.from(new Set([...input.dependencyIds, ...(prevLeg ? [prevLeg] : [])])),
      depends_on_local_entities: input.orderLocal ? [input.orderLocal] : [],
      payload: {
        order_id: input.orderId,
        order_local: input.orderLocal,
        method: input.method,
        currency: input.currency,
        allocations: sorted.map((a) => (a.order_item_id ? { order_item_id: a.order_item_id, quantity: a.quantity } : { line_local: a.line_local, quantity: a.quantity })),
        expected_version: null, // NULL offline — remaining-qty + state checks under the row lock are the guard
        batch_no: null,
        split_seq: legs.length + 1,
        table_name: input.tableName,
        order_number: input.orderNumber ?? null,
        // 1.0.38 (G1) — projection-only (never sent): the bill this completing leg closes (isTableSettleOp).
        ...(completes
          ? {
              table_id: completes.tableId,
              covers: { session_local: completes.sessionLocal, order_ids: Array.from(new Set(completes.orderIds.filter((x) => typeof x === "string" && x !== ""))), summary: false },
            }
          : {}),
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
    if (completes?.sessionLocal) {
      const d = await localdb.dineDrafts.get(completes.sessionLocal);
      if (d && d.status === "open") {
        await markDraftSettled(d, operationId);
        await localdb.dineDrafts.update(d.local_session_id, { closed_reason: "split_completed", closed_evidence_op_id: operationId });
      }
    }
    return { ok: true, operationId, clientOpId, alreadyCaptured: false };
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

/**
 * 1.0.38 (Bugs 5/6) — a session follows the AUTHORITATIVE fate of the offline move / merge that re-homed
 * it. Refused by the server (or withdrawn) → the bill is back where it was: a moved session returns to
 * its original table, a merged-away source session is the active bill of its table again, a session the
 * op itself created (a canonical-only bill had none) and that holds no round is retired. Valid again
 * (operator retry succeeded / awaiting recovery) → re-homed as captured. Nothing is re-sent here; the
 * refused op stays in needs_attention for the operator (never silently re-applied). Never puts two open
 * sessions on one table. ONE Dexie transaction.
 */
export async function reconcileStructuralDrafts(): Promise<void> {
  await localdb.transaction("rw", localdb.dineDrafts, localdb.operations, async () => {
    const drafts = (await localdb.dineDrafts.toArray()).filter((d) => d.structural_op_id || d.merged_op_id);
    const undone = (o: OfflineOperation | undefined) => !o || o.status === "cancelled" || structuralRefusedByServer(o);
    const openOn = async (d: DineDraft, tableId: string) =>
      localdb.dineDrafts
        .where("tenant_id")
        .equals(d.tenant_id)
        .filter((x) => x.local_session_id !== d.local_session_id && x.status === "open" && x.table_id === tableId && (x.branch_id ?? null) === (d.branch_id ?? null) && x.device_id === d.device_id && x.cashier_user_id === d.cashier_user_id)
        .count();
    const now = new Date().toISOString();
    for (const d of drafts) {
      // A merged-away SOURCE session.
      if (d.merged_op_id && (d.status === "merged" || d.status === "open")) {
        const m = await localdb.operations.get(d.merged_op_id);
        // 1.0.38 (G1) — the server REFUSED the merge but a payment captured after it (on the primary) already
        // collected this bill too: it is HELD by that payment (settled, awaiting the operator) — never the
        // table's collectible bill again while that payment stands (no double collection of the same value).
        if (m && structuralRefusedByServer(m)) {
          const held = await localdb.operations
            .where("operation_type")
            .anyOf("pay_table", "on_account_table")
            .filter((o) => settleHeldByRefusedStructural(o, m))
            .first();
          if (held) {
            await localdb.dineDrafts.update(d.local_session_id, { status: "settled", settled_operation_id: held.operation_id, settled_at: now, closed_reason: "held_by_payment", closed_evidence_op_id: m.operation_id, closed_at: now, updated_at: now });
            continue;
          }
        }
        const want = undone(m) ? "open" : "merged";
        if (want !== d.status && (want === "merged" || (await openOn(d, d.table_id)) === 0)) {
          await localdb.dineDrafts.update(d.local_session_id, { status: want, updated_at: now });
        }
        continue;
      }
      if (d.status !== "open" || !d.structural_op_id) continue;
      const s = await localdb.operations.get(d.structural_op_id);
      if (!s) continue;
      const refused = undone(s);
      // A session CREATED by the op (carrier) with nothing sent on it: retired when the op is undone.
      if (refused && d.carrier && d.rounds.length === 0) {
        await localdb.dineDrafts.update(d.local_session_id, { status: "closed", updated_at: now });
        continue;
      }
      if (s.operation_type !== "move_table") continue;
      const p = (s.payload ?? {}) as { from_table_id?: string; to_table_id?: string; from_table_name?: string; to_table_name?: string };
      const target = refused ? p.from_table_id : p.to_table_id;
      const name = refused ? p.from_table_name : p.to_table_name;
      if (!target || target === d.table_id || (await openOn(d, target)) > 0) continue;
      await localdb.dineDrafts.update(d.local_session_id, { table_id: target, table_name: name ?? d.table_name, updated_at: now });
    }
  });
}

export async function reconcileDineDraftsFromOperations(): Promise<void> {
  await reconcileStructuralDrafts();
  // rc.13 — a session closed locally by a settle the SERVER REFUSED (money not applied) is the table's
  // active bill again (SETTLEMENT_CONFLICT) — unless a newer session is already open on that table (that
  // one stays the active local session; the refused settle stays visible in the Sync Center for review).
  // Konan rc.13 — ONE Dexie transaction (read + decide + write, no interleaving with a capture), and a
  // deterministic chronology: candidates are taken NEWEST session first, so with several refused historical
  // sessions on one table only the newest becomes active; a table that already has an open session (older
  // or newer) never gets a second one — the refused session then stays visible for review in the Sync Center.
  await localdb.transaction("rw", localdb.dineDrafts, localdb.operations, async () => {
    const settled = (await localdb.dineDrafts.where("status").equals("settled").toArray()).sort(
      (a, b) => b.created_at.localeCompare(a.created_at) || b.local_session_id.localeCompare(a.local_session_id),
    );
    for (const d of settled) {
      if (!d.settled_operation_id) continue;
      const s = await localdb.operations.get(d.settled_operation_id);
      if (!s || settleStillCovers(s)) continue;
      const other = await localdb.dineDrafts
        .where("tenant_id")
        .equals(d.tenant_id)
        .filter((x) => x.status === "open" && x.table_id === d.table_id && (x.branch_id ?? null) === (d.branch_id ?? null) && x.device_id === d.device_id && x.cashier_user_id === d.cashier_user_id)
        .count();
      if (other > 0) continue;
      await localdb.dineDrafts.update(d.local_session_id, { status: "open", settled_operation_id: null, settled_at: null, updated_at: new Date().toISOString() });
    }
  });
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
  // 1.0.38 (G1) — sessions whose bill closed elsewhere (a completing split leg, paid online, closed remotely).
  await retireClosedSessions();
}

/**
 * 1.0.38 (G1) — SESSION LIFECYCLE TRUTH. Retire every OPEN local session whose bill is authoritatively closed
 * (operationalProjection.sessionClosure) from what this device durably knows: the op log, the last canonical
 * floor read and the cached bill. A completing split leg → `settled` (its leg is the evidence; a later server
 * refusal of that leg re-opens it, rc.13); closed elsewhere → `closed` / canonical_closed. Retiring is not a
 * delete: lines, rounds and ops stay for history / receipts / audit. A session with any unsynced or parked
 * work is never retired. ONE Dexie transaction (evaluate + write; a concurrent capture is never interleaved).
 * Called after every drain, before a capture reuses a table's session, and before an offline move / merge.
 */
export async function retireClosedSessions(only?: { tenantId: string | null; branchId: string | null; tableId?: string | null }): Promise<string[]> {
  if (only && !only.tenantId) return [];
  return localdb.transaction("rw", localdb.dineDrafts, localdb.operations, localdb.snapshots, async () => {
    const drafts = (await localdb.dineDrafts.where("status").equals("open").toArray()).filter(
      (d) => !only || (d.tenant_id === only.tenantId && (d.branch_id ?? null) === (only.branchId ?? null) && (!only.tableId || d.table_id === only.tableId)),
    );
    if (drafts.length === 0) return [];
    const all = await localdb.operations.toArray();
    const maps = new Map<string, { rows: TableSummary[]; at: number } | null>();
    const retired: string[] = [];
    for (const d of drafts) {
      const key = `${d.tenant_id}\u0001${d.branch_id ?? ""}`;
      if (!maps.has(key)) {
        const m = await readCachedTableMap(d.tenant_id, d.branch_id).catch(() => null);
        maps.set(key, m ? { rows: (m.map as { tables?: TableSummary[] } | null)?.tables ?? [], at: m.cachedAt } : null);
      }
      const map = maps.get(key) ?? null;
      const cached = await readCachedBill(d.table_id, d.tenant_id, d.branch_id).catch(() => null);
      const ops = all.filter((o) => opInScope(o, { tenantId: d.tenant_id, branchId: d.branch_id, cashierUserId: d.cashier_user_id, deviceId: d.device_id, terminalId: d.terminal_id }));
      const c = sessionClosure(d, ops, {
        row: map?.rows.find((t) => t.id === d.table_id) ?? null,
        mapAt: map?.at ?? null,
        bill: cached ? { bill: cached.bill as TableBill, fetchedAt: cached.cachedAt } : null,
      });
      if (!c) continue;
      const now = new Date().toISOString();
      await localdb.dineDrafts.update(d.local_session_id, {
        status: c.status,
        closed_reason: c.reason,
        closed_evidence_op_id: c.evidenceOpId,
        closed_at: now,
        updated_at: now,
        ...(c.status === "settled" ? { settled_operation_id: c.evidenceOpId, settled_at: now } : {}),
      });
      retired.push(d.local_session_id);
    }
    return retired;
  });
}

// ---------------------------------------------------------------------------
// UI adapters — map the cart/draft to the shapes the live Dine-In UI already uses,
// so the existing components render offline with NO change to the components.
// ---------------------------------------------------------------------------

/** Map a live cart line to a draft line (captured prices preserved). */
/**
 * 1.0.38 (native Bug 5) — an offline quantity INCREASE of an already-sent line is a NEW kitchen round of the
 * extra quantity: the sent round is immutable (the kitchen already has it), so the extra is new demand with
 * the SAME item, price snapshot, modifiers, note (and, for a line this device sent, its ingredient
 * customization). It needs no bill version (a round append never bumps it), so it works after an unsynced
 * Move / Merge too — through the first 1.0.38 build the increase went through the version-checked line edit
 * and was refused with "This bill's latest version isn't known on this device". Returns null when the line
 * cannot be re-ordered (no menu item: a pre-offline summary line) or the delta is not a positive integer.
 */
export function additionalRoundLineFor(
  line: { menu_item_id: string | null; name: string; base_price: number; kitchen_note: string | null; modifiers: SelectedModifier[] },
  extra: number,
  sentDraftLine?: Pick<DineDraftLine, "customization_json"> | null,
): (Omit<DineDraftLine, "line_id" | "sent_round"> & { line_id: string }) | null {
  if (!line.menu_item_id || !Number.isInteger(extra) || extra <= 0) return null;
  return {
    line_id: nid(),
    menu_item_id: line.menu_item_id,
    name: line.name,
    base_price: line.base_price,
    quantity: extra,
    kitchen_note: line.kitchen_note,
    modifiers: (line.modifiers as SelectedModifier[]).map((m) => ({
      group_id: (m as { group_id?: string | null }).group_id ?? null,
      option_id: (m as { option_id?: string | null }).option_id ?? null,
      name: m.name,
      price_delta: (m as { price_delta?: number }).price_delta ?? 0,
      quantity: (m as { quantity?: number }).quantity ?? 1,
    })),
    ...(sentDraftLine?.customization_json ? { customization_json: sentDraftLine.customization_json } : {}),
  };
}

export function draftLineFromCart(c: CartLine): Omit<DineDraftLine, "line_id" | "sent_round"> & { line_id: string } {
  return {
    // rc.9 — a fresh uuid, NEVER the cart key: cart keys are a per-process counter ("line-N") that
    // restarts with the app, so they collide across rounds/sessions/restarts AND are not a uuid (the
    // server casts client_line_id ::uuid — the rc.8 round-replay failure). The line id is the local
    // entity id the split/edit engines correlate through pos_order_item_map, so it must be unique.
    line_id: nid(),
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
  // 1.0.38 (G1) — a session whose bill closed elsewhere is never returned as the table's active session: the
  // caller then opens a NEW one (round 1, no expected_order_id) instead of a round N+1 of the closed order.
  await retireClosedSessions({ tenantId: scope.tenantId, branchId: scope.branchId, tableId });
  const all = await localdb.dineDrafts.where("tenant_id").equals(scope.tenantId).toArray();
  const open = all.filter(
    (d) =>
      d.table_id === tableId &&
      d.status === "open" &&
      (d.branch_id ?? null) === (scope.branchId ?? null) &&
      d.cashier_user_id === scope.cashierUserId &&
      d.device_id === scope.deviceId &&
      (scope.terminalId == null || (d.terminal_id ?? null) === scope.terminalId),
  );
  // Newest first (the same rule as operationalProjection.openDraftsInScope).
  open.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.local_session_id.localeCompare(a.local_session_id));
  for (const d of open) {
    // rc.10 repair: a pre-rc.10 session that a captured settle / on-account already covers is a
    // SETTLED bill, never the table's active one (rc.9 left it "open" → the table could not be reused
    // and a new round re-attached to the paid bill). Close it locally (kept for history) and skip it.
    const cover = await coveringSettleOp(d);
    if (cover) {
      await localdb.dineDrafts.update(d.local_session_id, { status: "settled", settled_operation_id: cover.operation_id, settled_at: cover.created_at, updated_at: new Date().toISOString() });
      continue;
    }
    return d;
  }
  return null;
}

/** The live settle / on-account op that covers a session (by its recorded `covers.session_local`, or —
 *  for ops captured before rc.10 — by depending on the session's open op), if any. */
export async function coveringSettleOp(d: DineDraft): Promise<OfflineOperation | undefined> {
  const rows = await localdb.operations.where("operation_type").anyOf("pay_table", "on_account_table").toArray();
  // rc.11 — the legacy (no `covers`) match additionally requires that NO round of the session was sent
  // after that settle: a later round is an ACTIVE bill and the session must not be repaired as settled.
  const noLaterRound = (o: OfflineOperation) => {
    const at = Date.parse(o.created_at);
    return !d.rounds.some((r) => Number.isFinite(at) && Date.parse(r.sent_at) > at);
  };
  return rows.find((o) => {
    // rc.13 — a REFUSED settle never closes the session (the money was not applied).
    if (!settleStillCovers(o)) return false;
    const covers = (o.payload as { covers?: { session_local?: string | null } } | null)?.covers;
    if (covers && Object.keys(covers).length > 0) return covers.session_local === d.local_session_id;
    return o.dependency_ids.includes(d.open_operation_id) && noLaterRound(o);
  });
}
