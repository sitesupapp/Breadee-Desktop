// Phase B — operator-facing SYNC CENTER (POS entry point).
//
// A small status chip ("All changes synced" / "N pending" / "N needs attention") that
// opens the Sync Center. Business-worded only — no Dexie/client_op_id/RPC jargon. Scoped to
// the active tenant + branch.
//
// 1.0.38 (Bug 7) — the dialog body is the SHARED SyncCenterPanel that Settings → Sync Center
// also renders, and the chip reads the same scoped summary (loadSyncSummary over the live
// operations log), so the two entry points can never disagree.

import { useState } from "react";
import { Glyph } from "@/components/Glyph";
import { SyncCenterPanel, useCurrentShiftId, useSyncSummary } from "@/components/sync/SyncCenterPanel";
import { chipOf } from "@/components/sync/syncCenterModel";

const CHIP_TONE = {
  attention: "text-amber-700 bg-amber-50 border-amber-200",
  pending: "text-brand-dark bg-brand-soft border-brand/30",
  clear: "text-emerald-700 bg-emerald-50 border-emerald-200",
} as const;

export function SyncCenter({ tenantId, branchId }: { tenantId: string | null; branchId: string | null }) {
  const [open, setOpen] = useState(false);
  const summary = useSyncSummary(tenantId, branchId);
  // The live shift (canonical or offline-opened local id), so work of an OLDER shift is
  // classified UNRELATED_OLD_SHIFT rather than mistaken for this shift's failure.
  const currentShiftId = useCurrentShiftId();

  // Chip text + tone. Needs-attention dominates, then in-flight, else all-synced.
  const chip = chipOf(summary);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${CHIP_TONE[chip.kind]}`}
        aria-label="Open sync center"
        title="Sync center"
      >
        <Glyph name="pos" size={13} />
        {chip.text}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Sync center">
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-base font-extrabold text-ink">Sync center</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-sm font-semibold text-sub hover:text-ink">Close</button>
            </div>
            <SyncCenterPanel tenantId={tenantId} branchId={branchId} currentShiftId={currentShiftId} />
          </div>
        </div>
      )}
    </>
  );
}
