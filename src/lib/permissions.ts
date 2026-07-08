// Ported from the web app (src/lib/permissions.ts) — pure helpers, safe everywhere.
import type { TenantRole, UserStatus } from "@/lib/types";

export const ROLE_LABELS: Record<string, string> = {
  owner: "Owner", admin: "Admin", manager: "Manager",
  cashier: "Cashier", kitchen_staff: "Kitchen Staff", staff: "Staff",
};
export const roleLabel = (r: string | null | undefined) => (r ? ROLE_LABELS[r] ?? r : "—");

export const isActiveMember = (status: UserStatus | null | undefined) => status === "active";

export const isOwner = (role: TenantRole | null | undefined) => role === "owner";

export const canUsePOS = (role: TenantRole | null | undefined, status: UserStatus | null | undefined) =>
  isActiveMember(status) && ["owner", "admin", "manager", "cashier"].includes(role ?? "");
export const canOpenShift = canUsePOS;
export const canApproveShift = (role: TenantRole | null | undefined, status: UserStatus | null | undefined) =>
  isActiveMember(status) && ["owner", "admin", "manager"].includes(role ?? "");
export const canViewReports = (role: TenantRole | null | undefined, status: UserStatus | null | undefined) =>
  isActiveMember(status) && ["owner", "admin", "manager"].includes(role ?? "");

// Non-owners are pinned to exactly one branch; owners can see all branches.
export const canAccessAllBranches = (role: TenantRole | null | undefined, allBranches: boolean) =>
  isOwner(role) || allBranches;
