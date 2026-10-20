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
//   4. rc.13 — the DURABLE order↔customer association (snapshots `delivery_party:<orderId>`, written at
//      send — offline AND online — and whenever a party resolves), looked up under the order's own id and
//      its remap aliases, so a refresh whose server/cache reads fail can never blank a known customer
//   5. the captured order snapshot (posOfflineTxns.party_snapshot, written at offline capture)
//
// rc.12 native: the receipt (in-memory selected customer) kept the identity while List / Detail lost it
// after Add Items → Orders, because the party map was RECOMPUTED on every refresh and a failed read
// replaced it with blanks. resolveOrderParties stays READ ONLY (no authority — display data); the
// association is written only by rememberOrderParty / persistResolvedParties. A field is taken from the
// first source that has it.

import { localdb, type CachedCustomer, type PosOfflineTxn, type Snapshot } from "@/lib/offline/db";
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

  // rc.13 — the durable associations for every row id and alias, in ONE bulk read (no per-row lookup).
  const assocKeys = new Set<string>();
  for (const row of rows) {
    assocKeys.add(orderPartyKey(row.id));
    for (const a of aliasesOf(row.id)) assocKeys.add(orderPartyKey(a));
    const t = txnFor(row);
    if (t) assocKeys.add(orderPartyKey(t.local_txn_id));
    if (t?.server_order_id) assocKeys.add(orderPartyKey(t.server_order_id));
  }
  const keyList = [...assocKeys];
  const assocRows = await localdb.snapshots.bulkGet(keyList).catch(() => [] as (Snapshot | undefined)[]);
  const assoc = new Map<string, OrderPartyAssociation>();
  keyList.forEach((k, i) => {
    const s = assocRows[i];
    // OU wall — an association recorded under another tenant / branch never serves this order.
    if (s && s.tenant_id === scope.tenantId && (s.branch_id ?? null) === (scope.branchId ?? null)) assoc.set(k, s.data as OrderPartyAssociation);
  });
  const assocFor = (row: DeliveryQueueOrder, txn: PosOfflineTxn | undefined): PartyPart[] =>
    [row.id, ...aliasesOf(row.id), txn?.local_txn_id ?? null, txn?.server_order_id ?? null]
      .filter((id): id is string => !!id)
      .map((id) => assoc.get(orderPartyKey(id)));

  const plan = rows.map((row) => {
    const txn = txnFor(row);
    const payload = rec(txn?.order_payload);
    const customerId = row.customer_id ?? str(payload.customer_id) ?? txn?.customer_local ?? null;
    const addressId = row.address_id ?? str(payload.address_id) ?? txn?.address_local ?? null;
    return { row, txn, customerId, addrIds: addressId ? [addressId, ...aliasesOf(addressId)] : [] };
  });
  // rc.13 — every cached customer the queue needs in ONE bulk read (was one awaited get per row + alias).
  const custIds = [...new Set(plan.flatMap((p) => (p.customerId ? [p.customerId, ...aliasesOf(p.customerId)] : [])))];
  const custRows = await localdb.posCustomers.bulkGet(custIds).catch(() => [] as (CachedCustomer | undefined)[]);
  const custCache = new Map<string, CachedCustomer>();
  custIds.forEach((id, i) => {
    const c = custRows[i];
    // OU wall: a profile cached under another tenant / branch never serves this order.
    if (c && c.tenant_id === scope.tenantId && (c.branch_id ?? null) === (scope.branchId ?? null)) custCache.set(id, c);
  });
  const cached = (id: string | null): CachedCustomer | undefined => (id ? custCache.get(id) : undefined);

  for (const { row, txn, customerId, addrIds } of plan) {
    const own = partyFromCachedCustomer(cached(customerId), addrIds);
    const aliasSources: PartyPart[] = aliasesOf(customerId).map((alt) => partyFromCachedCustomer(cached(alt), addrIds));
    out.set(row.id, pickParty([server.get(row.id), own, ...aliasSources, ...assocFor(row, txn), partyFromSnapshot(txn)]));
  }
  return out;
}

/** rc.13 — the durable order↔customer association (display identity, never authority). */
export type OrderPartyAssociation = OrderParty & { customerId: string | null; addressId: string | null };

export const orderPartyKey = (orderId: string): string => `delivery_party:${orderId}`;

function hasParty(p: Partial<OrderParty> | null | undefined): boolean {
  return !!p && (nonEmpty(p.customerName) != null || nonEmpty(p.customerPhone) != null || nonEmpty(p.addressText) != null);
}

