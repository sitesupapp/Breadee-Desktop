// Shift state.
//
// The invariant this store exists to protect: `shiftId` is either a real open
// shift on the server, or an offline-opened shift held durably on THIS device, or
// null. It is never inferred, never cached across a sign-out, and never carried
// forward once the shift ends - because an order submitted against a stale shift id
// is exactly the orphan-order class of bug this level was built to remove.
//
// Offline continuity (two cases):
//   * Case 1 - a server open shift was hydrated while online: restored from the
//     durable POS-session snapshot (`posSession.ts`) when the backend is unreachable.
//   * Case 2 - no open shift and the backend is down: `open()` captures a durable
//     PENDING shift locally (`pendingShift.ts`) and surfaces it as the active shift,
//     so Takeaway cash sales continue. The replay engine opens it exactly once on
//     reconnect and the next live read supersedes it with the canonical server shift.

import { create } from "zustand";
import type { ActiveShift, CashBox, DeliveryFeeCashTreatment, ShiftReport } from "@/types/pos";
import { endShift, findOpenShift, getCashBox, openShift } from "@/lib/pos/shifts";
import { getDeviceIdentity } from "@/lib/device";
import { clearPosSessionSnapshot, readPosSessionSnapshot, restoreShiftFromSnapshot } from "@/lib/offline/posSession";
import { getActivePendingShift, type PendingShift } from "@/lib/offline/db";
import {
  cacheEndShiftApprovalRequired,
  chainedShiftAfter,
  createLocalPendingShift,
  getActiveUnendedPendingShift,
  pendingShiftToActiveShift,
  readCachedEndShiftApprovalRequired,
} from "@/lib/offline/pendingShift";
import { resolveOperationalShift } from "@/lib/offline/shiftIdentity";
import { isBackendReachable } from "@/lib/offline/reachability";
import { isTransportFailure } from "@/lib/offline/posTxnSync";
import { createLatestGate } from "@/lib/offline/latestGate";
import { captureEndShiftOffline, endShiftOpForShift, unsyncedEndShiftOp, unsyncedEndShiftOps } from "@/lib/offline/endShiftOffline";
import { isEndShiftApprovalRequired } from "@/lib/pos/shiftApproval";

/** rc.10 — the shift was ENDED on this device while offline: its canonical close (end_shift op) waits
 *  behind every op of the shift and replays LAST. Until it syncs, the shift is operationally closed. */
export type EndedPendingSync = { operationId: string; shiftId: string; dependencyCount: number };

/**
 * rc.12 — THE shift close lifecycle, derived from the ONE durable record (the end_shift op) — no
 * second store:
 *
 *   OPEN ──End Shift offline──▶ CLOSING (op pending / blocked / retrying / syncing)
 *   CLOSING ──pos_end_shift ok──▶ CLOSED_CONFIRMED (op synced; the server shift is pending review /
 *                                  approved) ──Open Shift──▶ OPEN (a NEW canonical shift)
 *   CLOSING ──server refused (open orders, …)──▶ CLOSE_REFUSED ──next server read──▶ OPEN again (the
 *                                  refused close is superseded — kept, cancelled — and the operator is told why)
 *
 * While CLOSING, Open Shift is refused with the exact blocking reason (never sent to the server: its
 * single-open rule would hand back the OLD shift — the rc.11 "success but No open shift" F1 defect).
 */
export type CloseState = "none" | "closing" | "closed_confirmed" | "close_refused";

export function closeStateOf(op: { status: string; last_error_code: string | null } | null | undefined): CloseState {
  if (!op || op.status === "cancelled") return "none";
  if (op.status === "synced") return "closed_confirmed";
  // A pre-rc.12 terminal "prerequisite failed" never reached the server: the drain re-queues it (closing).
  if (op.status === "needs_attention" && op.last_error_code !== "dependency_failed") return "close_refused";
  return "closing";
}

/**
 * 1.0.38 (Bug 3) — the LOCAL close lifecycle of one shift on this device (derived from the end_shift op;
 * CLOSING_LOCAL is the short in-memory window while End Shift checks its preconditions and captures it):
 *
 *   OPEN ─End Shift offline─▶ CLOSING_LOCAL ─end_shift op durably captured─▶ CLOSED_LOCAL_PENDING_SYNC
 *   CLOSED_LOCAL_PENDING_SYNC ─pos_end_shift ok─▶ CLOSED_CONFIRMED   (─refused─▶ CLOSE_REFUSED)
 *
 * From CLOSED_LOCAL_PENDING_SYNC the NEXT shift may be opened offline (chained): its identity is derived
 * from that close op, its open replays strictly after it and must create (never adopt) a server shift,
 * and every op captured from then on belongs to the new shift. CLOSE_REFUSED is a human gate: no chained open.
 */
