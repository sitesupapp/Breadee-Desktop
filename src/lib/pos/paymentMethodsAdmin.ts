// Payment Methods MANAGEMENT data layer (POS Final W3 / Part 5).
//
// Distinct from the checkout catalog (lib/pos/split -> loadSplitPaymentMethods),
// which returns ACTIVE methods only and is untouched. This layer is for the POS
// Settings management screen: it lists ALL methods (including inactive) for an
// authorized manager, and creates/edits them through the canonical
// pos_payment_method_save RPC with its atomic optimistic-concurrency token.
//
// THE TOKEN IS OPAQUE. `updatedAt` is the server's timestamptz string; it is the
// concurrency token for the next update and must be round-tripped VERBATIM. It is
// never parsed into a JS Date (that truncates PostgreSQL microsecond precision and
// would cause false VERSION_CONFLICTs). An UPDATE must send the exact string it
// last read; the server rejects a stale one with a VERSION_CONFLICT the UI surfaces.

import { callPosRpc, asRecord, requireId, str, bool, num } from "@/lib/pos/rpc";

export type ManagedPaymentMethod = {
  id: string;
  key: string;
  label: string;
  isCash: boolean;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Opaque CAS token (timestamptz string). Round-trip verbatim; never Date-parse. */
  updatedAt: string;
};

function toManaged(raw: unknown, ctx: "pos_payment_methods_manage_list" | "pos_payment_method_save"): ManagedPaymentMethod {
  const r = asRecord(raw);
  return {
    id: requireId(r.id, ctx, "id"),
    key: str(r.key),
    label: str(r.label),
    isCash: bool(r.is_cash),
    isSystem: bool(r.is_system),
    isActive: bool(r.is_active),
    sortOrder: num(r.sort_order),
    updatedAt: str(r.updated_at),
  };
}

/** Every method for this tenant, INCLUDING inactive. Manager-gated server-side. */
export async function listManagedPaymentMethods(): Promise<ManagedPaymentMethod[]> {
  const rows = await callPosRpc("pos_payment_methods_manage_list", {});
  if (!Array.isArray(rows)) return [];
  return rows.map((raw) => toManaged(raw, "pos_payment_methods_manage_list"));
}

export type SavePaymentMethodInput = {
  /** Present => UPDATE (requires expectedUpdatedAt); absent => CREATE. */
  id?: string | null;
  label?: string;
  isActive?: boolean;
  sortOrder?: number;
  /** super-admin only; the server ignores it for non-super and for system rows. */
  isCash?: boolean;
  /** CREATE only; derived from the label when omitted. Reserved keys are rejected server-side. */
  key?: string;
  /** REQUIRED for an UPDATE: the opaque token from the last read. */
  expectedUpdatedAt?: string | null;
};

/**
 * Create or edit a payment method. On an UPDATE a stale/absent expectedUpdatedAt
 * is refused server-side (VERSION_CONFLICT => classifyError kind "version_conflict");
 * the caller must reload the list and ask the manager to reapply, never retry blindly.
 * The returned method carries the fresh `updatedAt` token for the next edit.
 */
export async function savePaymentMethod(input: SavePaymentMethodInput): Promise<ManagedPaymentMethod> {
  const payload: Record<string, unknown> = {};
  if (input.id) payload.id = input.id;
  if (input.label !== undefined) payload.label = input.label;
  if (input.isActive !== undefined) payload.is_active = input.isActive;
  if (input.sortOrder !== undefined) payload.sort_order = input.sortOrder;
  if (input.isCash !== undefined) payload.is_cash = input.isCash;
  if (input.key !== undefined) payload.key = input.key;
  if (input.expectedUpdatedAt != null) payload.expected_updated_at = input.expectedUpdatedAt;
  const row = await callPosRpc("pos_payment_method_save", { p_payload: payload });
  return toManaged(asRecord(row), "pos_payment_method_save");
}
