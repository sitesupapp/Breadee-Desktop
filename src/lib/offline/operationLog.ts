// Phase B — the generalized, typed, durable OFFLINE OPERATION LOG.
//
// One queue for every server-dependent mutation captured while offline. It REPLACES
// the role that the Takeaway-specific `posOfflineTxns` + `pendingShifts` stores played
// as replay sources: those remain as legacy/compat producers (migrated in, see
// migration.ts) but are no longer independently drained — the single orchestrator
// (orchestrator.ts) drains THIS log.
//
// Design rules (do not weaken):
//   * A business operation is DURABLE: once captured it must reach `synced` or
//     `needs_attention`. It is NEVER silently dropped and NEVER discarded by a
//     latest-wins/context rule (latest-wins applies only to context refresh, never to
//     a business op).
//   * Capture SCOPE (tenant/OU-branch/device/cashier + a permission snapshot) is
//     written once at creation and is IMMUTABLE. Replay revalidates live authority and
//     fails CLOSED on a scope mismatch — it never re-points an op at whatever branch is
//     selected now.
//   * Forward compatibility: every op carries a `schema_version`. An operation whose
//     (type, schema_version) has no registered handler is QUARANTINED
//     (`needs_attention`, reason `unknown_handler`) and never executed.

import { localdb, operationsRevision } from "@/lib/offline/db";

/** The business operation types Phase B knows. Compat handlers only — Phase B adds NO
 *  new offline business capability. Future phases register new types here. */
