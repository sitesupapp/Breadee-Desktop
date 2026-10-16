// Phase B — the ONE replay owner.
//
// A single orchestrator drains the generalized operation log. It is the only thing that
// replays offline business work: posTxnSync delegates to it (no competing drainers), and
// the hardened Phase-A spine is preserved — the single-flight lock is acquired BEFORE the
// first await, connectivity/session are re-checked, and work is processed by capture
// order. Scope isolation is enforced by executing only operations whose immutable scope
// equals the live context (fail-closed; others are reported `deferred`, never run). A
// business operation only ever reaches `synced` or `needs_attention` — it is never
// discarded by any latest-wins/context rule.

import { localdb } from "@/lib/offline/db";
import {
  type OfflineOperation,
  type RetryClass,
  updateOperation,
  gcSyncedOperations,
} from "@/lib/offline/operationLog";
import { evaluateDependencies, resolveEntity, canonicalIdForInScope } from "@/lib/offline/entityMap";
import { handlerFor, type HandlerContext } from "@/lib/offline/handlers";
import { appendHistory } from "@/lib/offline/syncHistory";
import { type PosTxnSyncContext, type PosTxnSyncDeps, defaultDeps } from "@/lib/offline/posTxnSync";

export type OperationDrainReport = {
  startedAt: string;
  finishedAt: string;
  triggeredBy: string;
  drained: string[]; // reached synced this pass
  needsAttention: { id: string; reason: string }[];
  retryable: string[];
  blocked: string[];
  skippedBackoff: string[];
  deferred: string[]; // exists but out of the live scope — never executed here
  /** A staging (migration) failure this pass. Surfaced, never swallowed: the legacy
   *  source rows are intact and the next drain retries, but the report is NOT falsely clean. */
  migrateError?: string;
  /** A legacy-reconciliation failure this pass (same resumability guarantee). */
  reconcileError?: string;
};

/** Module single-flight lock — the one guarantee that two concurrent drains never
 *  process the financial queue together, AND that migration/re-open/reconcile can never
 *  race a replay. Acquired before the first await; held across the WHOLE
 *  migrate -> drain -> reconcile pipeline (see drainOffline). */
let draining = false;

/** Bounded exponential backoff so a retryable op is not hot-looped on connectivity flap. */
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
function backoffMs(retryCount: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, retryCount - 1)));
}

function statusForRetryClass(rc: RetryClass): OfflineOperation["status"] {
  switch (rc) {
    case "TRANSPORT_RETRYABLE":
    case "SERVER_RETRYABLE":
      return "retryable";
    case "DEPENDENCY_BLOCKED":
      return "blocked_dependency";
    case "AUTHORITY_REFUSED":
    case "CONFLICT":
    case "VALIDATION_TERMINAL":
    case "UNKNOWN_HANDLER":
      return "needs_attention";
  }
}

function labelFor(op: OfflineOperation): string {
  if (op.operation_type === "open_shift") return "Open Shift";
  if (op.operation_type === "takeaway_sale") {
    return (op.payload as { payment_intent?: unknown } | null)?.payment_intent ? "Takeaway Cash Sale" : "Takeaway Order";
  }
  if (op.operation_type === "dinein_open_table") {
    const name = (op.payload as { name?: string } | null)?.name;
    return name ? `Open Table ${name}` : "Open Table";
  }
  if (op.operation_type === "dinein_send_round") {
    const p = (op.payload as { table_name?: string; round_seq?: number } | null) ?? {};
    const where = p.table_name ? ` — Table ${p.table_name}` : "";
    return `Kitchen round${where}`;
  }
  if (op.operation_type === "void_refund") {
    const p = (op.payload as { refund?: boolean; order_number?: string } | null) ?? {};
    const num = p.order_number ? ` #${p.order_number}` : "";
    return p.refund ? `Refund order${num}` : `Cancel order${num}`;
  }
  if (op.operation_type === "pay_table") {
    const p = (op.payload as { table_name?: string } | null) ?? {};
    return p.table_name ? `Pay table ${p.table_name}` : "Pay table";
  }
  if (op.operation_type === "pay_order") {
    const p = (op.payload as { order_number?: string } | null) ?? {};
    return p.order_number ? `Pay order #${p.order_number}` : "Pay order";
  }
  if (op.operation_type === "on_account_table") {
    const p = (op.payload as { table_name?: string } | null) ?? {};
    return p.table_name ? `On account — table ${p.table_name}` : "On account — table";
  }
  if (op.operation_type === "on_account_order") {
    const p = (op.payload as { order_number?: string } | null) ?? {};
    return p.order_number ? `On account — order #${p.order_number}` : "On account — order";
  }
  if (op.operation_type === "payout") return "Cash payout";
  if (op.operation_type === "end_shift") return "End shift";
  if (op.operation_type === "split_settle") {
    const p = (op.payload as { order_number?: string; split_seq?: number } | null) ?? {};
    const num = p.order_number ? ` #${p.order_number}` : "";
    return p.split_seq ? `Split ${p.split_seq} — order${num}` : `Split payment${num}`;
  }
  return String(op.operation_type);
}

