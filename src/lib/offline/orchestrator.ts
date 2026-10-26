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
import { closeEffectiveDependencies } from "@/lib/offline/endShiftOffline";

/** rc.12 — the generic evaluator over an End Shift's CLOSE-RELEVANT prerequisites (non-relevant /
 *  cancelled ones never gate the close; missing ones are still diagnosed; cycles still detected over the
 *  full graph), so a parked customer edit or table move can never block or fail the close. */
function evaluateCloseDependencies(op: OfflineOperation, byId: Map<string, OfflineOperation>, resolved: Set<string>, opts?: { goneSynced?: ReadonlySet<string> }) {
  return evaluateDependencies({ ...op, dependency_ids: closeEffectiveDependencies(op, byId) }, byId, resolved, opts);
}
import { appendHistory } from "@/lib/offline/syncHistory";
import { type PosTxnSyncContext, type PosTxnSyncDeps, defaultDeps, classifyReplayError, errMsg } from "@/lib/offline/posTxnSync";
import type { HandlerResult } from "@/lib/offline/handlers";

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
  /** 1.0.38 (C2) — dependency_failed ops re-opened this pass because their prerequisite recovered. */
  reopened?: string[];
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

// --- 1.0.38 (C1/D5) — bounded server retries + replay watchdog -----------------------------------
//
// A SERVER_RETRYABLE failure (transient fault, expired JWT, unclassified error, a hung call) is retried
// with the backoff above, but never forever: past its class budget the op parks for a human
// (needs_attention, `retry_exhausted`) — never an infinite loop, never a silent drop. Transport failures
// (no route) stay unbounded: being offline is the normal case, and every replay is idempotent.
const SERVER_RETRY_BUDGET: Record<string, number> = {
  server_transient: 12,
  replay_timeout: 12,
  auth_expired: 6,
  unclassified_error: 3,
  engine_error: 3,
};
const DEFAULT_SERVER_RETRY_BUDGET = 5;
export function serverRetryBudget(code: string): number {
  return SERVER_RETRY_BUDGET[code] ?? DEFAULT_SERVER_RETRY_BUDGET;
}

/** Per-op replay watchdog. A hung RPC (Supabase has no fetch timeout) must never hold the single-flight
 *  drain lock forever: past this the op is treated as a transient failure (the request may or may not
 *  have committed — the replay is idempotent on client_op_id) and the pass continues. */
let replayTimeoutMs = 45_000;
const SESSION_CHECK_TIMEOUT_MS = 10_000;
/** Test-only: shorten the replay watchdog. */
export function __setReplayTimeoutForTests(ms: number): void {
  replayTimeoutMs = ms;
}

class ReplayTimeoutError extends Error {}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReplayTimeoutError(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Wrap the injected server deps so the orchestrator sees the ORIGINAL error a handler caught (with its
 *  HTTP status / PG code), without changing any handler: the one classifier runs centrally. */
function trackDeps(d: PosTxnSyncDeps, onError: (e: unknown) => void): PosTxnSyncDeps {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (typeof v !== "function" || k === "isTransport" || k === "hasSession" || k === "refreshSession") {
      out[k] = v;
      continue;
    }
    const fn = v as (...a: unknown[]) => unknown;
    out[k] = (...args: unknown[]) => {
      try {
        const r = fn(...args);
        return r instanceof Promise ? r.catch((e: unknown) => { onError(e); throw e; }) : r;
      } catch (e) {
        onError(e);
        throw e;
      }
    };
  }
  return out as PosTxnSyncDeps;
}

/**
 * 1.0.38 (C1) — re-classify a handler's TERMINAL verdict through the one classifier when it came from a
 * server error the handler could not recognise: a transient fault or an expired JWT is retryable whatever
 * wording matcher it tripped; an unclassified error (no status/code, unknown text) that fell through to
 * the generic VALIDATION_TERMINAL gets a bounded retry first. A STRUCTURED business refusal (pos_op_error
 * code / 22xxx / 23xxx / 42xxx / P0001 / a known wording) keeps the handler's verdict. Only applied when
 * the result is provably that error (same message) — a handler's own pre-check verdict is never touched.
 */
