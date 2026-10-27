// Final Foundation (PERF, Track 10) — bounded LOCAL RETENTION of settled offline history.
//
// Through 1.0.38-dev nothing ever pruned the local stores in production: the synced-op GC ran only on a
// lock-OWNING drain (never the production drainOffline path), `trimSyncedHistory` had no caller, and
// entityMap / posOfflineTxns / dineDrafts / per-shift snapshots / receipts had no delete at all. Every hot
// local read (drain pass, floor projection, orders-history overlay, Sync Center) therefore grew linearly
// with the terminal's tenure.
//
// This module is the ONE retention pass. It runs inside drainOffline, UNDER the single-flight drain lock
// (so it never races a replay, a migration or a reconcile), at most once per RETENTION_MIN_INTERVAL_MS,
// and deletes ONLY settled, old, unreferenced rows. It NEVER deletes:
//   - an unsettled op (pending / blocked / syncing / retryable / needs_attention — incl. conflict, legacy
//     quarantine and manual-review ops) or a cancelled one;
//   - anything an unsettled op references (dependency ids, version / line-source chains, local entities,
//     any id in its payload), transitively through the referenced ops' own dependencies;
//   - anything inside a shift that is still open or unsynced (an unsettled op's shift, an open dine-in
//     session's shift, an unsynced offline-opened shift, the persisted POS session's shift);
//   - a migrated legacy op (mig:txn:*) unless its legacy source row is pruned in the same pass (otherwise
//     the next migrate would re-stage it), nor any mig:shift:* op (pendingShifts are never pruned);
//   - an entity mapping any remaining local row still names;
//   - sync-history events of an unsettled op or of an op an unsettled op / a kept session references
//     (provenGoneSynced in the orchestrator reads them).
// Phase 1 computes candidates from a full read (throttled); phase 2 re-derives the LIVE guards and deletes
// inside ONE rw transaction over every touched store, so a capture landing in between (captures do not
// take the drain lock) can never lose a row it just started to reference.

import { localdb, readAllOperationsMirrored, type DineDraft, type PosOfflineTxn } from "@/lib/offline/db";
import { type OfflineOperation, UNSETTLED_STATUSES, operationsWithStatus } from "@/lib/offline/operationLog";
import { readAllPosSessionSnapshots } from "@/lib/offline/posSession";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Synced operations are kept at least this long after they synced. */
export const RETENTION_SYNCED_OPS_MS = 30 * DAY_MS;
/** Sync-history events are kept at least this long. */
export const RETENTION_HISTORY_MS = 90 * DAY_MS;
/** Synced + reconciled legacy offline sales (posOfflineTxns) are kept at least this long. */
export const RETENTION_LEGACY_TXN_MS = 30 * DAY_MS;
/** Settled / closed / merged dine-in sessions are kept at least this long after their last update. */
export const RETENTION_DINE_DRAFT_MS = 30 * DAY_MS;
/** Entity mappings are kept at least this long after they resolved (and while anything names them). */
export const RETENTION_ENTITY_MAP_MS = 30 * DAY_MS;
/** Per-shift / per-order READ snapshots (re-fetchable caches) are kept at least this long. */
export const RETENTION_SNAPSHOT_MS = 30 * DAY_MS;
/** Final (non-provisional) receipt reprint snapshots are kept at least this long. */
export const RETENTION_RECEIPT_MS = 30 * DAY_MS;
/** A retention pass runs at most this often (it reads every op once). */
export const RETENTION_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Upper bound of rows deleted per store per pass, so one pass (one rw transaction) stays short on the main
 *  thread; a 90-day backlog catches up over a few throttled passes. */
export const RETENTION_MAX_DELETE_PER_STORE = 5_000;

/** Snapshot key prefixes that are per-shift / per-order READ caches (re-fetchable when online). The
 *  floor / table map / menu / catalog / proof snapshots are bounded by construction and never pruned. */
const PRUNABLE_SNAPSHOT_PREFIXES = ["orders:shift:", "orders:day:", "delivery_lines:", "delivery_queue:", "delivery_report:", "split:"];

export type RetentionReport = {
  at: string;
  operations: number;
  syncHistory: number;
  posOfflineTxns: number;
  dineDrafts: number;
  entityMap: number;
  snapshots: number;
  receipts: number;
  error?: string;
};

let lastRunAt = 0;
let lastReport: RetentionReport | null = null;

