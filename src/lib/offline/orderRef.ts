// 1.0.38 (Bug 4) — the ONE order reference for every offline Delivery capture (pay / provider /
// delivery-ops / note / on-account), plus the per-intent op-id minting and the capture-time
// dependency filter those captures share.
//
// D4: "is this order local?" was decided per call site by `txn.status !== "synced"`. Once the legacy
// row reconciled (or the entity map resolved first) the sites sent the LOCAL uuid as a canonical order
// id → the server refused it (needs_attention, with the cash already taken). Here it is decided from
// the entity map first (local id → canonical id when mapped), then from the local order itself; an
// unsynced local order travels as order_local WITH an op dependency on its create op (mig:txn:<id>),
// so a parked create escalates the dependent instead of blocking it forever.
//
// Read-only except `orderOnAccountWithDependencies`, which adds dependency ids to the op it captures
// in the SAME Dexie transaction. Holds no authority — the server RPC is the source of truth on replay.

import { localdb } from "@/lib/offline/db";
import type { OfflineOperation } from "@/lib/offline/operationLog";
import { deterministicUuid } from "@/lib/offline/dineinOffline";
import { orderOnAccountOffline, takeawaySaleOpId } from "@/lib/offline/orderOnAccountOffline";

export type OrderRefScope = { tenantId: string; branchId: string | null };

export type OrderRef = {
  /** The canonical order id (hydrated order, or a local order already mapped); null while local. */
  orderId: string | null;
  /** The local order id the replay remaps (order_local); null once canonical is known. */
  orderLocal: string | null;
  /** Op dependencies the capture must carry: the order-create op while the order is local. */
  dependencyIds: string[];
};

/**
 * Resolve how an offline capture must reference `id`:
 *   1. an entity-map mapping in this tenant/OU → its canonical id (no dependency);
 *   2. a local offline order (posOfflineTxns row or its mig:txn create op) → canonical when it already
 *      synced, else order_local + dependency on the create op;
 *   3. otherwise `id` is a canonical (hydrated) order id.
 * A mapping or local order of ANOTHER tenant/OU is refused (fail-closed), never referenced.
 */
export async function orderRefFor(id: string, scope: OrderRefScope): Promise<OrderRef> {
  const sameOu = (tenantId: string, branchId: string | null | undefined) =>
    tenantId === scope.tenantId && (branchId ?? null) === (scope.branchId ?? null);
  const foreign = () => new Error("This order belongs to another location on this device. Reconnect to settle it.");
  const canonical = (orderId: string): OrderRef => ({ orderId, orderLocal: null, dependencyIds: [] });

  const mapped = await localdb.entityMap.get(id).catch(() => undefined);
  if (mapped) {
    if (!sameOu(mapped.tenant_id, mapped.branch_id)) throw foreign();
    return canonical(mapped.canonical_id);
  }
  const [txn, createOp] = await Promise.all([
    localdb.posOfflineTxns.get(id).catch(() => undefined),
    localdb.operations.get(takeawaySaleOpId(id)).catch(() => undefined),
  ]);
  if (!txn && !createOp) return canonical(id);
  if (txn && !sameOu(txn.tenant_id, txn.branch_id)) throw foreign();
  if (createOp && !sameOu(createOp.scope.tenant_id, createOp.scope.branch_id)) throw foreign();
  if (txn?.server_order_id) return canonical(txn.server_order_id);
  if (createOp?.status === "synced" && createOp.canonical_entity_id) return canonical(createOp.canonical_entity_id);
  return { orderId: null, orderLocal: id, dependencyIds: [takeawaySaleOpId(id)] };
}

/**
 * 1.0.38 (D4, item edits) — re-point a projection-derived edit target at the ONE order reference. The
 * projection decides local-vs-canonical from the legacy row (`txn.status`), which lags the entity map: a
 * synced order whose row has not reconciled (or a local row shown after its txn synced) would otherwise be
 * captured with the LOCAL uuid as a canonical order id (refused at replay), or as a local order with no op
 * dependency on its create op (blocked forever if that create parks). The line target, version chain and
 * the target's own dependencies are kept; the create-op dependency is added while the order is local.
 */
export function editTargetWithOrderRef<T extends { orderId: string | null; orderLocal: string | null; payloadOrderId: string; dependencyIds: string[] }>(target: T, ref: OrderRef): T {
  return {
    ...target,
    orderId: ref.orderId,
    orderLocal: ref.orderId ? null : ref.orderLocal,
    payloadOrderId: ref.orderId ?? ref.orderLocal ?? target.payloadOrderId,
    dependencyIds: Array.from(new Set([...target.dependencyIds, ...ref.dependencyIds])),
  };
}

/** Statuses a NEW capture must never depend on: a parked/withdrawn op can never satisfy it (C3), and a
 *  synced op already has (and may be GC'd later, which would park the dependent as missing). */
const NOT_A_CAPTURE_DEPENDENCY: OfflineOperation["status"][] = ["needs_attention", "cancelled", "synced"];

/** C3 — keep only the given op ids that are still live, unsettled work (pending / blocked / retrying /
 *  syncing). Unknown ids are dropped. Order preserved, de-duplicated. */
export async function liveCaptureDependencies(ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of Array.from(new Set(ids))) {
    const op = await localdb.operations.get(id).catch(() => undefined);
    if (op && !NOT_A_CAPTURE_DEPENDENCY.includes(op.status)) out.push(id);
  }
  return out;
}

/**
 * D3 — per-INTENT client_op_ids for dialog actions (provider / delivery ops / note / address / customer
 * edit). One random nonce per (action, target) is minted on the first submit and reused by every retry
 * of THAT submit (same values → same id → exactly-once); `done(key)` after a successful capture ends
 * the intent, so the next submit — even of an earlier value (P1 → P2 → P1) — is a NEW op that replays
 * in order, instead of colliding with the first capture's id.
 */
export function createIntentIds(mint: () => string = () => crypto.randomUUID()) {
  const nonces = new Map<string, string>();
  return {
    clientOpId(key: string, parts: ReadonlyArray<string | number | boolean | null | undefined>): string {
      let nonce = nonces.get(key);
      if (!nonce) {
        nonce = mint();
        nonces.set(key, nonce);
      }
      return deterministicUuid([nonce, key, ...parts.map((p) => (p == null ? "~" : String(p)))]);
    },
    done(key: string): void {
      nonces.delete(key);
    },
  };
}

export type IntentIds = ReturnType<typeof createIntentIds>;

/**
 * D7(b) — capture an order on-account receivable that ALSO waits for the order's earlier unsynced
 * mutations (item edits / provider / ops / note), so it never replays against a pre-edit total. Reuses
 * the one on-account capture (orderOnAccountOffline) and adds the dependency ids to the op it just
 * created inside the SAME transaction (atomic: no drain can observe the op without them). An already
 * captured op is never rewritten.
 */
export async function orderOnAccountWithDependencies(
  input: Parameters<typeof orderOnAccountOffline>[0],
  extraDependencyIds: readonly string[],
): Promise<Awaited<ReturnType<typeof orderOnAccountOffline>>> {
  return localdb.transaction("rw", localdb.operations, async () => {
    const r = await orderOnAccountOffline(input);
    if (!r.alreadyCaptured && extraDependencyIds.length > 0) {
      const op = await localdb.operations.get(r.operationId);
      if (op) {
        await localdb.operations.update(r.operationId, {
          dependency_ids: Array.from(new Set([...op.dependency_ids, ...extraDependencyIds])),
        });
      }
    }
    return r;
  });
}