async function history(op: OfflineOperation, status: OfflineOperation["status"], errorSummary: string | null): Promise<void> {
  await appendHistory({
    at: new Date().toISOString(),
    operation_id: op.operation_id,
    operation_type: op.operation_type,
    action_label: labelFor(op),
    tenant_id: op.scope.tenant_id,
    branch_id: op.scope.branch_id,
    device_id: op.scope.device_id,
    cashier_user_id: op.scope.cashier_user_id,
    local_ref: op.local_entity_id,
    canonical_ref: op.canonical_entity_id,
    status,
    retry_count: op.retry_count,
    error_summary: errorSummary,
    synced_at: op.synced_at,
  });
}

async function commit(op: OfflineOperation, patch: Partial<OfflineOperation>): Promise<void> {
  Object.assign(op, patch);
  await updateOperation(op.operation_id, patch);
}

const TERMINAL: OfflineOperation["status"][] = ["synced", "needs_attention", "cancelled"];

/**
 * Drain the operation log once, under the EXACT live context. Safe to call on mount, on
 * reconnect, and from a manual retry — single-flight protects against overlap. Runs a
 * bounded fixpoint so a dependency chain (shift -> order) resolves within ONE call,
 * regardless of capture order. Returns a structured report. Optional `deps` inject the
 * server calls for tests.
 */