function reclassify(result: Extract<HandlerResult, { ok: false }>, lastError: unknown): Extract<HandlerResult, { ok: false }> {
  if (lastError === undefined) return result;
  if (["TRANSPORT_RETRYABLE", "SERVER_RETRYABLE", "DEPENDENCY_BLOCKED", "UNKNOWN_HANDLER"].includes(result.retryClass)) return result;
  if (errMsg(lastError) !== result.message) return result;
  const kind = classifyReplayError(lastError);
  if (kind === "transient") return { ...result, retryClass: "SERVER_RETRYABLE", code: "server_transient" };
  if (kind === "auth") return { ...result, retryClass: "SERVER_RETRYABLE", code: "auth_expired" };
  if (kind === "unknown" && result.retryClass === "VALIDATION_TERMINAL") return { ...result, retryClass: "SERVER_RETRYABLE", code: "unclassified_error" };
  return result;
}

/** 1.0.38 (C6) — declared dependency ids that are gone locally but PROVEN synced: durable sync history
 *  holds a `synced` event for that op under the live scope AND its local entity (if any) is mapped in the
 *  entity map (or, for a migrated legacy op, its deterministic id's local is mapped). Garbage collection
 *  through 1.0.37 deleted such prerequisites, which parked a dependent as missing_dependency forever. */
