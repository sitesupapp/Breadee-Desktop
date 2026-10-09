// POS Final W4/W5 (Part 6) — Open-Orders Transfer data layer.
//
// Thin, server-authoritative wrappers over the canonical transfer RPCs. The desktop performs
// NO authority logic here: every rule (perms, tenant/branch OU, self-transfer, single open
// shift, exactly-once, recipient eligibility, all-or-nothing reassignment) is enforced by the
// SECURITY DEFINER RPCs. A transfer reassigns the selected open orders' ownership IN PLACE —
// same order id — so the sender's shift auto-unblocks for End Shift.
//
// Concurrency tokens:
//   * create_client_token / reapprove_client_token — client-generated idempotency keys; a retry
//     with the same token + payload returns the existing transfer rather than duplicating.
//   * expected_version — the transfer row's pos_entity_version from the last read; a stale value
//     is refused with VERSION_CONFLICT (surface it, reload, reapply — never silently retry).

import { callPosRpc, asRecord, requireId, str, strOrNull, num } from "@/lib/pos/rpc";

export type TransferStatus = "pending_transfer" | "approved" | "rejected";

export type PendingTransfer = {
  transferId: string;
  fromUserId: string;
  /** The sender's display name, resolved server-side by the self-scoped read (§6.7 "From [user]"). */
  fromUserName: string | null;
  fromShiftId: string;
  branchId: string;
  status: TransferStatus;
  createdAt: string | null;
  orderCount: number;
  /** The transfer's CAS token, returned by the SELF-SCOPED recipient read so the recipient can
   *  pass it to decide WITHOUT needing pos.transfers.view (they only hold approve). */
  posEntityVersion: number;
};

export type EligibleRecipient = {
  userId: string;
  fullName: string | null;
  email: string | null;
  role: string | null;
};

export type TransferListRow = {
  transferId: string;
  branchId: string;
  fromUserId: string;
  toUserId: string;
  status: TransferStatus;
  createdAt: string | null;
  decidedAt: string | null;
  reapprovedAt: string | null;
  orderCount: number;
};

export type TransferItem = { orderId: string; orderNumber: string | null; orderType: string | null };

export type TransferDetail = {
  transferId: string;
  branchId: string;
  status: TransferStatus;
  fromUserId: string;
  fromShiftId: string;
  toUserId: string;
  note: string | null;
  createdAt: string | null;
  createdBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decidedShiftId: string | null;
  rejectionReason: string | null;
  reapprovedBy: string | null;
  reapprovedAt: string | null;
  reapprovedShiftId: string | null;
  /** The transfer row's optimistic-concurrency token; pass back as expectedVersion on decide/reapprove. */
  posEntityVersion: number;
  items: TransferItem[];
};

export type TransferResult = { transferId: string; status: TransferStatus; idempotent: boolean };

/** An order that currently blocks End Shift — the transferable set, straight from the server. */
export type UnresolvedOrder = {
  orderId: string;
  orderNumber: string | null;
  orderType: string | null;
  tableName: string | null;
  customerName: string | null;
  status: string | null;
  paymentStatus: string | null;
};

function toStatus(v: unknown): TransferStatus {
  const s = str(v);
  return s === "approved" || s === "rejected" ? s : "pending_transfer";
}

function newToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Pending transfers assigned to the current user — shown on Open Shift. Self-scoped server-side. */
export async function listPendingTransfersForMe(): Promise<PendingTransfer[]> {
  const rows = await callPosRpc("pos_order_transfers_for_recipient", {});
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const r = asRecord(raw);
    return {
      transferId: requireId(r.transfer_id, "pos_order_transfers_for_recipient", "transfer_id"),
      fromUserId: str(r.from_user_id),
      fromUserName: strOrNull(r.from_user_name),
      fromShiftId: str(r.from_shift_id),
      branchId: str(r.branch_id),
      status: toStatus(r.status),
      createdAt: strOrNull(r.created_at),
      orderCount: num(r.order_count),
      posEntityVersion: num(r.pos_entity_version),
    };
  });
}

/** The orders that currently block End Shift for this shift — the set offered for transfer. */
export async function getUnresolvedOrders(shiftId: string): Promise<UnresolvedOrder[]> {
  const rows = await callPosRpc("pos_shift_unresolved_orders", { p_shift: shiftId });
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const r = asRecord(raw);
    return {
      orderId: requireId(r.order_id, "pos_shift_unresolved_orders", "order_id"),
      orderNumber: strOrNull(r.order_number),
      orderType: strOrNull(r.order_type),
      tableName: strOrNull(r.table_name),
      customerName: strOrNull(r.customer_name),
      status: strOrNull(r.status),
      paymentStatus: strOrNull(r.payment_status),
    };
  });
}

