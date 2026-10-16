// READY POS Phase H — Payouts promoted to the MAIN dashboard.
//
// Phase G's Payouts business logic and UI are reused: this page re-wires NAVIGATION and, for
// Desktop 1.0.37 (D4), threads the OFFLINE capture context. It resolves the operator's own open
// shift through the shared shift store (useShift) — which resolves a server shift online, a
// hydrated shift from the offline snapshot, or an offline-opened pending shift — so the Payouts
// surface works after the backend goes unreachable, exactly like the POS workspace. While online
// it writes through the valid payout sources so a later offline payout can be proven; offline it
// passes the immutable 5-D scope + the pending-shift local id so a cash-out is captured durably,
// reduces the drawer immediately, and syncs exactly-once on reconnect. No payout RPC, cash
// calculation, reversal, source-linking or End-Shift behavior is otherwise changed.

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "@/state/session";
import { usePosContext } from "@/state/pos";
import { useShift, requireOpenShiftId } from "@/state/shift";
import { Card, EmptyState, Skeleton } from "@/components/ui";
import { PayoutsModal } from "@/components/pos/PayoutsModal";
import { canViewPayouts } from "@/lib/pos/access";
import { getDeviceIdentity } from "@/lib/device";
import { hydratePayoutSourceProofs } from "@/lib/pos/payoutProofHydration";
import type { PayoutScope } from "@/lib/offline/payoutOffline";
import type { CurrencyCode } from "@/lib/currency";

export function PayoutsPage() {
  const pos = usePosContext();
  const session = useSession();
  const shiftStore = useShift();
  const navigate = useNavigate();
  const online = session.online && !session.offlineMode;

  const gate = canViewPayouts(pos.access);
  const shift = shiftStore.shift;
  const shiftId = requireOpenShiftId(shift);
  const loading = shiftStore.loading;

  // Resolve the active shift through the shared store (online → server; offline → snapshot/pending).
  useEffect(() => {
    if (pos.ready && pos.tenantId && pos.userId) {
      void shiftStore.refresh(pos.tenantId, pos.userId, pos.branch.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.ready, pos.tenantId, pos.userId, pos.branch.id]);

  const branchId = shift?.branch_id ?? pos.branch.id;
  const offlineScope: PayoutScope | null =
    pos.tenantId && pos.userId
      ? {
          tenantId: pos.tenantId,
          branchId,
          cashierUserId: pos.userId,
          deviceId: getDeviceIdentity().device_id,
          terminalId: getDeviceIdentity().terminal_id,
        }
      : null;

  // While ONLINE, write through the valid payout sources for this scope so a later offline payout
  // can prove its source (fail-closed otherwise). Best-effort; a failure just leaves payouts online-only.
  useEffect(() => {
    if (!online || !shiftId || !offlineScope) return;
    void hydratePayoutSourceProofs(offlineScope).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, shiftId, offlineScope?.tenantId, offlineScope?.branchId, offlineScope?.cashierUserId]);

  if (!pos.ready || loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!gate.allowed) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState icon="💸" title="Cash payouts" hint={gate.reason ?? "You do not have access to cash payouts."} />
      </div>
    );
  }

  if (!shift || shift.status !== "open") {
    return (
      <div className="mx-auto max-w-3xl">
        <Card className="p-6">
          <EmptyState
            icon="💸"
            title="No open shift"
            hint="Cash payouts are recorded against your open shift. Open a shift on the POS, then return here to pay out or review drawer cash."
          />
        </Card>
      </div>
    );
  }

  return (
    <PayoutsModal
      open
      onClose={() => navigate("/dashboard")}
      shiftId={shift.id}
      tenantId={pos.tenantId}
      branchId={branchId}
      currency={session.currency.primary as CurrencyCode}
      online={online}
      canCreate={pos.gates.createPayout}
      canReverse={pos.gates.reversePayout}
      offlineReady={Boolean(shiftId)}
      offlineScope={offlineScope}
      shiftLocalId={shiftStore.pendingLocalId}
      usdRate={session.currency.rate}
    />
  );
}