export type OperationType =
  | "open_shift" // Case-2 offline-opened shift (was pendingShifts)
  | "takeaway_sale" // offline Takeaway/Delivery-cached sale: submit (+ optional cash pay) (was posOfflineTxns)
  // Phase C — offline Dine-In service continuity (certified Track-A contracts only):
  | "dinein_open_table" // occupy a table / establish the local session (→ pos_open_table)
  | "dinein_send_round" // send a round to the table's open order (→ pos_submit_order, expected_order_id-bound)
  // Phase D — bounded offline refund/void of a LOCALLY-HYDRATED canonical order (→ pos_void_order,
  // expected_version CAS + expected_refund_usd guard). Never against an ad-hoc/local-only order.
  | "void_refund"
  // Phase D — offline SETTLE (cash / dynamic tender). Exactly-once via client_op_id (the settle
  // RPCs already carry the server replay wrapper). pay_table settles a dine-in table bill
  // (→ pos_pay_table); pay_order settles a single order (→ pos_pay_order). Both may depend on the
  // session's open/round ops when the order/table was created offline.
  | "pay_table"
  | "pay_order"
  // Phase D — offline ON-ACCOUNT (receivable) against a LOCALLY-KNOWN (cached/canonical) customer.
  // on_account_table → pos_complete_table_on_account; on_account_order → pos_complete_on_account.
  // Exactly-once via client_op_id. An offline-created customer dependency arrives with Phase E.
  | "on_account_table"
  | "on_account_order"
  // Phase D — offline PAYOUT (petty-cash out of the drawer) → pos_payout_create (replay-safe,
  // records payout_id). Reduces the local drawer projection immediately; exactly-once on reconnect.
  | "payout"
  // Phase D — offline END SHIFT → pos_end_shift (replay-safe). Carries a dependency barrier on
  // EVERY prior shift-affecting op so the canonical close replays LAST, after all sales/payments/
  // refunds/payouts of the shift have synced. Local shift = ENDED_PENDING_SYNC until then.
  | "end_shift"
  // Phase D — offline SPLIT settle leg → pos_split_settle (replay-safe). ITEM-SUBSET split; amount
  // is server-derived from the allocated order-item quantities. Legs replay strictly in order
  // (each depends on the previous). Offline requires server order_item_ids (a hydrated/cached bill);
  // over-allocation / not-splittable / version drift → needs_attention. expected_version NULL offline.
  | "split_settle"
  // Phase E — offline CUSTOMER upsert (create / edit / add-or-edit address) → pos_upsert_customer
  // (replay-safe on client_op_id). A CREATE mints a local customer id (local_entity_id) resolved to
  // the canonical id on reconnect so a later offline delivery/on-account can chain to it; an EDIT
  // carries the canonical id and creates no local entity. A same-OU identity conflict replays as a
  // CONFLICT → needs_attention (never a silent duplicate / silent re-link).
  | "customer_upsert"
  // Phase E — offline ORDER ITEM EDIT of an open, unpaid order. edit_order_line → pos_edit_order_line
  // (set_quantity / change_modifiers; CAS expected_version + reason); add_order_items →
  // pos_add_order_items (CAS expected_version). Both replay-safe on client_op_id. A version drift
  // (the bill changed since it was loaded) → CONFLICT → needs_attention, never a blind re-apply. The
  // target order may be canonical (hydrated) or offline-created (order_local → canonical remap).
  | "edit_order_line"
  | "add_order_items"
  // Phase F — offline RECEIVABLE collection (book a cash/tender payment against ONE on-account
  // order) → pos_receivable_collect (exactly-once via pos_operation_idempotency on client_op_id;
  // FOR UPDATE row lock; re-derives outstanding under the lock and refuses over-collection). Only
  // against a receivable whose outstanding balance is locally proven; a stale/over balance →
  // CONFLICT → needs_attention. Drawer reduced... no — a CASH collection is cash IN.
  | "receivable_collect"
  // Phase E — offline dine-in TABLE RESTRUCTURE of CANONICAL (hydrated) tables with open bills.
  // move_table → pos_move_table (CAS expected_version); merge_tables → pos_merge_tables_v3 (CAS
  // version-map). Both replay-safe on client_op_id + atomic server-side. Any version drift (a bill
  // changed/settled since the floor was loaded) → CONFLICT → needs_attention, never a silent
  // destructive move/merge. (Order TRANSFER stays online — its cross-cashier approval needs the
  // server to mediate.)
  | "move_table"
  | "merge_tables"
  // Phase F (rc.8) — offline DELIVERY-OPS edit (internal delivered-by / handler / cost) →
  // pos_set_delivery_ops (replay-safe on client_op_id; pos_op_replay + pos_op_record). Deterministic
  // internal Breadee state, no money movement, no external coordination. Target order may be canonical
  // (hydrated) or offline-created (order_local → canonical remap).
  | "delivery_ops"
  // Phase F (rc.8) — offline ORDER NOTE edit of an open order → pos_edit_order (replay-safe on
  // client_op_id; every field is a SET so replay converges). NOTE ONLY: an offline discount change is
  // NOT captured here (server-authoritative pricing recompute + the local projection cannot show an
  // accurate payable offline). Target order may be canonical or offline-created (order_local remap).
  | "edit_order"
  // rc.9 — offline DELIVERY PROVIDER selection from the cached, previously-synced AUTHORIZED operational
  // catalog → pos_delivery_set_provider (replay-safe on p_client_op_id). An internal Breadee record; no
  // external provider is contacted. An invalid provider at replay → CONFLICT → needs_attention.
  | "delivery_set_provider";

/** Durable lifecycle of a logged operation. Terminal = synced | cancelled. */
export type OperationStatus =
  | "pending" // captured, awaiting a drain
  | "blocked_dependency" // a prerequisite op is not yet synced
  | "syncing" // a drain pass is actively replaying it
  | "synced" // confirmed on the server (terminal success)
  | "retryable" // transient failure; will be retried with backoff
  | "needs_attention" // definitive refusal / unknown handler / dependency terminal — awaits a human
  | "cancelled"; // explicitly withdrawn (terminal); never auto-set by replay

