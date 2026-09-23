import Dexie, { type Table } from "dexie";

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

class BreadeeDB extends Dexie {
  outbox!: Table<OutboxItem, number>;
  snapshots!: Table<Snapshot, string>;
  audit!: Table<AuditRecord, number>;
  // Added in schema version 2 (see below). Keyed by local_txn_id.
  posOfflineTxns!: Table<PosOfflineTxn, string>;
  // Added in schema version 3 (see below). Keyed by the server customer id.
  posCustomers!: Table<CachedCustomer, string>;

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