export type LocalCloseState = "OPEN" | "CLOSING_LOCAL" | "CLOSED_LOCAL_PENDING_SYNC" | "CLOSED_CONFIRMED" | "CLOSE_REFUSED";

export function localCloseStateOf(op: { status: string; last_error_code: string | null } | null | undefined, capturing = false): LocalCloseState {
  const cs = closeStateOf(op);
  if (cs === "closing") return "CLOSED_LOCAL_PENDING_SYNC";
  if (cs === "closed_confirmed") return "CLOSED_CONFIRMED";
  if (cs === "close_refused") return "CLOSE_REFUSED";
  return capturing ? "CLOSING_LOCAL" : "OPEN";
}

/** rc.12 — Open Shift refused because the previous shift's offline close has not reached the server.
 *  1.0.38: `tail` replaces the generic "can open as soon as it syncs" when that is not the whole story. */
export class ShiftStillClosingError extends Error {
  constructor(detail: string, tail?: string) {
    super(`The previous shift is still closing on this device — ${detail} ${tail ?? "Open the Sync Center to see what it is waiting for; the new shift can open as soon as it syncs."}`);
    this.name = "ShiftStillClosingError";
  }
}

/** rc.12 — notice shown when an offline End Shift was refused by the server and the shift is OPEN again. */
export type CloseRefusedNotice = { shiftId: string; message: string };

/** rc.12 — server-confirmed state: a refused close for any shift OTHER than the one the server reports
 *  open for this context can never apply (that shift is not open). Superseded = cancelled + reason. */
async function supersedeMootRefusedCloses(
  scope: { tenantId: string; branchId: string | null; cashierUserId: string; deviceId: string; terminalId: string | null },
  serverOpenShiftId: string | null,
): Promise<void> {
  const { localdb } = await import("@/lib/offline/db");
  const { updateOperation } = await import("@/lib/offline/operationLog");
  const rows = await localdb.operations.where("operation_type").equals("end_shift").toArray();
  for (const o of rows) {
    if (closeStateOf(o) !== "close_refused") continue;
    if (o.scope.tenant_id !== scope.tenantId || (o.scope.branch_id ?? null) !== (scope.branchId ?? null) || o.scope.cashier_user_id !== scope.cashierUserId || o.scope.device_id !== scope.deviceId) continue;
    const p = (o.payload ?? {}) as { shift_id?: string | null };
    if (!p.shift_id || p.shift_id === serverOpenShiftId) continue; // the open one is handled as CLOSE_REFUSED → OPEN
    await updateOperation(o.operation_id, {
      status: "cancelled",
      result_meta: { ...(o.result_meta ?? {}), superseded: "close_refused_shift_not_open_on_server", superseded_at: new Date().toISOString() },
    });
  }
}

async function closingDetail(op: { operation_id: string; status: string; dependency_ids: string[]; last_error_code: string | null; last_error_message: string | null }): Promise<string> {
  if (op.status === "blocked_dependency") {
    const deps = await Promise.all(op.dependency_ids.map((id) => import("@/lib/offline/operationLog").then((m) => m.getOperation(id)).catch(() => undefined)));
    const open = deps.filter((d) => d && d.status !== "synced" && d.status !== "cancelled");
    const parked = open.filter((d) => d!.status === "needs_attention").length;
    if (parked > 0) return `its close is waiting for ${parked} operation${parked === 1 ? "" : "s"} that need${parked === 1 ? "s" : ""} attention.`;
    if (open.length > 0) return `its close is waiting for ${open.length} operation${open.length === 1 ? "" : "s"} of that shift to sync.`;
  }
  if (op.status === "retryable") return "its close will retry automatically.";
  return "its close has not synced yet.";
}