/** How a failed replay attempt is classified (drives status + backoff). */
export type RetryClass =
  | "TRANSPORT_RETRYABLE" // network/transport; safe to retry (server idempotent)
  | "SERVER_RETRYABLE" // transient server error; bounded retry
  | "DEPENDENCY_BLOCKED" // a prerequisite is unresolved
  | "AUTHORITY_REFUSED" // permission/scope refusal → needs_attention
  | "CONFLICT" // server state conflict → needs_attention
  | "VALIDATION_TERMINAL" // definitive validation refusal → needs_attention
  | "UNKNOWN_HANDLER"; // no handler for (type, schema_version) → needs_attention (quarantine)

/** Immutable scope + authority snapshot captured at creation. Never rewritten. */
export type OperationScope = {
  tenant_id: string;
  branch_id: string | null; // OU/branch
  device_id: string;
  terminal_id: string;
  cashier_user_id: string;
  /** Permission keys the capturing session held, for later reconciliation/audit. Optional. */
  captured_permissions?: string[];
};

/** One durable operation envelope. PK = operation_id (client-minted uuid). */
export interface OfflineOperation {
  operation_id: string;
  operation_type: OperationType | string; // string tolerated so an unknown future type still stores + quarantines
  schema_version: number;
  scope: OperationScope;
  created_at: string; // client ISO at capture
  /** The immutable server-idempotency key for this op's canonical RPC(s). */
  client_op_id: string;
  /** Local id of the entity this op creates (shift/order/…), for dependency wiring. */
  local_entity_id: string | null;
  /** Canonical server id once resolved on reconnect. */
  canonical_entity_id: string | null;
  /** Operations that must be `synced` before this one may replay. */
  dependency_ids: string[];
  /** Local entity ids this op depends on (resolved to canonical before replay). */
  depends_on_local_entities: string[];
  /** The type-specific payload the handler replays. Opaque to the orchestrator. */
  payload: unknown;
  status: OperationStatus;
  retry_count: number;
  last_attempt_at: string | null;
  last_error_code: string | null; // a RetryClass or a short code
  last_error_message: string | null;
  /** Result metadata from a successful replay (safe summary, no sensitive payload). */
  result_meta: Record<string, unknown> | null;
  synced_at: string | null;
  /** rc.10 — the app build (git SHA) that CAPTURED this op, stamped automatically on creation, so queue
   *  forensics can separate this build's work from historical QA leftovers. Absent on older ops. */
  captured_build?: string | null;
  /** 1.0.38 (C1) — consecutive SERVER-side retryable failures (transient / auth / unclassified) since the
   *  last success or operator retry. Bounds the retry: past the class budget the op parks
   *  (needs_attention, `retry_exhausted`) instead of looping forever. Absent on older ops (= 0). */
  server_retry_count?: number;
}

// rc.10 — build provenance: every new operation is stamped with the running build (set once at startup
// from the injected VITE_BUILD_SHA). One Dexie creating-hook covers every capture path.
let captureBuild: string | null = null;
export function setCaptureBuild(build: string | null | undefined): void {
  captureBuild = build && build.trim() !== "" ? build.trim() : null;
}
export function currentCaptureBuild(): string | null {
  return captureBuild;
}
/**
 * 1.0.38 (native Bug 3) — the stamp for this build: its git SHA, else its app version. The staging release
 * workflow never injected VITE_BUILD_SHA, so every operation a Staging build captured carried NO stamp and the
 * Sync Center filed current work as "earlier test build (rc.8/9)". A version stamp can never be mistaken for
 * an unstamped pre-rc.10 capture.
 */
export function captureBuildStamp(sha: string | null | undefined, appVersion: string | null | undefined): string | null {
  const s = (sha ?? "").trim();
  if (s !== "") return s;
  const v = (appVersion ?? "").trim();
  return v !== "" && v !== "0.0.0" ? `v${v}` : null;
}
localdb.operations.hook("creating", (_pk, obj) => {
  const o = obj as OfflineOperation;
  if (o.captured_build == null && captureBuild) o.captured_build = captureBuild;
});

/** The schema version new captures are written at. Bump when the envelope/payload shape changes. */
export const OPERATION_SCHEMA_VERSION = 1;