/** Eligible recipients for the branch — active members holding pos.transfers.approve, excluding the caller. */
export async function listEligibleRecipients(branchId: string): Promise<EligibleRecipient[]> {
  const rows = await callPosRpc("pos_order_transfer_eligible_recipients", { p_branch: branchId });
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const r = asRecord(raw);
    return {
      userId: str(r.user_id),
      fullName: strOrNull(r.full_name),
      email: strOrNull(r.email),
      role: strOrNull(r.role),
    };
  });
}

/** Transfer history / website list — perm-gated (pos.transfers.view), tenant+branch scoped. */
export async function listTransfers(filters: { status?: TransferStatus; branchId?: string } = {}): Promise<TransferListRow[]> {
  const p: Record<string, unknown> = {};
  if (filters.status) p.status = filters.status;
  if (filters.branchId) p.branch_id = filters.branchId;
  const rows = await callPosRpc("pos_order_transfers_list", { p_filters: p });
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => {
    const r = asRecord(raw);
    return {
      transferId: requireId(r.transfer_id, "pos_order_transfers_list", "transfer_id"),
      branchId: str(r.branch_id),
      fromUserId: str(r.from_user_id),
      toUserId: str(r.to_user_id),
      status: toStatus(r.status),
      createdAt: strOrNull(r.created_at),
      decidedAt: strOrNull(r.decided_at),
      reapprovedAt: strOrNull(r.reapproved_at),
      orderCount: num(r.order_count),
    };
  });
}

export async function getTransferDetail(transferId: string): Promise<TransferDetail> {
  const r = asRecord(await callPosRpc("pos_order_transfer_detail", { p_id: transferId }));
  const items: TransferItem[] = Array.isArray(r.items)
    ? r.items.map((x) => {
        const i = asRecord(x);
        return { orderId: str(i.order_id), orderNumber: strOrNull(i.order_number), orderType: strOrNull(i.order_type) };
      })
    : [];
  return {
    transferId: requireId(r.transfer_id, "pos_order_transfer_detail", "transfer_id"),
    branchId: str(r.branch_id),
    status: toStatus(r.status),
    fromUserId: str(r.from_user_id),
    fromShiftId: str(r.from_shift_id),
    toUserId: str(r.to_user_id),
    note: strOrNull(r.note),
    createdAt: strOrNull(r.created_at),
    createdBy: strOrNull(r.created_by),
    decidedBy: strOrNull(r.decided_by),
    decidedAt: strOrNull(r.decided_at),
    decidedShiftId: strOrNull(r.decided_shift_id),
    rejectionReason: strOrNull(r.rejection_reason),
    reapprovedBy: strOrNull(r.reapproved_by),
    reapprovedAt: strOrNull(r.reapproved_at),
    reapprovedShiftId: strOrNull(r.reapproved_shift_id),
    posEntityVersion: num(r.pos_entity_version),
    items,
  };
}

/** Sender creates a transfer of selected OPEN orders to another authorised user. */
export async function createTransfer(input: {
  toUserId: string;
  orderIds: string[];
  note?: string | null;
  /** Reuse the SAME token across retries of one user action for idempotency. */
  clientToken?: string;
}): Promise<TransferResult> {
  const payload: Record<string, unknown> = {
    create_client_token: input.clientToken ?? newToken(),
    to_user_id: input.toUserId,
    order_ids: input.orderIds,
  };
  if (input.note && input.note.trim()) payload.note = input.note.trim();
  const r = asRecord(await callPosRpc("pos_order_transfer_create", { p_payload: payload }));
  return {
    transferId: requireId(r.transfer_id, "pos_order_transfer_create", "transfer_id"),
    status: toStatus(r.status),
    idempotent: r.idempotent === true,
  };
}

