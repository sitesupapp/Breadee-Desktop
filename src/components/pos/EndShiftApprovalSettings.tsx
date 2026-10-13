// R7 (Desktop 1.0.36) — the branch's OU-scoped End-Shift Approval setting, on Settings → POS Settings.
//
// BRANCH-WIDE, PER-OU, SHARED WITH THE SERVER. Governed by `pos_shift_settings` (PK tenant+branch),
// so this switch is the branch's own — NO inheritance from a sibling OU or Main. The write goes
// through `pos_shift_approval_set`, which re-enforces `pos.settings.manage` server-side.
//
// INVERSE MAPPING (stated once, here). The backend stores `approval_required`:
//     approval_required = TRUE  => ending a shift goes to 'pending_manager_review' (a manager must
//                                  approve it) — this is the DEFAULT and today's behaviour.
//     approval_required = FALSE => ending a shift closes it directly ('approved') — the legacy
//                                  no-approval flow.
// The user-facing switch is phrased as a BYPASS, so it is the INVERSE of the backend boolean:
//     switch ON  (checked)  = "Allow direct shift close"      => approval_required = FALSE
//     switch OFF (default)  = manager approval required         => approval_required = TRUE
// The existing manager-review workflow and any pending reviews are untouched by this switch; it
// only decides whether NEWLY ended shifts require a review going forward.

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Card, EmptyState } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { classifyError } from "@/lib/pos/errors";
import { isEndShiftApprovalRequired, setEndShiftApprovalRequired } from "@/lib/pos/shiftApproval";

export function EndShiftApprovalSettings({
  branchId,
  canManage,
  reason,
}: {
  branchId: string | null;
  canManage: boolean;
  /** Why management is unavailable (server permission), shown when the switch is disabled. */
  reason: string | null;
}) {
  // We hold the BACKEND boolean (approval_required). The switch renders its inverse.
  const [approvalRequired, setApprovalRequired] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // OU ISOLATION by REMOUNT: PosSettings keys this with `key={branchId}`, so a branch change mounts
  // a FRESH instance (approvalRequired=null/loading=true). seqRef only orders requests within one mount.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = (seqRef.current += 1);
    setError(null);
    if (!branchId) { setApprovalRequired(null); setLoading(false); return; }
    setLoading(true);
    try {
      const v = await isEndShiftApprovalRequired(branchId);
      if (seq === seqRef.current) setApprovalRequired(v);
    } catch (e) {
      if (seq === seqRef.current) setError(classifyError(e).message);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { void load(); }, [load]);

  // `next` is the UI (bypass) boolean: ON => allow direct close => approval_required = !next = FALSE.
  const toggle = useCallback(
    async (next: boolean) => {
      if (!branchId || saving) return;
      const seq = (seqRef.current += 1);
      const previous = approvalRequired;
      const nextApprovalRequired = !next;
      setApprovalRequired(nextApprovalRequired); // optimistic
      setSaving(true);
      setError(null);
      try {
        const r = await setEndShiftApprovalRequired({ branchId, approvalRequired: nextApprovalRequired });
        if (seq === seqRef.current) setApprovalRequired(r.approvalRequired);
      } catch (e) {
        if (seq === seqRef.current) { setApprovalRequired(previous ?? null); setError(classifyError(e).message); }
      } finally {
        if (seq === seqRef.current) setSaving(false);
      }
    },
    [branchId, approvalRequired, saving],
  );

  // Switch shows the BYPASS state = the inverse of approval_required.
  const switchOn = approvalRequired === false;

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-extrabold text-ink">End-Shift Approval</p>
          <p className="mt-0.5 text-xs text-sub">
            Whether a cashier ending their shift requires a <strong className="text-ink">manager review</strong> before
            it is final. This is a <strong className="text-ink">branch</strong> setting for this OU alone — it is not
            inherited from, or shared with, any other branch.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && <Badge tone="amber">Saving…</Badge>}
          <Badge tone="blue">Branch-wide</Badge>
        </div>
      </div>

      {!branchId ? (
        <div className="mt-3">
          <EmptyState title="No branch resolved" hint="This terminal is not scoped to a branch, and the approval setting belongs to one." />
        </div>
      ) : (
        <>
          {!canManage && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-sub">{reason}</p>}
          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">{error}</p>}
          <div className="mt-2">
            <Switch
              checked={switchOn}
              disabled={!canManage || saving || loading || approvalRequired === null}
              title={reason ?? undefined}
              onChange={(next) => void toggle(next)}
              label="Allow direct shift close (skip manager approval)"
              hint="OFF (default): ending a shift sends it for manager approval before it is final — today's behaviour. ON: ending a shift closes it directly with no approval step (the legacy flow). This changes only shifts ended from now on; reviews already pending are not affected, and a manager still cannot approve their own shift."
            />
          </div>
        </>
      )}
    </Card>
  );
}
