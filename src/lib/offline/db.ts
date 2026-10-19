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
  /**
   * Phase E (E3): set when this (delivery) order was placed against an OFFLINE-CREATED customer /
   * address whose ids in `order_payload` are LOCAL (not yet synced). On reconnect the replay engine
   * waits for the customer_upsert to resolve them, then remaps `order_payload.customer_id` /
   * `order_payload.address_id` to the canonical ids BEFORE submitting. Null/absent for a real
   * server customer (the common case).
   */
  customer_local?: string | null;
  address_local?: string | null;
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
  id: string; // server customer id (PK) — OR a LOCAL id when pending_local (offline-created, Phase E)
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
  /** Phase E: true when this is an OFFLINE-CREATED customer whose `id` is a LOCAL id, not yet synced.
   *  A dependent offline order/on-account chains to it via customer_local; the customer_upsert op
   *  resolves it to the canonical id on reconnect. Absent/false for a real server customer. */
  pending_local?: boolean;
  /** Phase E: the local id of the first address captured with an offline-created customer, so a
   *  dependent delivery order can chain address_local → canonical. Absent when no address was added. */
  local_address_id?: string | null;
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

/** Lifecycle of a local Dine-In session (local-only; never a replayable op itself).
 *  rc.10 — `settled` = a full settle / on-account was CAPTURED offline for this session: it is no
 *  longer the table's ACTIVE bill (the table is reusable locally), but it is kept durably — lines,
 *  rounds, the settle op reference — for receipt / Sync History / audit until it syncs. */
export type DineDraftStatus = "open" | "settled" | "closed";

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
  /** rc.10 — the captured settle / on-account op that settled this session locally (status=settled). */
  settled_operation_id?: string | null;
  settled_at?: string | null;
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

/**
 * Phase D (D4) — the local PAYOUT-SOURCE proof, written through while ONLINE.
 *
 * A cash payout records PHYSICAL cash leaving the till to fund an EXISTING economic source
 * (an expense / purchase invoice / supplier payment / maintenance job). The server validates
 * that source against the live DB. OFFLINE, a payout is permitted ONLY against a source whose
 * proof is cached here — i.e. the source provably EXISTED and was VALID at hydration, and
 * belonged to THIS tenant+OU on THIS device/terminal/cashier (fail-closed 5-D isolation). The
 * server re-validates on replay under its row lock, so a source deleted/voided/changed since
 * hydration surfaces as a CONFLICT → needs_attention, never a blind cash-out against a bad
 * record. This store NEVER creates a second economic event and holds NO financial authority —
 * it only GATES offline capture; the canonical `pos_payout_create` remains the source of truth.
 */
export interface PayoutSourceProof {
  /** Deterministic PK: the full 5-D scope + source type + id, so one scope's proof can never
   *  be read under another's (two scopes may legitimately cache the same source id). */
  proof_key: string;
  source_type: string; // 'expense' | 'purchase_invoice' | 'supplier_payment' | 'maintenance_job'
  source_id: string; // the economic record id (server-validated on replay)
  label: string; // preview label (the server re-snapshots the authoritative one)
  sublabel: string | null;
  tenant_id: string;
  branch_id: string | null; // OU
  cashier_user_id: string | null;
  device_id: string | null;
  terminal_id: string | null;
  cached_at: string; // ISO; freshness for the operator
}

/**
 * Phase F — a write-through cache of a RESOLVED print route (kitchen/receipt destination), so a
 * ticket can be ROUTED offline exactly as it was resolved while online. The server stays the
 * authoritative resolver (`resolve_print_route`); this is ONLY a fallback read when that RPC is
 * unreachable, populated on every SUCCESSFUL online resolve. A route is a per-BRANCH config, so the
 * cache is keyed + scoped by branch (routes never cross branches). Printing from the cache creates
 * NO business mutation — it only picks a destination; the sale/round already committed independently.
 */
