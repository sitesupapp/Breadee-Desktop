// R5 policy (2026-10-15): an all-branches operator (owner/admin, branch_id NULL) is no longer hard-pinned
// to Main Branch. They PIN one operational branch for the POS session; shifts are opened and orders are
// created in that branch, and the shift-status read filters by it. The choice is per (tenant,user) and
// persisted to localStorage so it survives reloads. The server (pos_resolve_operational_branch) re-validates
// the branch, so this only chooses which branch to request — it never widens access.

import { create } from "zustand";

const KEY = "breadee.operationalBranch.v1";

function loadAll(): Record<string, string> {
  try {
    if (typeof localStorage === "undefined") return {};
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

type State = {
  sel: Record<string, string>;
  /** Pin the operational branch for a (tenant,user). Persists + triggers re-resolution. */
  setBranch: (tenantId: string, userId: string, branchId: string) => void;
  /** The pinned branch for a (tenant,user), or null. */
  getBranch: (tenantId: string, userId: string) => string | null;
};

const k = (t: string | null, u: string | null) => `${t ?? ""}:${u ?? ""}`;

export const useOperationalBranch = create<State>((set, get) => ({
  sel: loadAll(),
  setBranch: (tenantId, userId, branchId) =>
    set((s) => {
      const sel = { ...s.sel, [k(tenantId, userId)]: branchId };
      try {
        localStorage.setItem(KEY, JSON.stringify(sel));
      } catch {
        /* non-fatal: a private-mode / blocked store just means the pin isn't durable */
      }
      return { sel };
    }),
  getBranch: (tenantId, userId) => get().sel[k(tenantId, userId)] ?? null,
}));