type ShiftState = {
  loading: boolean;
  shift: ActiveShift | null;
  cashBox: CashBox | null;
  /**
   * True only when `shift` was restored/held from offline state (Case 1 snapshot or
   * Case 2 pending shift) because the server was unreachable, rather than read live.
   * Cleared the instant a live read succeeds. Lets the UI say "offline" honestly.
   */
  offlineRestored: boolean;
  /**
   * The local id of the OFFLINE-opened (Case 2) shift that is currently active, or
   * null when the active shift is a real server shift. Offline sales read this to
   * mark themselves as depending on a pending shift, so the replay engine can remap
   * them to the canonical server id after it opens the shift on reconnect.
   */
  pendingLocalId: string | null;
  /** The report returned by the most recent end-shift, kept for the summary view. */
  lastReport: ShiftReport | null;
  /** rc.10 — set when the last End Shift was CAPTURED offline (pending sync); null otherwise. */
  endedPendingSync: EndedPendingSync | null;
  /** rc.12 — an offline End Shift the SERVER refused: the shift is open again; shown once to the operator. */
  closeRefused: CloseRefusedNotice | null;
  /** 1.0.38 (Bug 3) — CLOSING_LOCAL: an offline End Shift is checking its preconditions / capturing its op.
   *  A concurrent Open Shift is refused until it lands (it would otherwise race the close it must follow). */
  closingLocal: boolean;
  error: string | null;

  /**
   * `isCurrent`, when supplied, is a LIVE-context predicate re-evaluated at every
   * commit point: a commit happens only while it still returns true. The reconnect
   * drain passes it so a pass whose OU/context moved mid-refresh (after an OU switch)
   * never commits its now-stale shift, even though its generation claim is the newest.
   */
  refresh: (tenantId: string, userId: string, branchId?: string | null, isCurrent?: () => boolean) => Promise<void>;
  /**
   * Re-read the cash box for the active shift. `guard`, when supplied, is checked
   * after the (async) read and the result is discarded if it returns true - the
   * caller (e.g. a shift refresh) uses this to drop a response that a newer refresh
   * has superseded. The active-shift identity is always re-checked regardless, so an
   * in-flight read for a shift that is no longer active can never overwrite state.
   */
  refreshCashBox: (guard?: () => boolean) => Promise<void>;
  open: (input: {
    tenantId: string;
    userId: string;
    branchId: string | null;
    openingCash: number;
    currency?: string;
  }) => Promise<{ continuedPrevious: boolean } | void>;
  close: (input: {
    actualCashCounted: number;
    notes: string | null;
    deliveryFeeCashTreatment?: DeliveryFeeCashTreatment;
  }) => Promise<ShiftReport>;
  /**
   * rc.10 — End Shift while OFFLINE: capture the durable end_shift op (dependency barrier over every
   * op of this shift → the canonical close replays LAST), then mark the shift ENDED-pending-sync on
   * this device (no server call, no raw fetch). The local session snapshot is cleared so no restart
   * restores the closed shift.
   */
  closeOffline: (input: {
    scope: { tenantId: string; branchId: string | null; cashierUserId: string; deviceId: string; terminalId: string | null };
    actualCashCounted: number;
    notes: string | null;
    deliveryFeeCashTreatment?: DeliveryFeeCashTreatment;
  }) => Promise<EndedPendingSync>;
  clearReport: () => void;
  /** rc.12 — dismiss the close-refused notice once shown. */
  clearCloseRefused: () => void;
  clear: () => void;
};

// refresh() is async and can be invoked again (a new branch/OU, a reconnect) before
// an in-flight call resolves. Each call claims the next generation and commits its
// result ONLY if it is still the latest; an older refresh that finishes late must
// never restore its (now stale) OU's shift over a newer refresh's authoritative
// result. The gate mechanism is unit-tested in test/offline-latest-gate.test.ts.
const shiftRefreshGate = createLatestGate();

// Network reads routed through one indirection object so integration tests can
// inject deterministic fakes and drive the REAL store - its generation gate, branch
// equality checks, cash-box guard and async ordering - without a Supabase client.
// Production uses the shipped implementations.
export const shiftNet = {
  findOpenShift,
  getCashBox,
  openShift,
  reachable: isBackendReachable,
  /** 1.0.38 (Bug 3) — the branch's End-Shift approval rule, read after every live shift refresh and cached
   *  (server truth for a chained offline open). Browser runtime only (null outside it, e.g. node tests,
   *  which inject a fake); best-effort, never awaited by the refresh and never affects its result. */
  endShiftApprovalRequired: (typeof window === "undefined" ? null : isEndShiftApprovalRequired) as ((branchId: string) => Promise<boolean>) | null,
};

function primeEndShiftApprovalCache(tenantId: string, branchId: string | null): void {
  const read = shiftNet.endShiftApprovalRequired;
  if (!read || !branchId) return;
  void Promise.resolve()
    .then(() => read(branchId))
    .then((required) => cacheEndShiftApprovalRequired(tenantId, branchId, required))
    .catch(() => undefined);
}