/** Statuses that still hold unsynced work (must never be GC'd). */
export const UNSETTLED_STATUSES: OperationStatus[] = [
  "pending",
  "blocked_dependency",
  "syncing",
  "retryable",
  "needs_attention",
];

/**
 * Final Foundation (PERF) — every op whose status is in `statuses`, in EXACTLY the order `where("status")
 * .anyOf(statuses)` returns (status ascending, then operation_id), but as one equality range per status
 * read in parallel with a bulk getAll (no JS filter inside the query: a filtered or multi-range anyOf read
 * becomes a key-by-key cursor, which is the slow path — rc.12 measured cursor steps ~35x slower). The
 * optional `filter` is applied in memory afterwards.
 */
export async function operationsWithStatus(statuses: readonly OperationStatus[], filter?: (o: OfflineOperation) => boolean): Promise<OfflineOperation[]> {
  const sorted = [...new Set(statuses)].sort();
  const parts = await Promise.all(sorted.map((s) => localdb.operations.where("status").equals(s).toArray()));
  const all = parts.flat();
  return filter ? all.filter(filter) : all;
}

/**
 * rc.10 — normalize a customer reference for an offline capture. A customer CREATED offline is selected
 * in the UI by its LOCAL id (the customer_upsert op's local_entity_id); sending that as `customer_id`
 * would replay a non-canonical id (the handlers only remap `customer_local`). Any id minted by an
 * offline customer create is therefore carried as `customer_local` — the orchestrator then waits for
 * the create to sync and the handler remaps it to canonical. A canonical id is returned unchanged.
 */
export async function normalizeCustomerRef(customerId: string | null, customerLocal: string | null | undefined): Promise<{ customerId: string | null; customerLocal: string | null }> {
  if (customerLocal) return { customerId: null, customerLocal };
  if (!customerId) return { customerId: null, customerLocal: null };
  const created = await localdb.operations.where("local_entity_id").equals(customerId).toArray().catch(() => [] as OfflineOperation[]);
  if (created.some((o) => o.operation_type === "customer_upsert" && o.status !== "cancelled")) {
    return { customerId: null, customerLocal: customerId };
  }
  return { customerId, customerLocal: null };
}

/** rc.10 — true when `addressId` was minted by an offline customer upsert (its payload.local_address_id). */
export async function isOfflineCreatedAddress(addressId: string | null | undefined): Promise<boolean> {
  if (!addressId) return false;
  const ups = await localdb.operations.where("operation_type").equals("customer_upsert").toArray().catch(() => [] as OfflineOperation[]);
  return ups.some((o) => o.status !== "cancelled" && (o.payload as { local_address_id?: string | null } | null)?.local_address_id === addressId);
}

/** Durably append a new operation BEFORE the UI reports success. Returns its id. */
export async function addOperation(op: OfflineOperation): Promise<string> {
  await localdb.operations.add(op);
  return op.operation_id;
}

/** Patch one operation by id. */
export async function updateOperation(operationId: string, patch: Partial<OfflineOperation>): Promise<void> {
  await localdb.operations.update(operationId, patch);
}

/** One operation by id. */
export async function getOperation(operationId: string): Promise<OfflineOperation | undefined> {
  return localdb.operations.get(operationId);
}

/** Every operation, newest first — for the Sync Center / diagnostics. */
export async function listOperations(): Promise<OfflineOperation[]> {
  return localdb.operations.orderBy("created_at").reverse().toArray();
}

/** Count of operations still holding unsynced work (pending badge source of truth). */
export async function unsettledOperationCount(): Promise<number> {
  const all = await localdb.operations.where("status").anyOf(UNSETTLED_STATUSES).count();
  return all;
}

/**
 * Phase F (Conflict Center) — put a parked operation back in the drain queue for an explicit
 * operator retry. ONLY a `needs_attention` op is requeued (→ pending, errors cleared); a synced,
 * syncing, pending or cancelled op is left untouched (returns false) so a retry can never disturb
 * in-flight or terminal work or resurrect a withdrawn op. The next drain picks it up.
 */
