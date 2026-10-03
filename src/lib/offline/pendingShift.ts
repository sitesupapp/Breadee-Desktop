// Offline shift-open (Case 2) domain helpers.
//
// A thin layer over the durable `pendingShifts` store (see db.ts): minting a new
// offline-opened shift and projecting it onto the `ActiveShift` shape the POS
// stores/UI already consume, so a shift opened during an outage behaves like any
// open shift for ordering - while staying clearly marked as "not yet on the server".
//
// It performs NO network and NO financial arithmetic. The canonical shift is always
// the server's; this only lets the cashier keep working until the backend returns,
// at which point the replay engine opens the shift exactly once and reconciles.

import type { ActiveShift } from "@/types/pos";
import { getDeviceIdentity } from "@/lib/device";
import { localdb, type PendingShift } from "@/lib/offline/db";

/**
 * Mint and durably commit a new offline-opened shift for the live session, then
 * return it. The ids are client-generated BEFORE anything is shown as successful,
 * so a crash right after this call still leaves a recoverable, replayable shift.
 *
 * EXACTLY-ONCE per (tenant + branch/OU + cashier + device): the check-and-create
 * runs inside one Dexie read-write transaction, so repeated or concurrent offline
 * Open-Shift actions can never leave more than one `pending_sync` shift for the same
 * live context - the existing one is returned instead of inserting a duplicate. A
 * `needs_attention` shift is NOT reused (it was refused and awaits reconciliation).
 */
export async function createLocalPendingShift(args: {
  tenantId: string;
  branchId: string | null;
  cashierUserId: string;
  openingCashAmount: number;
  currency: string;
}): Promise<PendingShift> {
  const dev = getDeviceIdentity();
  return localdb.transaction("rw", localdb.pendingShifts, async () => {
    const existing = (await localdb.pendingShifts.where("status").equals("pending_sync").toArray()).find(
      (s) =>
        s.tenant_id === args.tenantId &&
        s.cashier_user_id === args.cashierUserId &&
        (s.branch_id ?? null) === (args.branchId ?? null) &&
        s.device_id === dev.device_id,
    );
    if (existing) return existing;
    const shift: PendingShift = {
      local_shift_id: crypto.randomUUID(),
      client_op_id: crypto.randomUUID(),
      tenant_id: args.tenantId,
      branch_id: args.branchId,
      device_id: dev.device_id,
      terminal_id: dev.terminal_id,
      cashier_user_id: args.cashierUserId,
      opening_cash_amount: Number(args.openingCashAmount) || 0,
      currency: args.currency,
      opened_at: new Date().toISOString(),
      status: "pending_sync",
      attempts: 0,
    };
    await localdb.pendingShifts.add(shift);
    return shift;
  });
}

/**
 * Project a pending offline shift onto the `ActiveShift` shape. `id` is the LOCAL
 * shift id, which the offline order path carries as `shift_id`; the replay engine
 * remaps it to the canonical server id on reconnect. Status is "open" so the POS
 * order/payment gates treat it as usable offline.
 */
export function pendingShiftToActiveShift(p: PendingShift): ActiveShift {
  return {
    id: p.local_shift_id,
    status: "open",
    opened_at: p.opened_at,
    opening_cash_amount: p.opening_cash_amount,
    branch_id: p.branch_id,
  };
}
