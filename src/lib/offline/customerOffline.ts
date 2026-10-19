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
  cacheCustomers,
  cachePendingLocalCustomer,
  getCachedCustomer,
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
import { normalizeCustomerRef } from "@/lib/offline/operationLog";
import { normalizePhoneE164 } from "@/lib/pos/phone";

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
  const addressRec =
    upsert.address != null && typeof upsert.address === "object" ? (upsert.address as Record<string, unknown>) : null;
  // A NEW address (no server id) captured offline needs a LOCAL address id so a dependent delivery
  // order can chain to address_local and the handler can remap it on replay (it resolves
  // p.local_address_id for BOTH a create and an edit). An EXISTING address being edited keeps its id.
  const isNewAddress = addressRec != null && !(typeof addressRec.id === "string" && (addressRec.id as string).length > 0);
  const localCustomerId = isEdit ? null : localCustomerIdFor(clientOpId);
  const localAddressId = isNewAddress ? localAddressIdFor(clientOpId) : null;

  const existing = await getOperation(operationId);
  if (existing) {
    return { operationId, clientOpId, localCustomerId, localAddressId, alreadyCaptured: true };
  }

  // rc.11 — an EDIT (e.g. a new address) of a customer that was itself CREATED offline targets the
  // customer's LOCAL id. rc.10 sent that local id as upsert.id → the server raised "Customer not found
  // for this operating unit" (42501 → 403) and every delivery order on that address stayed blocked. The
  // edit now WAITS for the create (dependency) and the handler remaps upsert.id → canonical at replay.
  const editTargetLocal = isEdit ? (await normalizeCustomerRef(upsert.id as string, null)).customerLocal : null;

  const op: OfflineOperation = {
    operation_id: operationId,
    operation_type: "customer_upsert",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: opScope(scope),
    created_at: new Date().toISOString(),
    client_op_id: clientOpId,
    local_entity_id: localCustomerId, // CREATE → the local customer id; EDIT → null
    canonical_entity_id: isEdit && !editTargetLocal ? (upsert.id as string) : null,
    dependency_ids: [],
    depends_on_local_entities: editTargetLocal ? [editTargetLocal] : [],
    payload: { upsert, local_address_id: localAddressId, ...(editTargetLocal ? { customer_local: editTargetLocal } : {}) },
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
    const addresses = addressRec ? [{ ...addressRec, id: localAddressId }] : null;
    const cached: CachedCustomer = {
      id: localCustomerId,
      tenant_id: scope.tenantId,
      branch_id: scope.branchId,
      name: input.display?.name ?? (typeof upsert.name === "string" ? upsert.name : null),
      phone: input.display?.phone ?? (typeof upsert.phone === "string" ? upsert.phone : null),
      // rc.12 — the SAME normalisation the server stores (lib/pos/phone = port of _phone_normalize_e164),
      // so the offline customer is found by the indexed phone lookup ("78900000" == "+96178900000").
      phone_e164:
        input.display?.phone_e164 ??
        normalizePhoneE164(input.display?.phone ?? (typeof upsert.phone === "string" ? upsert.phone : null)),
      addresses,
      notes: typeof upsert.notes === "string" ? upsert.notes : null,
      has_profile: true, // we hold the locally-entered details
      cached_at: new Date().toISOString(),
      pending_local: true,
      local_address_id: localAddressId,
    };
    await cachePendingLocalCustomer(cached).catch(() => undefined);
  } else if (isEdit && localAddressId) {
    // Adding a NEW address OFFLINE to a locally-created (pending-local) customer: append the local
    // address to its cached profile so the picker can select it and a dependent order can chain to
    // address_local. ONLY for a pending-local customer — a canonical customer must never be re-marked
    // pending-local (cachePendingLocalCustomer forces that flag); its address replays with the op and
    // appears after sync. Nothing else about the customer changes.
    const existing = await getCachedCustomer(upsert.id as string, scope.tenantId, scope.branchId).catch(() => undefined);
    if (existing?.pending_local && addressRec) {
      const prior = Array.isArray(existing.addresses) ? (existing.addresses as unknown[]) : [];
      await cachePendingLocalCustomer({
        ...existing,
        addresses: [...prior, { ...addressRec, id: localAddressId }],
        has_profile: true,
        cached_at: new Date().toISOString(),
      }).catch(() => undefined);
    } else if (existing && addressRec) {
      // rc.10 — a NEW address on a CANONICAL customer offline: append it (marked pending_local on the
      // ADDRESS only; the customer stays canonical) so it is selectable for an offline delivery order.
      // The order carries it as address_local and the replay remaps it once this upsert syncs.
      const prior = Array.isArray(existing.addresses) ? (existing.addresses as unknown[]) : [];
      await cacheCustomers([
        { ...existing, addresses: [...prior, { ...addressRec, id: localAddressId, pending_local: true }], cached_at: new Date().toISOString() },
      ]).catch(() => undefined);
    }
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
