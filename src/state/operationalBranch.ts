// R5 policy (2026-10-15, amended 2026-10-16): an all-branches operator (owner/admin, branch_id NULL) PINS
// one operational branch for the POS session; shifts are opened and orders are created in that branch, and
// the shift-status read filters by it. The pin is PER APP SESSION (in memory) and is NOT persisted across
// restarts: opening the Desktop app always LANDS ON MAIN BRANCH, and the operator re-picks another branch
// for the session if they want one. The server (pos_resolve_operational_branch) re-validates the branch, so
// this only chooses which branch to request — it never widens access.

import { create } from "zustand";

type State = {
  sel: Record<string, string>;
  /** Pin the operational branch for a (tenant,user) for THIS app session. Triggers re-resolution. */
  setBranch: (tenantId: string, userId: string, branchId: string) => void;
  /** The pinned branch for a (tenant,user) in this session, or null (→ Main Branch on a fresh open). */
  getBranch: (tenantId: string, userId: string) => string | null;
};

const k = (t: string | null, u: string | null) => `${t ?? ""}:${u ?? ""}`;

export const useOperationalBranch = create<State>((set, get) => ({
  // In-memory only: a fresh app start has no pin, so resolveBranchId falls back to Main Branch.
  sel: {},
  setBranch: (tenantId, userId, branchId) =>
    set((s) => ({ sel: { ...s.sel, [k(tenantId, userId)]: branchId } })),
  getBranch: (tenantId, userId) => get().sel[k(tenantId, userId)] ?? null,
}));
