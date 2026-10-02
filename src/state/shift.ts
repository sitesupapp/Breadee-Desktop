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
import { getActivePendingShift } from "@/lib/offline/db";
import { createLocalPendingShift, pendingShiftToActiveShift } from "@/lib/offline/pendingShift";
import { isBackendReachable } from "@/lib/offline/reachability";
import { isTransportFailure } from "@/lib/offline/posTxnSync";

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
  error: string | null;

  refresh: (tenantId: string, userId: string) => Promise<void>;
  refreshCashBox: () => Promise<void>;
  open: (input: {
    tenantId: string;
    userId: string;
    branchId: string | null;
    openingCash: number;
    currency?: string;
  }) => Promise<void>;
  close: (input: {
    actualCashCounted: number;
    notes: string | null;
    deliveryFeeCashTreatment?: DeliveryFeeCashTreatment;
  }) => Promise<ShiftReport>;
  clearReport: () => void;
  clear: () => void;
};

export const useShift = create<ShiftState>((set, get) => ({
  loading: true,
  shift: null,
  cashBox: null,
  offlineRestored: false,
  pendingLocalId: null,
  lastReport: null,
  error: null,

  refresh: async (tenantId, userId) => {
    set({ loading: true, error: null });
    const deviceId = getDeviceIdentity().device_id;
    try {
      const shift = await findOpenShift(tenantId, userId);
      if (shift) {
        // Server is the authority: a real open shift supersedes any offline state.
        set({ shift, loading: false, offlineRestored: false, pendingLocalId: null });
        await get().refreshCashBox();
        return;
      }
      // Reachable, and the server says NO open shift. A pending offline-opened shift
      // that hasn't synced yet is NOT contradicted by this (it was never on the
      // server), so keep showing it until the replay engine opens it on reconnect.
      const pending = await getActivePendingShift(tenantId, userId).catch(() => undefined);
      if (pending) {
        set({
          shift: pendingShiftToActiveShift(pending),
          cashBox: null,
          loading: false,
          offlineRestored: true,
          pendingLocalId: pending.local_shift_id,
        });
        return;
      }
      // Genuinely no shift. Drop any stale Case-1 snapshot so a restart can never
      // restore a shift that has since been closed.
      set({ shift: null, cashBox: null, loading: false, offlineRestored: false, pendingLocalId: null });
      clearPosSessionSnapshot();
    } catch (e) {
      // The server is unreachable - not "no shift". Restore the offline operating
      // context so the cashier can keep taking the cash sales this level exists for.
      const transport = isTransportFailure(e) || (typeof navigator !== "undefined" && navigator.onLine === false);

      // 1) a previously-hydrated server open shift (Case 1).
      const restored = restoreShiftFromSnapshot(readPosSessionSnapshot(), {
        deviceId,
        tenantId,
        cashierUserId: userId,
      });
      if (restored) {
        set({ shift: restored, cashBox: null, loading: false, offlineRestored: true, pendingLocalId: null, error: null });
        return;
      }
      // 2) a shift opened offline on this device (Case 2).
      const pending = await getActivePendingShift(tenantId, userId).catch(() => undefined);
      if (pending) {
        set({
          shift: pendingShiftToActiveShift(pending),
          cashBox: null,
          loading: false,
          offlineRestored: true,
          pendingLocalId: pending.local_shift_id,
          error: null,
        });
        return;
      }
      // 3) No offline context at all. For an expected outage this is NOT an error:
      // the status bar shows Offline and the cashier can open a shift offline. Only
      // a genuine (non-transport) server refusal surfaces a message.
      if (transport) {
        set({ shift: null, cashBox: null, loading: false, offlineRestored: false, pendingLocalId: null, error: null });
        return;
      }
      set({
        shift: null,
        cashBox: null,
        loading: false,
        offlineRestored: false,
        pendingLocalId: null,
        error: e instanceof Error ? e.message : "Could not read the current shift.",
      });
    }
  },

  refreshCashBox: async () => {
    const shift = get().shift;
    // A pending offline-opened shift has no server drawer to read; skip it.
    if (!shift || get().pendingLocalId) {
      set({ cashBox: null });
      return;
    }
    try {
      set({ cashBox: await getCashBox(shift.id) });
    } catch (e) {
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
    const reachable = await isBackendReachable().catch(() => false);
    if (reachable) {
      try {
        await openShift({ branchId, openingCash });
        // Re-read rather than trust the returned id: this also picks up the case
        // where the server CONTINUED an existing open shift instead of creating one.
        await get().refresh(tenantId, userId);
        return;
      } catch (e) {
        // A definitive refusal (permission, prior shift awaiting approval, feature
        // off) must surface to the operator. Only a transport failure falls through
        // to the durable offline open below.
        if (!isTransportFailure(e)) throw e;
      }
    }
    // Offline: capture a durable pending shift and surface it as the active shift.
    const pending = await createLocalPendingShift({
      tenantId,
      branchId,
      cashierUserId: userId,
      openingCashAmount: openingCash,
      currency: currency ?? "USD",
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
    set({ shift: null, cashBox: null, offlineRestored: false, pendingLocalId: null, lastReport: report });
    return report;
  },

  clearReport: () => set({ lastReport: null }),

  clear: () =>
    set({ loading: false, shift: null, cashBox: null, offlineRestored: false, pendingLocalId: null, lastReport: null, error: null }),
}));

/** The one predicate the order/payment paths consult. */
export function requireOpenShiftId(shift: ActiveShift | null): string | null {
  return shift && shift.status === "open" ? shift.id : null;
}
