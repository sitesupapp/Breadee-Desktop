// R7 (Desktop 1.0.36) — End-Shift Approval setting data layer.
//
// Thin, server-authoritative wrappers over the canonical R7 RPCs. The desktop performs NO
// authority logic: pos_shift_approval_set re-enforces `pos.settings.manage` server-side and the
// setting is per-branch (pos_shift_settings, PK tenant+branch) with NO inheritance from a sibling
// OU or Main. pos_end_shift_core reads this setting at close time and sets the shift to
// 'pending_manager_review' (approval REQUIRED, the default) or 'approved' (legacy direct-close).
//
// CRITICAL MAPPING — the backend stores `approval_required` (TRUE = a manager must review each
// ended shift; the current/default behaviour). The user-facing switch is phrased as a BYPASS
// ("Allow direct shift close"), so the UI boolean is the INVERSE of the backend boolean:
//     UI switch ON  = direct close (legacy)        => approval_required = FALSE
//     UI switch OFF = manager approval required     => approval_required = TRUE  (default)
// isEndShiftApprovalRequired returns the backend boolean; setEndShiftApprovalRequired takes the
// backend boolean. The component owns the single inversion so it is stated once, not re-derived.

import { callPosRpc, asRecord, str, num } from "@/lib/pos/rpc";

/**
 * R7 — is manager approval REQUIRED to end a shift on this branch? The server defaults to TRUE
 * (approval required = today's behaviour) when the branch has no setting row, and returns the
 * safe default for a branch the caller cannot access (no cross-OU probe). Anything that is not an
 * explicit `false` is treated as "required" so an unexpected shape never silently disables review.
 */
export async function isEndShiftApprovalRequired(branchId: string): Promise<boolean> {
  const r = await callPosRpc("pos_end_shift_approval_required", { p_branch: branchId });
  return r !== false;
}

export type ShiftApprovalResult = { branchId: string; approvalRequired: boolean; configVersion: number };

/** Pure builder for the write payload. `expected_config_version` is sent ONLY when a real integer
 *  is supplied (optional optimistic concurrency); never as null/NaN. */
export function buildShiftApprovalPayload(input: {
  branchId: string;
  approvalRequired: boolean;
  expectedConfigVersion?: number;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    branch_id: input.branchId,
    approval_required: input.approvalRequired,
  };
  if (Number.isInteger(input.expectedConfigVersion)) payload.expected_config_version = input.expectedConfigVersion;
  return payload;
}

/**
 * R7 — set the OU-scoped End-Shift Approval requirement for a branch. Requires
 * `pos.settings.manage` (server-enforced); per-branch with NO inheritance. Takes the BACKEND
 * boolean (`approvalRequired`), not the UI bypass boolean — the caller performs the inversion.
 */
export async function setEndShiftApprovalRequired(input: {
  branchId: string;
  approvalRequired: boolean;
  expectedConfigVersion?: number;
}): Promise<ShiftApprovalResult> {
  const r = asRecord(await callPosRpc("pos_shift_approval_set", { p_payload: buildShiftApprovalPayload(input) }));
  return {
    branchId: str(r.branch_id),
    approvalRequired: r.approval_required === true,
    configVersion: num(r.config_version),
  };
}