export async function requeueOperation(operationId: string): Promise<boolean> {
  const op = await localdb.operations.get(operationId);
  if (!op || op.status !== "needs_attention") return false;
  await localdb.operations.update(operationId, {
    status: "pending",
    last_error_code: null,
    last_error_message: null,
    server_retry_count: 0,
  });
  // 1.0.38 (C2) — the retry CASCADES to the dependency_failed chain parked behind this op (only that
  // chain — never an unrelated parked op), and asks the live POS for a drain: "Try again on next sync"
  // through 1.0.37 re-queued one op and then waited for a connectivity flip that might never come.
  await requeueDependents([operationId]).catch(() => undefined);
  requestDrain("operator-retry");
  return true;
}

const sameOpScope = (a: OperationScope, b: OperationScope) =>
  a.tenant_id === b.tenant_id &&
  (a.branch_id ?? null) === (b.branch_id ?? null) &&
  a.device_id === b.device_id &&
  a.cashier_user_id === b.cashier_user_id;

/**
 * 1.0.38 (C2) — re-open (needs_attention → pending) every op parked as `dependency_failed` BECAUSE of
 * one of `rootIds`, transitively: it declares the root in dependency_ids, or depends on a local entity
 * the root produces (its local_entity_id / an offline address it creates). Same immutable scope only.
 * Ops parked for any other reason are never touched. A dependent whose OTHER prerequisite is still
 * parked simply re-parks on the next gate (naming it). Returns the re-opened ids (FIFO).
 */
export async function requeueDependents(rootIds: string[]): Promise<string[]> {
  const parked = (await localdb.operations.where("status").equals("needs_attention").toArray()).filter(
    (o) => o.last_error_code === "dependency_failed",
  );
  if (parked.length === 0 || rootIds.length === 0) return [];
  const roots = (await localdb.operations.bulkGet(rootIds)).filter((o): o is OfflineOperation => !!o);
  const done = new Set(rootIds);
  const frontier = [...roots];
  const reopened: OfflineOperation[] = [];
  while (frontier.length > 0) {
    const r = frontier.shift() as OfflineOperation;
    const produced = producedLocalIds(r);
    for (const o of parked) {
      if (done.has(o.operation_id) || !sameOpScope(o.scope, r.scope)) continue;
      const viaOp = o.dependency_ids.includes(r.operation_id);
      const viaEntity = produced.length > 0 && implicitLocalDependencies(o).some((l) => produced.includes(l));
      if (!viaOp && !viaEntity) continue;
      done.add(o.operation_id);
      reopened.push(o);
      frontier.push(o);
    }
  }
  reopened.sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const o of reopened) {
    await localdb.operations.update(o.operation_id, { status: "pending", last_error_code: null, last_error_message: null, server_retry_count: 0 });
  }
  return reopened.map((o) => o.operation_id);
}

/** The local entity ids an op PRODUCES on success (its local_entity_id + an offline address it creates). */
export function producedLocalIds(o: OfflineOperation): string[] {
  const out: string[] = [];
  if (o.local_entity_id) out.push(o.local_entity_id);
  const addr = (o.payload as { local_address_id?: unknown } | null)?.local_address_id;
  if (typeof addr === "string" && addr !== "") out.push(addr);
  return out;
}

/** The local entity ids an op NEEDS resolved: its declared depends_on_local_entities plus an offline
 *  address it remaps at replay (payload.address_local), which the gate does not list. */
export function implicitLocalDependencies(o: OfflineOperation): string[] {
  const out = [...o.depends_on_local_entities];
  const addr = (o.payload as { address_local?: unknown } | null)?.address_local;
  if (typeof addr === "string" && addr !== "" && !out.includes(addr)) out.push(addr);
  return out;
}

// --- 1.0.38 (C2/D5) — drain requests --------------------------------------------------------------
// The replay core cannot import the UI, so an operator retry ANNOUNCES that a drain is wanted; the live
// POS workspace (the owner of the authoritative drain context) subscribes and runs its existing
// single-flight drain. No listener (tests, settings screen without POS) = a harmless no-op.
type DrainListener = (reason: string) => void;
const drainListeners = new Set<DrainListener>();