/** The last pass's report (diagnostics / tests). */
export function lastRetentionReport(): RetentionReport | null {
  return lastReport;
}

/** Test-only: forget the throttle. */
export function __resetRetentionForTests(): void {
  lastRunAt = 0;
  lastReport = null;
}

/** Run a retention pass when the throttle allows. MUST be called under the drain lock (drainOffline).
 *  Never throws: housekeeping must never fail a drain. */
export async function runRetentionIfDue(now = Date.now()): Promise<RetentionReport | null> {
  if (lastRunAt !== 0 && now - lastRunAt < RETENTION_MIN_INTERVAL_MS) return null;
  lastRunAt = now;
  try {
    lastReport = await runRetention({ now });
  } catch (e) {
    lastReport = { ...emptyReport(now), error: e instanceof Error ? e.message : String(e) };
  }
  return lastReport;
}

function emptyReport(now: number): RetentionReport {
  return { at: new Date(now).toISOString(), operations: 0, syncHistory: 0, posOfflineTxns: 0, dineDrafts: 0, entityMap: 0, snapshots: 0, receipts: 0 };
}

/** Every string reachable in a value (ids in payloads, nested submits, line refs …), bounded depth. */
function collectStrings(v: unknown, out: Set<string>, depth = 0): void {
  if (typeof v === "string") {
    if (v !== "") out.add(v);
    return;
  }
  if (v == null || typeof v !== "object" || depth > 8) return;
  if (Array.isArray(v)) {
    for (const x of v) collectStrings(x, out, depth + 1);
    return;
  }
  for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out, depth + 1);
}

function opRefs(o: OfflineOperation, out: Set<string>): void {
  out.add(o.operation_id);
  if (o.local_entity_id) out.add(o.local_entity_id);
  if (o.canonical_entity_id) out.add(o.canonical_entity_id);
  for (const d of o.dependency_ids ?? []) out.add(d);
  for (const l of o.depends_on_local_entities ?? []) out.add(l);
  collectStrings(o.payload, out);
  // dependency_failed / awaiting_parked_prerequisite name their prerequisite ids here.
  for (const t of (o.last_error_message ?? "").split(",")) if (t.trim() !== "") out.add(t.trim());
}

/** The shift ids an op names (canonical or offline-local). */
function shiftsOfOp(o: OfflineOperation): string[] {
  const p = (o.payload ?? {}) as Record<string, unknown>;
  const sub = ((p.order_payload ?? p.submit ?? {}) as Record<string, unknown>) ?? {};
  const out: string[] = [];
  for (const v of [p.shift_id, p.shift_local, sub.shift_id]) if (typeof v === "string" && v !== "") out.push(v);
  if (o.operation_type === "open_shift" || o.operation_type === "end_shift") {
    if (o.local_entity_id) out.push(o.local_entity_id);
    if (o.canonical_entity_id) out.push(o.canonical_entity_id);
  }
  return out;
}
const shiftsOfTxn = (t: PosOfflineTxn): string[] =>
  [t.shift_id, t.pending_shift_local_id, (t.order_payload as { shift_id?: unknown } | null)?.shift_id].filter((x): x is string => typeof x === "string" && x !== "");
const shiftsOfDraft = (d: DineDraft): string[] => [d.shift_id, d.shift_local].filter((x): x is string => typeof x === "string" && x !== "");

/** The op ids a dine-in session names (its barrier / work references). */
function draftOpIds(d: DineDraft): string[] {
  return [
    d.open_operation_id,
    ...(d.rounds ?? []).map((r) => r.operation_id),
    d.structural_op_id,
    d.carried_op_id,
    d.settled_operation_id,
    d.merged_op_id,
    d.closed_evidence_op_id,
    ...(d.merged_blocks ?? []).map((b) => b.op_id),
  ].filter((x): x is string => typeof x === "string" && x !== "");
}

type LiveGuards = { refs: Set<string>; shifts: Set<string>; deps: Set<string> };

/** References + open shifts held by LIVE work only (cheap: status-indexed reads). New references can only
 *  appear through live work, so re-deriving these inside the delete transaction closes the capture race. */
