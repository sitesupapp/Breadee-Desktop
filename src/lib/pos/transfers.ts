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
  fromShiftId: string;
  branchId: string;
  status: TransferStatus;
  createdAt: string | null;
  orderCount: number;
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
      fromShiftId: str(r.from_shift_id),
      branchId: str(r.branch_id),
      status: toStatus(r.status),
      createdAt: strOrNull(r.created_at),
      orderCount: num(r.order_count),
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
  expectedVersion?: number | null;
}): Promise<TransferResult> {
  const payload: Record<string, unknown> = { transfer_id: input.transferId, decision: input.decision };
  if (input.targetShiftId) payload.target_shift_id = input.targetShiftId;
  if (input.note && input.note.trim()) payload.note = input.note.trim();
  if (input.expectedVersion != null) payload.expected_version = input.expectedVersion;
  const r = asRecord(await callPosRpc("pos_order_transfer_decide", { p_payload: payload }));
  return {
    transferId: requireId(r.transfer_id, "pos_order_transfer_decide", "transfer_id"),
    status: toStatus(r.status),
    idempotent: r.idempotent === true,
  };
}

/** Website authorised user re-approves a REJECTED transfer into the recipient's open shift (W6). */
export async function reapproveTransfer(input: {
  transferId: string;
  targetShiftId: string;
  note?: string | null;
  expectedVersion?: number | null;
  clientToken?: string;
}): Promise<TransferResult> {
  const payload: Record<string, unknown> = {
    transfer_id: input.transferId,
    target_shift_id: input.targetShiftId,
    reapprove_client_token: input.clientToken ?? newToken(),
  };
  if (input.note && input.note.trim()) payload.note = input.note.trim();
  if (input.expectedVersion != null) payload.expected_version = input.expectedVersion;
  const r = asRecord(await callPosRpc("pos_order_transfer_reapprove", { p_payload: payload }));
  return {
    transferId: requireId(r.transfer_id, "pos_order_transfer_reapprove", "transfer_id"),
    status: toStatus(r.status),
    idempotent: r.idempotent === true,
  };
}
