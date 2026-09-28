// READY POS Phase H — Payouts promoted to the MAIN dashboard.
//
// Phase G's Payouts business logic and UI are CLOSED and reused UNCHANGED: this page
// only re-wires NAVIGATION. It resolves the operator's own open shift (the same
// findOpenShift the POS workspace uses) and renders the existing PayoutsModal against
// it. No payout RPC, cash calculation, reversal, source-linking or End-Shift behavior
// is touched here — only where the surface is reached from.

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSession } from "@/state/session";
import { usePosContext } from "@/state/pos";
import { Card, EmptyState, Skeleton } from "@/components/ui";
import { PayoutsModal } from "@/components/pos/PayoutsModal";
import { findOpenShift } from "@/lib/pos/shifts";
import { canViewPayouts } from "@/lib/pos/access";
import type { CurrencyCode } from "@/lib/currency";
import type { ActiveShift } from "@/types/pos";

export function PayoutsPage() {
  const pos = usePosContext();
  const session = useSession();
  const navigate = useNavigate();
  const online = session.online && !session.offlineMode;

  const gate = canViewPayouts(pos.access);
  const [shift, setShift] = useState<ActiveShift | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshShift = useCallback(async () => {
    if (!pos.tenantId || !pos.userId) {
      setShift(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setShift(await findOpenShift(pos.tenantId, pos.userId));
    } catch {
      setShift(null);
    } finally {
      setLoading(false);
    }
  }, [pos.tenantId, pos.userId]);

  useEffect(() => {
    if (pos.ready) void refreshShift();
  }, [pos.ready, refreshShift]);

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
      branchId={shift.branch_id ?? pos.branch.id}
      currency={session.currency.primary as CurrencyCode}
      online={online}
      canCreate={pos.gates.createPayout}
      canReverse={pos.gates.reversePayout}
    />
  );
}
