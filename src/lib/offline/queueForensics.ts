// rc.10 — SYNC QUEUE FORENSICS + HISTORICAL RECOVERY.
//
// Classifies every unresolved operation (needs_attention / pending / blocked / retryable) so a final
// acceptance run can tell rc.10 work from historical QA leftovers, exports a REDACTED diagnostic (no
// payloads, no customer data, no secrets — type / status / build / timestamps / error class only), and
// safely re-queues the ONE known historical defect that is provably replay-safe:
//
//   rc.8/rc.9 offline Dine-In rounds whose draft line ids were the cart key "line-N", sent as
//   client_line_id → the server's ::uuid cast failed the WHOLE pos_submit_order transaction (22P02).
//   Nothing was applied server-side (the transaction rolled back; the client_op_id was never recorded),
//   and the round handler now strips non-uuid ids, so a re-queue replays it EXACTLY ONCE. Its dependents
//   that parked with `dependency_failed` never reached the server either, so they are re-queued with it.
//
// Every other parked op is left untouched (operator-driven Retry in the Sync Center).

import { localdb } from "@/lib/offline/db";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { closeEffectiveDependencies } from "@/lib/offline/endShiftOffline";

export type ForensicCategory =
  | "HISTORICAL_LINE_ID_BUG" // pre-rc.10 round 22P02 — auto-recoverable (replay-safe)
  | "HISTORICAL_LOCAL_CUSTOMER_EDIT" // pre-rc.11 edit of an offline-created customer sent its LOCAL id — auto-recoverable
  | "HISTORICAL_SHIFTLESS_DINEIN" // pre-rc.12 offline dine-in order created WITHOUT a shift — server refuses every settle/move/merge
  | "SERVER_COORDINATION_REQUIRED" // pre-rc.12 offline table move/merge (now online-only)
  | "HISTORICAL_DEPENDENT" // parked only because a prerequisite failed
  | "EXPECTED_CONFLICT" // the server state changed elsewhere (version / settled / identity …)
  | "AUTHORITY_REFUSED" // permission refusal at replay
  | "REAL_REPLAY_BUG" // unknown handler / missing dependency / unexplained validation refusal
  | "WAITING" // pending / blocked / retryable — not a failure
  | "SYNCED";

/** rc.12 — which build captured the op (captured_build was introduced in rc.10). */
export type BuildEra = "HISTORICAL_RC8_RC9" | "HISTORICAL_RC10" | "RC11" | "CURRENT" | "OTHER_BUILD";

/** rc.12 — what the operator should do with it. Never an automatic bulk retry. */
export type Disposition = "SYNCED" | "WAITING" | "RETRY_SAFE" | "EXPECTED_CONFLICT" | "UNRELATED_OLD_SHIFT" | "MANUAL_REVIEW" | "REAL_FAILURE";

/** Known RC build SHAs (short prefix match). The current build is passed in by the caller. */
const RC_BUILDS: { prefix: string; era: BuildEra }[] = [
  { prefix: "aa11f48", era: "HISTORICAL_RC10" },
  { prefix: "f61fbd8", era: "RC11" },
];

export function buildEra(captured: string | null | undefined, currentBuild: string | null): BuildEra {
  if (!captured) return "HISTORICAL_RC8_RC9";
  if (currentBuild && (captured === currentBuild || captured.startsWith(currentBuild) || currentBuild.startsWith(captured))) return "CURRENT";
  return RC_BUILDS.find((b) => captured.startsWith(b.prefix))?.era ?? "OTHER_BUILD";
}

const LINE_ID_BUG = /invalid input syntax for type uuid|22p02/i;
const SHIFTLESS = /not attached to an open shift/i;
const CONFLICT_CODES = new Set([
  "version_conflict", "expected_order_mismatch", "settle_conflict", "split_conflict", "edit_conflict", "add_conflict",
  "provider_invalid", "customer_identity_conflict", "refund_conflict", "move_conflict", "merge_conflict",
  "shift_conflict", "shift_closed", "delivery_ops_conflict", "edit_order_conflict", "payout_source_drift", "receivable_conflict",
]);