/** Subscribe to drain requests. Returns the unsubscribe function. */
export function onDrainRequested(listener: DrainListener): () => void {
  drainListeners.add(listener);
  return () => {
    drainListeners.delete(listener);
  };
}

/** Test-only (long-run leak check): how many drain-request listeners are subscribed. */
export function __drainListenerCountForTests(): number {
  return drainListeners.size;
}

/** Ask the live POS (if mounted) to run a drain now. Never throws. */
export function requestDrain(reason: string): void {
  for (const l of [...drainListeners]) {
    try {
      l(reason);
    } catch {
      /* a listener fault never breaks the caller */
    }
  }
}

/**
 * Phase F — garbage-collect SYNCED operations older than `olderThanMs` (default 7 days). (Final Foundation:
 * the production path is the bounded retention pass in retention.ts — 30-day window, legacy-row aware, run
 * by drainOffline under the lock; this standalone helper is kept for direct callers.) NEVER
 * touches an unsettled op (pending/blocked/syncing/retryable/needs_attention) or a cancelled one
 * that is younger than the window — durable work is never dropped. Returns the count removed. The
 * entity map + sync history are intentionally retained (audit/remap continuity). Safe to call on
 * mount; bounded by the synced-status index.
 *
 * 1.0.38 (C6) — a synced op that any UNSETTLED op (incl. needs_attention, which an operator may retry)
 * still references is KEPT: as a declared dependency, as the version source of a later op
 * (payload.version_after_op), or as the line source of a later edit (payload.target_ref.op_id).
 * Deleting it parked the dependent as `missing_dependency` (or silently lost its version chain).
 */
export async function gcSyncedOperations(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - olderThanMs;
  const synced = await localdb.operations.where("status").equals("synced").toArray();
  const live = await localdb.operations.where("status").anyOf(UNSETTLED_STATUSES).toArray();
  const referenced = new Set<string>();
  for (const o of live) {
    for (const d of o.dependency_ids) referenced.add(d);
    const p = (o.payload ?? {}) as { version_after_op?: unknown; target_ref?: { kind?: unknown; op_id?: unknown } | null };
    if (typeof p.version_after_op === "string") referenced.add(p.version_after_op);
    if (p.target_ref && p.target_ref.kind === "after" && typeof p.target_ref.op_id === "string") referenced.add(p.target_ref.op_id);
  }
  const stale = synced.filter((o) => {
    if (referenced.has(o.operation_id)) return false;
    const t = Date.parse(o.synced_at ?? o.created_at);
    return Number.isFinite(t) && t < cutoff;
  });
  await Promise.all(stale.map((o) => localdb.operations.delete(o.operation_id)));
  return stale.length;
}

// --- 1.0.38 — read helpers for badges / Device Settings / sign-out ------------------------------------

/** A (partial) scope filter. An omitted (undefined) dimension is not filtered. `branchId` null OR
 *  undefined = TENANT-WIDE (the same convention as the Sync Center rows / history); the other
 *  dimensions: undefined = not filtered, a value = exact match. */
export type OperationSummaryScope = {
  tenantId: string | null;
  branchId?: string | null;
  cashierUserId?: string | null;
  deviceId?: string | null;
  terminalId?: string | null;
};

/** Counts per state for a scope. `waiting_dependency` = blocked_dependency. `legacy_pending` = captured
 *  rows still only in the legacy stores (posOfflineTxns / pendingShifts) — not yet staged into the log
 *  (they are migrated on the next drain), so they are unsynced work the op-log counts cannot see yet.
 *  `unsettled` = pending + syncing + retryable + waiting_dependency + needs_attention + legacy_pending. */
export type OperationSummary = {
  pending: number;
  syncing: number;
  retryable: number;
  waiting_dependency: number;
  needs_attention: number;
  synced: number;
  legacy_pending: number;
  unsettled: number;
};