async function liveGuards(): Promise<LiveGuards> {
  const refs = new Set<string>();
  const shifts = new Set<string>();
  const deps = new Set<string>();
  const live = await operationsWithStatus(UNSETTLED_STATUSES);
  for (const o of live) {
    opRefs(o, refs);
    for (const s of shiftsOfOp(o)) shifts.add(s);
    for (const d of o.dependency_ids ?? []) deps.add(d);
  }
  const open = await localdb.dineDrafts.where("status").equals("open").toArray();
  for (const d of open) {
    collectStrings(d, refs);
    for (const s of shiftsOfDraft(d)) shifts.add(s);
  }
  const txns = (await Promise.all(["needs_attention", "queued", "syncing"].map((s) => localdb.posOfflineTxns.where("status").equals(s).toArray()))).flat();
  for (const t of txns) {
    collectStrings(t, refs);
    for (const s of shiftsOfTxn(t)) shifts.add(s);
  }
  for (const p of await localdb.pendingShifts.toArray()) {
    refs.add(p.local_shift_id);
    if (p.status !== "synced") {
      shifts.add(p.local_shift_id);
      if (p.server_shift_id) shifts.add(p.server_shift_id);
      if (p.after_end_op_id) refs.add(p.after_end_op_id);
    }
  }
  // Every cashier's open shift on this device (one snapshot per cashier since the offline-first recovery).
  for (const session of readAllPosSessionSnapshots()) if (session.shift?.id) shifts.add(session.shift.id);
  // A live op's prerequisite may already be gone (GC'd by an older build): the orchestrator proves it
  // synced from its history event + the mapping of that event's local ref (provenGoneSynced) — keep both.
  if (deps.size > 0) {
    for (const d of deps) {
      if (d.startsWith("mig:shift:")) refs.add(d.slice("mig:shift:".length));
      else if (d.startsWith("mig:txn:")) refs.add(d.slice("mig:txn:".length));
    }
    // Only a prerequisite already GONE from the log is proven through history (a present one is kept as a
    // ref anyway): one equality read per gone id — normally none.
    const depIds = [...deps];
    const present = await localdb.operations.bulkGet(depIds);
    const gone = depIds.filter((_, i) => !present[i]);
    const evs = (await Promise.all(gone.map((id) => localdb.syncHistory.where("operation_id").equals(id).toArray()))).flat();
    for (const e of evs) if (e.local_ref) refs.add(e.local_ref);
  }
  return { refs, shifts, deps };
}

const olderThan = (iso: string | null | undefined, cutoff: number) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) && t < cutoff;
};

/**
 * One retention pass. Exported for tests and for the long-run harness; production calls
 * runRetentionIfDue from drainOffline (under the drain lock).
 */
