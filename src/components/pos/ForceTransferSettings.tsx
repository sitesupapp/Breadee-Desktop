// Desktop 1.0.35 (B3) — the branch's OU-scoped Force-Transfer setting, on Settings → POS Settings.
//
// BRANCH-WIDE, PER-OU, SHARED WITH THE SERVER. Force Transfer is governed by `pos_transfer_settings`
// (PK tenant+branch), so this switch is the branch's own — there is NO inheritance from a sibling OU or
// Main, and changing it here changes it for every terminal in this branch. The write goes through the
// canonical `pos_transfer_settings_set` RPC, which re-enforces `pos.transfers.manage_force_setting`
// server-side; this screen only offers the control where the server would honour it. When OFF, the B1
// `pos_order_transfer_force_core` gate refuses every force attempt on the branch. Standard transfers
// (recipient-acceptance) are always available and unaffected by this switch.

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Card, EmptyState } from "@/components/ui";
import { Switch } from "@/components/Switch";
import { classifyError } from "@/lib/pos/errors";
import { isForceTransferEnabled, setForceTransferEnabled } from "@/lib/pos/transfers";

export function ForceTransferSettings({
  branchId,
  canManage,
  reason,
}: {
  branchId: string | null;
  canManage: boolean;
  /** Why management is unavailable (server permission), shown when the switch is disabled. */
  reason: string | null;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // OU ISOLATION is by REMOUNT: the integration keys this component with `key={branchId}` (see
  // PosSettings), so a branch change mounts a FRESH instance — initial state is always enabled=null /
  // loading=true / saving=false, so branch A's value can never render for branch B even for one frame,
  // and no render-time ref mutation (unsafe under concurrent/abandoned renders) is needed. `seqRef` then
  // only orders requests WITHIN this one branch's mount (a slow read vs a later write): a completion is
  // applied ONLY if its captured `seq` is still the newest.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = (seqRef.current += 1);
    setError(null);
    if (!branchId) { setEnabled(null); setLoading(false); return; }
    setLoading(true);
    try {
      // The server returns false for a branch the caller cannot access (no cross-OU probe), so this is
      // both the current value and an access-aware read.
      const v = await isForceTransferEnabled(branchId);
      if (seq === seqRef.current) setEnabled(v);
    } catch (e) {
      if (seq === seqRef.current) setError(classifyError(e).message);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { void load(); }, [load]);

  // Optimistic in the UI, authoritative on the server: the switch moves at once and is put back if the
  // server refuses, so it never shows a state the branch does not have. Guarded by the current-seq check.
  const toggle = useCallback(
    async (next: boolean) => {
      if (!branchId || saving) return;
      const seq = (seqRef.current += 1); // a write supersedes any in-flight read
      const previous = enabled;
      setEnabled(next);
      setSaving(true);
      setError(null);
      try {
        const r = await setForceTransferEnabled({ branchId, enabled: next });
        if (seq === seqRef.current) setEnabled(r.enabled);
      } catch (e) {
        if (seq === seqRef.current) { setEnabled(previous ?? null); setError(classifyError(e).message); }
      } finally {
        if (seq === seqRef.current) setSaving(false);
      }
    },
    [branchId, enabled, saving],
  );

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-extrabold text-ink">Force Transfer</p>
          <p className="mt-0.5 text-xs text-sub">
            Whether an authorised cashier may <strong className="text-ink">immediately</strong> move their open orders
            to another cashier. This is a <strong className="text-ink">branch</strong> setting for this OU alone — it is
            not inherited from, or shared with, any other branch.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && <Badge tone="amber">Saving…</Badge>}
          <Badge tone="blue">Branch-wide</Badge>
        </div>
      </div>

      {!branchId ? (
        <div className="mt-3">
          <EmptyState title="No branch resolved" hint="This terminal is not scoped to a branch, and the force-transfer setting belongs to one." />
        </div>
      ) : (
        <>
          {!canManage && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-[11px] text-sub">{reason}</p>}
          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">{error}</p>}
          <div className="mt-2">
            <Switch
              checked={enabled === true}
              disabled={!canManage || saving || loading || enabled === null}
              title={reason ?? undefined}
              onChange={(next) => void toggle(next)}
              label="Allow Force Transfer on this branch"
              hint="When ON, a cashier with the Force-Transfer permission can move their FULLY-UNPAID open orders straight into another cashier's open shift, with no acceptance step. Standard transfers — which the recipient must approve — are always available and are not affected by this switch. When OFF, every force attempt on this branch is refused by the server."
            />
          </div>
        </>
      )}
    </Card>
  );
}