/**
 * rc.13 — record (or refresh) an order's customer association. Field-wise: the NEW non-empty value wins
 * (a customer / address changed on the order is followed), a blank never erases a known field. An empty
 * party writes nothing. Best-effort: never throws.
 */
export async function rememberOrderParty(
  scope: { tenantId: string | null; branchId: string | null },
  orderId: string,
  party: Partial<OrderPartyAssociation>,
): Promise<void> {
  if (!scope.tenantId || !orderId || !hasParty(party)) return;
  try {
    const key = orderPartyKey(orderId);
    const prev = await localdb.snapshots.get(key).catch(() => undefined);
    const old = prev && prev.tenant_id === scope.tenantId && (prev.branch_id ?? null) === (scope.branchId ?? null) ? (prev.data as OrderPartyAssociation) : null;
    const merged = pickParty([party, old]);
    const data: OrderPartyAssociation = {
      ...merged,
      customerId: party.customerId ?? old?.customerId ?? null,
      addressId: party.addressId ?? old?.addressId ?? null,
    };
    if (old && old.customerName === data.customerName && old.customerPhone === data.customerPhone && old.addressText === data.addressText && old.customerId === data.customerId && old.addressId === data.addressId) return;
    await localdb.snapshots.put({ key, tenant_id: scope.tenantId, branch_id: scope.branchId ?? null, data, cached_at: new Date().toISOString() });
  } catch {
    /* display data — a failed write only loses the durable fallback */
  }
}

/** rc.13 — write through every RESOLVED (non-empty) party of a refresh, so the next refresh — even one
 *  whose server and cache reads all fail — still shows it. Only rows whose party actually changed write. */
export async function persistResolvedParties(
  scope: { tenantId: string | null; branchId: string | null },
  rows: DeliveryQueueOrder[],
  who: Map<string, OrderParty>,
): Promise<void> {
  if (!scope.tenantId) return;
  const todo = rows.filter((r) => hasParty(who.get(r.id)));
  if (todo.length === 0) return;
  try {
    const keys = todo.map((r) => orderPartyKey(r.id));
    const prevRows = await localdb.snapshots.bulkGet(keys);
    const now = new Date().toISOString();
    const puts: Snapshot[] = [];
    todo.forEach((row, i) => {
      const prev = prevRows[i];
      const old = prev && prev.tenant_id === scope.tenantId && (prev.branch_id ?? null) === (scope.branchId ?? null) ? (prev.data as OrderPartyAssociation) : null;
      const merged = pickParty([who.get(row.id), old]);
      const data: OrderPartyAssociation = { ...merged, customerId: row.customer_id ?? old?.customerId ?? null, addressId: row.address_id ?? old?.addressId ?? null };
      if (old && old.customerName === data.customerName && old.customerPhone === data.customerPhone && old.addressText === data.addressText && old.customerId === data.customerId && old.addressId === data.addressId) return;
      puts.push({ key: keys[i], tenant_id: scope.tenantId as string, branch_id: scope.branchId ?? null, data, cached_at: now });
    });
    if (puts.length > 0) await localdb.snapshots.bulkPut(puts);
  } catch {
    /* display data — best-effort */
  }
  await pruneOrderParties();
}

/** Associations untouched for this long are dropped (the Delivery queue spans a shift / a day; an older
 *  order's identity is still available from the server, the cache, or its txn snapshot). */
export const ORDER_PARTY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
let prunedThisSession = false;

/** Bounded growth: once per session, drop stale associations (a primary-key prefix range — no full scan). */
export async function pruneOrderParties(now = Date.now(), force = false): Promise<number> {
  if (prunedThisSession && !force) return 0;
  prunedThisSession = true;
  try {
    const stale = await localdb.snapshots
      .where("key")
      .startsWith("delivery_party:")
      .filter((s) => !(Date.parse(s.cached_at) > now - ORDER_PARTY_RETENTION_MS))
      .primaryKeys();
    if (stale.length > 0) await localdb.snapshots.bulkDelete(stale);
    return stale.length;
  } catch {
    return 0;
  }
}

/** PURE — never replace a known party with a blank one on refresh (the new non-empty field wins). */
export function mergePartyMaps(prev: Map<string, OrderParty>, next: Map<string, OrderParty>): Map<string, OrderParty> {
  const out = new Map(next);
  for (const [id, p] of next) out.set(id, pickParty([p, prev.get(id)]));
  return out;
}
