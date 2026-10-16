// Phase E — offline CUSTOMER (+ address) create/edit capture.
//
// Turns an operator "Save customer" into a durable Phase-B `customer_upsert` operation while
// offline, through the single operation log. Create MINTS a local customer id (and, when an address
// is captured, a local address id); both are resolved to their canonical server ids on reconnect
// (the customer via the orchestrator's entity map, the address by the handler), so a later offline
// delivery / on-account can chain to them via customer_local / address_local — the remap plumbing
// that already exists on the on-account handlers. An EDIT targets a locally-hydrated canonical
// customer and creates no local entity. The server (pos_upsert_customer, replay-safe on
// client_op_id) stays authoritative: a same-OU identity clash replays as a CONFLICT →
// needs_attention, never a silent duplicate or silent re-link. This module holds NO authority — it
// only CAPTURES; the canonical customer is the source of truth after sync.

import {
  cachePendingLocalCustomer,
  type CachedCustomer,
} from "@/lib/offline/db";
import {
  type OfflineOperation,
  type OperationScope,
  OPERATION_SCHEMA_VERSION,
  addOperation,
  getOperation,
} from "@/lib/offline/operationLog";
import { deterministicUuid } from "@/lib/offline/dineinOffline";

/** The immutable 5-dimensional scope an offline customer upsert is captured + replayed under. */
export type CustomerOpScope = {
  tenantId: string;
  branchId: string | null; // OU
  cashierUserId: string;
  deviceId: string;
  terminalId: string | null;
};

function opScope(s: CustomerOpScope): OperationScope {
  return { tenant_id: s.tenantId, branch_id: s.branchId, device_id: s.deviceId, terminal_id: s.terminalId ?? "", cashier_user_id: s.cashierUserId };
}

const CUSTOMER_OP_PREFIX = "customer:";

export type CaptureCustomerResult = {
  operationId: string;
  clientOpId: string;
  /** For a CREATE, the local customer id the UI should use until sync (also the entityMap key). */
  localCustomerId: string | null;
  /** For a CREATE WITH ADDRESS, the local address id. */
  localAddressId: string | null;
  alreadyCaptured: boolean;
};

/** Stable local ids per attempt: a double-tap / restart reuses the SAME client_op_id → the SAME op
 *  id and the SAME local ids, so nothing is duplicated. */
function localCustomerIdFor(clientOpId: string): string {
  return deterministicUuid([clientOpId, "customer"]);
}
function localAddressIdFor(clientOpId: string): string {
  return deterministicUuid([clientOpId, "address"]);
}

/**
 * Durably CAPTURE an offline customer create/edit BEFORE the UI reports success. Atomic; idempotent
 * on a deterministic op id. A CREATE (no `upsert.id`) also caches a pending-local customer so the
 * picker can select it offline straight away; an EDIT carries the canonical id.
 *
 * `upsert` is the exact pos_upsert_customer payload (branch_id + optional id/phone/name/notes/
 * address), WITHOUT client_op_id — the handler adds the op's client_op_id at replay.
 */
export async function captureCustomerUpsertOffline(input: {
  scope: CustomerOpScope;
  upsert: Record<string, unknown>;
  clientOpId: string;
  /** A compact display identity for the pending-local picker row (create only). */
  display?: { name: string | null; phone: string | null; phone_e164: string | null };
}): Promise<CaptureCustomerResult> {
  const { scope, upsert } = input;
  const clientOpId = input.clientOpId;
  const operationId = CUSTOMER_OP_PREFIX + clientOpId;

  const isEdit = typeof upsert.id === "string" && upsert.id.length > 0;
  const hasAddress = upsert.address != null && typeof upsert.address === "object";
  const localCustomerId = isEdit ? null : localCustomerIdFor(clientOpId);
  const localAddressId = !isEdit && hasAddress ? localAddressIdFor(clientOpId) : null;

  const existing = await getOperation(operationId);
  if (existing) {
    return { operationId, clientOpId, localCustomerId, localAddressId, alreadyCaptured: true };
  }

  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: "customer_upsert",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: localCustomerId, // CREATE → the local customer id; EDIT → null
    canonical_entity_id: isEdit ? (upsert.id as string) : null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: { upsert, local_address_id: localAddressId },
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };

  try {
    await addOperation(op);
  } catch (e) {
    const now = await getOperation(operationId);
    if (now) return { operationId, clientOpId, localCustomerId, localAddressId, alreadyCaptured: true };
    throw e;
  }

  // CREATE: cache a pending-local customer so the picker can select it offline immediately.
  if (localCustomerId) {
    const addresses = hasAddress ? [{ ...(upsert.address as Record<string, unknown>), id: localAddressId }] : null;
    const cached: CachedCustomer = {
      id: localCustomerId,
      tenant_id: scope.tenantId,
      branch_id: scope.branchId,
      name: input.display?.name ?? (typeof upsert.name === "string" ? upsert.name : null),
      phone: input.display?.phone ?? (typeof upsert.phone === "string" ? upsert.phone : null),
      phone_e164: input.display?.phone_e164 ?? null,
      addresses,
      notes: typeof upsert.notes === "string" ? upsert.notes : null,
      has_profile: true, // we hold the locally-entered details
      cached_at: new Date().toISOString(),
      pending_local: true,
      local_address_id: localAddressId,
    };
    await cachePendingLocalCustomer(cached).catch(() => undefined);
  }

  return { operationId, clientOpId, localCustomerId, localAddressId, alreadyCaptured: false };
}

/** Pure readiness for the offline customer-write gate — mirrors the online customerWriteGate's
 *  permission rule but ALLOWS an offline capture when the POS is offline-ready + scope is present
 *  (the online gate blocks offline entirely). The permission snapshot still governs. */
export function evaluateCustomerWriteOfflineReady(input: {
  online: boolean;
  offlineReady: boolean;
  hasScope: boolean;
  canManageCustomers: boolean;
  canCreateOrders: boolean;
}): { allowed: boolean; reason: string | null } {
  if (!input.canManageCustomers && !input.canCreateOrders) {
    return { allowed: false, reason: "You do not have permission to add or edit customers." };
  }
  if (input.online) return { allowed: true, reason: null }; // online path unchanged
  if (!input.offlineReady || !input.hasScope) return { allowed: false, reason: "Saving a customer needs the POS to be ready offline." };
  return { allowed: true, reason: null };
}

/** The customer_upsert op this client_op_id would capture, if already present. */
export async function findCustomerUpsertOp(clientOpId: string): Promise<OfflineOperation | undefined> {
  return getOperation(CUSTOMER_OP_PREFIX + clientOpId);
}
