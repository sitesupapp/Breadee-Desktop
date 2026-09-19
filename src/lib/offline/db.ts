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

/**
 * A single UNRESOLVED online order submit, journaled durably ONLY for the window
 * between "about to call pos_submit_order" and "the outcome is known".
 *
 * This is NOT the offline outbox and has NOTHING to do with `enqueue()` / `sync.ts`:
 * it never queues offline work and never replays anything on its own. Its sole job
 * is to let the ALREADY-EXISTING `client_op_id` idempotency survive a process/app
 * crash during a submit, so a restart can reconcile the exact same logical order
 * (same id, same payload) instead of the cashier rebuilding it into a duplicate.
 * A resolved submit is deleted, so a present row always means "unresolved".
 */
export interface InflightSubmit {
  /** The cart's own `client_op_id` — the operation identity, and the primary key. */
  client_op_id: string;
  /** The EXACT payload sent to `pos_submit_order`. Immutable for this id; the
   * reconciliation replay re-sends this verbatim, never a rebuilt cart. */
  payload: unknown;
  tenant_id: string;
  branch_id: string | null;
  terminal_id: string | null;
  device_id: string | null;
  status: "submitting";
  created_at: string; // ISO
}

/** Operator-facing lifecycle of an offline-originated sale. */
export type PosOfflineTxnStatus = "queued" | "syncing" | "synced" | "needs_attention";

/**
 * A durable, offline-ORIGINATED Takeaway + Cash sale (Phase B1).
 *
 * This is deliberately SEPARATE from `inflightSubmits` (Phase A's crash-window
 * journal for an ONLINE submit) and from the generic `outbox`: a B1 transaction
 * is one logical sale that was created while fully offline and carries BOTH the
 * exact order payload AND the cash payment intent as one immutable, replayable
 * unit. Replay is `pos_submit_order` (idempotent on `client_op_id`) then
 * `pos_pay_order` (state-based `already paid` dedup) — exactly the online path,
 * deferred. A row is retained until it is `synced`; it is never dropped silently.
 */
export interface PosOfflineTxn {
  /** Stable client-generated identity, created BEFORE any network request. PK. */
  local_txn_id: string;
  /** Immutable operation id reused on every replay — the server idempotency key. */
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
  /** Why the transaction needs a human (shift closed, permission, validation…). */
  review_reason?: string | null;
  last_error?: string | null;
}

class BreadeeDB extends Dexie {
  outbox!: Table<OutboxItem, number>;
  snapshots!: Table<Snapshot, string>;
  audit!: Table<AuditRecord, number>;
  // Added in schema version 2 (see below). Keyed by client_op_id.
  inflightSubmits!: Table<InflightSubmit, string>;
  // Added in schema version 3 (see below). Keyed by local_txn_id.
  posOfflineTxns!: Table<PosOfflineTxn, string>;

  constructor() {
    super("breadee-desktop");
    this.version(1).stores({
      outbox: "++id, kind, status, tenant_id, branch_id, created_at",
      snapshots: "key, tenant_id, branch_id",
      audit: "++id, action, tenant_id, at, sync_status",
    });
    // Version 2 — ADDITIVE. Dexie carries every unmentioned store (outbox,
    // snapshots, audit) forward untouched; this only ADDS the inflightSubmits
    // store. An existing v1 database upgrades in place with ALL prior data
    // preserved — nothing is cleared, recreated or migrated destructively.
    this.version(2).stores({
      inflightSubmits: "client_op_id, tenant_id, branch_id, created_at",
    });
    // Version 3 — ADDITIVE. Adds ONLY the posOfflineTxns store for offline-
    // originated Takeaway + Cash sales (Phase B1). outbox, snapshots, audit and
    // inflightSubmits carry forward untouched; a v1/v2 database upgrades in place
    // with ALL prior data (Phase-A journal, outbox, snapshots, audit) preserved —
    // nothing is cleared, recreated or migrated destructively.
    this.version(3).stores({
      posOfflineTxns: "local_txn_id, client_op_id, tenant_id, branch_id, status, created_at, cashier_user_id",
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
// Phase B1 — offline Takeaway + Cash transactions
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

/** Every offline sale, newest first — for the Sync Center queue. */
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
