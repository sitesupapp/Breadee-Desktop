import Dexie, { type Table } from "dexie";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import type { EntityMapping } from "@/lib/offline/entityMap";
import type { SyncHistoryEvent } from "@/lib/offline/syncHistory";

// Local offline store. Holds ONLY required operational data + a durable outbox of
// actions to sync. No raw passwords, no secrets, no service keys. Snapshots are
// minimal (menu/tables/stock) to avoid full production-data downloads.

export type OutboxStatus = "queued" | "syncing" | "synced" | "failed" | "conflict" | "review";

export interface OutboxItem {
  id?: number;
  kind: string; // e.g. "pos.save_order", "pos.pay_order", "inventory.movement", "expense.create"
  payload: unknown; // the RPC/table payload to replay online
  // Audit metadata (required on every offline record):
  user_id: string;
  user_name: string;
  tenant_id: string;
  branch_id: string | null;
  device_id: string;
  terminal_id: string;
  created_at: string; // ISO
  status: OutboxStatus;
  attempts: number;
  last_error?: string | null;
  note?: string | null;
}

export interface Snapshot {
  key: string; // e.g. "menu", "tables", "stock:<branch>"
  tenant_id: string;
  branch_id: string | null;
  data: unknown;
  cached_at: string;
}

export interface AuditRecord {
  id?: number;
  action: string;
  user_id: string;
  tenant_id: string;
  branch_id: string | null;
  device_id: string;
  terminal_id: string;
  at: string;
  sync_status: OutboxStatus | "local";
  detail?: unknown;
}

/** Operator-facing lifecycle of an offline-originated sale. */
export type PosOfflineTxnStatus = "queued" | "syncing" | "synced" | "needs_attention";

/**
 * A durable, offline-ORIGINATED Takeaway + Cash sale (offline POS).
 *
 * One logical sale created while fully offline, carrying BOTH the exact order
 * payload AND the cash payment intent as one immutable, replayable unit. Replay is
 * `pos_submit_order` (idempotent on `client_op_id`) then `pos_pay_order`
 * (state-based `already paid` dedup) - exactly the online path, deferred. A row is
 * retained until it is `synced`; it is never dropped silently.
 */
export interface PosOfflineTxn {
  /** Stable client-generated identity, created BEFORE any network request. PK. */
  local_txn_id: string;
  /** Immutable operation id reused on every replay - the server idempotency key. */
  client_op_id: string;
  tenant_id: string;
  branch_id: string | null;
  device_id: string;
  terminal_id: string;
  cashier_user_id: string;
  cashier_user_name: string;
  /** The open shift captured while online; frozen, never re-attributed. */
  shift_id: string;
  created_at: string; // client ISO, at offline capture
  /** Immutable exact `pos_submit_order` payload (SubmitOrderPayload). */
  order_payload: unknown;
  /**
   * Cash payment intent for `pos_pay_order`, or null. A transaction created by an
   * offline "Send to kitchen" starts with `payment_intent: null` (sent, unpaid);
   * a later offline Cash Pay UPDATES the same transaction (matched by
   * `client_op_id`) to fill this in. Replay pays only when it is present.
   */
  payment_intent: { method: "cash"; currency: string; discount?: Record<string, unknown> } | null;
  /** True once this order has been sent to the kitchen (online or offline). */
  sent_to_kitchen?: boolean;
  currency: string;
  /** Local provisional total (display only); the authoritative total is the server's. */
  total: number;
  status: PosOfflineTxnStatus;
  attempts: number;
  last_attempt_at?: string | null;
  /** Filled once the order is created on the server during replay. */
  server_order_id?: string | null;
  server_order_number?: string | null;
  /** Set once the cash payment is confirmed settled on the server. */
  paid?: boolean;
  /** Why the transaction needs a human (shift closed, permission, validation...). */
  review_reason?: string | null;
  last_error?: string | null;
  /**
   * Set when this sale was created against an OFFLINE-opened shift that has no
   * canonical server shift id yet (see `PendingShift`). On reconnect the replay
   * engine resolves that pending shift exactly once, then remaps this txn's
   * `shift_id` (inside `order_payload`) to the canonical id BEFORE submitting.
   * Null/absent for sales against a real server shift (the common case).
   */
  pending_shift_local_id?: string | null;
}