/** 1.0.38 (Bug 3) — the next shift opened OFFLINE right after this device closed the previous one offline
 *  (chained, CLOSED_LOCAL_PENDING_SYNC predecessor), for the exact context, if any. */
async function chainedNextShift(tenantId: string, userId: string, branchId: string | null, deviceId: string): Promise<PendingShift | undefined> {
  const next = await getActiveUnendedPendingShift(tenantId, userId, branchId, deviceId).catch(() => undefined);
  return next?.after_end_op_id ? next : undefined;
}

/** 1.0.38 (Bug 3) — for a chained pending shift: its predecessor's close, while that close is still pending
 *  sync (shown alongside the active N+1). Empty object otherwise (the store field is left untouched). */
async function chainEndedPatch(p: PendingShift): Promise<{ endedPendingSync?: EndedPendingSync }> {
  if (!p.after_end_op_id) return {};
  const { getOperation } = await import("@/lib/offline/operationLog");
  const op = await getOperation(p.after_end_op_id).catch(() => undefined);
  if (!op || closeStateOf(op) !== "closing") return {};
  const pl = (op.payload ?? {}) as { shift_id?: string | null; shift_local?: string | null };
  return { endedPendingSync: { operationId: op.operation_id, shiftId: pl.shift_local ?? pl.shift_id ?? "", dependencyCount: op.dependency_ids.length } };
}