/** PURE — classify one operation. */
export function classifyOperation(op: OfflineOperation): { category: ForensicCategory; reason: string } {
  if (op.status === "synced") return { category: "SYNCED", reason: "synced" };
  if (op.status !== "needs_attention") return { category: "WAITING", reason: op.status };
  const code = op.last_error_code ?? "";
  const msg = op.last_error_message ?? "";
  if (op.operation_type === "dinein_send_round" && LINE_ID_BUG.test(msg)) {
    return { category: "HISTORICAL_LINE_ID_BUG", reason: "pre-rc.10 round sent a non-uuid line id (22P02); nothing applied server-side" };
  }
  if (op.operation_type === "customer_upsert" && /customer not found for this operating unit/i.test(msg)) {
    return { category: "HISTORICAL_LOCAL_CUSTOMER_EDIT", reason: "pre-rc.11 edit of an offline-created customer sent its local id (refused before any write)" };
  }
  if (SHIFTLESS.test(msg) || code === "shift_missing") {
    return { category: "HISTORICAL_SHIFTLESS_DINEIN", reason: "the order was created without a shift by a pre-rc.12 offline round; the server refuses to settle/move/merge it (nothing applied)" };
  }
  if ((op.operation_type === "move_table" || op.operation_type === "merge_tables") && code !== "dependency_failed") {
    return { category: "SERVER_COORDINATION_REQUIRED", reason: "table move/merge captured offline by a pre-rc.12 build; it now runs online only (nothing applied)" };
  }
  if (code === "dependency_failed") return { category: "HISTORICAL_DEPENDENT", reason: "a prerequisite operation could not complete" };
  if (code === "permission") return { category: "AUTHORITY_REFUSED", reason: "permission refused at replay" };
  if (CONFLICT_CODES.has(code)) return { category: "EXPECTED_CONFLICT", reason: `server state changed (${code})` };
  return { category: "REAL_REPLAY_BUG", reason: code || "unclassified refusal" };
}

/** A redacted, shareable diagnostic of the operation log (no payloads / customer data / secrets). */
export type DiagnosticRow = {
  op: string;
  type: string;
  status: string;
  created_at: string;
  build: string | null;
  rc_current_build: boolean;
  retries: number;
  dependencies: number;
  error_code: string | null;
  error: string | null;
  category: ForensicCategory;
  reason: string;
  /** rc.12 — which build captured it (rc.8/9 · rc.10 · rc.11 · current). */
  era: BuildEra;
  /** rc.12 — what to do with it (never an automatic bulk retry). */
  disposition: Disposition;
  /** rc.12 — the shift the op belongs to (canonical id or offline local id), when it names one. */
  shift: string | null;
  /** rc.12 — operating unit (branch) of its immutable scope. */
  ou: string | null;
  /** rc.12 — the server id it resolved to, when known. */
  canonical: string | null;
  /** rc.12 — every prerequisite with its type + live state (the blocked End Shift chain, in seconds). */
  depends_on: { op: string; type: string; status: string }[];
  /** rc.12 — why it is not done, in one line (null when synced). */
  blocking: string | null;
};

/** rc.12 — the shift an op names (end_shift / sale / round payloads), canonical or offline-local. */
export function shiftOf(o: OfflineOperation): string | null {
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const sub = (p.order_payload ?? p.submit ?? {}) as Record<string, unknown>;
  for (const v of [p.shift_id, p.shift_local, sub.shift_id]) if (typeof v === "string" && v !== "") return v;
  if (o.operation_type === "open_shift") return o.local_entity_id;
  return null;
}

/** rc.12 — PURE. The disposition of one op given its category and (optionally) the live shift. */
export function dispositionOf(o: OfflineOperation, category: ForensicCategory, currentShift: string | null): Disposition {
  if (category === "SYNCED") return "SYNCED";
  if (category === "WAITING") return "WAITING";
  const shift = shiftOf(o);
  if (currentShift && shift && shift !== currentShift && category !== "EXPECTED_CONFLICT") return "UNRELATED_OLD_SHIFT";
  switch (category) {
    case "HISTORICAL_LINE_ID_BUG":
    case "HISTORICAL_LOCAL_CUSTOMER_EDIT":
      return "RETRY_SAFE";
    case "EXPECTED_CONFLICT":
    case "AUTHORITY_REFUSED":
      return "EXPECTED_CONFLICT";
    case "HISTORICAL_SHIFTLESS_DINEIN":
    case "SERVER_COORDINATION_REQUIRED":
    case "HISTORICAL_DEPENDENT":
      return "MANUAL_REVIEW";
    default:
      return "REAL_FAILURE";
  }
}