/** Lifecycle of an offline-opened shift that has not yet reached the server. */
export type PendingShiftStatus = "pending_sync" | "synced" | "needs_attention";

/**
 * A shift OPENED while fully offline.
 *
 * Case 2 of offline continuity: a cashier meets a backend outage with no
 * previously-hydrated open shift. `pos_open_shift` needs connectivity, so the open
 * is captured durably here - BEFORE the UI reports success - and the shift is
 * surfaced to POS as the active shift (`local_shift_id` stands in for the server
 * id) so Takeaway cash sales can continue. On reconnect the replay engine opens the
 * shift exactly once (`pos_open_shift` dedups on `client_op_id` AND is single-open
 * server-side), records the canonical `server_shift_id`, and remaps every dependent
 * offline sale to it. The server stays authoritative: if a shift is already open for
 * this cashier, the canonical id is that existing shift.
 */
export interface PendingShift {
  /** Client-generated identity, minted BEFORE any UI success. PK + the offline ActiveShift.id. */
  local_shift_id: string;
  /** Immutable op id reused on every open replay - the server idempotency key. */
  client_op_id: string;
  tenant_id: string;
  branch_id: string | null;
  device_id: string;
  terminal_id: string;
  cashier_user_id: string;
  opening_cash_amount: number;
  /** Operational currency code captured at open (display only; POS math never reads this). */
  currency: string;
  opened_at: string; // client ISO, at offline capture
  status: PendingShiftStatus;
  /** The canonical server shift id, filled once opened on reconnect. */
  server_shift_id?: string | null;
  attempts: number;
  last_error?: string | null;
  /** Why the open needs a human (permission, prior shift awaiting approval, branch access...). */
  review_reason?: string | null;
}

/**
 * A compact, tenant+branch-scoped Delivery customer record cached while online so
 * the caller can be found again offline. Keyed by the SERVER customer id - never a
 * local id, because offline customer CREATION is not supported in this hotfix.
 * `addresses` is present only once the full profile has been opened online (a
 * plain search caches identity fields only); an offline order needs a cached
 * address, so a compact-only record cannot yet be ordered against offline.
 */
export interface CachedCustomer {
  id: string; // server customer id (PK)
  tenant_id: string;
  branch_id: string | null;
  name: string | null;
  phone: string | null;
  phone_e164: string | null;
  /** Full addresses, cached only when the profile was opened online. */
  addresses: unknown[] | null;
  notes: string | null;
  /** True once the full profile (with addresses) was cached, not just a match. */
  has_profile: boolean;
  cached_at: string;
}

// ---------------------------------------------------------------------------
// Phase C (schema version 6) — offline Dine-In local projection.
// ---------------------------------------------------------------------------

/** A line in a local Dine-In bill. `sent_round` is null while unsent (editable),
 *  else the round sequence it was committed in (immutable once sent). */
export interface DineDraftLine {
  line_id: string; // stable local id (deterministic op-id input)
  menu_item_id: string | null;
  name: string;
  /** Captured selling price — honoured by the server on replay (snapshot, never repriced). */
  base_price: number;
  quantity: number;
  modifiers: { group_id?: string | null; option_id?: string | null; name: string; price_delta: number; quantity: number }[];
  kitchen_note: string | null;
  customization_json?: unknown;
  /** null = unsent draft line; else the round seq it was sent in. */
  sent_round: number | null;
}

/** Local print state of a sent round — tracked SEPARATELY from server sync state. */
export type DineRoundPrintState = "not_printed" | "printed" | "print_failed";

/** One committed round of a local Dine-In session. Each maps 1:1 to a
 *  `dinein_send_round` operation (operation_id) and is a node in the replay chain. */
export interface DineDraftRound {
  round_local_id: string; // local entity id (the op's local_entity_id)
  operation_id: string; // the dinein_send_round op
  seq: number; // 1, 2, 3 ...
  line_ids: string[]; // the draft lines captured in this round
  print_state: DineRoundPrintState;
  sent_at: string;
}