function matchesScope(s: OperationSummaryScope, row: { tenant_id: string; branch_id: string | null; cashier_user_id: string; device_id: string; terminal_id?: string | null }): boolean {
  if (row.tenant_id !== s.tenantId) return false;
  if (s.branchId != null && (row.branch_id ?? null) !== s.branchId) return false;
  if (s.cashierUserId !== undefined && row.cashier_user_id !== s.cashierUserId) return false;
  if (s.deviceId !== undefined && row.device_id !== s.deviceId) return false;
  if (s.terminalId !== undefined && s.terminalId !== null && (row.terminal_id ?? null) !== s.terminalId) return false;
  return true;
}

/**
 * 1.0.38 — per-state counts for UI badges (POS status bar, Sync Center chip). Every read goes through
 * the `status` INDEX (one cursor per state) — never a full-history scan. The synced cursor is bounded by
 * the local retention window (Final Foundation: retention.ts, run by drainOffline). Hot paths that only
 * need unsettled counts must pass `includeSynced: false` to skip that cursor.
 */
const summaryCache = new Map<string, { rev: number; counts: Partial<OperationSummary> }>();
export async function summarizeOperations(scope: OperationSummaryScope, opts?: { includeSynced?: boolean }): Promise<OperationSummary> {
  const out: OperationSummary = { pending: 0, syncing: 0, retryable: 0, waiting_dependency: 0, needs_attention: 0, synced: 0, legacy_pending: 0, unsettled: 0 };
  if (!scope.tenantId) return out;
  const m = (o: OfflineOperation) => matchesScope(scope, o.scope);
  // Final Foundation (PERF): one bulk getAll per status range + an in-memory scope filter (a filtered count()
  // walks a cursor key by key — rc.12 measured cursor steps ~35x slower than a bulk read), and the op-log
  // counts are memoised on the operations-store revision: the 15 s badge, the 10 s Sync Center tick and the
  // chip re-read nothing while no op changed. (The legacy-row count below is always re-read.)
  const includeSynced = opts?.includeSynced !== false;
  // (null and undefined mean different filters for some dimensions — keep them distinct in the key)
  const k = (v: string | null | undefined) => (v === undefined ? "\u0000u" : v === null ? "\u0000n" : v);
  const key = [k(scope.tenantId), k(scope.branchId), k(scope.cashierUserId), k(scope.deviceId), k(scope.terminalId), String(includeSynced)].join("\u0001");
  const rev = operationsRevision();
  const hit = summaryCache.get(key);
  if (hit && hit.rev === rev) {
    Object.assign(out, hit.counts);
  } else {
    const count = async (s: OperationStatus) => (await localdb.operations.where("status").equals(s).toArray()).filter(m).length;
    [out.pending, out.syncing, out.retryable, out.waiting_dependency, out.needs_attention] = await Promise.all([
      count("pending"),
      count("syncing"),
      count("retryable"),
      count("blocked_dependency"),
      count("needs_attention"),
    ]);
    if (includeSynced) out.synced = await count("synced");
    if (operationsRevision() === rev) {
      if (summaryCache.size > 32) summaryCache.clear();
      summaryCache.set(key, { rev, counts: { pending: out.pending, syncing: out.syncing, retryable: out.retryable, waiting_dependency: out.waiting_dependency, needs_attention: out.needs_attention, synced: out.synced } });
    }
  }
  out.legacy_pending = await countUnstagedLegacy(scope);
  out.unsettled = out.pending + out.syncing + out.retryable + out.waiting_dependency + out.needs_attention + out.legacy_pending;
  return out;
}

/** Legacy capture rows (offline sale / offline-opened shift) whose work the op log does not show yet:
 *  not staged at all (queued / syncing / needs_attention rows with no mig: op), or a QUEUED sale row whose
 *  op already SYNCED — a later phase (e.g. a cash payment after the order synced) waiting for the next
 *  migrate to re-open the op (the C5 bridge). Without this the badges could read "all synced" while that
 *  payment waits. */