export interface CachedPrintRoute {
  key: string; // `${branch_id}:${purpose}:${order_source}`
  branch_id: string;
  purpose: string; // 'kitchen_ticket' | 'receipt'
  order_source: string;
  route: unknown; // the ResolvedRoute JSON as the server resolved it
  cached_at: string;
}

/**
 * Phase F (GAP 1) — a durable snapshot of a presented RECEIPT, so a transaction created or settled
 * on THIS device can be reprinted immediately offline AND after a cold restart, before and after
 * canonical sync, without a reconnect. Stores the exact ReceiptData the presenter built (the same
 * layout prints it); keyed by a stable ref (order number / local ref). Device-local and cleared on
 * sign-out. Historical server-only receipts never hydrated here stay reconnect-required.
 */
export interface CachedReceipt {
  ref: string; // stable receipt ref (order number / provisional local ref) — PK
  data: unknown; // the ReceiptData snapshot as presented
  tenant_id: string | null;
  branch_id: string | null;
  provisional: boolean; // true for an offline/local settlement whose server figures aren't final yet
  created_at: string;
}

/**
 * Phase F (GAP 2) — the local proof of an OUTSTANDING on-account RECEIVABLE, written through while
 * ONLINE. An offline receivable collection is permitted ONLY against a receivable proven here: the
 * order existed as a completed on_account order with a locally-known outstanding balance, in THIS
 * tenant+OU. The capture refuses an amount above the proven outstanding; the server
 * (pos_receivable_collect) re-derives outstanding under a FOR UPDATE lock on replay and refuses
 * over-collection, so a stale/over balance → CONFLICT → needs_attention, never an over-collection.
 */