/** Lifecycle of a local Dine-In session (local-only; never a replayable op itself). */
export type DineDraftStatus = "open" | "closed";

/**
 * The durable LOCAL Dine-In projection — the active bill the operator sees and edits
 * offline. It is NOT a replay queue (that is `operations`); it is the local-only state
 * that lets the UI restore the exact table/bill/round view after a restart, and the
 * source the "send round" action turns into a `dinein_send_round` operation. Carries the
 * FULL immutable offline scope (tenant+branch/OU+cashier+device+terminal) so a different
 * context can never attach to it.
 */
export interface DineDraft {
  local_session_id: string; // PK — stable local id minted at open
  tenant_id: string;
  branch_id: string | null; // the operating unit (OU)
  cashier_user_id: string;
  device_id: string;
  terminal_id: string | null;
  floor_id: string | null;
  section_id: string | null;
  table_id: string; // canonical table id (from the cached map/floor) for configured tables
  table_name: string;
  /** Operational currency captured at open (display only for the local provisional bill). */
  currency: string;
  /** The dinein_open_table op that establishes/occupies the table. */
  open_operation_id: string;
  /** Resolved once round 1 syncs — the session's canonical server order; rounds >=2 pin it. */
  canonical_order_id: string | null;
  /** 'online' = a table opened while online then serviced offline; 'offline' = opened offline. */
  origin: "offline" | "online";
  /** Server order version captured at hydration (conflict detection for online-opened tables). */
  base_order_version: number | null;
  status: DineDraftStatus;
  lines: DineDraftLine[];
  rounds: DineDraftRound[];
  /** Monotonic; bumped on every mutation. A deterministic client_op_id input for a send. */
  draft_revision: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Phase D — the local REFUND-PROOF of a PAID canonical order, written through while ONLINE.
 *
 * An offline refund is allowed ONLY against an order whose proof is cached here (policy
 * rules 1/8/9): the order must have existed, been paid, and belonged to THIS tenant+OU — all
 * established from authoritative server data captured while connected. `refundable_usd` is the
 * client's best local knowledge of the refundable balance; the server re-verifies it under the
 * row lock (the `p_expected_refund_usd` guard), so a drift is caught as a conflict, never a
 * wrong-amount refund. This store is NEVER an independent financial authority — it only gates
 * capture; the canonical server transaction remains the source of truth after sync.
 */
export interface PaidOrderProof {
  order_id: string; // canonical server order id (PK)
  order_number: string | null;
  tenant_id: string;
  branch_id: string | null; // OU
  shift_id: string | null; // the shift that took the payment (refund must post to it)
  pos_entity_version: number | null; // CAS value known locally at cache time
  payment_status: string; // 'paid' required for a refund
  status: string; // order status at cache time (must not be terminal)
  refundable_usd: number; // best local knowledge of sum(pos_payments.amount_usd)
  currency: string; // order primary currency snapshot
  cashier_user_id: string | null;
  device_id: string | null;
  terminal_id: string | null;
  cached_at: string; // ISO; freshness for the operator
}

class BreadeeDB extends Dexie {
  outbox!: Table<OutboxItem, number>;
  snapshots!: Table<Snapshot, string>;
  audit!: Table<AuditRecord, number>;
  // Added in schema version 2 (see below). Keyed by local_txn_id.
  posOfflineTxns!: Table<PosOfflineTxn, string>;
  // Added in schema version 3 (see below). Keyed by the server customer id.
  posCustomers!: Table<CachedCustomer, string>;
  // Added in schema version 4 (see below). Keyed by local_shift_id.
  pendingShifts!: Table<PendingShift, string>;
  // Phase B (schema version 5). The generalized offline operation log — the single
  // durable queue the one orchestrator drains. Keyed by operation_id.
  operations!: Table<OfflineOperation, string>;
  // Phase B (v5). Durable local->canonical entity-id map. Keyed by local_entity_id.
  entityMap!: Table<EntityMapping, string>;
  // Phase B (v5). Durable operator-facing sync history. Keyed by ++id.
  syncHistory!: Table<SyncHistoryEvent, number>;
  // Phase C (schema version 6). Durable local Dine-In projection. Keyed by local_session_id.
  dineDrafts!: Table<DineDraft, string>;
  // Phase D (schema version 7). Local refund-proof of PAID canonical orders. Keyed by order_id.
  paidOrderProofs!: Table<PaidOrderProof, string>;