function blockingOf(o: OfflineOperation, byId: Map<string, OfflineOperation>): string | null {
  if (o.status === "synced" || o.status === "cancelled") return null;
  if (o.status === "blocked_dependency" || o.last_error_code === "dependency_failed" || o.last_error_code === "awaiting_parked_prerequisite") {
    // An End Shift is gated by its CLOSE-RELEVANT prerequisites only (rc.12 barrier) — report exactly those.
    const gating = o.operation_type === "end_shift" ? closeEffectiveDependencies(o, byId) : o.dependency_ids;
    const missing = gating.filter((id) => !byId.has(id)).map((id) => `${id.slice(0, 18)} is missing`);
    const open = gating
      .map((id) => byId.get(id))
      .filter((d): d is OfflineOperation => d != null && d.status !== "synced" && d.status !== "cancelled")
      .map((d) => `${d.operation_type} ${d.operation_id.slice(0, 18)} is ${d.status}${d.last_error_message ? ` (${d.last_error_message.slice(0, 60)})` : ""}`)
      .concat(missing);
    const local = o.depends_on_local_entities.length > 0 ? [`waiting for ${o.depends_on_local_entities.length} local record(s) to sync`] : [];
    const parts = [...open, ...local];
    return parts.length > 0 ? `waiting for: ${parts.join("; ")}` : "waiting for a prerequisite";
  }
  if (o.status === "needs_attention") return o.last_error_message ? o.last_error_message.slice(0, 160) : (o.last_error_code ?? "needs attention");
  if (o.status === "retryable") return "will retry (temporary)";
  return null;
}

export function buildDiagnostic(
  ops: OfflineOperation[],
  currentBuild: string | null,
  opts: { currentShiftId?: string | null; allOps?: OfflineOperation[] } = {},
): DiagnosticRow[] {
  const byId = new Map((opts.allOps ?? ops).map((o) => [o.operation_id, o]));
  return [...ops]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((o) => {
      const c = classifyOperation(o);
      const build = (o as OfflineOperation & { captured_build?: string | null }).captured_build ?? null;
      return {
        op: o.operation_id.slice(0, 18),
        type: String(o.operation_type),
        status: o.status,
        created_at: o.created_at,
        build,
        rc_current_build: currentBuild != null && build === currentBuild,
        retries: o.retry_count,
        dependencies: o.dependency_ids.length,
        error_code: o.last_error_code,
        // Server refusal text only, truncated; never the payload.
        error: o.last_error_message ? o.last_error_message.slice(0, 160) : null,
        category: c.category,
        reason: c.reason,
        era: buildEra(build, currentBuild),
        disposition: dispositionOf(o, c.category, opts.currentShiftId ?? null),
        shift: shiftOf(o),
        ou: o.scope.branch_id ?? null,
        canonical: o.canonical_entity_id ?? null,
        depends_on: o.dependency_ids.map((id) => {
          const d = byId.get(id);
          return { op: id.slice(0, 18), type: d ? String(d.operation_type) : "unknown", status: d ? d.status : "gone (synced + cleaned up)" };
        }),
        blocking: blockingOf(o, byId),
      };
    });
}

/** rc.12 — one Sync Center row: the operation's CURRENT state (one row per operation — the rc.11 list
 *  showed every history EVENT, so one op appeared as Synced, Syncing and Needs attention at once). */
export type SyncCenterRow = DiagnosticRow & { operation_id: string; label: string };

const UNSETTLED = ["pending", "blocked_dependency", "syncing", "retryable", "needs_attention"];

/**
 * rc.12 — the operations the Sync Center shows, BOUNDED: every unsettled op of the scope + the most
 * recent synced ones (the rendered list never grows with the log), with every prerequisite resolved.
 * Unsettled first (needs-attention, then waiting), newest first.
 */
export async function loadSyncCenterRows(input: {
  tenantId: string | null;
  branchId: string | null;
  currentBuild: string | null;
  currentShiftId?: string | null;
  syncedLimit?: number;
}): Promise<SyncCenterRow[]> {
  if (!input.tenantId) return [];
  const inScope = (o: OfflineOperation) => o.scope.tenant_id === input.tenantId && (input.branchId == null || (o.scope.branch_id ?? null) === input.branchId);
  // ONE bulk read (measured faster than index cursors), then bounded in memory.
  const all = await localdb.operations.toArray();
  const scoped = all.filter(inScope);
  const unsettled = scoped.filter((o) => UNSETTLED.includes(o.status));
  const synced = scoped
    .filter((o) => o.status === "synced")
    .sort((a, b) => (b.synced_at ?? b.created_at).localeCompare(a.synced_at ?? a.created_at))
    .slice(0, input.syncedLimit ?? 30);
  const shown = [...unsettled, ...synced];
  const known = new Map(all.map((o) => [o.operation_id, o]));
  // buildDiagnostic orders by created_at (stable) — the same order as `ordered`, so rows zip 1:1.
  const ordered = [...shown].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const diag = buildDiagnostic(ordered, input.currentBuild, { currentShiftId: input.currentShiftId ?? null, allOps: [...known.values()] });
  const rank = (s: string) => (s === "needs_attention" ? 0 : s === "synced" ? 2 : 1);
  return diag
    .map((r, i) => ({ ...r, operation_id: ordered[i].operation_id, label: String(ordered[i].operation_type).replace(/_/g, " ") }))
    .sort((a, b) => rank(a.status) - rank(b.status) || b.created_at.localeCompare(a.created_at));
}