export async function drainOperations(
  ctx: PosTxnSyncContext,
  triggeredBy = "auto",
  deps?: Partial<PosTxnSyncDeps>,
  opts?: { assumeLocked?: boolean },
): Promise<OperationDrainReport> {
  const d: PosTxnSyncDeps = { ...defaultDeps, ...deps };
  // When the whole pipeline already holds the lock (drainOffline), do not re-acquire or
  // release it here; otherwise acquire it standalone (direct callers / tests).
  const ownsLock = !opts?.assumeLocked;
  const report: OperationDrainReport = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    triggeredBy,
    drained: [],
    needsAttention: [],
    retryable: [],
    blocked: [],
    skippedBackoff: [],
    deferred: [],
  };

  const netOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  // Single-flight acquired BEFORE the first await (Phase-A guarantee).
  if (ownsLock && draining) return report;
  if (!ctx.online || netOffline) return report;
  if (!ctx.tenantId || !ctx.cashierUserId) return report;
  if (ownsLock) draining = true;

  try {
    if (!(await d.hasSession())) return report;

    const allOps = await localdb.operations.toArray();
    const byId = new Map(allOps.map((o) => [o.operation_id, o]));
    // Only entity mappings created under the LIVE scope count as resolved — a mapping from
    // another tenant/branch/OU/cashier/device never satisfies a dependency here. (The
    // actual canonical VALUE the handler remaps is additionally gated by
    // canonicalIdForInScope against the op's full immutable scope, incl. terminal.)
    const resolvedLocalEntities = new Set<string>();
    for (const m of await localdb.entityMap.toArray()) {
      if (
        m.tenant_id === ctx.tenantId &&
        (m.branch_id ?? null) === (ctx.branchId ?? null) &&
        m.cashier_user_id === ctx.cashierUserId &&
        m.device_id === ctx.deviceId &&
        (ctx.terminalId == null || (m.terminal_id ?? null) === ctx.terminalId)
      ) {
        // Full five-dimensional scope: a mapping from another TERMINAL must not make an
        // operation here appear dependency-ready (fail-closed at the GATE, so the handler
        // is never even attempted — not merely rejected later at canonical lookup).
        resolvedLocalEntities.add(m.local_entity_id);
      }
    }

    // Immutable scope must equal the live context (fail-closed). terminal_id is part of the
    // scope: enforced when the live context carries one (production always does); contexts
    // that omit it fall back to the device boundary, which terminal is derived from.
    const inScope = (o: OfflineOperation) =>
      o.scope.tenant_id === ctx.tenantId &&
      (o.scope.branch_id ?? null) === (ctx.branchId ?? null) &&
      o.scope.cashier_user_id === ctx.cashierUserId &&
      o.scope.device_id === ctx.deviceId &&
      (ctx.terminalId == null || (o.scope.terminal_id ?? null) === ctx.terminalId);

    // Unsettled ops, FIFO by capture time. Out-of-scope ops are deferred (never run).
    const unsettled = allOps
      .filter((o) => !TERMINAL.includes(o.status))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const working: OfflineOperation[] = [];
    for (const op of unsettled) {
      if (inScope(op)) working.push(op);
      else report.deferred.push(op.operation_id);
    }

    const now = () => Date.now();
    const backoffSkipped = new Set<string>();

    // Bounded fixpoint: repeat while an op newly settled (which may unblock dependents).
    let progress = true;
    let guard = 0;
    while (progress && guard++ <= working.length) {
      progress = false;
      for (const op of working) {
        if (TERMINAL.includes(op.status)) continue;

        const dep = evaluateDependencies(op, byId, resolvedLocalEntities);
        if (!dep.ready) {
          if (dep.reason === "circular") {
            await commit(op, { status: "needs_attention", last_error_code: "circular_dependency", last_error_message: dep.cycle.join(" -> ") });
            await history(op, "needs_attention", "circular dependency");
            progress = true;
          } else if (dep.reason === "missing") {
            await commit(op, { status: "needs_attention", last_error_code: "missing_dependency", last_error_message: dep.missing.join(",") });
            await history(op, "needs_attention", "missing dependency");
            progress = true;
          } else if (dep.reason === "dependency_failed") {
            await commit(op, { status: "needs_attention", last_error_code: "dependency_failed", last_error_message: dep.failed.join(",") });
            await history(op, "needs_attention", "a prerequisite could not be completed");
            progress = true;
          } else if (op.status !== "blocked_dependency") {
            await commit(op, { status: "blocked_dependency" });
            await history(op, "blocked_dependency", null);
          }
          continue;
        }

        // Backoff: skip a retryable op still within its cooldown (no hot-loop on flap).
        if (op.status === "retryable" && op.last_attempt_at) {
          const since = now() - Date.parse(op.last_attempt_at);
          if (Number.isFinite(since) && since < backoffMs(op.retry_count)) {
            backoffSkipped.add(op.operation_id);
            continue;
          }
        }

        const handler = handlerFor(op.operation_type, op.schema_version);
        if (!handler) {
          await commit(op, { status: "needs_attention", last_error_code: "unknown_handler", last_error_message: `${op.operation_type}@${op.schema_version}` });
          await history(op, "needs_attention", "unsupported operation (quarantined)");
          progress = true;
          continue;
        }

        await commit(op, { status: "syncing", retry_count: op.retry_count + 1, last_attempt_at: new Date().toISOString() });
        await history(op, "syncing", null);

        const hctx: HandlerContext = {
          deps: d,
          // Scope-exact: a dependency's canonical id is remapped ONLY from a mapping created
          // under this op's full immutable scope (incl. terminal) — never a foreign one.
          canonicalFor: (localId) => canonicalIdForInScope(localId, op.scope),
          update: async (patch) => commit(op, patch),
        };

        let result;
        try {
          result = await handler.replay(op, hctx);
        } catch (e) {
          await commit(op, { status: "retryable", last_error_code: "engine_error", last_error_message: e instanceof Error ? e.message : String(e) });
          await history(op, "retryable", "temporary error");
          continue;
        }

        if (result.ok) {
          if (op.local_entity_id && result.canonicalId) {
            await resolveEntity({
              local_entity_id: op.local_entity_id,
              entity_type:
                op.operation_type === "open_shift"
                  ? "shift"
                  : op.operation_type === "dinein_open_table"
                    ? "table"
                    : op.operation_type === "customer_upsert"
                      ? "customer"
                      : "order",
              canonical_id: result.canonicalId,
              resolved_at: new Date().toISOString(),
              tenant_id: op.scope.tenant_id,
              branch_id: op.scope.branch_id,
              device_id: op.scope.device_id,
              cashier_user_id: op.scope.cashier_user_id,
              terminal_id: op.scope.terminal_id,
            });
            resolvedLocalEntities.add(op.local_entity_id);
          }
          await commit(op, {
            status: "synced",
            canonical_entity_id: result.canonicalId ?? op.canonical_entity_id,
            synced_at: new Date().toISOString(),
            result_meta: { ...(op.result_meta ?? {}), ...(result.resultMeta ?? {}) },
            last_error_code: null,
            last_error_message: null,
          });
          await history(op, "synced", null);
          progress = true;
        } else {
          const status = statusForRetryClass(result.retryClass);
          await commit(op, { status, last_error_code: result.code, last_error_message: result.message });
          await history(op, status, safeErrorSummary(result.retryClass));
          if (status === "needs_attention") progress = true; // terminal → dependents re-evaluate
        }
      }
    }

    // Derive the report from final statuses (durable truth), de-duplicated.
    for (const op of working) {
      switch (op.status) {
        case "synced":
          report.drained.push(op.operation_id);
          break;
        case "needs_attention":
          report.needsAttention.push({ id: op.operation_id, reason: op.last_error_code ?? "needs_attention" });
          break;
        case "blocked_dependency":
          report.blocked.push(op.operation_id);
          break;
        case "retryable":
        case "syncing":
          if (backoffSkipped.has(op.operation_id)) report.skippedBackoff.push(op.operation_id);
          else report.retryable.push(op.operation_id);
          break;
      }
    }
  } finally {
    if (ownsLock) draining = false;
  }

  // Phase F — housekeeping: GC old SYNCED ops so the log does not grow unbounded. Best-effort and
  // only on a lock-owning pass; it NEVER touches unsettled work (durable ops are never dropped).
  if (ownsLock) {
    try { await gcSyncedOperations(); } catch { /* housekeeping only — never fail a drain */ }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/** A short, non-sensitive summary for history (never the raw server message/payload). */
function safeErrorSummary(rc: RetryClass): string {
  switch (rc) {
    case "TRANSPORT_RETRYABLE": return "waiting for connection";
    case "SERVER_RETRYABLE": return "temporary server issue";
    case "DEPENDENCY_BLOCKED": return "waiting for dependency";
    case "AUTHORITY_REFUSED": return "permission needed";
    case "CONFLICT": return "conflict on the server";
    case "VALIDATION_TERMINAL": return "could not be accepted";
    case "UNKNOWN_HANDLER": return "unsupported operation";
  }
}

/**
 * The single public offline-drain entry for the app. Stages any legacy rows into the
 * operation log (idempotent migration), drains the log through the one orchestrator, then
 * reconciles the legacy source rows' terminal status for the existing UI. This is what
 * the reconnect/mount drain calls — there is no other drainer.
 */
export async function drainOffline(
  ctx: PosTxnSyncContext,
  triggeredBy = "auto",
  deps?: Partial<PosTxnSyncDeps>,
): Promise<OperationDrainReport> {
  // Hold the single-flight lock across the ENTIRE pipeline so migration / synced-op
  // re-open / reconciliation can never race a concurrent replay. A second concurrent
  // drainOffline returns an empty (not-run) report rather than overlapping.
  if (draining) {
    const now = new Date().toISOString();
    return { startedAt: now, finishedAt: now, triggeredBy, drained: [], needsAttention: [], retryable: [], blocked: [], skippedBackoff: [], deferred: [] };
  }
  draining = true;
  try {
    const { migrateLegacyToOperations, reconcileLegacyFromOperations } = await import("@/lib/offline/migration");
    let migrateError: string | undefined;
    let reconcileError: string | undefined;
    // Failures are SURFACED, never swallowed to a falsely-clean report. Migration/reconcile
    // are idempotent and delete nothing, so a failure here leaves the legacy rows intact and
    // the next drain retries — but this pass reports the fault so stranded work is visible.
    try {
      await migrateLegacyToOperations();
    } catch (e) {
      migrateError = e instanceof Error ? e.message : String(e);
    }
    const report = await drainOperations(ctx, triggeredBy, deps, { assumeLocked: true });
    try {
      await reconcileLegacyFromOperations();
      const { reconcileDineDraftsFromOperations } = await import("@/lib/offline/dineinOffline");
      await reconcileDineDraftsFromOperations();
    } catch (e) {
      reconcileError = e instanceof Error ? e.message : String(e);
    }
    if (migrateError) report.migrateError = migrateError;
    if (reconcileError) report.reconcileError = reconcileError;
    return report;
  } finally {
    draining = false;
  }
}

/** Test-only: reset the module single-flight lock between cases. */
export function __resetDrainLockForTests(): void {
  draining = false;
}
