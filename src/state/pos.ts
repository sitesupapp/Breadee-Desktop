// POS session context: the resolved access decision, the branch, and who is on
// the terminal. Derived from the auth session, so it re-computes automatically
// when permissions or features change.

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/state/session";
import { loadBranchContext, UNKNOWN_BRANCH, type BranchContext } from "@/lib/branch";
import { useOperationalBranch } from "@/state/operationalBranch";
import { findOpenShift } from "@/lib/pos/shifts";
import { loadOperatorName } from "@/lib/operator";
import {
  canApplyDiscounts,
  canCollectReceivables,
  canCreateOrders,
  canCreatePayout,
  canEndShift,
  canManageDelivery,
  canOpenShift,
  canOperatePOS,
  canReversePayout,
  canTakeOnAccount,
  canViewPayouts,
  canTakePayments,
  canUseOrderType,
  canViewDeliveryReport,
  canReconcileDeliverySettlements,
  canViewReceivables,
  posAccessDenialReason,
  type PosAccessContext,
} from "@/lib/pos/access";
import { FEATURES } from "@/lib/features";
import type { Gate } from "@/components/ui";

export type PosContext = {
  ready: boolean;
  access: PosAccessContext;
  allowed: boolean;
  denialReason: string | null;
  branch: BranchContext;
  /** True when the operator is all-branches (owner/admin): they pick the operational branch. */
  allBranches: boolean;
  /** Active branches to choose from (all-branches operators only). */
  branchOptions: { id: string; name: string }[];
  /** Pin the operational branch for this session (all-branches operators). Re-resolves branch + shift. */
  setOperationalBranch: (branchId: string) => void;
  tenantId: string | null;
  tenantName: string;
  userId: string | null;
  userName: string;
  role: string | null;
  gates: {
    createOrders: Gate;
    takePayments: Gate;
    takeOnAccount: Gate;
    applyDiscounts: Gate;
    openShift: Gate;
    endOwnShift: Gate;
    viewReceivables: Gate;
    collectReceivables: Gate;
    manageDelivery: Gate;
    viewDeliveryReport: Gate;
    reconcileDeliverySettlements: Gate;
    viewPayouts: Gate;
    createPayout: Gate;
    reversePayout: Gate;
  };
  routes: {
    takeaway: boolean;
    dineIn: boolean;
    delivery: boolean;
  };
};

export function usePosContext(): PosContext {
  const session = useSession();
  const [branch, setBranch] = useState<BranchContext>(UNKNOWN_BRANCH);
  const [operatorName, setOperatorName] = useState<string>("Cashier");
  const [contextLoaded, setContextLoaded] = useState(false);
  const [branchOptions, setBranchOptions] = useState<{ id: string; name: string }[]>([]);

  const tenantId = session.tenant?.id ?? null;
  const membershipId = session.membership?.id ?? null;
  const userId = session.userId;
  const email = session.email;
  const currency = session.currency?.primary ?? "USD";
  const allBranches = !!session.membership?.all_branches;

  // The session-pinned operational branch for an all-branches operator (null = not yet pinned).
  const selectedBranch = useOperationalBranch((s) => (tenantId && userId ? s.sel[`${tenantId}:${userId}`] ?? null : null));
  const setBranchInStore = useOperationalBranch((s) => s.setBranch);

  useEffect(() => {
    let active = true;
    setContextLoaded(false);
    (async () => {
      // All-branches operator with no pin yet: default to the branch of their OWN open shift (so an existing
      // shift is used and the status bar/orders agree), else Main (resolveBranchId's fallback).
      let effectiveSelected = selectedBranch;
      if (allBranches && !effectiveSelected && tenantId && userId) {
        try {
          const sh = await findOpenShift(tenantId, userId);
          if (sh?.branch_id) {
            effectiveSelected = sh.branch_id;
            setBranchInStore(tenantId, userId, sh.branch_id);
          }
        } catch {
          /* offline / unreadable: fall through to Main */
        }
      }
      const [b, name] = await Promise.all([
        loadBranchContext(session.tenant, session.membership, { currency, selectedBranchId: effectiveSelected }).catch(() => UNKNOWN_BRANCH),
        loadOperatorName(userId, email).catch(() => email ?? "Cashier"),
      ]);
      if (!active) return;
      setBranch(b);
      setOperatorName(name);
      // Active branches for the picker (all-branches operators only).
      if (allBranches && tenantId) {
        try {
          const { supabase } = await import("@/lib/supabase");
          const { data } = await supabase.from("branches").select("id, name").eq("tenant_id", tenantId).eq("status", "active").order("name");
          if (active) setBranchOptions(((data as { id: string; name: string }[] | null) ?? []).map((x) => ({ id: x.id, name: x.name })));
        } catch {
          /* ignore: picker simply has no options offline */
        }
      } else if (active) {
        setBranchOptions([]);
      }
    })().finally(() => {
      if (active) setContextLoaded(true);
    });
    return () => {
      active = false;
    };
    // Re-resolve when the tenant, membership, user, or the pinned operational branch changes.
  }, [tenantId, membershipId, userId, email, currency, session.tenant, session.membership, selectedBranch, allBranches, setBranchInStore]);

  return useMemo(() => {
    const access: PosAccessContext = {
      membership: session.membership,
      permissions: session.permissions,
      features: session.features,
    };
    const allowed = canOperatePOS(access);
    return {
      ready: !session.loading && contextLoaded,
      access,
      allowed,
      denialReason: posAccessDenialReason(access),
      branch,
      allBranches,
      branchOptions,
      setOperationalBranch: (bId: string) => {
        if (tenantId && userId) setBranchInStore(tenantId, userId, bId);
      },
      tenantId,
      tenantName: session.tenant?.business_name?.trim() || "Breadee",
      userId: session.userId,
      userName: operatorName,
      role: session.membership?.role ?? null,
      gates: {
        createOrders: canCreateOrders(access),
        takePayments: canTakePayments(access),
        takeOnAccount: canTakeOnAccount(access),
        applyDiscounts: canApplyDiscounts(access),
        openShift: canOpenShift(access),
        endOwnShift: canEndShift(access, true),
        viewReceivables: canViewReceivables(access),
        collectReceivables: canCollectReceivables(access),
        manageDelivery: canManageDelivery(access),
        viewDeliveryReport: canViewDeliveryReport(access),
        reconcileDeliverySettlements: canReconcileDeliverySettlements(access),
        viewPayouts: canViewPayouts(access),
        createPayout: canCreatePayout(access),
        reversePayout: canReversePayout(access),
      },
      routes: {
        takeaway: canUseOrderType(access, FEATURES.POS_TAKEAWAY),
        dineIn: canUseOrderType(access, FEATURES.POS_DINE_IN),
        delivery: canUseOrderType(access, FEATURES.POS_DELIVERY),
      },
    };
  }, [session, branch, operatorName, contextLoaded, tenantId, userId, allBranches, branchOptions, setBranchInStore]);
}
