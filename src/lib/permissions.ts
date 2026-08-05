// Pure membership helpers ported from the web app (src/lib/permissions.ts).
//
// NOTE: the POS role gates that used to live here (`canUsePOS`, `canOpenShift`,
// `canApproveShift`, `canViewReports`) have been REMOVED, not deprecated. They
// were hard-coded role lists that contradicted the permission registry - most
// visibly by admitting tenant owners, whom `pos_assert_operator` (m93) rejects
// server-side. POS access now lives in `lib/pos/access.ts` and is decided by the
// effective permission map plus the tenant feature, exactly as the database does.
// Nothing should reintroduce a second permission model here.

import type { TenantRole, UserStatus } from "@/lib/types";

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  cashier: "Cashier",
  kitchen_staff: "Kitchen Staff",
  staff: "Staff",
};

export const roleLabel = (r: string | null | undefined) => (r ? (ROLE_LABELS[r] ?? r) : "-");

export const isActiveMember = (status: UserStatus | null | undefined) => status === "active";

export const isOwner = (role: TenantRole | null | undefined) => role === "owner";

// Non-owners are pinned to exactly one branch; owners can see all branches.
export const canAccessAllBranches = (role: TenantRole | null | undefined, allBranches: boolean) =>
  isOwner(role) || allBranches;
