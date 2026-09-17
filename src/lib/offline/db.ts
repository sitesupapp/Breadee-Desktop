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

class BreadeeDB extends Dexie {
  outbox!: Table<OutboxItem, number>;
  snapshots!: Table<Snapshot, string>;
  audit!: Table<AuditRecord, number>;
  // Added in schema version 2 (see below). Keyed by client_op_id.
  inflightSubmits!: Table<InflightSubmit, string>;

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