export interface ReceivableProof {
  order_id: string; // canonical on-account order id (PK)
  order_number: string | null;
  tenant_id: string;
  branch_id: string | null; // OU
  customer_id: string | null;
  customer_name: string | null;
  outstanding_amount: number; // in the order's PRIMARY currency (what the collect amount is in)
  currency: string;
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
  // Phase D (D4, schema version 8). Local payout-source proof (valid economic records hydrated
  // while online), so a cash payout can be captured offline against a proven source. Keyed by proof_key.
  payoutSourceProofs!: Table<PayoutSourceProof, string>;
  // Phase F (schema version 9). Write-through cache of resolved print routes (per branch), so a
  // kitchen/receipt ticket can be routed offline. Keyed by `${branch}:${purpose}:${order_source}`.
  printRoutes!: Table<CachedPrintRoute, string>;
  // Phase F (GAP 2, schema version 10). Local proof of outstanding on-account receivables, so a
  // collection can be captured offline against a proven balance. Keyed by order_id.
  receivableProofs!: Table<ReceivableProof, string>;
  // Phase F (GAP 1, schema version 11). Durable presented-receipt snapshots, so a device-created
  // transaction reprints offline + after cold restart. Keyed by ref.
  receipts!: Table<CachedReceipt, string>;

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
    // Version 8 - Phase D (D4), ADDITIVE. Adds ONLY the payoutSourceProofs store (the local proof
    // of valid payout sources, written through while online). Every prior store (v1..v7) carries
    // forward UNTOUCHED; a v1..v7 database upgrades in place with all data preserved. No destructive
    // change, no data migration. `scope_type` is a compound index for scope-exact write-through replace.
    this.version(8).stores({
      payoutSourceProofs: "proof_key, source_type, source_id, tenant_id, branch_id, cashier_user_id, device_id, cached_at",
    });
    // Version 9 - Phase F, ADDITIVE. Adds ONLY the printRoutes write-through cache (resolved
    // kitchen/receipt destinations per branch) so tickets route offline. Every prior store (v1..v8)
    // carries forward UNTOUCHED; a v1..v8 database upgrades in place with all data preserved.
    this.version(9).stores({
      printRoutes: "key, branch_id, purpose, order_source, cached_at",
    });
    // Version 10 - Phase F (GAP 2), ADDITIVE. Adds ONLY the receivableProofs store (local proof of
    // outstanding on-account receivables, written through while online). Every prior store (v1..v9)
    // carries forward UNTOUCHED; a v1..v9 database upgrades in place with all data preserved.
    this.version(10).stores({
      receivableProofs: "order_id, tenant_id, branch_id, customer_id, cached_at",
    });
    // Version 11 - Phase F (GAP 1), ADDITIVE. Adds ONLY the receipts snapshot store (durable
    // reprint of device-created transactions). Every prior store (v1..v10) carries forward UNTOUCHED.
    this.version(11).stores({
      receipts: "ref, tenant_id, branch_id, created_at",
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

// --- Phase E — offline-created (pending-local) customers ---------------------

/** Cache an OFFLINE-CREATED customer under its LOCAL id so the picker can select it offline. The
 *  record carries pending_local:true; a dependent order chains to it via customer_local, and the
 *  customer_upsert op resolves it to a canonical id on reconnect. */
export async function cachePendingLocalCustomer(c: CachedCustomer): Promise<void> {
  if (!c.tenant_id || !c.id) return;
  await localdb.posCustomers.put({ ...c, pending_local: true, cached_at: c.cached_at || new Date().toISOString() });
}

/** Every offline-created (pending-local) customer for a tenant+branch scope. */
export async function listPendingLocalCustomers(tenantId: string | null, branchId: string | null): Promise<CachedCustomer[]> {
  if (!tenantId) return [];
  const all = await localdb.posCustomers.where("tenant_id").equals(tenantId).toArray();
  return all.filter((c) => c.pending_local === true && (c.branch_id ?? null) === (branchId ?? null));
}

/** Drop a pending-local customer once it has synced (the canonical record is cached by the normal
 *  online search/profile mirror). Best-effort; never throws on a missing row. */
export async function deletePendingLocalCustomer(localId: string): Promise<void> {
  await localdb.posCustomers.delete(localId).catch(() => undefined);
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

/** One offline txn by its LOCAL id (PK). Used to tell an offline-captured order (whose id IS the
 *  local_txn_id) from a hydrated canonical order when chaining a receivable offline. */
export async function getPosOfflineTxn(localTxnId: string): Promise<PosOfflineTxn | undefined> {
  return localdb.posOfflineTxns.get(localTxnId);
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

// Phase F (rc.5) — Delivery ORDERS queue read-snapshot, reusing `snapshots`. A READ/CONTINUITY
// projection only (never a mutation authority — pending writes stay in the operation log / posOfflineTxns).
// Written write-through on a successful online queue load (and a hydration prewarm), read offline so the
// Delivery → Orders tab never raises a raw "Failed to fetch". Scope: tenant + branch + shift.
const deliveryQueueKey = (branchId: string | null, shiftId: string | null) =>
  `delivery_queue:${branchId ?? "none"}:${shiftId ?? "today"}`;

/** Cache the operator's delivery-order queue for offline continuity (call only after a successful load). */
export async function cacheDeliveryQueue(rows: unknown, tenantId: string | null, branchId: string | null, shiftId: string | null): Promise<void> {
  if (!tenantId) return;
  await localdb.snapshots.put({ key: deliveryQueueKey(branchId, shiftId), tenant_id: tenantId, branch_id: branchId, data: rows, cached_at: new Date().toISOString() });
}

/** The cached delivery-order queue for a branch+shift, or null. Scope-checked. */
export async function readCachedDeliveryQueue(tenantId: string | null, branchId: string | null, shiftId: string | null): Promise<{ rows: unknown; cachedAt: number } | null> {
  if (!tenantId) return null;
  const row = await localdb.snapshots.get(deliveryQueueKey(branchId, shiftId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { rows: row.data, cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
}

// Phase F (rc.7) — Delivery REPORT read-only snapshot, reusing `snapshots`. The desktop NEVER
// recomputes report metrics: this caches the exact server response for a (branch, from, to) range so
// an offline reopen can show the LAST SYNCED report read-only instead of an indefinite skeleton. Not a
// Reporting-Engine artefact and never presented as live/canonical — the UI labels it "last synced".
const deliveryReportKey = (branchId: string | null, from: string, to: string) =>
  `delivery_report:${branchId ?? "none"}:${from}:${to}`;

/** Cache the exact delivery-report response for a range (call only after a successful online load). */
export async function cacheDeliveryReport(report: unknown, tenantId: string | null, branchId: string | null, from: string, to: string): Promise<void> {
  if (!tenantId) return;
  await localdb.snapshots.put({ key: deliveryReportKey(branchId, from, to), tenant_id: tenantId, branch_id: branchId, data: report, cached_at: new Date().toISOString() });
}

/** The cached delivery-report response for a (branch, range), or null. Scope-checked. */
export async function readCachedDeliveryReport(tenantId: string | null, branchId: string | null, from: string, to: string): Promise<{ report: unknown; cachedAt: string } | null> {
  if (!tenantId) return null;
  const row = await localdb.snapshots.get(deliveryReportKey(branchId, from, to));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  return { report: row.data, cachedAt: row.cached_at };
}

/** Cache an authoritative open bill for a table (call only after a successful online load). rc.9:
 *  `fetchedAt` = when the READ STARTED (not when the write lands), so the operational projection's
 *  "already reflected" test (op synced_at <= fetchedAt) can never treat a round that synced DURING
 *  the read as included when the read actually predates it. */
export async function cacheBill(tableId: string, bill: unknown, tenantId: string | null, branchId: string | null, fetchedAt?: number): Promise<void> {
  if (!tenantId || !tableId) return;
  const at = fetchedAt != null && Number.isFinite(fetchedAt) ? new Date(fetchedAt) : new Date();
  await localdb.snapshots.put({ key: billKey(branchId, tableId), tenant_id: tenantId, branch_id: branchId, data: bill, cached_at: at.toISOString() });
}

// rc.9 — Delivery order LINE snapshot (per canonical order), reusing `snapshots`. Written on every
// successful online detail read (and a bounded hydration prewarm of open unpaid orders) so an order's
// lines are visible + editable offline. Read-only continuity; the server stays authoritative.
const deliveryLinesKey = (orderId: string) => `delivery_lines:${orderId}`;

export async function cacheDeliveryLines(orderId: string, lines: unknown, tenantId: string | null, branchId: string | null, fetchedAt?: number): Promise<void> {
  if (!tenantId || !orderId) return;
  const at = fetchedAt != null && Number.isFinite(fetchedAt) ? new Date(fetchedAt) : new Date();
  await localdb.snapshots.put({ key: deliveryLinesKey(orderId), tenant_id: tenantId, branch_id: branchId, data: lines, cached_at: at.toISOString() });
}

export async function readCachedDeliveryLines(orderId: string, tenantId: string | null, branchId: string | null): Promise<{ lines: unknown; cachedAt: number } | null> {
  if (!tenantId || !orderId) return null;
  const row = await localdb.snapshots.get(deliveryLinesKey(orderId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { lines: row.data, cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
}

// rc.9 — the branch's ACTIVE operational delivery-provider catalog (delivery_providers_operational),
// mirrored per tenant+OU after a successful AUTHORIZED online read. Offline, a provider may be chosen
// ONLY from this previously-synced list (the server re-validates it at replay).
const providersKey = (branchId: string | null) => `delivery_providers:${branchId ?? "none"}`;

export async function cacheDeliveryProviders(providers: unknown[], tenantId: string | null, branchId: string | null): Promise<void> {
  if (!tenantId || !branchId) return;
  await localdb.snapshots.put({ key: providersKey(branchId), tenant_id: tenantId, branch_id: branchId, data: providers, cached_at: new Date().toISOString() });
}

export async function readCachedDeliveryProviders(tenantId: string | null, branchId: string | null): Promise<{ providers: unknown[]; cachedAt: number } | null> {
  if (!tenantId || !branchId) return null;
  const row = await localdb.snapshots.get(providersKey(branchId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { providers: Array.isArray(row.data) ? (row.data as unknown[]) : [], cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
}

/** The cached open bill for a table, or null. Scope-checked. */
export async function readCachedBill(tableId: string, tenantId: string | null, branchId: string | null): Promise<{ bill: unknown; cachedAt: number } | null> {
  if (!tenantId || !tableId) return null;
  const row = await localdb.snapshots.get(billKey(branchId, tableId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { bill: row.data, cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
}

// --- Phase D — payment-method catalog cache (tenant-scoped) ------------------

const payMethodsKey = (tenantId: string) => `paymethods:${tenantId}`;

/** Mirror the tenant's ACTIVE payment-method catalog while online, so the checkout dialog can
 *  still offer the real tenant tenders offline instead of falling back to Cash-only. Tenant-scoped
 *  (methods are a tenant catalog, not branch-specific). The payload is the method list as-is. */
export async function cachePaymentMethods(tenantId: string | null, methods: unknown[]): Promise<void> {
  if (!tenantId) return;
  await localdb.snapshots.put({ key: payMethodsKey(tenantId), tenant_id: tenantId, branch_id: null, data: methods, cached_at: new Date().toISOString() });
}

/** The cached payment-method catalog for a tenant, or null. Scope-checked by tenant. */
export async function readCachedPaymentMethods(tenantId: string | null): Promise<{ methods: unknown[]; cachedAt: number } | null> {
  if (!tenantId) return null;
  const row = await localdb.snapshots.get(payMethodsKey(tenantId));
  if (!row || row.tenant_id !== tenantId) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { methods: Array.isArray(row.data) ? (row.data as unknown[]) : [], cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
}

// --- Phase D (D3) — split-state cache (per canonical order, for offline split of a hydrated bill) -

const splitStateKey = (orderId: string) => `split:${orderId}`;

/** Mirror a bill's authoritative split state (order + its canonical order_item rows + already-
 *  allocated quantities) while online, so a HYDRATED bill can still be split offline against the
 *  real server item ids. Scope-checked by tenant+branch; survives restart. The payload is the
 *  split state as-is (lines carry order_item_id / original + allocated qty / unit price). */
export async function cacheSplitState(orderId: string, state: unknown, tenantId: string | null, branchId: string | null): Promise<void> {
  if (!tenantId || !orderId) return;
  await localdb.snapshots.put({ key: splitStateKey(orderId), tenant_id: tenantId, branch_id: branchId, data: state, cached_at: new Date().toISOString() });
}

/** The cached split state for a canonical order, or null. Scope-checked (tenant + branch/OU). */
export async function readSplitState(orderId: string, tenantId: string | null, branchId: string | null): Promise<{ state: unknown; cachedAt: number } | null> {
  if (!tenantId || !orderId) return null;
  const row = await localdb.snapshots.get(splitStateKey(orderId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const cachedAt = Date.parse(row.cached_at);
  return { state: row.data, cachedAt: Number.isFinite(cachedAt) ? cachedAt : Date.now() };
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

// ---------------------------------------------------------------------------
// Phase D (D4) — payout-source proofs (payoutSourceProofs, v8)
// ---------------------------------------------------------------------------

/** The immutable 5-D scope a payout source is proven and captured under. */
export type PayoutProofScope = {
  tenantId: string | null;
  branchId: string | null; // OU
  cashierUserId: string | null;
  deviceId: string | null;
  terminalId: string | null;
};

/** Deterministic scope-exact key for a payout-source proof. A null dimension is encoded
 *  distinctly (not a wildcard), so a proof captured without a terminal never satisfies a
 *  scoped terminal and vice-versa — the same fail-closed rule the read enforces. */
function payoutProofKey(scope: PayoutProofScope, sourceType: string, sourceId: string): string {
  return [
    scope.tenantId ?? "∅",
    scope.branchId ?? "∅",
    scope.cashierUserId ?? "∅",
    scope.deviceId ?? "∅",
    scope.terminalId ?? "∅",
    sourceType,
    sourceId,
  ].join("\u0001");
}

function inPayoutScope(row: PayoutSourceProof, scope: PayoutProofScope): boolean {
  // FAIL-CLOSED 5-D isolation: every dimension must match EXACTLY, null-safe, in both directions.
  return (
    row.tenant_id === scope.tenantId &&
    (row.branch_id ?? null) === (scope.branchId ?? null) &&
    (row.cashier_user_id ?? null) === (scope.cashierUserId ?? null) &&
    (row.device_id ?? null) === (scope.deviceId ?? null) &&
    (row.terminal_id ?? null) === (scope.terminalId ?? null)
  );
}

/**
 * Write through the valid payout sources of ONE source type for a scope while ONLINE, as a
 * REPLACE-SET: every prior proof for THIS exact (scope, source_type) is dropped and replaced by
 * the current list. A source no longer returned by the authoritative online read is therefore
 * EVICTED (it has gone / become invalid) and can never be offline-paid-out against — exactly the
 * eviction-on-absence the refund proof uses. No-op without a tenant.
 */
export async function cachePayoutSourceProofs(
  scope: PayoutProofScope,
  sourceType: string,
  sources: { id: string; label: string; sublabel: string | null }[],
): Promise<void> {
  if (!scope.tenantId) return;
  const now = new Date().toISOString();
  await localdb.transaction("rw", localdb.payoutSourceProofs, async () => {
    const existing = await localdb.payoutSourceProofs.where("source_type").equals(sourceType).toArray();
    const stale = existing.filter((r) => inPayoutScope(r, scope));
    await Promise.all(stale.map((r) => localdb.payoutSourceProofs.delete(r.proof_key)));
    const rows: PayoutSourceProof[] = sources
      .filter((s) => s.id)
      .map((s) => ({
        proof_key: payoutProofKey(scope, sourceType, s.id),
        source_type: sourceType,
        source_id: s.id,
        label: s.label,
        sublabel: s.sublabel,
        tenant_id: scope.tenantId as string,
        branch_id: scope.branchId ?? null,
        cashier_user_id: scope.cashierUserId ?? null,
        device_id: scope.deviceId ?? null,
        terminal_id: scope.terminalId ?? null,
        cached_at: now,
      }));
    if (rows.length > 0) await localdb.payoutSourceProofs.bulkPut(rows);
  });
}

/** Every cached payout-source proof of one type for the EXACT scope (for the offline picker). */
export async function listPayoutSourceProofs(scope: PayoutProofScope, sourceType: string): Promise<PayoutSourceProof[]> {
  if (!scope.tenantId) return [];
  const all = await localdb.payoutSourceProofs.where("source_type").equals(sourceType).toArray();
  return all.filter((r) => inPayoutScope(r, scope)).sort((a, b) => b.cached_at.localeCompare(a.cached_at));
}

/** One payout-source proof, SCOPE-CHECKED (fail-closed 5-D). Returns null when the source was
 *  never hydrated for this exact scope — the caller must then refuse the offline payout. */
export async function readPayoutSourceProof(
  sourceType: string,
  sourceId: string,
  scope: PayoutProofScope,
): Promise<PayoutSourceProof | null> {
  if (!scope.tenantId || !sourceId) return null;
  const row = await localdb.payoutSourceProofs.get(payoutProofKey(scope, sourceType, sourceId));
  if (!row) return null;
  // Defence in depth: the key already encodes the scope, but re-check every dimension.
  if (!inPayoutScope(row, scope)) return null;
  return row;
}

/** Scope hygiene: drop payout-source proofs that do NOT belong to the current tenant/branch, so a
 *  previous session's sources can never surface for a different tenant/branch. */
export async function purgeForeignPayoutSourceProofs(tenantId: string | null, branchId: string | null): Promise<number> {
  const all = await localdb.payoutSourceProofs.toArray();
  const foreign = all.filter((r) => r.tenant_id !== tenantId || (branchId != null && (r.branch_id ?? null) !== branchId));
  await Promise.all(foreign.map((r) => localdb.payoutSourceProofs.delete(r.proof_key)));
  return foreign.length;
}

/** Sign-out cleanup: drop the whole payout-source proof cache. */
export async function clearPayoutSourceProofs(): Promise<void> {
  await localdb.payoutSourceProofs.clear();
}

// ---------------------------------------------------------------------------
// Phase F — resolved print-route cache (printRoutes, v9)
// ---------------------------------------------------------------------------

const printRouteKey = (branchId: string, purpose: string, orderSource: string) => `${branchId}:${purpose}:${orderSource}`;

/** Write through a RESOLVED print route for a branch (call only after a SUCCESSFUL online resolve).
 *  No-op without a branch. The route JSON is stored as-is so the offline fallback returns exactly
 *  what the server resolved. */
export async function cachePrintRoute(branchId: string | null, purpose: string, orderSource: string, route: unknown): Promise<void> {
  if (!branchId) return;
  await localdb.printRoutes.put({
    key: printRouteKey(branchId, purpose, orderSource),
    branch_id: branchId,
    purpose,
    order_source: orderSource,
    route,
    cached_at: new Date().toISOString(),
  });
}

/** The cached resolved route for a branch+purpose+source, or null. Scope-checked by branch (a route
 *  never crosses branches), so one branch's cached destination can never serve another. */
export async function readCachedPrintRoute(branchId: string | null, purpose: string, orderSource: string): Promise<unknown | null> {
  if (!branchId) return null;
  const row = await localdb.printRoutes.get(printRouteKey(branchId, purpose, orderSource));
  if (!row || row.branch_id !== branchId) return null;
  return row.route;
}

/** Sign-out cleanup: drop the print-route cache. */
export async function clearPrintRoutes(): Promise<void> {
  await localdb.printRoutes.clear();
}

// --- Phase F (GAP 4) — item/station routing + server-printer caches ----------
// Reuse the generic snapshots store (tenant+branch scoped) so an offline kitchen ticket reproduces
// the EXACT station/item routing it had online, instead of falling back to the branch default.
// Write-through ONLY on a successful online load; read as a fallback when that load throws offline.

const itemRoutesKey = (branchId: string | null) => `itemroutes:${branchId ?? "none"}`;
const serverPrintersKey = (branchId: string | null) => `printers:${branchId ?? "none"}`;

/** Cache the branch's item/category kitchen routes (call only after a successful online load). */
export async function cacheItemRoutes(tenantId: string | null, branchId: string | null, routes: unknown[]): Promise<void> {
  if (!tenantId) return;
  await localdb.snapshots.put({ key: itemRoutesKey(branchId), tenant_id: tenantId, branch_id: branchId, data: routes, cached_at: new Date().toISOString() });
}

/** The cached item routes for a branch, or null. Scope-checked (tenant + branch). */
export async function readCachedItemRoutes(tenantId: string | null, branchId: string | null): Promise<unknown[] | null> {
  if (!tenantId) return null;
  const row = await localdb.snapshots.get(itemRoutesKey(branchId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  return Array.isArray(row.data) ? (row.data as unknown[]) : null;
}

/** Cache the branch's server printer registry (call only after a successful online load). */
export async function cacheServerPrinters(tenantId: string | null, branchId: string | null, printers: unknown[]): Promise<void> {
  if (!tenantId) return;
  await localdb.snapshots.put({ key: serverPrintersKey(branchId), tenant_id: tenantId, branch_id: branchId, data: printers, cached_at: new Date().toISOString() });
}

/** The cached server printers for a branch, or null. Scope-checked (tenant + branch). */
export async function readCachedServerPrinters(tenantId: string | null, branchId: string | null): Promise<unknown[] | null> {
  if (!tenantId) return null;
  const row = await localdb.snapshots.get(serverPrintersKey(branchId));
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  return Array.isArray(row.data) ? (row.data as unknown[]) : null;
}

// ---------------------------------------------------------------------------
// Phase F (GAP 2) — outstanding-receivable proofs (receivableProofs, v10)
// ---------------------------------------------------------------------------

/** Write through the proof of an OUTSTANDING receivable while ONLINE. Idempotent per order_id; a
 *  newer read replaces the prior proof. A receivable with no outstanding balance is EVICTED so it
 *  can never be offline-collected against. No-op without tenant/order. */
export async function cacheReceivableProof(proof: ReceivableProof): Promise<void> {
  if (!proof.tenant_id || !proof.order_id) return;
  if (!(proof.outstanding_amount > 0)) {
    await localdb.receivableProofs.delete(proof.order_id).catch(() => undefined);
    return;
  }
  await localdb.receivableProofs.put({ ...proof, cached_at: proof.cached_at || new Date().toISOString() });
}

/** The proof for a receivable order, or null. SCOPE-CHECKED (tenant + OU/branch) — a proof from a
 *  sibling OU or another tenant is never returned (fail-closed). */
export async function readReceivableProof(
  orderId: string,
  scope: { tenantId: string | null; branchId: string | null },
): Promise<ReceivableProof | null> {
  if (!scope.tenantId || !orderId) return null;
  const row = await localdb.receivableProofs.get(orderId);
  if (!row) return null;
  if (row.tenant_id !== scope.tenantId) return null;
  if ((row.branch_id ?? null) !== (scope.branchId ?? null)) return null;
  return row;
}

/** Every proven outstanding receivable for a customer in a tenant+branch scope (for the offline list). */
export async function listReceivableProofs(tenantId: string | null, branchId: string | null, customerId?: string | null): Promise<ReceivableProof[]> {
  if (!tenantId) return [];
  const all = await localdb.receivableProofs.where("tenant_id").equals(tenantId).toArray();
  return all.filter((r) => (r.branch_id ?? null) === (branchId ?? null) && (customerId == null || r.customer_id === customerId));
}

/** Drop a receivable proof (e.g. once its collection reconciles). Best-effort. */
export async function deleteReceivableProof(orderId: string): Promise<void> {
  await localdb.receivableProofs.delete(orderId).catch(() => undefined);
}

/** Sign-out cleanup: drop the receivable-proof cache (privacy — customer balances). */
export async function clearReceivableProofs(): Promise<void> {
  await localdb.receivableProofs.clear();
}

// ---------------------------------------------------------------------------
// Phase F (GAP 1) — durable receipt snapshots (receipts, v11)
// ---------------------------------------------------------------------------

/** Persist a presented receipt so it can be reprinted offline + after restart. Idempotent per ref
 *  (a newer present of the same ref — e.g. a provisional offline receipt later reconciled online —
 *  replaces it). No-op without a ref. Best-effort: never throws into the caller's print path. */
export async function persistReceiptSnapshot(input: {
  ref: string;
  data: unknown;
  tenantId?: string | null;
  branchId?: string | null;
  provisional?: boolean;
}): Promise<void> {
  if (!input.ref) return;
  try {
    await localdb.receipts.put({
      ref: input.ref,
      data: input.data,
      tenant_id: input.tenantId ?? null,
      branch_id: input.branchId ?? null,
      provisional: input.provisional === true,
      created_at: new Date().toISOString(),
    });
  } catch {
    /* a persistence failure must never break presenting/printing a receipt */
  }
}

/** One persisted receipt by its ref, or null. */
export async function readReceiptSnapshot(ref: string): Promise<CachedReceipt | null> {
  if (!ref) return null;
  return (await localdb.receipts.get(ref).catch(() => undefined)) ?? null;
}

/** The most recent persisted receipt (optionally scoped to tenant), for a post-restart Ctrl+P
 *  reprint of the last transaction. */
export async function readLatestReceiptSnapshot(tenantId?: string | null): Promise<CachedReceipt | null> {
  const rows = await localdb.receipts.orderBy("created_at").reverse().toArray().catch(() => []);
  const match = rows.find((r) => tenantId == null || r.tenant_id == null || r.tenant_id === tenantId);
  return match ?? null;
}

/** Sign-out cleanup: drop the receipt-snapshot cache (privacy). */
export async function clearReceiptSnapshots(): Promise<void> {
  await localdb.receipts.clear();
}
