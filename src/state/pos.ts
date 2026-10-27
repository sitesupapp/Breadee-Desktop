// POS session context: the resolved access decision, the branch, and who is on
// the terminal. Derived from the auth session, so it re-computes automatically
// when permissions or features change.

import { useEffect, useMemo, useState } from "react";
import { useSession } from "@/state/session";
import { cacheActiveBranches, cachedBranchName, loadBranchContext, readCachedActiveBranches, resolveBranchId, UNKNOWN_BRANCH, type BranchContext } from "@/lib/branch";
import { filterToEntitledScope, useOperationalBranch } from "@/state/operationalBranch";
import { findOpenShift } from "@/lib/pos/shifts";
import { loadOperatorName } from "@/lib/operator";
import { isBackendReachable } from "@/lib/offline/reachability";
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

/** 1.0.38 (PERF C9) — how long an OFFLINE POS boot waits for the branch context before a placeholder. */
export const POS_BOOT_READ_TIMEOUT_MS = 4_000;

/** The promise's value if it settles within `ms`, else null (the promise keeps running). */
export async function raceBootRead<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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
      // Read THIS tenant's ACTIVE branches first: they populate the picker AND bound the operational-branch
      // selection. A persisted pin that is no longer an active branch of this tenant (e.g. the branch was
      // disabled after it was picked) must never be used — pos_resolve_operational_branch validates tenant
      // membership, not status, so it would otherwise be accepted. This mirrors the web server component,
      // which validates the pos_op_branch cookie against active branches before trusting it.
      let activeBranches: { id: string; name: string }[] = [];
      let branchesKnown = false;
      // 1.0.38 (PERF C9) — ask the SHARED reachability store first (TTL-fresh, de-duplicated with the
      // workspace's own probe). Unreachable: none of the boot reads below is attempted except the branch
      // name, which is bounded (see the offline block) — POS readiness never waits on a hung link.
      const reachable = await isBackendReachable().catch(() => false);
      if (allBranches && tenantId && reachable) {
        try {
          const { supabase } = await import("@/lib/supabase");
          // PostgREST returns { data, error } WITHOUT throwing for most failures, so an unreadable list must
          // be detected via `error` too — not only via a thrown transport error. Only treat the list as KNOWN
          // when there is no error; otherwise leave branchesKnown=false so the last-good pin is trusted.
          const { data, error } = await supabase.from("branches").select("id, name").eq("tenant_id", tenantId).eq("status", "active").order("name");
          if (!error) {
            activeBranches = ((data as { id: string; name: string }[] | null) ?? []).map((x) => ({ id: x.id, name: x.name }));
            branchesKnown = true;
            cacheActiveBranches(tenantId, activeBranches);
          }
        } catch {
          /* offline: cannot validate; trust the last-good pin below (server re-validates on sync) */
        }
      }
      const isActiveBranch = (id: string | null | undefined): boolean => !!id && activeBranches.some((x) => x.id === id);

      // The operational branch for an all-branches operator:
      //  - list unknown (offline / query error): trust the persisted pin as-is — it was validated when set,
      //    and the server re-validates every mutation; falling back to Main here would strand them.
      //  - online: a still-active persisted pin wins; else the branch of their OWN active open shift; else Main
      //    (if active) else the first active branch. The resolved branch is written back to the store so a
      //    stale/invalid pin is genuinely repaired and the picker/store/branch all agree.
      let effectiveSelected: string | null = null;
      if (allBranches) {
        if (!branchesKnown) {
          effectiveSelected = selectedBranch;
        } else if (isActiveBranch(selectedBranch)) {
          effectiveSelected = selectedBranch;
        } else {
          if (tenantId && userId) {
            try {
              const sh = await findOpenShift(tenantId, userId);
              if (sh?.branch_id && isActiveBranch(sh.branch_id)) effectiveSelected = sh.branch_id;
            } catch {
              /* unreadable: fall through to Main / first active */
            }
          }
          if (!effectiveSelected) {
            const mainId = session.tenant?.main_branch_id ?? null;
            effectiveSelected = isActiveBranch(mainId) ? mainId : (activeBranches[0]?.id ?? null);
          }
          // Repair the stale/invalid persisted pin so the store, picker and resolved branch all agree.
          if (effectiveSelected && effectiveSelected !== selectedBranch && tenantId && userId) {
            setBranchInStore(tenantId, userId, effectiveSelected);
          }
        }
      }

      if (!reachable) {
        // Offline: the branch context serves its durable cache (it fails fast on a real disconnect); a
        // half-open link is bounded by POS_BOOT_READ_TIMEOUT_MS with a placeholder of the SAME resolved id,
        // replaced by the late answer. The operator name is the same fallback a failed read gives.
        const branchP = loadBranchContext(session.tenant, session.membership, { currency, selectedBranchId: effectiveSelected }).catch(() => UNKNOWN_BRANCH);
        const early = await raceBootRead(branchP, POS_BOOT_READ_TIMEOUT_MS);
        if (!active) return;
        const placeholderId = resolveBranchId(session.tenant, session.membership, effectiveSelected);
        // Offline-first recovery — the cached NAME of the resolved branch (never "Branch unavailable" when
        // this device has named it before), and the cached active-branch list for the picker.
        const cachedName = placeholderId && tenantId ? cachedBranchName(placeholderId, tenantId) : null;
        setBranch(early ?? (placeholderId ? { id: placeholderId, name: cachedName ?? "Branch unavailable", pinned: !allBranches } : UNKNOWN_BRANCH));
        if (!early) {
          void branchP.then((late) => {
            if (active && late.id) setBranch(late);
          });
        }
        setOperatorName(email?.trim() || "Cashier");
        setBranchOptions(allBranches && tenantId ? filterToEntitledScope(readCachedActiveBranches(tenantId)) : []);
        return;
      }

      const [b, name] = await Promise.all([
        loadBranchContext(session.tenant, session.membership, { currency, selectedBranchId: effectiveSelected }).catch(() => UNKNOWN_BRANCH),
        loadOperatorName(userId, email).catch(() => email ?? "Cashier"),
      ]);
      if (!active) return;
      setBranch(b);
      setOperatorName(name);
      setBranchOptions(allBranches ? activeBranches : []);
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