export const useShift = create<ShiftState>((set, get) => ({
  loading: true,
  shift: null,
  cashBox: null,
  offlineRestored: false,
  pendingLocalId: null,
  lastReport: null,
  endedPendingSync: null,
  closeRefused: null,
  closingLocal: false,
  error: null,

  refresh: async (tenantId, userId, branchId = null, isCurrent) => {
    // Claim this refresh's generation. Any commit below is made ONLY while this is
    // still the latest refresh AND (if supplied) the live context is still ours. The
    // generation stops an EARLIER refresh; `isCurrent` stops a refresh whose context
    // moved after it was invoked - which the generation order alone cannot catch,
    // because a late drain's refresh is the newest claim.
    const { isStale } = shiftRefreshGate.claim();
    const superseded = () => isStale() || !(isCurrent?.() ?? true);
    set({ loading: true, error: null });
    const deviceId = getDeviceIdentity().device_id;
    try {
      const shift = await shiftNet.findOpenShift(tenantId, userId);
      if (superseded()) return;
      primeEndShiftApprovalCache(tenantId, branchId);
      // rc.12 — a REFUSED offline close of a shift the server no longer has open (closed / force-ended
      // elsewhere) is moot: supersede it (kept, cancelled) so it can never block a later Open Shift.
      await supersedeMootRefusedCloses({ tenantId, branchId, cashierUserId: userId, deviceId, terminalId: getDeviceIdentity().terminal_id ?? null }, shift && (shift.branch_id ?? null) === (branchId ?? null) ? shift.id : null).catch(() => undefined);
      if (superseded()) return;
      // The live open shift must be for THIS branch/OU. findOpenShift returns the
      // cashier's most recent open shift across branches, so a shift opened in a
      // sibling branch/OU must NOT surface as this POS context's active shift; fall
      // through to the branch-scoped pending/none handling below instead.
      if (shift && (shift.branch_id ?? null) === (branchId ?? null)) {
        // rc.10 — a shift END captured offline that has not synced yet: the server still reports it
        // open, but on this device it is CLOSED (its close replays after its last op). Never re-open it
        // for new orders (they would land after the barrier and be refused once the close lands).
        const ended = await endShiftOpForShift(shift.id).catch(() => undefined);
        if (superseded()) return;
        const cs = closeStateOf(ended);
        if (cs === "closing") {
          const endedInfo = { operationId: ended!.operation_id, shiftId: shift.id, dependencyCount: ended!.dependency_ids.length };
          clearPosSessionSnapshot();
          // 1.0.38 (Bug 3) — N is CLOSED_LOCAL_PENDING_SYNC; the next shift this device opened offline after
          // that close (chained) is the active one. Through 1.0.37 this branch returned "no shift" and hid it.
          const next = await chainedNextShift(tenantId, userId, branchId, deviceId);
          if (superseded()) return;
          if (next) {
            set({ shift: pendingShiftToActiveShift(next), cashBox: null, loading: false, offlineRestored: true, pendingLocalId: next.local_shift_id, endedPendingSync: endedInfo });
            return;
          }
          set({ shift: null, cashBox: null, loading: false, offlineRestored: false, pendingLocalId: null, endedPendingSync: endedInfo });
          return;
        }
        if (cs === "close_refused" && ended) {
          // rc.12 — the server REFUSED the offline close and still reports this shift open (e.g. orders
          // were still open). The refused close is superseded (kept for audit, never replayed again —
          // a later replay would close a shift the operator is still working in) and the shift is
          // OPEN again on this device, with the reason.
          const { updateOperation } = await import("@/lib/offline/operationLog");
          await updateOperation(ended.operation_id, {
            status: "cancelled",
            result_meta: { ...(ended.result_meta ?? {}), superseded: "close_refused_shift_still_open", superseded_at: new Date().toISOString() },
          }).catch(() => undefined);
          // 1.0.38 (Bug 3) — a shift opened offline AFTER that close cannot start now (its open depends on the
          // refused close → dependency_failed). Its sales are kept, never moved into this shift: say so.
          const orphanNext = await chainedShiftAfter(ended.operation_id).catch(() => undefined);
          if (superseded()) return;
          set({
            shift,
            loading: false,
            offlineRestored: false,
            pendingLocalId: null,
            endedPendingSync: null,
            closeRefused: {
              shiftId: shift.id,
              message: `Your offline End Shift was not accepted by the server${ended.last_error_message ? `: ${ended.last_error_message}` : ""}. This shift is still open.${orphanNext ? " The shift you opened offline after it could not start; its sales are kept for review in the Sync Center and were not added to this shift." : ""}`,
            },
          });
          await get().refreshCashBox(superseded);
          return;
        }
        // Server is the authority: a real open shift supersedes any offline state.
        set({ shift, loading: false, offlineRestored: false, pendingLocalId: null, endedPendingSync: null });
        await get().refreshCashBox(superseded);
        return;
      }
      // Reachable, and the server says NO open shift. A pending offline-opened shift
      // that hasn't synced yet is NOT contradicted by this (it was never on the
      // server), so keep showing it until the reconnect reconcile opens it. Scoped to
      // THIS exact tenant+branch/OU+cashier+device; pending_sync only.
      // 1.0.38 (Bug 3) — the live (unended) one: a pending shift closed offline is never surfaced, a chained
      // next shift opened after it is.
      const pending = await getActiveUnendedPendingShift(tenantId, userId, branchId, deviceId).catch(() => undefined);
      if (superseded()) return;
      if (pending) {
        const chain = await chainEndedPatch(pending);
        if (superseded()) return;
        set({
          shift: pendingShiftToActiveShift(pending),
          cashBox: null,
          loading: false,
          offlineRestored: true,
          pendingLocalId: pending.local_shift_id,
          ...chain,
        });
        return;
      }
      // Genuinely no shift. Drop any stale Case-1 snapshot so a restart can never
      // restore a shift that has since been closed.
      set({ shift: null, cashBox: null, loading: false, offlineRestored: false, pendingLocalId: null });
      clearPosSessionSnapshot();
    } catch (e) {
      if (superseded()) return;
      // Restore offline state ONLY for a confirmed transport/unreachable condition.
      // A definitive server authorization/validation refusal must NOT reactivate a
      // stale snapshot or pending shift - it surfaces as an error instead.
      const transport = isTransportFailure(e) || (typeof navigator !== "undefined" && navigator.onLine === false);
      if (!transport) {
        set({
          shift: null,
          cashBox: null,
          loading: false,
          offlineRestored: false,
          pendingLocalId: null,
          error: e instanceof Error ? e.message : "Could not read the current shift.",
        });
        return;
      }
      // 1) a previously-hydrated server open shift (Case 1), for THIS branch/OU only.
      let restored = restoreShiftFromSnapshot(readPosSessionSnapshot(), {
        deviceId,
        tenantId,
        cashierUserId: userId,
        branchId,
      });
      // rc.14 (F4) — a snapshot written by rc.13 could hold a shift opened OFFLINE as if the server had
      // confirmed it. Never restore a LOCAL id as a canonical shift: a still-pending one is handled as the
      // pending shift below (Case 2, with its local marker); a synced one is restored under its OWN
      // canonical id.
      if (restored) {
        const ref = await resolveOperationalShift(restored.id).catch(() => null);
        if (superseded()) return;
        if (ref?.shift_local) restored = null;
        else if (ref?.shift_id && ref.shift_id !== restored.id) restored = { ...restored, id: ref.shift_id };
      }
      // rc.10 — a shift whose End Shift was captured offline is CLOSED on this device: never restore it.
      const restoredEnded = restored ? await endShiftOpForShift(restored.id).catch(() => undefined) : undefined;
      if (restored && restoredEnded) {
        if (superseded()) return;
        clearPosSessionSnapshot();
        const endedInfo = { operationId: restoredEnded.operation_id, shiftId: restored.id, dependencyCount: restoredEnded.dependency_ids.length };
        // 1.0.38 (Bug 3) — restart between shifts: the chained next shift opened offline is the active one.
        const next = await chainedNextShift(tenantId, userId, branchId, deviceId);
        if (superseded()) return;
        if (next) {
          set({ shift: pendingShiftToActiveShift(next), cashBox: null, loading: false, offlineRestored: true, pendingLocalId: next.local_shift_id, error: null, endedPendingSync: endedInfo });
          return;
        }
        set({ shift: null, cashBox: null, loading: false, offlineRestored: false, pendingLocalId: null, error: null, endedPendingSync: endedInfo });
        return;
      }
      if (restored) {
        if (superseded()) return;
        set({ shift: restored, cashBox: null, loading: false, offlineRestored: true, pendingLocalId: null, error: null });
        return;
      }
      // 2) a shift opened offline on this device for THIS exact context (Case 2). 1.0.38 (Bug 3): the live
      // (unended) one — a chained next shift wins over the offline-opened shift it follows.
      const pending = await getActiveUnendedPendingShift(tenantId, userId, branchId, deviceId).catch(() => undefined);
      if (superseded()) return;
      const newest = pending ? undefined : await getActivePendingShift(tenantId, userId, branchId, deviceId).catch(() => undefined);
      const pendingEnded = newest ? await endShiftOpForShift(newest.local_shift_id).catch(() => undefined) : undefined;
      if (newest && pendingEnded) {
        if (superseded()) return;
        set({ shift: null, cashBox: null, loading: false, offlineRestored: false, pendingLocalId: null, error: null, endedPendingSync: { operationId: pendingEnded.operation_id, shiftId: newest.local_shift_id, dependencyCount: pendingEnded.dependency_ids.length } });
        return;
      }
      if (pending) {
        const chain = await chainEndedPatch(pending);
        if (superseded()) return;
        set({
          shift: pendingShiftToActiveShift(pending),
          cashBox: null,
          loading: false,
          offlineRestored: true,
          pendingLocalId: pending.local_shift_id,
          error: null,
          ...chain,
        });
        return;
      }
      // 3) No offline context at all. For an expected outage this is NOT an error:
      // the status bar shows Offline and the cashier can open a shift offline.
      set({ shift: null, cashBox: null, loading: false, offlineRestored: false, pendingLocalId: null, error: null });
    }
  },

  refreshCashBox: async (guard) => {
    const shift = get().shift;
    // A pending offline-opened shift has no server drawer to read; skip it.
    if (!shift || get().pendingLocalId) {
      set({ cashBox: null });
      return;
    }
    // The shift this read is FOR. The active shift can change (a newer refresh, an
    // OU switch) while getCashBox is in flight; a response for a shift that is no
    // longer active - or that a newer refresh superseded (guard) - must be dropped so
    // it never overwrites the current OU's drawer state.
    const forShiftId = shift.id;
    const stillCurrent = () => !guard?.() && get().shift?.id === forShiftId && !get().pendingLocalId;
    try {
      const box = await shiftNet.getCashBox(forShiftId);
      if (!stillCurrent()) return;
      set({ cashBox: box });
    } catch (e) {
      if (!stillCurrent()) return;
      // The drawer is informational; a failure here must not block ordering, and a
      // transport failure must not surface a raw network message.
      if (isTransportFailure(e)) {
        set({ cashBox: null });
        return;
      }
      set({ error: e instanceof Error ? e.message : "Could not read the cash box." });
    }
  },

  open: async ({ tenantId, userId, branchId, openingCash, currency }) => {
    // Prefer the server whenever it is reachable; a backend outage must not block
    // opening a shift (full POS continuity after authentication).
    const reachable = await shiftNet.reachable().catch(() => false);
    const dev = getDeviceIdentity();
    const closeScope = { tenantId, branchId, cashierUserId: userId, deviceId: dev.device_id, terminalId: dev.terminal_id ?? null };
    if (reachable) {
      // rc.12 — the previous shift's offline close has not reached the server: pos_open_shift would hand
      // back that OLD (still open) shift, which this device then hides → "success" with "No open shift"
      // (F1). Refuse BEFORE calling the server, with the exact reason.
      const closing = await unsyncedEndShiftOp(closeScope).catch(() => undefined);
      if (closing && closeStateOf(closing) === "closing") throw new ShiftStillClosingError(await closingDetail(closing));
      let opened: string;
      try {
        opened = (await shiftNet.openShift({ branchId, openingCash })).shiftId;
      } catch (e) {
        // A definitive refusal (permission, prior shift awaiting approval, feature
        // off) must surface to the operator. Only a transport failure falls through
        // to the durable offline open below.
        if (!isTransportFailure(e)) throw e;
        opened = "";
      }
      if (opened) {
        // Re-read rather than trust the returned id: this also picks up the case where the server
        // CONTINUED an existing open shift instead of creating one (refresh() decides what it is —
        // e.g. an offline close the server refused makes it OPEN again with the reason).
        await get().refresh(tenantId, userId, branchId);
        const now = get();
        // rc.12 — SUCCESS means: the canonical open shift exists AND this device committed that SAME
        // shift as its active open shift (so the POS accepts orders). Anything else is not a success.
        if (!now.shift || now.shift.id !== opened || now.shift.status !== "open" || now.pendingLocalId) {
          const ended = await endShiftOpForShift(opened).catch(() => undefined);
          if (ended && closeStateOf(ended) === "closing") throw new ShiftStillClosingError(await closingDetail(ended));
          throw new Error(now.error ?? "The server opened the shift, but this device could not activate it. Check the connection and try again — no new shift was created twice.");
        }
        return { continuedPrevious: now.closeRefused?.shiftId === opened };
      }
    }
    // 1.0.38 (Bug 3) — CLOSING_LOCAL: an End Shift is still being captured; the next shift must follow it.
    if (get().closingLocal) throw new ShiftStillClosingError("its End Shift is still being recorded.", "Try again in a moment.");
    // rc.10 — a previous shift's End Shift captured offline has not synced yet. Through 1.0.37 opening another
    // shift offline was refused here (an unordered open would replay BEFORE that close and the server's
    // single-open rule would ADOPT the still-open old shift). 1.0.38 (Bug 3): CHAIN it instead — the new
    // shift's identity derives from that close, its open replays strictly after it and must create a new
    // server shift (never adopt), and its sales stay bound to it. Still refused: a close the server REFUSED
    // (human gate), and a branch whose closes need manager approval (the server would refuse the open).
    const endsPending = await unsyncedEndShiftOps(closeScope).catch(() => []);
    let afterEndOpId: string | null = null;
    if (endsPending.length > 0) {
      const refused = endsPending.find((o) => closeStateOf(o) === "close_refused");
      if (refused) {
        throw new Error(`The previous shift's offline End Shift was not accepted by the server${refused.last_error_message ? ` (${refused.last_error_message})` : ""}. Reconnect to resolve it before opening a new shift.`);
      }
      const approval = await readCachedEndShiftApprovalRequired(tenantId, branchId).catch(() => null);
      if (approval !== false) {
        const prev = endsPending[endsPending.length - 1];
        throw new ShiftStillClosingError(
          await closingDetail(prev),
          approval === true
            ? "This branch requires manager approval to close a shift, so the next shift cannot be opened offline: reconnect, let the close sync, and have a manager approve it before opening a new shift."
            : "This device has not yet confirmed whether this branch closes shifts directly or needs manager approval, so the next shift cannot be opened offline. Reconnect to open it.",
        );
      }
      afterEndOpId = endsPending[endsPending.length - 1].operation_id;
    }
    // Offline: capture a durable pending shift and surface it as the active shift.
    const pending = await createLocalPendingShift({
      tenantId,
      branchId,
      cashierUserId: userId,
      openingCashAmount: openingCash,
      currency: currency ?? "USD",
      afterEndOpId,
    });
    set({
      shift: pendingShiftToActiveShift(pending),
      cashBox: null,
      loading: false,
      offlineRestored: true,
      pendingLocalId: pending.local_shift_id,
      error: null,
    });
  },

  close: async ({ actualCashCounted, notes, deliveryFeeCashTreatment }) => {
    const shift = get().shift;
    if (!shift) throw new Error("There is no open shift to end.");
    // A shift opened offline has no canonical server shift to end yet. Ending it
    // requires the connection that opens it; refuse with a clear message instead of
    // a raw backend error.
    if (get().pendingLocalId) {
      throw new Error(
        "This shift was opened offline and hasn't synced yet. Reconnect to the internet to sync it, then end the shift.",
      );
    }
    const report = await endShift({ shiftId: shift.id, actualCashCounted, notes, deliveryFeeCashTreatment });
    // The shift is now pending_manager_review - it is no longer usable for orders,
    // so the durable snapshot must go too or a later offline restart would restore
    // a closed shift.
    clearPosSessionSnapshot();
    set({ shift: null, cashBox: null, offlineRestored: false, pendingLocalId: null, lastReport: report, endedPendingSync: null });
    return report;
  },

  closeOffline: async (input) => {
    // 1.0.38 (Bug 3) — OPEN → CLOSING_LOCAL (preconditions + capture) → CLOSED_LOCAL_PENDING_SYNC (op captured).
    set({ closingLocal: true });
    try {
      return await closeOfflineCapture(input);
    } finally {
      set({ closingLocal: false });
    }
  },

  clearReport: () => set({ lastReport: null }),
  clearCloseRefused: () => set({ closeRefused: null }),

  clear: () => {
    // Invalidate any in-flight refresh FIRST: a refresh that claimed its generation
    // before sign-out must not resolve afterwards and repopulate shift state for a
    // session that no longer exists.
    shiftRefreshGate.invalidate();
    set({ loading: false, shift: null, cashBox: null, offlineRestored: false, pendingLocalId: null, lastReport: null, endedPendingSync: null, closeRefused: null, closingLocal: false, error: null });
  },
}));