  constructor() {
    super("breadee-desktop");
    this.version(1).stores({
      outbox: "++id, kind, status, tenant_id, branch_id, created_at",
      snapshots: "key, tenant_id, branch_id",
      audit: "++id, action, tenant_id, at, sync_status",
    });
    // Version 2 - ADDITIVE. Dexie carries every unmentioned store (outbox,
    // snapshots, audit) forward untouched; this only ADDS the posOfflineTxns store
    // for offline-originated Takeaway + Cash sales. An existing v1 database upgrades
    // in place with ALL prior data preserved - nothing is cleared, recreated or
    // migrated destructively.
    this.version(2).stores({
      posOfflineTxns: "local_txn_id, client_op_id, tenant_id, branch_id, status, created_at, cashier_user_id",
    });
    // Version 3 - ADDITIVE. Adds ONLY the posCustomers cache for offline Delivery
    // customer lookup. Every prior store carries forward untouched; a v1/v2
    // database upgrades in place with all data preserved.
    this.version(3).stores({
      posCustomers: "id, tenant_id, branch_id, phone_e164, name",
    });
    // Version 4 - ADDITIVE. Adds ONLY the pendingShifts store for shifts opened
    // while fully offline (Case 2). Every prior store carries forward untouched; a
    // v1/v2/v3 database upgrades in place with all data preserved.
    this.version(4).stores({
      pendingShifts: "local_shift_id, client_op_id, tenant_id, branch_id, status, cashier_user_id, opened_at",
    });
    // Version 5 - Phase B, ADDITIVE. Adds the generalized operation log, the generic
    // entity-id map, and the durable sync-history store. Every prior store carries
    // forward UNTOUCHED; a v1..v4 database upgrades in place with all data preserved.
    // The content migration of pendingShifts/posOfflineTxns INTO `operations` is a
    // controlled, crash-resumable, idempotent step run explicitly (see migration.ts) —
    // NOT a Dexie upgrade function — so it can verify counts and be rollback-safe.
    this.version(5).stores({
      operations: "operation_id, status, operation_type, created_at, client_op_id, local_entity_id",
      entityMap: "local_entity_id, entity_type, tenant_id",
      syncHistory: "++id, operation_id, tenant_id, branch_id, at, status",
    });
    // Version 6 - Phase C, ADDITIVE. Adds ONLY the dineDrafts store (the local Dine-In
    // projection). Every prior store (v1..v5) carries forward UNTOUCHED; a v1..v5 database
    // upgrades in place with all data preserved. No destructive change, no data migration.
    this.version(6).stores({
      dineDrafts: "local_session_id, tenant_id, branch_id, table_id, status, cashier_user_id, device_id, updated_at",
    });
    // Version 7 - Phase D, ADDITIVE. Adds ONLY the paidOrderProofs store (the local refund-proof
    // of paid canonical orders, written through while online). Every prior store (v1..v6) carries
    // forward UNTOUCHED; a v1..v6 database upgrades in place with all data preserved. No
    // destructive change, no data migration.
    this.version(7).stores({
      paidOrderProofs: "order_id, tenant_id, branch_id, shift_id, payment_status, cashier_user_id, device_id, cached_at",
    });
  }
}

export const localdb = new BreadeeDB();

export async function enqueue(item: Omit<OutboxItem, "id" | "status" | "attempts">): Promise<number> {
  return localdb.outbox.add({ ...item, status: "queued", attempts: 0 });
}

export async function pendingCount(): Promise<number> {
  return localdb.outbox.where("status").anyOf("queued", "failed", "conflict", "review").count();
}

// Count of outbox items that still hold unsynced work (must never be dropped silently).
export async function unsyncedOutboxCount(): Promise<number> {
  return localdb.outbox.where("status").anyOf("queued", "syncing", "failed", "conflict", "review").count();
}

// Cache-scope hardening: remove cached snapshots that do NOT belong to the current
// tenant/branch scope, so one tenant/branch's cached read data can never leak into a
// different session. Tenant-wide snapshots (branch_id === null) are kept when the
// tenant matches. The durable outbox is intentionally NOT touched here.
export async function purgeForeignSnapshots(tenantId: string | null, branchId: string | null): Promise<number> {
  const all = await localdb.snapshots.toArray();
  const foreign = all.filter(
    (s) => s.tenant_id !== tenantId || (branchId != null && s.branch_id != null && s.branch_id !== branchId),
  );
  await Promise.all(foreign.map((s) => localdb.snapshots.delete(s.key)));
  return foreign.length;
}

// Sign-out cleanup: drop the read-only snapshot cache (re-fetchable when online) so no
// cached data survives into the next login. The outbox (unsynced work) is PRESERVED —
// call unsyncedOutboxCount() first if the UI needs to warn about pending items.
export async function clearSnapshotCache(): Promise<void> {
  await localdb.snapshots.clear();
}

// ---------------------------------------------------------------------------
// Dine-In table map cache (read continuity) - reuses the generic snapshot store.
// ---------------------------------------------------------------------------

const tableMapKey = (branchId: string | null) => `tables:${branchId ?? "none"}`;

/**
 * Cache the last successfully-loaded table map for a branch. Called ONLY after a
 * successful online load, so a failed/empty network response can never overwrite
 * a valid snapshot. Branch/tenant scoped.
 */
export async function cacheTableMap(map: unknown, tenantId: string | null, branchId: string | null): Promise<void> {
  if (!tenantId) return;
  await localdb.snapshots.put({
    key: tableMapKey(branchId),
    tenant_id: tenantId,
    branch_id: branchId,
    data: map,
    cached_at: new Date().toISOString(),
  });
}

/** The cached table map for a branch, or null. Scope-checked so it can never
 *  serve another tenant/branch's map. */
export async function readCachedTableMap(
  tenantId: string | null,
  branchId: string | null,
): Promise<{ map: unknown; cachedAt: number } | null> {
  if (!tenantId) return null;
  const row = await localdb.snapshots.get(tableMapKey(branchId));
  if (!row) return null;
  if (row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { map: row.data, cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
}

// ---------------------------------------------------------------------------
// Delivery customer cache (offline lookup) - posCustomers store (v3).
// ---------------------------------------------------------------------------

/** Upsert one or more cached customers (identity match, or full profile). */
export async function cacheCustomers(records: CachedCustomer[]): Promise<void> {
  if (records.length === 0) return;
  await localdb.posCustomers.bulkPut(records);
}

/** Every cached customer for a tenant+branch scope (for local search). */
export async function listCachedCustomers(tenantId: string | null, branchId: string | null): Promise<CachedCustomer[]> {
  if (!tenantId) return [];
  const all = await localdb.posCustomers.where("tenant_id").equals(tenantId).toArray();
  return all.filter((c) => (c.branch_id ?? null) === (branchId ?? null));
}

/** One cached customer by server id, scope-checked. */
export async function getCachedCustomer(
  id: string,
  tenantId: string | null,
  branchId: string | null,
): Promise<CachedCustomer | undefined> {
  const c = await localdb.posCustomers.get(id);
  if (!c) return undefined;
  if (c.tenant_id !== tenantId || (c.branch_id ?? null) !== (branchId ?? null)) return undefined;
  return c;
}

/**
 * Drop cached customers that do NOT belong to the current tenant/branch, so a
 * previous session's callers can never surface for a different tenant/branch.
 */
export async function purgeForeignCachedCustomers(tenantId: string | null, branchId: string | null): Promise<number> {
  const all = await localdb.posCustomers.toArray();
  const foreign = all.filter((c) => c.tenant_id !== tenantId || (branchId != null && (c.branch_id ?? null) !== branchId));
  await Promise.all(foreign.map((c) => localdb.posCustomers.delete(c.id)));
  return foreign.length;
}

/** Sign-out cleanup: drop the whole customer cache (privacy - phones/addresses). */
export async function clearCachedCustomers(): Promise<void> {
  await localdb.posCustomers.clear();
}

// ---------------------------------------------------------------------------
// Offline Takeaway + Cash transactions
// ---------------------------------------------------------------------------

/**
 * Durably commit an offline-originated sale BEFORE the UI reports success. The
 * returned promise resolves only once the row is written, so the caller can
 * safely clear the cart afterwards (never before).
 */
export async function addPosOfflineTxn(txn: PosOfflineTxn): Promise<string> {
  await localdb.posOfflineTxns.add(txn);
  return txn.local_txn_id;
}

/** Every offline sale, newest first - for the Sync Center queue. */
export async function listPosOfflineTxns(): Promise<PosOfflineTxn[]> {
  return localdb.posOfflineTxns.orderBy("created_at").reverse().toArray();
}

/** Offline sales that still hold unsynced work (must never be dropped silently). */
export async function pendingPosTxnCount(): Promise<number> {
  return localdb.posOfflineTxns.where("status").anyOf("queued", "syncing", "needs_attention").count();
}

/** Patch one offline transaction by its local id. */
export async function updatePosOfflineTxn(localTxnId: string, patch: Partial<PosOfflineTxn>): Promise<void> {
  await localdb.posOfflineTxns.update(localTxnId, patch);
}

/**
 * The offline transaction for a given cart operation id, if one exists. Used to
 * keep "Send to kitchen" and a later "Pay" as ONE logical order: both carry the
 * cart's stable `client_op_id`, so the second action updates the first row rather
 * than opening a second sale. A row that already synced is still returned so the
 * caller can decide (e.g. pay it online instead).
 */
export async function getPosOfflineTxnByOp(clientOpId: string): Promise<PosOfflineTxn | undefined> {
  return localdb.posOfflineTxns.where("client_op_id").equals(clientOpId).first();
}

/**
 * Offline orders that were SENT to the kitchen but not yet paid, for the given
 * live session (tenant + branch + cashier). These are the orders a cashier can
 * RESUME and pay after a restart - the in-memory cart is gone, but the order is
 * durable. Scoped so another context's order is never offered here.
 */
export async function listResumablePosTxns(
  tenantId: string | null,
  branchId: string | null,
  cashierUserId: string | null,
): Promise<PosOfflineTxn[]> {
  const all = await localdb.posOfflineTxns.toArray();
  return all
    .filter(
      (t) =>
        t.sent_to_kitchen === true &&
        !t.paid &&
        !t.payment_intent &&
        // TAKEAWAY only: the Resume banner rebuilds a takeaway cart. A queued
        // offline DELIVERY order carries its own customer/address and syncs on
        // reconnect without a cart resume, so it must never appear here.
        (t.order_payload as { order_type?: string } | null)?.order_type === "takeaway" &&
        // Only orders still held locally. Once SYNCED, the order exists on the
        // server (unpaid) and is paid through the normal shift-orders flow, so it
        // must not linger here after an online payment.
        t.status === "queued" &&
        t.tenant_id === tenantId &&
        (t.branch_id ?? null) === (branchId ?? null) &&
        t.cashier_user_id === cashierUserId,
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ---------------------------------------------------------------------------
// Offline-opened shifts (Case 2) - pendingShifts store (v4)
// ---------------------------------------------------------------------------

/** Durably commit an offline-opened shift BEFORE the UI reports success. */
export async function addPendingShift(shift: PendingShift): Promise<string> {
  await localdb.pendingShifts.add(shift);
  return shift.local_shift_id;
}

/** One pending shift by its local id. */
export async function getPendingShift(localShiftId: string): Promise<PendingShift | undefined> {
  return localdb.pendingShifts.get(localShiftId);
}

/**
 * In-scope offline-opened shifts for the EXACT live context. Scoped by
 * tenant + cashier + branch/OU + device, and ONLY `pending_sync` (never
 * `needs_attention`, which has been definitively refused and must not be reactivated
 * for new sales, nor `synced`). This is the isolation boundary: a pending shift from
 * a sibling branch/OU, another cashier, another tenant, or another device can never
 * surface as the active shift. Newest-opened first.
 */
export async function listActivePendingShifts(
  tenantId: string | null,
  cashierUserId: string | null,
  branchId: string | null,
  deviceId: string | null,
): Promise<PendingShift[]> {
  if (!tenantId || !cashierUserId || !deviceId) return [];
  const all = await localdb.pendingShifts.where("status").equals("pending_sync").toArray();
  return all
    .filter(
      (s) =>
        s.tenant_id === tenantId &&
        s.cashier_user_id === cashierUserId &&
        (s.branch_id ?? null) === (branchId ?? null) &&
        s.device_id === deviceId,
    )
    .sort((a, b) => b.opened_at.localeCompare(a.opened_at));
}

/**
 * The ONE active offline-opened (`pending_sync`) shift for the EXACT live context
 * (tenant + cashier + branch/OU + device), or undefined. See `listActivePendingShifts`
 * for the isolation rationale.
 */
export async function getActivePendingShift(
  tenantId: string | null,
  cashierUserId: string | null,
  branchId: string | null,
  deviceId: string | null,
): Promise<PendingShift | undefined> {
  return (await listActivePendingShifts(tenantId, cashierUserId, branchId, deviceId))[0];
}

/** Patch one pending shift by its local id. */
export async function updatePendingShift(localShiftId: string, patch: Partial<PendingShift>): Promise<void> {
  await localdb.pendingShifts.update(localShiftId, patch);
}

/** Drop a pending shift (e.g. once reconciled to a canonical server shift). */
export async function deletePendingShift(localShiftId: string): Promise<void> {
  await localdb.pendingShifts.delete(localShiftId);
}

// ---------------------------------------------------------------------------
// Phase C — Floor + Bill read-snapshot cache (hydration), reusing `snapshots`.
// These make the Floor Map and an open bill viewable OFFLINE. Written ONLY on a
// successful authoritative online load (a SUCCESSFUL empty/null result replaces the
// stale snapshot; only a FAILED load preserves the prior snapshot — the caller must
// not call these on failure). Scope-checked on read so no other tenant/branch leaks.
// ---------------------------------------------------------------------------

const floorKey = (branchId: string | null) => `floor:${branchId ?? "none"}`;
const billKey = (branchId: string | null, tableId: string) => `bill:${branchId ?? "none"}:${tableId}`;

/** Cache the authoritative floor layout for a branch (call only after a successful load;
 *  pass the authoritative value even if it is "no published floor" so offline reflects it). */
export async function cacheFloor(layout: unknown, tenantId: string | null, branchId: string | null): Promise<void> {
  if (!tenantId) return;
  await localdb.snapshots.put({ key: floorKey(branchId), tenant_id: tenantId, branch_id: branchId, data: layout, cached_at: new Date().toISOString() });
}

/** The cached floor layout for a branch, or null. Scope-checked. */
export async function readCachedFloor(tenantId: string | null, branchId: string | null): Promise<{ layout: unknown; cachedAt: number } | null> {
  if (!tenantId) return null;
  const row = await localdb.snapshots.get(floorKey(branchId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { layout: row.data, cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
}

/** Cache an authoritative open bill for a table (call only after a successful online load). */
export async function cacheBill(tableId: string, bill: unknown, tenantId: string | null, branchId: string | null): Promise<void> {
  if (!tenantId || !tableId) return;
  await localdb.snapshots.put({ key: billKey(branchId, tableId), tenant_id: tenantId, branch_id: branchId, data: bill, cached_at: new Date().toISOString() });
}

/** The cached open bill for a table, or null. Scope-checked. */
export async function readCachedBill(tableId: string, tenantId: string | null, branchId: string | null): Promise<{ bill: unknown; cachedAt: number } | null> {
  if (!tenantId || !tableId) return null;
  const row = await localdb.snapshots.get(billKey(branchId, tableId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { bill: row.data, cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
}

// ---------------------------------------------------------------------------
// Phase C — Dine-In local projection (dineDrafts, v6)
// ---------------------------------------------------------------------------

/** Durably write a new local Dine-In session projection. */
export async function addDineDraft(draft: DineDraft): Promise<string> {
  await localdb.dineDrafts.add(draft);
  return draft.local_session_id;
}

/** One local session by id. */
export async function getDineDraft(localSessionId: string): Promise<DineDraft | undefined> {
  return localdb.dineDrafts.get(localSessionId);
}

/** Patch one local session by id. */
export async function updateDineDraft(localSessionId: string, patch: Partial<DineDraft>): Promise<void> {
  await localdb.dineDrafts.update(localSessionId, patch);
}

/** Drop a local session (e.g. after it is closed and fully reconciled). */
export async function deleteDineDraft(localSessionId: string): Promise<void> {
  await localdb.dineDrafts.delete(localSessionId);
}

/**
 * Open local Dine-In sessions for the EXACT live context (tenant + branch/OU + cashier +
 * device + terminal). The isolation boundary for the offline floor projection: a session
 * from a sibling OU, another cashier, device, or terminal can never surface here. The
 * `terminal` dimension is enforced only when a live terminal is supplied (production always
 * does), mirroring the orchestrator's scope rule.
 */
export async function listDineDrafts(scope: {
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
  deviceId: string | null;
  terminalId?: string | null;
}): Promise<DineDraft[]> {
  if (!scope.tenantId || !scope.cashierUserId || !scope.deviceId) return [];
  const all = await localdb.dineDrafts.where("tenant_id").equals(scope.tenantId).toArray();
  return all
    .filter(
      (d) =>
        (d.branch_id ?? null) === (scope.branchId ?? null) &&
        d.cashier_user_id === scope.cashierUserId &&
        d.device_id === scope.deviceId &&
        (scope.terminalId == null || (d.terminal_id ?? null) === scope.terminalId) &&
        d.status === "open",
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ---------------------------------------------------------------------------
// Phase D — refund-proof of paid canonical orders (paidOrderProofs, v7)
// ---------------------------------------------------------------------------

/** Write through the refund-proof of a PAID canonical order while ONLINE. Idempotent per
 *  order_id (a newer read replaces the prior proof). No-op without a tenant/order id. */
export async function cachePaidOrderProof(proof: PaidOrderProof): Promise<void> {
  if (!proof.tenant_id || !proof.order_id) return;
  await localdb.paidOrderProofs.put({ ...proof, cached_at: proof.cached_at || new Date().toISOString() });
}

/** The refund-proof for a canonical order, or null. SCOPE-CHECKED: a proof from a sibling OU,
 *  another tenant, cashier, device or terminal is never returned (fail-closed, mirrors the
 *  operation scope rule; terminal enforced only when a live terminal is supplied). */
export async function readPaidOrderProof(
  orderId: string,
  scope: { tenantId: string | null; branchId: string | null; cashierUserId?: string | null; deviceId?: string | null; terminalId?: string | null },
): Promise<PaidOrderProof | null> {
  if (!scope.tenantId || !orderId) return null;
  const row = await localdb.paidOrderProofs.get(orderId);
  if (!row) return null;
  // FAIL-CLOSED five-dimensional isolation: every dimension must match EXACTLY, null-safe, in
  // BOTH directions. A null stored value is NOT a wildcard — a proof captured without a terminal
  // (null) never satisfies a scoped terminal, and vice versa. Anything short of exact equality on
  // tenant, OU/branch, cashier, device and terminal returns null (not ours to reverse).
  if (row.tenant_id !== scope.tenantId) return null;
  if ((row.branch_id ?? null) !== (scope.branchId ?? null)) return null;
  if ((row.cashier_user_id ?? null) !== (scope.cashierUserId ?? null)) return null;
  if ((row.device_id ?? null) !== (scope.deviceId ?? null)) return null;
  if ((row.terminal_id ?? null) !== (scope.terminalId ?? null)) return null;
  return row;
}

/** Drop a proof once its order has reached a terminal state locally (e.g. after a refund op
 *  reconciles). Best-effort; never throws on a missing row. */
export async function deletePaidOrderProof(orderId: string): Promise<void> {
  await localdb.paidOrderProofs.delete(orderId).catch(() => undefined);
}