/** Recipient approves (into their own open shift) or rejects a pending transfer. Two-step in the UI. */
export async function decideTransfer(input: {
  transferId: string;
  decision: "approve" | "reject";
  /** Required for approve: the recipient's own OPEN shift the orders move into. */
  targetShiftId?: string | null;
  note?: string | null;
  /** REQUIRED (mandatory CAS): the transfer's pos_entity_version from the last read. */
  expectedVersion: number;
}): Promise<TransferResult> {
  if (!Number.isInteger(input.expectedVersion)) throw new Error("A valid expected version is required to decide a transfer.");
  const payload: Record<string, unknown> = {
    transfer_id: input.transferId,
    decision: input.decision,
    expected_version: input.expectedVersion,
  };
  if (input.targetShiftId) payload.target_shift_id = input.targetShiftId;
  if (input.note && input.note.trim()) payload.note = input.note.trim();
  const r = asRecord(await callPosRpc("pos_order_transfer_decide", { p_payload: payload }));
  return {
    transferId: requireId(r.transfer_id, "pos_order_transfer_decide", "transfer_id"),
    status: toStatus(r.status),
    idempotent: r.idempotent === true,
  };
}

/** Website authorised user re-approves a REJECTED transfer into the recipient's open shift (W6).
 *  `targetShiftId` is OPTIONAL: when omitted (or null/blank) the server resolves the recipient's single
 *  open shift itself (and refuses if they have zero or more than one). Only pass an explicit shift id to
 *  pin a specific target; never send an empty string (the server validates it as a uuid). */
export async function reapproveTransfer(input: {
  transferId: string;
  targetShiftId?: string | null;
  note?: string | null;
  /** REQUIRED (mandatory CAS): the transfer's pos_entity_version from the last read. */
  expectedVersion: number;
  clientToken?: string;
}): Promise<TransferResult> {
  const r = asRecord(await callPosRpc("pos_order_transfer_reapprove", { p_payload: buildReapprovePayload(input) }));
  return {
    transferId: requireId(r.transfer_id, "pos_order_transfer_reapprove", "transfer_id"),
    status: toStatus(r.status),
    idempotent: r.idempotent === true,
  };
}

/** Pure builder for the RE-APPROVE payload. Sends `target_shift_id` ONLY when a concrete shift is chosen;
 *  when omitted/blank it is absent so the server auto-resolves the recipient's single open shift. Never
 *  emits an empty-string shift id (the server validates it as a uuid). */
export function buildReapprovePayload(input: { transferId: string; targetShiftId?: string | null; note?: string | null; expectedVersion: number; clientToken?: string }): Record<string, unknown> {
  if (!Number.isInteger(input.expectedVersion)) throw new Error("A valid expected version is required to re-approve a transfer.");
  const payload: Record<string, unknown> = {
    transfer_id: input.transferId,
    reapprove_client_token: input.clientToken ?? newToken(),
    expected_version: input.expectedVersion,
  };
  if (input.targetShiftId && input.targetShiftId.trim()) payload.target_shift_id = input.targetShiftId.trim();
  if (input.note && input.note.trim()) payload.note = input.note.trim();
  return payload;
}

// --- Desktop 1.0.35 Transfer Center (B1) -------------------------------------
//
// Force Transfer and Sender Cancel. As everywhere else in this file, the desktop
// performs NO authority logic: default-deny permissions, the branch's Force-Transfer
// setting, fully-unpaid-only eligibility, single-open-shift resolution, exactly-once
// replay (actor + branch + payload-fingerprint bound) and ownership-only reassignment
// are ALL enforced by the SECURITY DEFINER RPCs. Force and Standard are separate RPCs;
// Force never substitutes for Standard's recipient acceptance.

/** A uuid for `client_op_id` (the force/cancel idempotency key — must be a real uuid, unlike
 *  the free-form create_client_token). Prefers crypto.randomUUID; falls back to a v4 shape. */
export function newOpId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Exactly-once key lifecycle: keep the SAME id while the intent fingerprint is unchanged (a retry of the
 *  identical action, so a lost response replays), and rotate to a fresh id the moment the fingerprint
 *  changes (a genuinely different action, so it never collides with the server's payload-fingerprint
 *  binding or CAS). Used for the Send payload fingerprint and for each (transfer, action) cancel/reapprove
 *  intent. Pure + deterministic given `prev`, so the id-rotation rule is unit-testable. */
export function nextOpId(prev: { id: string; fp: string } | null, fp: string): { id: string; fp: string } {
  return prev && prev.fp === fp ? prev : { id: newOpId(), fp };
}

/** Keep only the still-available ids from a prior selection — NEVER auto-adds. Used when a Send refresh
 *  follows a failed/uncertain submit, so a reload cannot silently expand the operator's chosen subset. */
export function keepAvailable(prev: Iterable<string>, available: Iterable<string>): Set<string> {
  const avail = new Set(available);
  return new Set([...prev].filter((id) => avail.has(id)));
}