async function provenGoneSynced(ids: string[], ctx: PosTxnSyncContext): Promise<Set<string>> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const mapped = async (local: string) => !!(await localdb.entityMap.get(local).catch(() => undefined));
  const rows = await localdb.syncHistory.where("operation_id").anyOf(ids).toArray().catch(() => []);
  for (const id of ids) {
    const legacy = id.startsWith("mig:shift:") ? id.slice("mig:shift:".length) : id.startsWith("mig:txn:") ? id.slice("mig:txn:".length) : null;
    if (legacy && (await mapped(legacy))) {
      out.add(id);
      continue;
    }
    const ev = rows.find(
      (r) =>
        r.operation_id === id &&
        r.status === "synced" &&
        r.tenant_id === ctx.tenantId &&
        (r.branch_id ?? null) === (ctx.branchId ?? null) &&
        r.cashier_user_id === ctx.cashierUserId &&
        r.device_id === ctx.deviceId,
    );
    if (ev && (ev.local_ref == null || (await mapped(ev.local_ref)))) out.add(id);
  }
  return out;
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
    const p = (op.payload as { payment_intent?: unknown; order_payload?: { order_type?: unknown } | null } | null) ?? {};
    // 1.0.38 — a Delivery order shares the legacy takeaway capture; name it for what it is.
    if (p.order_payload?.order_type === "delivery") return "Delivery order";
    return p.payment_intent ? "Takeaway Cash Sale" : "Takeaway Order";
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
    const p = (op.payload as { order_number?: string; order_type?: string } | null) ?? {};
    if (p.order_type === "delivery") return p.order_number ? `Pay delivery order #${p.order_number}` : "Pay delivery order";
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
    // 1.0.38 — a hung session read (auth lock) must not hold the drain lock either.
    if (!(await withTimeout(d.hasSession(), SESSION_CHECK_TIMEOUT_MS, "session check").catch(() => false))) return report;

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

    // 1.0.38 (C6) — prerequisites garbage-collected after they synced are satisfied, not "missing".
    const missingIds = new Set<string>();
    for (const o of allOps) {
      if (o.status === "synced" || o.status === "cancelled" || !inScope(o)) continue;
      for (const id of o.dependency_ids) if (!byId.has(id)) missingIds.add(id);
    }
    const gateOpts = { goneSynced: await provenGoneSynced([...missingIds], ctx) };
    const gate = (op: OfflineOperation) =>
      op.operation_type === "end_shift" ? evaluateCloseDependencies(op, byId, resolvedLocalEntities, gateOpts) : evaluateDependencies(op, byId, resolvedLocalEntities, gateOpts);
    /** rc.12 — the End Shift prerequisites that are PARKED in this op's own scope (it waits on them). */
    const parkedSameScope = (op: OfflineOperation, ids: string[]) =>
      ids.filter((id) => {
        const p = byId.get(id);
        return p != null && p.status === "needs_attention" && p.scope.tenant_id === op.scope.tenant_id && (p.scope.branch_id ?? null) === (op.scope.branch_id ?? null) && p.scope.device_id === op.scope.device_id && p.scope.cashier_user_id === op.scope.cashier_user_id;
      });

    // 1.0.38 (C2) — deterministic re-open BEFORE the pass: an in-scope op parked as dependency_failed
    // whose prerequisites are no longer failed (synced, or re-queued by an operator retry / recovery) goes
    // back to pending. Repeated to a fixpoint so a whole chain (open → round → settle → next open …)
    // recovers in one pass. Through 1.0.37 dependency_failed was terminal forever. Ops parked for any
    // other reason (a real refusal, a missing/circular dependency) are never touched here.
    const reopened: string[] = [];
    let reopenProgress = true;
    let reopenGuard = 0;
    while (reopenProgress && reopenGuard++ <= allOps.length) {
      reopenProgress = false;
      for (const op of allOps) {
        if (op.status !== "needs_attention" || op.last_error_code !== "dependency_failed" || !inScope(op)) continue;
        const dep = gate(op);
        let stillFailed = !dep.ready && dep.reason !== "blocked";
        if (stillFailed && op.operation_type === "end_shift" && !dep.ready && dep.reason === "dependency_failed" && parkedSameScope(op, dep.failed).length === dep.failed.length) {
          stillFailed = false; // rc.12: the close WAITS on a parked prerequisite (non-terminal)
        }
        if (stillFailed) continue;
        await commit(op, { status: "pending", last_error_code: null, last_error_message: null, server_retry_count: 0 });
        await history(op, "pending", "prerequisite recovered — queued again");
        reopened.push(op.operation_id);
        reopenProgress = true;
      }
    }
    if (reopened.length) report.reopened = reopened;

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
    let refreshedSession = false;

    // Bounded fixpoint: repeat while an op newly settled (which may unblock dependents).
    let progress = true;
    let guard = 0;
    while (progress && guard++ <= working.length) {
      progress = false;
      for (const op of working) {
        if (TERMINAL.includes(op.status)) continue;

        // rc.12 — the End Shift close is gated by its CLOSE-RELEVANT prerequisites only, through the SAME
        // generic evaluator (scope / missing / cycle checks intact). The one difference: a same-scope
        // prerequisite parked in needs_attention makes the close WAIT non-terminally, naming it (it
        // proceeds by itself once the operator resolves it) — through rc.11 it turned the close itself
        // terminal forever ("A prerequisite could not be completed").
        let dep = gate(op);
        if (op.operation_type === "end_shift" && !dep.ready && dep.reason === "dependency_failed") {
          const parked = parkedSameScope(op, dep.failed);
          if (parked.length === dep.failed.length) {
            const message = parked.join(",");
            if (op.status !== "blocked_dependency" || op.last_error_code !== "awaiting_parked_prerequisite" || op.last_error_message !== message) {
              await commit(op, { status: "blocked_dependency", last_error_code: "awaiting_parked_prerequisite", last_error_message: message });
              await history(op, "blocked_dependency", "waiting for an operation that needs attention");
            }
            continue;
          }
          dep = { ready: false, reason: "dependency_failed", failed: dep.failed.filter((id) => !parked.includes(id)) };
        }
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
          } else if (op.status !== "blocked_dependency" || op.last_error_code === "awaiting_parked_prerequisite") {
            // (rc.12: a close that was waiting on a PARKED prerequisite now waits on an ordinary one —
            // clear the stale parked label so the Sync Center diagnostic stays exact.)
            await commit(op, { status: "blocked_dependency", ...(op.last_error_code === "awaiting_parked_prerequisite" ? { last_error_code: null, last_error_message: null } : {}) });
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

        // 1.0.38 — the original server error a handler caught (for the central classifier), and the
        // watchdog's abandon flag: once a replay timed out, its late mid-replay writes are ignored (the
        // next pass replays the op again, idempotently on client_op_id).
        let lastError: unknown = undefined;
        let abandoned = false;
        const hctx: HandlerContext = {
          deps: trackDeps(d, (e) => {
            if (!abandoned) lastError = e;
          }),
          // Scope-exact: a dependency's canonical id is remapped ONLY from a mapping created
          // under this op's full immutable scope (incl. terminal) — never a foreign one.
          canonicalFor: (localId) => canonicalIdForInScope(localId, op.scope),
          update: async (patch) => {
            if (abandoned) return;
            await commit(op, patch);
          },
        };

        let result: HandlerResult;
        try {
          result = await withTimeout(handler.replay(op, hctx), replayTimeoutMs, `${String(op.operation_type)} replay`);
        } catch (e) {
          abandoned = true;
          // A hung call or an engine fault: bounded server-side retry (never a hot loop, never forever).
          result =
            e instanceof ReplayTimeoutError
              ? { ok: false, retryClass: "SERVER_RETRYABLE", code: "replay_timeout", message: e.message }
              : { ok: false, retryClass: "SERVER_RETRYABLE", code: "engine_error", message: e instanceof Error ? e.message : String(e) };
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
            server_retry_count: 0,
          });
          await history(op, "synced", null);
          progress = true;
        } else {
          const failure = reclassify(result, lastError);
          if (failure.retryClass === "SERVER_RETRYABLE") {
            // Bounded: past the class budget the op parks for a human (retry_exhausted), named.
            const n = (op.server_retry_count ?? 0) + 1;
            if (n >= serverRetryBudget(failure.code)) {
              await commit(op, { status: "needs_attention", server_retry_count: n, last_error_code: "retry_exhausted", last_error_message: `${failure.code}: ${failure.message}` });
              await history(op, "needs_attention", "still failing after repeated retries");
              progress = true;
              continue;
            }
            await commit(op, { status: "retryable", server_retry_count: n, last_error_code: failure.code, last_error_message: failure.message });
            await history(op, "retryable", failure.code === "engine_error" || failure.code === "replay_timeout" ? "temporary error" : safeErrorSummary(failure.retryClass));
            // An expired/invalid JWT: refresh the session once per pass so the next attempt is authorised.
            if (failure.code === "auth_expired" && !refreshedSession && d.refreshSession) {
              refreshedSession = true;
              await withTimeout(d.refreshSession(), SESSION_CHECK_TIMEOUT_MS, "session refresh").catch(() => false);
            }
            continue;
          }
          const status = statusForRetryClass(failure.retryClass);
          await commit(op, { status, last_error_code: failure.code, last_error_message: failure.message });
          await history(op, status, safeErrorSummary(failure.retryClass));
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
    // rc.10 — re-queue (once) the provably replay-safe historical failures (pre-rc.10 rounds that sent
    // a non-uuid line id → nothing applied server-side) + their dependency_failed dependents. Under the
    // single-flight lock; never touches any other parked op.
    try {
      const { recoverHistoricalReplayFailures } = await import("@/lib/offline/queueForensics");
      await recoverHistoricalReplayFailures();
    } catch {
      /* recovery is best-effort; the parked ops stay visible + operator-retryable */
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
