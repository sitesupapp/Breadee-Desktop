// rc.11 — THE unified Delivery customer projection (who + where for one order).
//
// rc.10 printed the customer name / phone / address on the receipt (it reads the selected customer) but
// the Orders LIST and DETAIL showed "Customer / No address on file" for an offline order: they read
// only the SERVER (pos_customers / pos_customer_addresses), which offline fails soft to an empty map —
// and which never knows an offline-created customer. Every Delivery surface (List, Detail, Receipt,
// Edit) now resolves the party from the SAME ordered sources, field by field:
//
//   1. the canonical customer / address (server read, when it answered)
//   2. the local customer cache under the order's own ids (pending-local customer / address included)
//   3. the remap alias (entity map: local ↔ canonical — an order synced under its canonical customer
//      whose profile is only cached under the local id, or vice versa)
//   4. the captured order snapshot (posOfflineTxns.party_snapshot, written at offline capture)
//
// READ ONLY: no store, no write, no authority. A field is taken from the first source that has it.

import { localdb, type CachedCustomer, type PosOfflineTxn } from "@/lib/offline/db";
import { addressText, type OrderParty } from "@/lib/pos/deliveryHistory";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

type PartyPart = Partial<OrderParty> | null | undefined;

function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** PURE — field-wise first non-empty across the ordered sources. */
export function pickParty(sources: PartyPart[]): OrderParty {
  const out: OrderParty = { customerName: null, customerPhone: null, addressText: null };
  for (const s of sources) {
    if (!s) continue;
    out.customerName ??= nonEmpty(s.customerName);
    out.customerPhone ??= nonEmpty(s.customerPhone);
    out.addressText ??= nonEmpty(s.addressText);
  }
  return out;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** PURE — a cached customer profile as a party for one (possibly aliased) address id. */
export function partyFromCachedCustomer(c: CachedCustomer | null | undefined, addressIds: string[]): PartyPart {
  if (!c) return null;
  const addrs = Array.isArray(c.addresses) ? (c.addresses as unknown[]).map(rec) : [];
  const a = addrs.find((x) => typeof x.id === "string" && addressIds.includes(x.id as string)) ?? null;
  return {
    customerName: c.name,
    customerPhone: c.phone,
    addressText: a
      ? addressText({ address_label: str(a.address_label), area: str(a.area), street: str(a.street), building: str(a.building), floor: str(a.floor) })
      : null,
  };
}

/** PURE — the order-time snapshot of a local txn. */
export function partyFromSnapshot(txn: PosOfflineTxn | null | undefined): PartyPart {
  const s = txn?.party_snapshot;
  if (!s) return null;
  return { customerName: s.customer_name, customerPhone: s.customer_phone, addressText: s.address_text };
}

/**
 * Resolve the party of every order through the unified ordered sources. `server` is the canonical read
 * (may be empty offline). Never throws — a failed local read just leaves that source out.
 */
export async function resolveOrderParties(
  rows: DeliveryQueueOrder[],
  server: Map<string, OrderParty>,
  scope: { tenantId: string | null; branchId: string | null },
): Promise<Map<string, OrderParty>> {
  const out = new Map<string, OrderParty>();
  if (rows.length === 0) return out;
  const [maps, txns] = await Promise.all([
    localdb.entityMap.toArray().catch(() => []),
    localdb.posOfflineTxns.toArray().catch(() => [] as PosOfflineTxn[]),
  ]);
  const toCanonical = new Map<string, string>();
  const toLocal = new Map<string, string[]>();
  for (const m of maps) {
    toCanonical.set(m.local_entity_id, m.canonical_id);
    toLocal.set(m.canonical_id, [...(toLocal.get(m.canonical_id) ?? []), m.local_entity_id]);
  }
  const aliasesOf = (id: string | null): string[] => {
    if (!id) return [];
    const c = toCanonical.get(id);
    return [...(c ? [c] : []), ...(toLocal.get(id) ?? [])];
  };
  const txnFor = (row: DeliveryQueueOrder): PosOfflineTxn | undefined =>
    txns.find((t) => t.local_txn_id === row.id || (t.server_order_id != null && t.server_order_id === row.id)) ??
    txns.find((t) => aliasesOf(row.id).includes(t.local_txn_id));

  const custCache = new Map<string, CachedCustomer | undefined>();
  const cached = async (id: string | null): Promise<CachedCustomer | undefined> => {
    if (!id) return undefined;
    if (!custCache.has(id)) {
      const c = await localdb.posCustomers.get(id).catch(() => undefined);
      // OU wall: a profile cached under another tenant / branch never serves this order.
      custCache.set(id, c && c.tenant_id === scope.tenantId && (c.branch_id ?? null) === (scope.branchId ?? null) ? c : undefined);
    }
    return custCache.get(id);
  };

  for (const row of rows) {
    const txn = txnFor(row);
    const payload = rec(txn?.order_payload);
    const customerId = row.customer_id ?? str(payload.customer_id) ?? txn?.customer_local ?? null;
    const addressId = row.address_id ?? str(payload.address_id) ?? txn?.address_local ?? null;
    const addrIds = addressId ? [addressId, ...aliasesOf(addressId)] : [];
    const own = partyFromCachedCustomer(await cached(customerId), addrIds);
    const aliasSources: PartyPart[] = [];
    for (const alt of aliasesOf(customerId)) aliasSources.push(partyFromCachedCustomer(await cached(alt), addrIds));
    out.set(row.id, pickParty([server.get(row.id), own, ...aliasSources, partyFromSnapshot(txn)]));
  }
  return out;
}