export async function runRetention(opts: { now?: number } = {}): Promise<RetentionReport> {
  const now = opts.now ?? Date.now();
  const report = emptyReport(now);
  const opCut = now - RETENTION_SYNCED_OPS_MS;
  const histCut = now - RETENTION_HISTORY_MS;
  const txnCut = now - RETENTION_LEGACY_TXN_MS;
  const draftCut = now - RETENTION_DINE_DRAFT_MS;
  const mapCut = now - RETENTION_ENTITY_MAP_MS;
  const snapCut = now - RETENTION_SNAPSHOT_MS;
  const rcptCut = now - RETENTION_RECEIPT_MS;

  // ---------------- phase 1: candidates (full read; throttled) ----------------
  // (read-only use: the shared incremental mirror — same rows as toArray(), without re-reading the store)
  const allOps = await readAllOperationsMirrored();
  const byId = new Map(allOps.map((o) => [o.operation_id, o]));
  const { refs, shifts } = await liveGuards();
  const shiftOpen = (ids: string[]) => ids.some((s) => shifts.has(s));

  // Transitive closure: a synced op an unsettled op references keeps ITS prerequisites too.
  const frontier = [...refs].filter((id) => byId.has(id));
  const protectedOps = new Set<string>();
  while (frontier.length > 0) {
    const id = frontier.pop() as string;
    if (protectedOps.has(id)) continue;
    protectedOps.add(id);
    const o = byId.get(id);
    if (!o) continue;
    for (const d of o.dependency_ids ?? []) if (byId.has(d) && !protectedOps.has(d)) frontier.push(d);
    const p = (o.payload ?? {}) as { version_after_op?: unknown; target_ref?: { op_id?: unknown } | null };
    for (const d of [p.version_after_op, p.target_ref?.op_id]) if (typeof d === "string" && byId.has(d) && !protectedOps.has(d)) frontier.push(d);
  }

  // Legacy offline sales: synced + reconciled (row synced), old, unreferenced, closed shift, op settled.
  const syncedTxns = await localdb.posOfflineTxns.where("status").equals("synced").toArray();
  const txnDel = new Set<string>();
  for (const t of syncedTxns) {
    if (txnDel.size >= RETENTION_MAX_DELETE_PER_STORE) break;
    if (!olderThan(t.created_at, txnCut) || refs.has(t.local_txn_id) || shiftOpen(shiftsOfTxn(t))) continue;
    const op = byId.get(`mig:txn:${t.local_txn_id}`);
    if (op && (op.status !== "synced" || protectedOps.has(op.operation_id) || !olderThan(op.synced_at ?? op.created_at, opCut))) continue;
    txnDel.add(t.local_txn_id);
  }

  // Dine-in sessions: settled / closed / merged, old, every op they name settled (no unsettled work).
  const doneDrafts = (await Promise.all(["closed", "merged", "settled"].map((s) => localdb.dineDrafts.where("status").equals(s).toArray()))).flat();
  const draftDel = new Map<string, DineDraft>();
  for (const d of doneDrafts) {
    if (draftDel.size >= RETENTION_MAX_DELETE_PER_STORE) break;
    if (!olderThan(d.updated_at ?? d.created_at, draftCut) || refs.has(d.local_session_id) || shiftOpen(shiftsOfDraft(d))) continue;
    const ids = draftOpIds(d);
    if (ids.some((id) => refs.has(id) || protectedOps.has(id))) continue;
    if (ids.some((id) => { const o = byId.get(id); return o != null && o.status !== "synced" && o.status !== "cancelled"; })) continue;
    draftDel.set(d.local_session_id, d);
  }
  // Ops a KEPT session still names stay (sessionWorkOps counts a missing barrier op).
  const keptDraftOps = new Set<string>();
  const keptDrafts = (await localdb.dineDrafts.toArray()).filter((d) => !draftDel.has(d.local_session_id));
  for (const d of keptDrafts) for (const id of draftOpIds(d)) keptDraftOps.add(id);

  // Synced ops: old, unreferenced, not in an open shift, not a migrated op whose legacy row stays.
  const legacyRows = new Set((await localdb.posOfflineTxns.toCollection().primaryKeys()) as string[]);
  const opDel = new Set<string>();
  for (const o of allOps) {
    if (opDel.size >= RETENTION_MAX_DELETE_PER_STORE) break;
    if (o.status !== "synced" || !olderThan(o.synced_at ?? o.created_at, opCut)) continue;
    const id = o.operation_id;
    if (refs.has(id) || protectedOps.has(id) || keptDraftOps.has(id) || shiftOpen(shiftsOfOp(o))) continue;
    if (id.startsWith("mig:shift:") || id.startsWith("mig:outbox:")) continue;
    if (id.startsWith("mig:txn:")) {
      const local = id.slice("mig:txn:".length);
      if (legacyRows.has(local) && !txnDel.has(local)) continue;
    }
    opDel.add(id);
  }

  // Entity mappings: old, and no remaining local row names the local id.
  const remainingRefs = new Set<string>(refs);
  for (const o of allOps) if (!opDel.has(o.operation_id)) opRefs(o, remainingRefs);
  for (const d of keptDrafts) collectStrings(d, remainingRefs);
  for (const t of await localdb.posOfflineTxns.toArray()) if (!txnDel.has(t.local_txn_id)) collectStrings(t, remainingRefs);
  for (const c of await localdb.posCustomers.toArray()) {
    if (c.pending_local === true) collectStrings(c, remainingRefs);
    else if (c.local_address_id) remainingRefs.add(c.local_address_id);
  }
  const mapDel = new Set<string>();
  for (const m of await localdb.entityMap.toArray()) {
    if (mapDel.size >= RETENTION_MAX_DELETE_PER_STORE) break;
    if (!olderThan(m.resolved_at, mapCut) || remainingRefs.has(m.local_entity_id)) continue;
    mapDel.add(m.local_entity_id);
  }

  // Sync history: old events, except those of live / referenced / kept-session ops.
  // (Bulk index-range reads + in-memory filters throughout: a JS-filtered Dexie query is a key-by-key cursor,
  // which on a 200k-event history is the slow path — profiled.)
  const histKeep = (opId: string) => refs.has(opId) || protectedOps.has(opId) || keptDraftOps.has(opId);
  const histDel = (await localdb.syncHistory.where("at").below(new Date(histCut).toISOString()).limit(RETENTION_MAX_DELETE_PER_STORE).toArray())
    .filter((e) => !histKeep(e.operation_id))
    .map((e) => e.id as number);

  // Read snapshots of closed shifts / old orders; final receipts.
  const snapDel = (await localdb.snapshots.toArray())
    .filter((s) => PRUNABLE_SNAPSHOT_PREFIXES.some((p) => s.key.startsWith(p)) && olderThan(s.cached_at, snapCut) && ![...shifts].some((sh) => s.key.endsWith(`:${sh}`)))
    .slice(0, RETENTION_MAX_DELETE_PER_STORE)
    .map((s) => s.key);
  const rcptDel = (await localdb.receipts.where("created_at").below(new Date(rcptCut).toISOString()).limit(RETENTION_MAX_DELETE_PER_STORE).toArray())
    .filter((r) => r.provisional !== true)
    .map((r) => r.ref);

  if (opDel.size + txnDel.size + draftDel.size + mapDel.size + histDel.length + snapDel.length + rcptDel.length === 0) return report;

  // ---------------- phase 2: re-derive live guards + delete, atomically ----------------
  await localdb.transaction(
    "rw",
    [localdb.operations, localdb.dineDrafts, localdb.posOfflineTxns, localdb.pendingShifts, localdb.entityMap, localdb.syncHistory, localdb.snapshots, localdb.receipts],
    async () => {
      const g = await liveGuards();
      const stillOpen = (ids: string[]) => ids.some((s) => g.shifts.has(s));
      // Legacy rows: must still be synced and unreferenced.
      const txnIds = [...txnDel];
      const txnRows = await localdb.posOfflineTxns.bulkGet(txnIds);
      const txnOk = new Set(txnIds.filter((id, i) => { const t = txnRows[i]; return t != null && t.status === "synced" && !g.refs.has(id) && !stillOpen(shiftsOfTxn(t)); }));
      // Sessions: must be unchanged since phase 1 and still unreferenced.
      const draftIds = [...draftDel.keys()];
      const draftRows = await localdb.dineDrafts.bulkGet(draftIds);
      const draftOk = draftIds.filter((id, i) => {
        const d = draftRows[i];
        const was = draftDel.get(id) as DineDraft;
        return d != null && d.status === was.status && d.updated_at === was.updated_at && !g.refs.has(id) && !draftOpIds(d).some((x) => g.refs.has(x)) && !stillOpen(shiftsOfDraft(d));
      });
      // Ops: still synced, unreferenced by live work; a migrated op only with its (deleted) legacy row.
      const opIds = [...opDel];
      const opRows = await localdb.operations.bulkGet(opIds);
      const opOk = opIds.filter((id, i) => {
        const o = opRows[i];
        if (!o || o.status !== "synced" || g.refs.has(id) || stillOpen(shiftsOfOp(o))) return false;
        if (id.startsWith("mig:txn:")) {
          const local = id.slice("mig:txn:".length);
          if (legacyRows.has(local) && !txnOk.has(local)) return false;
        }
        return true;
      });
      const mapOk = [...mapDel].filter((id) => !g.refs.has(id));
      const histOk = histDel.length > 0 ? (await localdb.syncHistory.bulkGet(histDel)).filter((e) => e != null && !g.refs.has(e.operation_id)).map((e) => e!.id as number) : [];
      const snapOk = snapDel.filter((k) => ![...g.shifts].some((sh) => k.endsWith(`:${sh}`)));

      await localdb.posOfflineTxns.bulkDelete([...txnOk]);
      await localdb.dineDrafts.bulkDelete(draftOk);
      await localdb.operations.bulkDelete(opOk);
      await localdb.entityMap.bulkDelete(mapOk);
      await localdb.syncHistory.bulkDelete(histOk);
      await localdb.snapshots.bulkDelete(snapOk);
      await localdb.receipts.bulkDelete(rcptDel);
      report.posOfflineTxns = txnOk.size;
      report.dineDrafts = draftOk.length;
      report.operations = opOk.length;
      report.entityMap = mapOk.length;
      report.syncHistory = histOk.length;
      report.snapshots = snapOk.length;
      report.receipts = rcptDel.length;
    },
  );
  return report;
}