/**
 * Re-queue the provably replay-safe historical failures (see header), at most ONCE per op. Returns the
 * re-queued operation ids. Must run inside the drain's single-flight lock (drainOffline does).
 */
export async function recoverHistoricalReplayFailures(): Promise<string[]> {
  let all = await localdb.operations.toArray();
  // rc.11 — repair (ONCE) a pre-rc.11 edit of an offline-created customer: it was refused before any
  // write, so re-pointing it at the customer's create (customer_local + dependency) and re-queuing it is
  // exactly-once. Only when the target id is provably an offline-created customer (its create op exists).
  const creates = new Set(all.filter((o) => o.operation_type === "customer_upsert" && o.local_entity_id).map((o) => o.local_entity_id as string));
  const custFix = all.filter(
    (o) =>
      o.status === "needs_attention" &&
      classifyOperation(o).category === "HISTORICAL_LOCAL_CUSTOMER_EDIT" &&
      o.result_meta?.rc10_recovered !== true &&
      creates.has(String(((o.payload as { upsert?: { id?: string } } | null)?.upsert?.id) ?? "")),
  );
  if (custFix.length > 0) {
    await localdb.transaction("rw", localdb.operations, async () => {
      for (const o of custFix) {
        const p = (o.payload ?? {}) as { upsert: { id: string } };
        await localdb.operations.update(o.operation_id, {
          status: "pending",
          last_error_code: null,
          last_error_message: null,
          canonical_entity_id: null,
          depends_on_local_entities: [p.upsert.id],
          payload: { ...(o.payload as object), customer_local: p.upsert.id },
          result_meta: { ...(o.result_meta ?? {}), rc10_recovered: true },
        });
      }
    });
    all = await localdb.operations.toArray();
  }
  // rc.12 — an End Shift that rc.10/rc.11 made TERMINAL only because a prerequisite was parked
  // (dependency_failed) never reached the server (pos_end_shift was never called). Under the rc.12 close
  // barrier it WAITS instead, so it is put back to pending ONCE; the barrier then holds it until its
  // close-relevant work has synced (or replays it now when that work is already done). Exactly-once is
  // the server's (pos_end_shift is replay-safe on client_op_id).
  const endFix = all.filter(
    (o) => o.operation_type === "end_shift" && o.status === "needs_attention" && o.last_error_code === "dependency_failed" && o.result_meta?.rc12_recovered !== true,
  );
  if (endFix.length > 0) {
    await localdb.transaction("rw", localdb.operations, async () => {
      for (const o of endFix) {
        await localdb.operations.update(o.operation_id, {
          status: "pending",
          last_error_code: null,
          last_error_message: null,
          result_meta: { ...(o.result_meta ?? {}), rc12_recovered: true },
        });
      }
    });
    all = await localdb.operations.toArray();
  }
  const byId = new Map(all.map((o) => [o.operation_id, o]));
  const roots = all.filter(
    (o) => o.status === "needs_attention" && classifyOperation(o).category === "HISTORICAL_LINE_ID_BUG" && o.result_meta?.rc10_recovered !== true,
  );
  if (roots.length === 0 && custFix.length === 0) return endFix.map((o) => o.operation_id);
  // The re-queue seeds: the historical line-id rounds + the repaired customer edits (already pending).
  const requeue = new Set([...roots.map((o) => o.operation_id), ...custFix.map((o) => o.operation_id), ...endFix.map((o) => o.operation_id)]);
  // Transitively: parked dependents whose ONLY failure is a prerequisite in the re-queue set.
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of all) {
      if (requeue.has(o.operation_id) || o.status !== "needs_attention" || o.last_error_code !== "dependency_failed") continue;
      if (o.result_meta?.rc10_recovered === true) continue;
      const failed = (o.last_error_message ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const deps = failed.length > 0 ? failed : o.dependency_ids;
      if (deps.some((d) => requeue.has(d) || byId.get(d)?.status === "synced")) {
        if (deps.every((d) => requeue.has(d) || byId.get(d)?.status === "synced" || byId.get(d)?.status === "pending")) {
          requeue.add(o.operation_id);
          grew = true;
        }
      }
    }
  }
  await localdb.transaction("rw", localdb.operations, async () => {
    for (const id of requeue) {
      const o = byId.get(id);
      if (!o || o.status !== "needs_attention") continue;
      await localdb.operations.update(id, {
        status: "pending",
        last_error_code: null,
        last_error_message: null,
        result_meta: { ...(o.result_meta ?? {}), rc10_recovered: true },
      });
    }
  });
  return [...requeue];
}