async function countUnstagedLegacy(scope: OperationSummaryScope): Promise<number> {
  const txns = (await localdb.posOfflineTxns.where("status").anyOf(["queued", "syncing", "needs_attention"]).toArray()).filter((t) => matchesScope(scope, t));
  const shifts = (await localdb.pendingShifts.where("status").anyOf(["pending_sync", "needs_attention"]).toArray()).filter((s) => matchesScope(scope, s));
  if (txns.length === 0 && shifts.length === 0) return 0;
  const txnOps = await localdb.operations.bulkGet(txns.map((t) => `mig:txn:${t.local_txn_id}`));
  const shiftOps = await localdb.operations.bulkGet(shifts.map((s) => `mig:shift:${s.local_shift_id}`));
  let n = 0;
  txns.forEach((t, i) => {
    const o = txnOps[i];
    if (!o || (t.status === "queued" && o.status === "synced")) n++;
  });
  for (const o of shiftOps) if (!o) n++;
  return n;
}

/** 1.0.38 (C4) — unsettled work captured on this DEVICE (any cashier/branch), incl. not-yet-staged
 *  legacy rows. Device Settings refuses a terminal-id change while this is > 0: the drain replays only
 *  ops whose terminal equals the live one, so renaming the terminal would orphan them. */
export async function unsettledOperationCountForDevice(deviceId: string): Promise<number> {
  const ops = await localdb.operations.where("status").anyOf(UNSETTLED_STATUSES).filter((o) => o.scope.device_id === deviceId).count();
  const txns = await localdb.posOfflineTxns.where("status").anyOf(["queued", "syncing", "needs_attention"]).filter((t) => t.device_id === deviceId).count();
  const shifts = await localdb.pendingShifts.where("status").anyOf(["pending_sync", "needs_attention"]).filter((s) => s.device_id === deviceId).count();
  return ops + txns + shifts;
}

/** 1.0.38 — local entity ids (offline customers / addresses) that unsettled work still needs: what an
 *  unsettled op depends on or remaps, and what an unsettled customer create produces. Sign-out keeps the
 *  matching pending-local customer rows so a re-login can still see and replay them. */
export async function localEntityIdsNeededByUnsettledOps(): Promise<Set<string>> {
  const out = new Set<string>();
  const live = await localdb.operations.where("status").anyOf(UNSETTLED_STATUSES).toArray();
  for (const o of live) {
    for (const l of implicitLocalDependencies(o)) out.add(l);
    const c = (o.payload as { customer_local?: unknown } | null)?.customer_local;
    if (typeof c === "string" && c !== "") out.add(c);
    if (o.operation_type === "customer_upsert") for (const l of producedLocalIds(o)) out.add(l);
  }
  const txns = await localdb.posOfflineTxns.where("status").anyOf(["queued", "syncing", "needs_attention"]).toArray();
  for (const t of txns) {
    if (t.customer_local) out.add(t.customer_local);
    if (t.address_local) out.add(t.address_local);
  }
  return out;
}

/**
 * Operations ready for a drain pass, in FIFO capture order, scoped to the EXACT live
 * context. An op for another tenant/branch/cashier/device is never returned here (it is
 * not ours to replay in this session). `needs_attention`/`synced`/`cancelled` are excluded;
 * `blocked_dependency` is included so the orchestrator can re-evaluate its prerequisites.
 */
export async function claimableOperations(scope: {
  tenantId: string | null;
  branchId: string | null;
  cashierUserId: string | null;
  deviceId: string | null;
}): Promise<OfflineOperation[]> {
  const rows = await operationsWithStatus(["pending", "blocked_dependency", "retryable", "syncing"]);
  return rows
    .filter(
      (o) =>
        o.scope.tenant_id === scope.tenantId &&
        (o.scope.branch_id ?? null) === (scope.branchId ?? null) &&
        o.scope.cashier_user_id === scope.cashierUserId &&
        o.scope.device_id === scope.deviceId,
    )
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
