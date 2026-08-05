// POS session context: the resolved access decision, the branch, and who is on
// the terminal. Derived from the auth session, so it re-computes automatically
// when permissions or features change.

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/state/session";
import { loadBranchContext, UNKNOWN_BRANCH, type BranchContext } from "@/lib/branch";
import { loadOperatorName } from "@/lib/operator";
import {
  canApplyDiscounts,
  canCreateOrders,
  canEndShift,
  canOpenShift,
  canOperatePOS,
  canTakePayments,
  canUseOrderType,
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
  tenantId: string | null;
  tenantName: string;
  userId: string | null;
  userName: string;
  role: string | null;
  gates: {
    createOrders: Gate;
    takePayments: Gate;
    applyDiscounts: Gate;
    openShift: Gate;
    endOwnShift: Gate;
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

  const tenantId = session.tenant?.id ?? null;
  const membershipId = session.membership?.id ?? null;
  const userId = session.userId;
  const email = session.email;

  useEffect(() => {
    let active = true;
    setContextLoaded(false);
    Promise.all([
      loadBranchContext(session.tenant, session.membership).catch(() => UNKNOWN_BRANCH),
      loadOperatorName(userId, email).catch(() => email ?? "Cashier"),
    ])
      .then(([b, name]) => {
        if (!active) return;
        setBranch(b);
        setOperatorName(name);
      })
      .finally(() => {
        if (active) setContextLoaded(true);
      });
    return () => {
      active = false;
    };
    // Re-resolve when the tenant, membership or signed-in user changes - nothing
    // else can move the branch or the operator.
  }, [tenantId, membershipId, userId, email, session.tenant, session.membership]);

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
      tenantId,
      tenantName: session.tenant?.business_name?.trim() || "Breadee",
      userId: session.userId,
      userName: operatorName,
      role: session.membership?.role ?? null,
      gates: {
        createOrders: canCreateOrders(access),
        takePayments: canTakePayments(access),
        applyDiscounts: canApplyDiscounts(access),
        openShift: canOpenShift(access),
        endOwnShift: canEndShift(access, true),
      },
      routes: {
        takeaway: canUseOrderType(access, FEATURES.POS_TAKEAWAY),
        dineIn: canUseOrderType(access, FEATURES.POS_DINE_IN),
        delivery: canUseOrderType(access, FEATURES.POS_DELIVERY),
      },
    };
  }, [session, branch, operatorName, contextLoaded, tenantId]);
}
