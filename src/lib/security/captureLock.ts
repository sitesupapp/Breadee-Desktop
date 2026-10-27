// Final Foundation - the CAPTURE LOCK. When the device can no longer prove its offline
// authority (clock rolled back, entitlement expired / invalid, device or access
// revoked) NEW financial captures stop; everything already captured stays exactly
// where it is (operations log, outbox, history are never touched here) and keeps
// draining - the server decides whether to accept it.
//
// Mechanism: the session exposes a LOCKED VIEW of the permission map. Every POS gate
// already reads that map (lib/pos/access.ts), so one pure filter closes order entry,
// payment, refunds, payouts, shift open/close, transfers and table operations at
// once, while history / reports / reprints stay readable.

export type CaptureLockReason = "clock_rollback" | "entitlement_expired" | "entitlement_invalid" | "device_revoked" | "access_revoked";

/** Read-only grants that survive a capture lock. Everything else is forced false. */
export const VIEW_ONLY_PERMISSIONS: readonly string[] = [
  "pos.access",
  "pos.view_orders",
  "pos.reports.view",
  "pos.print_receipts",
  "pos.analytics.view",
  "pos.payouts.view",
  "pos.transfers.view",
  "pos.tables.view",
  "pos.customers.view",
  "pos.receivables.view",
];

export const CAPTURE_LOCK_MESSAGE: Readonly<Record<CaptureLockReason, string>> = {
  clock_rollback: "This computer's clock moved backwards. New sales are paused until you sign in online again. Nothing already recorded was lost.",
  entitlement_expired: "Offline access has expired. Connect and sign in to continue taking sales. Nothing already recorded was lost.",
  entitlement_invalid: "This device could not verify its offline access. Connect and sign in to continue. Nothing already recorded was lost.",
  device_revoked: "This device's access was revoked. New sales are paused; recorded work will still sync if the server accepts it.",
  access_revoked: "Your access to this business changed. New sales are paused; recorded work will still sync if the server accepts it.",
};

/** PURE - the permission map the UI may see under `lock`. */
export function applyCaptureLock(perms: Record<string, boolean>, lock: CaptureLockReason | null): Record<string, boolean> {
  if (!lock) return perms;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(perms)) out[k] = v === true && VIEW_ONLY_PERMISSIONS.includes(k);
  return out;
}
