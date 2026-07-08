// Minimal shared types mirrored from the web app's generated database.types.
// TODO(desktop): replace with the full generated types via
//   npx supabase gen types typescript --project-id <staging-ref> > src/lib/database.types.ts
// and import from there for end-to-end type safety on RPC/table calls.

export type TenantRole = "owner" | "admin" | "manager" | "cashier" | "kitchen_staff" | "staff";
export type UserStatus = "active" | "invited" | "frozen" | "inactive" | "removed" | "suspended";
export type TenantStatus =
  | "active"
  | "pending"
  | "rejected"
  | "disabled"
  | "expired"
  | "suspended";

export type Tenant = {
  id: string;
  business_name: string | null;
  tenant_status: TenantStatus;
  verification_status: string | null;
  selected_plan_id: string | null;
  main_branch_id: string | null;
};

export type Membership = {
  id: string;
  tenant_id: string;
  role: TenantRole;
  status: UserStatus;
  branch_id: string | null;
  all_branches: boolean;
};

export type Branch = {
  id: string;
  tenant_id: string;
  name: string | null;
  branch_number: number | null;
  status: string | null;
  is_main: boolean | null;
};