/** Pure builder for the FORCE payload (extracted so the exactly-once + shape contract is testable). */
export function buildForcePayload(input: { toUserId: string; orderIds: string[]; note?: string | null; clientOpId?: string }): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    client_op_id: input.clientOpId ?? newOpId(),
    to_user_id: input.toUserId,
    order_ids: input.orderIds,
  };
  if (input.note && input.note.trim()) payload.note = input.note.trim();
  return payload;
}

/** Pure builder for the CANCEL payload (client_op_id + mandatory expected_version CAS). */
export function buildCancelPayload(input: { transferId: string; note?: string | null; expectedVersion: number; clientOpId?: string }): Record<string, unknown> {
  if (!Number.isInteger(input.expectedVersion)) throw new Error("A valid expected version is required to cancel a transfer.");
  const payload: Record<string, unknown> = {
    client_op_id: input.clientOpId ?? newOpId(),
    transfer_id: input.transferId,
    expected_version: input.expectedVersion,
  };
  if (input.note && input.note.trim()) payload.note = input.note.trim();
  return payload;
}

export type ForceTransferResult = TransferResult & { transferMode: "force" };

/** FORCE a transfer: immediately reassign the selected FULLY-UNPAID open orders to the recipient's
 *  single open shift, with NO recipient acceptance. Requires `pos.orders.force_transfer` +
 *  `pos.transfers.select_recipient` AND the branch's Force-Transfer setting ON (all server-enforced).
 *  Reuse the SAME `clientOpId` across retries of one action for exactly-once semantics. */
export async function forceTransfer(input: {
  toUserId: string;
  orderIds: string[];
  note?: string | null;
  clientOpId?: string;
}): Promise<ForceTransferResult> {
  const r = asRecord(await callPosRpc("pos_order_transfer_force", { p_payload: buildForcePayload(input) }));
  return {
    transferId: requireId(r.transfer_id, "pos_order_transfer_force", "transfer_id"),
    status: toStatus(r.status),
    idempotent: r.idempotent === true,
    transferMode: "force",
  };
}

/** SENDER (or a holder of `pos.transfers.cancel_others`) cancels a PENDING transfer. The orders'
 *  ownership is unchanged; only the pending transfer is withdrawn and its claim released.
 *  `expectedVersion` is a mandatory CAS (the transfer's pos_entity_version from the last read). */
export async function cancelTransfer(input: {
  transferId: string;
  note?: string | null;
  expectedVersion: number;
  clientOpId?: string;
}): Promise<TransferResult> {
  const r = asRecord(await callPosRpc("pos_order_transfer_cancel", { p_payload: buildCancelPayload(input) }));
  return {
    transferId: requireId(r.transfer_id, "pos_order_transfer_cancel", "transfer_id"),
    status: toStatus(r.status),
    idempotent: r.idempotent === true,
  };
}

/** Whether Force Transfer is enabled for a branch. Server returns false for a branch the caller
 *  cannot access (no cross-OU probe), so this doubles as an access-aware capability check. */
export async function isForceTransferEnabled(branchId: string): Promise<boolean> {
  const r = await callPosRpc("pos_transfer_force_enabled", { p_branch: branchId });
  return r === true;
}

export type ForceSettingResult = { branchId: string; enabled: boolean; configVersion: number };

/** Pure builder for the Force-setting write payload. `expected_config_version` is included ONLY when a
 *  real integer is supplied (optional optimistic concurrency); never sent as null/NaN. */
export function buildForceSettingPayload(input: { branchId: string; enabled: boolean; expectedConfigVersion?: number }): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    branch_id: input.branchId,
    force_transfer_enabled: input.enabled,
  };
  if (Number.isInteger(input.expectedConfigVersion)) payload.expected_config_version = input.expectedConfigVersion;
  return payload;
}

/** B3 — set the OU-scoped Force-Transfer setting for a branch. Requires `pos.transfers.manage_force_setting`
 *  (server-enforced); the setting is per-branch (PK tenant+branch) with NO inheritance. `expectedConfigVersion`
 *  is an OPTIONAL optimistic-concurrency check — when provided and stale, the server refuses with
 *  VERSION_CONFLICT; omit it to simply set (the server still audits every change). */
export async function setForceTransferEnabled(input: {
  branchId: string;
  enabled: boolean;
  expectedConfigVersion?: number;
}): Promise<ForceSettingResult> {
  const r = asRecord(await callPosRpc("pos_transfer_settings_set", { p_payload: buildForceSettingPayload(input) }));
  return {
    branchId: str(r.branch_id),
    enabled: r.force_transfer_enabled === true,
    configVersion: num(r.config_version),
  };
}
