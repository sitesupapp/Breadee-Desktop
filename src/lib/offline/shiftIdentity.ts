// rc.14 — THE single shift-identity contract for every offline business operation.
//
// rc.13 native (F4): a Takeaway sale captured under a shift opened OFFLINE replayed with that shift's LOCAL
// id ("Shift not found for this tenant/branch"). The Takeaway / Delivery captures decided "is this shift
// local?" from the shift store's `pendingLocalId` marker, which a restored POS-session snapshot can drop
// (the snapshot writer persisted a pending shift as if the server had confirmed it). Dine-In already
// decided from the durable pendingShifts record. Every capture now resolves through THIS module, from the
// id itself — never from "whatever shift is open now" and never from a UI flag:
//
//   captured shift id ──► a pendingShifts row?  no  → canonical as captured (the server validates it)
//                                               yes → its canonical id once known (pendingShifts.server_shift_id
//                                                     or the entity map), else it travels as `shift_local`
//                                                     and is remapped at replay — EXACTLY to its own canonical
//                                                     shift (never to a newer one that happens to be open).

import { localdb } from "@/lib/offline/db";
import { canonicalIdFor } from "@/lib/offline/entityMap";

export type ShiftRef = { shift_id: string | null; shift_local: string | null };

/** Is this id a shift opened OFFLINE on this device (a pendingShifts row)? */
export async function isLocalShiftId(shiftId: string | null | undefined): Promise<boolean> {
  if (!shiftId) return false;
  return (await localdb.pendingShifts.get(shiftId).catch(() => undefined)) != null;
}

/**
 * Resolve the shift a captured operation belongs to (capture time). Canonical → as is; an offline-opened
 * shift → its OWN canonical id when already synced, else `shift_local` (remapped at replay).
 */
export async function resolveOperationalShift(shiftId: string | null | undefined): Promise<ShiftRef> {
  if (!shiftId) return { shift_id: null, shift_local: null };
  const pending = await localdb.pendingShifts.get(shiftId).catch(() => undefined);
  if (!pending) return { shift_id: shiftId, shift_local: null };
  const canonical = pending.server_shift_id ?? (await canonicalIdFor(shiftId).catch(() => null));
  if (canonical) return { shift_id: canonical, shift_local: null };
  return { shift_id: null, shift_local: shiftId };
}