/** rc.10 — End Shift while OFFLINE (the body of `closeOffline`, run inside its CLOSING_LOCAL window). */
async function closeOfflineCapture({ scope, actualCashCounted, notes, deliveryFeeCashTreatment }: Parameters<ShiftState["closeOffline"]>[0]): Promise<EndedPendingSync> {
    const { getState: get, setState: set } = useShift;
    const shift = get().shift;
    if (!shift) throw new Error("There is no open shift to end.");
    const pendingLocalId = get().pendingLocalId;
    // rc.12 — the server's own close rule, applied BEFORE capture: a shift with unresolved orders cannot
    // close (pos_end_shift → "N order(s) still open"). Queuing such a close guaranteed a refused close and a
    // shift stuck open on the server (F1). Same wording as the server so the existing UI path applies.
    {
      const { unresolvedOrdersForShift, openOrdersRefusal } = await import("@/lib/offline/shiftCloseGuard");
      const open = await unresolvedOrdersForShift(
        { tenantId: scope.tenantId, branchId: scope.branchId, cashierUserId: scope.cashierUserId, deviceId: scope.deviceId, terminalId: scope.terminalId },
        pendingLocalId ?? shift.id,
      ).catch(() => []);
      if (open.length > 0) throw new Error(openOrdersRefusal(open));
    }
    // Stage this device's offline sales (posOfflineTxns) into the operation log FIRST so they join the
    // barrier — otherwise a takeaway/delivery sale captured offline could replay after the close.
    // Idempotent, local-only (the same staging the drain runs); a failure never blocks the close.
    try {
      const { migrateLegacyToOperations } = await import("@/lib/offline/migration");
      await migrateLegacyToOperations();
    } catch {
      /* staging is retried by every drain; the close still waits behind every op already logged */
    }
    const r = await captureEndShiftOffline({
      scope,
      shiftId: pendingLocalId ? null : shift.id,
      shiftLocal: pendingLocalId,
      actualCashCounted,
      notes,
      deliveryFeeCashTreatment,
      shiftOpenedAt: shift.opened_at,
    });
    // Operationally CLOSED on this device: no restart may restore it (snapshot cleared; refresh()
    // also refuses any shift with a captured end_shift op).
    clearPosSessionSnapshot();
    const ended: EndedPendingSync = { operationId: r.operationId, shiftId: pendingLocalId ?? shift.id, dependencyCount: r.dependencyCount };
    set({ shift: null, cashBox: null, offlineRestored: false, pendingLocalId: null, lastReport: null, endedPendingSync: ended, error: null });
    return ended;
}

/** The one predicate the order/payment paths consult. */
export function requireOpenShiftId(shift: ActiveShift | null): string | null {
  return shift && shift.status === "open" ? shift.id : null;
}
