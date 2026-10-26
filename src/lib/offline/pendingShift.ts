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
import { localdb, listActivePendingShifts, type PendingShift } from "@/lib/offline/db";
import { deterministicUuid } from "@/lib/offline/dineinOffline";
import { endShiftOpForShift } from "@/lib/offline/endShiftOffline";

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
  /** 1.0.38 (Bug 3) — the captured, not-yet-synced end_shift op of the PREVIOUS shift (N). Set ONLY by the
   *  chained offline open (OPEN(N+1) after CLOSE(N) on this device): the new shift's identity is derived
   *  from that close (deterministic → a double-tap / restart gives the SAME N+1) and its open replays
   *  strictly after it (the open_shift op depends on it, see migration.ts). */
  afterEndOpId?: string | null;
}): Promise<PendingShift> {
  const dev = getDeviceIdentity();
  return localdb.transaction("rw", [localdb.pendingShifts, localdb.operations, localdb.entityMap], async () => {
    // 1.0.38 (Bug 3) — a pending shift whose End Shift was captured offline is CLOSED on this device: it
    // is never handed back as "the" open shift (through 1.0.37 the next offline open returned it, so N+1
    // WAS N). An unended one is still the one live local shift for the context — never a second, overlapping one.
    const candidates = (await localdb.pendingShifts.where("status").equals("pending_sync").toArray()).filter(
      (s) =>
        s.tenant_id === args.tenantId &&
        s.cashier_user_id === args.cashierUserId &&
        (s.branch_id ?? null) === (args.branchId ?? null) &&
        s.device_id === dev.device_id,
    );
    const afterEndOpId = args.afterEndOpId ?? null;
    for (const s of candidates) {
      if (await endShiftOpForShift(s.local_shift_id)) continue;
      // A chained open only ever hands back ITS OWN shift (same predecessor close); any other live local
      // shift here is anomalous — fail closed rather than bypass the close→open ordering.
      if (afterEndOpId && s.after_end_op_id !== afterEndOpId) {
        throw new Error("Another shift opened offline on this device is still active. Reconnect and let it sync before opening a new shift.");
      }
      return s;
    }
    let localShiftId: string = crypto.randomUUID();
    let clientOpId: string = crypto.randomUUID();
    let generation: number | undefined;
    if (afterEndOpId) {
      const end = await localdb.operations.get(afterEndOpId);
      if (!end || end.operation_type !== "end_shift") throw new Error("The previous shift's close was not found on this device. Reconnect before opening a new shift.");
      const base = [args.tenantId, args.branchId ?? "", args.cashierUserId, dev.device_id, dev.terminal_id ?? "", "open_shift_after", afterEndOpId];
      localShiftId = deterministicUuid(base);
      clientOpId = deterministicUuid([...base, "client_op_id"]);
      const again = await localdb.pendingShifts.get(localShiftId);
      if (again) {
        if (again.status === "pending_sync") return again;
        throw new Error(`The shift opened offline after the previous close was not accepted by the server${again.review_reason ? ` (${again.review_reason})` : ""}. Open the Sync Center to resolve it.`);
      }
      const prevLocal = (end.payload as { shift_local?: string | null } | null)?.shift_local ?? null;
      const prev = prevLocal ? await localdb.pendingShifts.get(prevLocal) : undefined;
      generation = (prev?.generation ?? 1) + 1;
    }
    const shift: PendingShift = {
      local_shift_id: localShiftId,
      client_op_id: clientOpId,
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
      ...(afterEndOpId ? { after_end_op_id: afterEndOpId, generation } : {}),
    };
    await localdb.pendingShifts.add(shift);
    return shift;
  });
}

/**
 * 1.0.38 (Bug 3) — the ONE live (not ended on this device) offline-opened shift for the exact context
 * (tenant + cashier + branch/OU + device), newest first. A pending shift with a captured End Shift is
 * CLOSED here (CLOSED_LOCAL_PENDING_SYNC) and is never surfaced as the active shift again.
 */
export async function getActiveUnendedPendingShift(
  tenantId: string | null,
  cashierUserId: string | null,
  branchId: string | null,
  deviceId: string | null,
): Promise<PendingShift | undefined> {
  for (const s of await listActivePendingShifts(tenantId, cashierUserId, branchId, deviceId)) {
    if (!(await endShiftOpForShift(s.local_shift_id))) return s;
  }
  return undefined;
}

/** 1.0.38 (Bug 3) — the (not yet synced) shift opened offline right after this end_shift op, any status. */
export async function chainedShiftAfter(endOpId: string): Promise<PendingShift | undefined> {
  const rows = await localdb.pendingShifts.toArray();
  return rows.find((s) => s.after_end_op_id === endOpId && s.status !== "synced");
}

// ---------------------------------------------------------------------------------------------------
// 1.0.38 (Bug 3) — End-Shift approval, as last observed for a branch. pos_end_shift_core decides at close
// time: approval required → the closed shift waits in pending_manager_review and pos_open_shift_core
// REFUSES any new shift for the cashier ("previous shift waiting for manager approval"). A chained offline
// open (N+1 after an offline close of N) is therefore only captured when this device KNOWS the branch
// closes directly; unknown is treated as required (fail closed — never park a whole shift of sales).
// Recorded from server truth only: every pos_end_shift result (online close or offline replay) carries
// `approval_required`, and the setting read itself.
// ---------------------------------------------------------------------------------------------------

const approvalKey = (branchId: string | null) => `shift_approval:${branchId ?? ""}`;

export async function cacheEndShiftApprovalRequired(tenantId: string | null, branchId: string | null, required: unknown): Promise<void> {
  if (!tenantId || typeof required !== "boolean") return;
  await localdb.snapshots.put({ key: approvalKey(branchId), tenant_id: tenantId, branch_id: branchId, data: { approval_required: required }, cached_at: new Date().toISOString() });
}

/** The last server-observed End-Shift approval requirement for this branch, or null when never observed. */
export async function readCachedEndShiftApprovalRequired(tenantId: string | null, branchId: string | null): Promise<boolean | null> {
  if (!tenantId) return null;
  const row = await localdb.snapshots.get(approvalKey(branchId)).catch(() => undefined);
  if (!row || row.tenant_id !== tenantId || (row.branch_id ?? null) !== (branchId ?? null)) return null;
  const v = (row.data as { approval_required?: unknown } | null)?.approval_required;
  return typeof v === "boolean" ? v : null;
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
