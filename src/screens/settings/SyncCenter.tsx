// Settings → Sync Center.
//
// 1.0.38 (Bug 7) — this screen used to read the legacy `outbox` store (which nothing writes any
// more), unscoped across every tenant and branch on the device, and so always said "All changes
// are synced" even while POS work was pending or parked; its "Sync now" drained only that dead
// store. It now renders the SAME SyncCenterPanel as the POS Sync Center, scoped to the session
// tenant + the operational branch POS uses (the session-pinned branch), so both entry points show
// identical states, counts and labels. Opening it never writes: no drain, no migration, no replay.
// Quarantined legacy outbox records appear here as "Manager review" operations (never deleted).

import { Card } from "@/components/ui";
import { SyncCenterPanel, useCurrentShiftId, useSyncScope } from "@/components/sync/SyncCenterPanel";

export function SyncCenter() {
  const { tenantId, branchId } = useSyncScope();
  const currentShiftId = useCurrentShiftId();

  return (
    <div className="space-y-5">
      <Card className="flex max-h-[75vh] flex-col overflow-hidden">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-lg font-bold">Sync Center</h2>
          <p className="mt-1 text-sm text-sub">
            Offline work on this terminal for the current business and branch, and how it synced. The same view as the Sync Center in the POS.
          </p>
        </div>
        {tenantId ? (
          <SyncCenterPanel tenantId={tenantId} branchId={branchId} currentShiftId={currentShiftId} />
        ) : (
          <p className="px-5 py-8 text-center text-sm text-sub">Sign in to a business to see its sync status.</p>
        )}
      </Card>
    </div>
  );
}
