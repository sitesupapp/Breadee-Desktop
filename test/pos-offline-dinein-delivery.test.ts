// Production hotfix - offline Dine-In READ continuity + Delivery cached-customer
// offline SEARCH and offline UNPAID order creation.
//
// Exercises the REAL Dexie store via fake-indexeddb and the REAL replay engine;
// server calls are injected so the guarantees are proven without a network. The
// central safety claim - an offline DELIVERY order creates an UNPAID order via the
// idempotent pos_submit_order and NEVER touches the non-idempotent delivery
// settlement path - is asserted directly (pays === 0).

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  localdb,
  cacheTableMap,
  readCachedTableMap,
  cacheCustomers,
  listCachedCustomers,
  getCachedCustomer,
  purgeForeignCachedCustomers,
  clearCachedCustomers,
  addPosOfflineTxn,
  getPosOfflineTxnByOp,
  updatePosOfflineTxn,
  listResumablePosTxns,
  pendingPosTxnCount,
  type CachedCustomer,
  type PosOfflineTxn,
} from "@/lib/offline/db";
import {
  matchCachedCustomers,
  cacheCustomerMatches,
  cacheCustomerProfile,
  type CustomerScope,
} from "@/lib/offline/customerCache";
import { SEARCH_LIMIT } from "@/lib/pos/customers";
import { buildDeliveryPayload } from "@/lib/pos/deliveryOrder";
import { syncPosTxns, type PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import type { CartLine } from "@/types/pos";

const scope: CustomerScope = { tenantId: "t1", branchId: "b1" };
const ctx = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", online: true };

const cust = (over: Partial<CachedCustomer> = {}): CachedCustomer => ({
  id: over.id ?? "c1",
  tenant_id: "t1",
  branch_id: "b1",
  name: "Rami",
  phone: "03123456",
  phone_e164: "+96103123456",
  addresses: null,
  notes: null,
  has_profile: false,
  cached_at: new Date().toISOString(),
  ...over,
});

const line = (over: Partial<CartLine> = {}): CartLine => ({
  key: "k1",
  menu_item_id: "m1",
  name: "Margherita",
  base_price: 7,
  quantity: 1,
  modifiers: [],
  kitchen_note: null,
  ...over,
});

function makeDeliveryTxn(over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  const id = over.local_txn_id ?? crypto.randomUUID();
  const op = over.client_op_id ?? "op-" + id.slice(0, 6);
  const payload = buildDeliveryPayload({
    branchId: "b1",
    shiftId: "s1",
    clientOpId: op,
    lines: [line()],
    customerId: "c1",
    addressId: "a1",
    orderNote: "Ring twice",
    deliveryFee: 3,
  });
  return {
    local_txn_id: id,
    client_op_id: op,
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "dev1",
    terminal_id: "term1",
    cashier_user_id: "u1",
    cashier_user_name: "Cashier",
    shift_id: "s1",
    created_at: over.created_at ?? new Date().toISOString(),
    order_payload: payload,
    // The whole point: an offline delivery order is UNPAID (no intent).
    payment_intent: null,
    sent_to_kitchen: true,
    currency: "USD",
    total: 10,
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function makeTakeawayTxn(over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  const id = over.local_txn_id ?? crypto.randomUUID();
  const op = over.client_op_id ?? "op-" + id.slice(0, 6);
  return {
    local_txn_id: id,
    client_op_id: op,
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "dev1",
    terminal_id: "term1",
    cashier_user_id: "u1",
    cashier_user_name: "Cashier",
    shift_id: "s1",
    created_at: over.created_at ?? new Date().toISOString(),
    order_payload: { client_op_id: op, order_type: "takeaway", shift_id: "s1", branch_id: "b1", status: "sent_to_kitchen", notes: null, items: [] },
    payment_intent: null,
    sent_to_kitchen: true,
    currency: "USD",
    total: 10,
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function deps(over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  return {
    submit: async () => ({ order_id: "srv-" + crypto.randomUUID().slice(0, 8), order_number: "260923-0001" }),
    pay: async () => ({ paid: true }),
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
}

beforeEach(async () => {
  await localdb.posOfflineTxns.clear();
  await localdb.posCustomers.clear();
  await localdb.snapshots.clear();
});

// === A. Dine-In table map cache (READ continuity) ============================

test("table map cache: a cached map is read back for the same tenant+branch", async () => {
  const map = { tables: [{ id: "T1" }, { id: "T2" }], available: 2, occupied: 0, configured: 2, legacy_hidden: 0 };
  await cacheTableMap(map, "t1", "b1");
  const cached = await readCachedTableMap("t1", "b1");
  assert.ok(cached);
  assert.deepEqual((cached!.map as { tables: unknown[] }).tables.length, 2);
  assert.ok(Number.isFinite(cached!.cachedAt));
});

test("table map cache: a DIFFERENT tenant can never read the map", async () => {
  await cacheTableMap({ tables: [] }, "t1", "b1");
  assert.equal(await readCachedTableMap("OTHER", "b1"), null);
});

test("table map cache: a DIFFERENT branch can never read the map", async () => {
  await cacheTableMap({ tables: [] }, "t1", "b1");
  assert.equal(await readCachedTableMap("t1", "b2"), null);
});

test("table map cache: no tenant => nothing is written (and nothing read)", async () => {
  await cacheTableMap({ tables: [] }, null, "b1");
  assert.equal(await readCachedTableMap(null, "b1"), null);
  assert.equal(await localdb.snapshots.count(), 0);
});

test("table map cache: two branches cache independently", async () => {
  await cacheTableMap({ tables: [{ id: "A" }] }, "t1", "b1");
  await cacheTableMap({ tables: [{ id: "X" }, { id: "Y" }] }, "t1", "b2");
  const a = await readCachedTableMap("t1", "b1");
  const b = await readCachedTableMap("t1", "b2");
  assert.equal((a!.map as { tables: unknown[] }).tables.length, 1);
  assert.equal((b!.map as { tables: unknown[] }).tables.length, 2);
});

// === B. Delivery customer cache (offline lookup) =============================

test("customer cache: list is scoped to the tenant+branch", async () => {
  await cacheCustomers([cust({ id: "c1" }), cust({ id: "c2" })]);
  const rows = await listCachedCustomers("t1", "b1");
  assert.equal(rows.length, 2);
});

test("customer cache: another branch's customers are excluded", async () => {
  await cacheCustomers([cust({ id: "c1", branch_id: "b1" }), cust({ id: "c9", branch_id: "b2" })]);
  const rows = await listCachedCustomers("t1", "b1");
  assert.deepEqual(rows.map((r) => r.id), ["c1"]);
});

test("customer cache: getCachedCustomer is scope-checked (wrong tenant => undefined)", async () => {
  await cacheCustomers([cust({ id: "c1" })]);
  assert.ok(await getCachedCustomer("c1", "t1", "b1"));
  assert.equal(await getCachedCustomer("c1", "OTHER", "b1"), undefined);
});

test("customer cache: getCachedCustomer is scope-checked (wrong branch => undefined)", async () => {
  await cacheCustomers([cust({ id: "c1", branch_id: "b1" })]);
  assert.equal(await getCachedCustomer("c1", "t1", "b2"), undefined);
});

test("customer cache: purgeForeign drops other tenants/branches, keeps the current scope", async () => {
  await cacheCustomers([
    cust({ id: "keep", tenant_id: "t1", branch_id: "b1" }),
    cust({ id: "foreignTenant", tenant_id: "t2", branch_id: "b1" }),
    cust({ id: "foreignBranch", tenant_id: "t1", branch_id: "b2" }),
  ]);
  const dropped = await purgeForeignCachedCustomers("t1", "b1");
  assert.equal(dropped, 2);
  const rows = await localdb.posCustomers.toArray();
  assert.deepEqual(rows.map((r) => r.id), ["keep"]);
});

test("customer cache: clearCachedCustomers empties the whole store (sign-out privacy)", async () => {
  await cacheCustomers([cust({ id: "c1" }), cust({ id: "c2" })]);
  await clearCachedCustomers();
  assert.equal(await localdb.posCustomers.count(), 0);
});

test("customer cache: empty write is a no-op", async () => {
  await cacheCustomers([]);
  assert.equal(await localdb.posCustomers.count(), 0);
});

// === B2. caching semantics (compact match never downgrades a full profile) ===

test("cache profile then a later compact match must NOT erase the cached addresses", async () => {
  await cacheCustomerProfile(
    { id: "c1", name: "Rami", phone: "03123456", phone_e164: "+96103123456", notes: "VIP", addresses: [{ id: "a1" }] } as never,
    scope,
  );
  let row = await getCachedCustomer("c1", "t1", "b1");
  assert.equal(row!.has_profile, true);
  assert.equal((row!.addresses as unknown[]).length, 1);

  // A plain search later returns the same id as a compact match.
  await cacheCustomerMatches([{ id: "c1", name: "Rami", phone: "03123456", phone_e164: "+96103123456" }], scope);
  row = await getCachedCustomer("c1", "t1", "b1");
  assert.equal(row!.has_profile, true, "full profile is preserved");
  assert.equal((row!.addresses as unknown[]).length, 1, "addresses are NOT downgraded");
});

test("a compact match for an unknown id caches identity only (has_profile false)", async () => {
  await cacheCustomerMatches([{ id: "c2", name: "Sara", phone: "70999888", phone_e164: "+96170999888" }], scope);
  const row = await getCachedCustomer("c2", "t1", "b1");
  assert.equal(row!.has_profile, false);
  assert.equal(row!.addresses, null);
});

// === B3. offline search matching (pure) ======================================

test("offline search: exact E.164 phone match", () => {
  const rows = [cust({ id: "c1", phone_e164: "+96103123456" }), cust({ id: "c2", phone_e164: "+96170000000", phone: "70000000", name: "Other" })];
  const hits = matchCachedCustomers(rows, "+96103123456");
  assert.deepEqual(hits.map((h) => h.id), ["c1"]);
});

test("offline search: case-insensitive name substring", () => {
  const rows = [cust({ id: "c1", name: "Rami Haddad" }), cust({ id: "c2", name: "Sara", phone: "70000000", phone_e164: "+96170000000" })];
  assert.deepEqual(matchCachedCustomers(rows, "rami").map((h) => h.id), ["c1"]);
});

test("offline search: partial phone digits (contains)", () => {
  const rows = [cust({ id: "c1", phone: "03123456" }), cust({ id: "c2", phone: "70999888", phone_e164: "+96170999888", name: "Other" })];
  assert.deepEqual(matchCachedCustomers(rows, "1234").map((h) => h.id), ["c1"]);
});

test("offline search: raw same-phone match", () => {
  const rows = [cust({ id: "c1", phone: "03 123 456", phone_e164: "+96103123456" })];
  assert.deepEqual(matchCachedCustomers(rows, "03123456").map((h) => h.id), ["c1"]);
});

test("offline search: empty query returns nothing", () => {
  assert.deepEqual(matchCachedCustomers([cust()], "   "), []);
});

test("offline search: a non-matching term returns nothing (never a raw error)", () => {
  assert.deepEqual(matchCachedCustomers([cust({ name: "Rami", phone: "03123456", phone_e164: "+96103123456" })], "zzz-nobody"), []);
});

test("offline search: results are capped at SEARCH_LIMIT", () => {
  const many = Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => cust({ id: "c" + i, name: "Pizza Fan " + i }));
  assert.equal(matchCachedCustomers(many, "pizza fan").length, SEARCH_LIMIT);
});

// === C. Delivery OFFLINE order: exactly-once, UNPAID, via the real engine =====

test("delivery offline order: replays via submit ONCE, pays ZERO (unpaid), then synced", async () => {
  let submits = 0;
  let pays = 0;
  let seenPayload: Record<string, unknown> | null = null;
  await addPosOfflineTxn(makeDeliveryTxn());
  const report = await syncPosTxns(ctx, "test", deps({
    submit: async (p) => { submits++; seenPayload = p as unknown as Record<string, unknown>; return { order_id: "o1", order_number: "N1" }; },
    pay: async () => { pays++; return { paid: true }; },
  }));
  assert.equal(submits, 1, "order created exactly once (idempotent pos_submit_order)");
  assert.equal(pays, 0, "NEVER settled offline - the non-idempotent delivery pay path is untouched");
  assert.equal(report.synced.length, 1);
  const rows = await localdb.posOfflineTxns.toArray();
  assert.equal(rows[0].status, "synced");
  assert.equal(rows[0].paid ?? false, false, "the synced server order is UNPAID");
  // The delivery identity survived into the payload the server received.
  assert.equal(seenPayload!.order_type, "delivery");
  assert.equal(seenPayload!.customer_id, "c1");
  assert.equal(seenPayload!.address_id, "a1");
});

test("delivery offline order: the manual delivery fee travels in the replayed payload", async () => {
  let seen: Record<string, unknown> | null = null;
  await addPosOfflineTxn(makeDeliveryTxn());
  await syncPosTxns(ctx, "test", deps({ submit: async (p) => { seen = p as unknown as Record<string, unknown>; return { order_id: "o1", order_number: "N1" }; } }));
  assert.equal(seen!.delivery_fee, 3);
});

test("delivery offline order: an unsynced order survives a restart and still counts pending", async () => {
  await addPosOfflineTxn(makeDeliveryTxn());
  assert.equal(await pendingPosTxnCount(), 1);
  const rows = await localdb.posOfflineTxns.toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "queued");
});

test("delivery offline order: a re-send on the SAME op updates the one row (one logical order)", async () => {
  const op = "op-shared-delivery";
  await addPosOfflineTxn(makeDeliveryTxn({ client_op_id: op }));
  // A second Send on the same cart finds the existing row and updates it.
  const existing = await getPosOfflineTxnByOp(op);
  assert.ok(existing);
  await updatePosOfflineTxn(existing!.local_txn_id, { status: "queued", sent_to_kitchen: true });
  const rows = await localdb.posOfflineTxns.toArray();
  assert.equal(rows.length, 1, "still ONE row - never a second sale");
});

test("delivery offline order: a txn from another cashier is DEFERRED, never submitted", async () => {
  await addPosOfflineTxn(makeDeliveryTxn({ cashier_user_id: "OTHER" }));
  let submits = 0;
  const report = await syncPosTxns(ctx, "test", deps({ submit: async () => { submits++; return { order_id: "o", order_number: "N" }; } }));
  assert.equal(submits, 0);
  assert.equal(report.deferred.length, 1);
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "queued");
});

test("delivery offline order: a transport failure keeps it QUEUED (retriable), never dropped", async () => {
  await addPosOfflineTxn(makeDeliveryTxn());
  const report = await syncPosTxns(ctx, "test", deps({ submit: async () => { throw new TypeError("Failed to fetch"); } }));
  assert.equal(report.retriable.length, 1);
  assert.equal(report.synced.length, 0);
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "queued");
});

test("delivery offline order: a terminal refusal => needs_attention, never a hot retry", async () => {
  await addPosOfflineTxn(makeDeliveryTxn());
  const report = await syncPosTxns(ctx, "test", deps({ submit: async () => { throw new Error("This order is invalid"); } }));
  assert.equal(report.needsAttention.length, 1);
  assert.equal((await localdb.posOfflineTxns.toArray())[0].status, "needs_attention");
});

// === D. Resume-banner isolation (Takeaway-only) ==============================

test("resume banner: a queued DELIVERY order is EXCLUDED but a queued TAKEAWAY order is INCLUDED", async () => {
  await addPosOfflineTxn(makeTakeawayTxn({ client_op_id: "op-take" }));
  await addPosOfflineTxn(makeDeliveryTxn({ client_op_id: "op-deliver" }));
  const resumable = await listResumablePosTxns("t1", "b1", "u1");
  assert.deepEqual(resumable.map((t) => t.client_op_id), ["op-take"], "only the takeaway order resumes a cart");
});

test("resume banner: an already-synced takeaway order no longer appears", async () => {
  await addPosOfflineTxn(makeTakeawayTxn({ client_op_id: "op-take", status: "synced" }));
  assert.equal((await listResumablePosTxns("t1", "b1", "u1")).length, 0);
});
