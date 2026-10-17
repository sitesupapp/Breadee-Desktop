// SECOND-LAYER offline blockers (1.0.37 rc.4): the ACCESS layer passed natively, but page/modal DATA
// LOADERS threw raw "TypeError: Failed to fetch" offline. This locks the fixes:
//   1. Dine-In Floor Map — pre-hydrated during normal online POS use; a controlled offline readiness
//      message instead of a raw fetch error when no cache exists.
//   2. Delivery customer — the live UI routes to the Phase-E offline capture (search/create/edit/
//      address) instead of the online-only "Saving a customer needs a connection" gate.
//   3. Transfer Center / 4. Force End Shift — the modal OPENS offline with a controlled coordination
//      message and runs NO loader (server-authoritative; never a raw fetch error).
//
// Behavioural coverage uses fake-indexeddb for the offline customer/address capture; the loader
// wiring (React components / stores) is asserted at the source level, the repo's established style.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, getCachedCustomer, readCachedFloor, addPosOfflineTxn, cacheDeliveryQueue, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation } from "@/lib/offline/operationLog";
import {
  captureCustomerUpsertOffline,
  evaluateCustomerWriteOfflineReady,
  type CustomerOpScope,
} from "@/lib/offline/customerOffline";
import { prewarmFloorCache } from "@/state/floor";
import {
  loadDeliveryQueueOfflineAware,
  projectLocalDeliveryOrders,
  mergeDeliveryQueue,
} from "@/lib/offline/deliveryQueueOffline";
import type { DeliveryQueueOrder } from "@/lib/pos/deliveryOrderManagement";

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

const SCOPE: CustomerOpScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };

function deliveryTxn(over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  return {
    local_txn_id: "LOCAL-1",
    client_op_id: "op-1",
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "dev1",
    terminal_id: "term1",
    cashier_user_id: "u1",
    cashier_user_name: "Cashier",
    shift_id: "s1",
    created_at: "2026-10-17T10:00:00.000Z",
    order_payload: { order_type: "delivery", customer_id: "c1", address_id: "a1", delivery_fee: 2, items: [] },
    payment_intent: null,
    sent_to_kitchen: true,
    currency: "USD",
    total: 12,
    status: "queued",
    attempts: 0,
    ...over,
  };
}

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(),
    localdb.entityMap.clear(),
    localdb.posCustomers.clear(),
    localdb.snapshots.clear(),
    localdb.posOfflineTxns.clear(),
  ]);
});

// --- Delivery offline customer (Phase-E capture) ----------------------------

test("offline CREATE with an address mints a local address and caches the pending-local customer with it", async () => {
  const r = await captureCustomerUpsertOffline({
    scope: SCOPE,
    upsert: { branch_id: "b1", phone: "03111222", name: "Zed", address: { street: "Main St" } },
    clientOpId: "op-create-1",
    display: { name: "Zed", phone: "03111222", phone_e164: null },
  });
  assert.ok(r.localCustomerId, "a new customer gets a local id");
  assert.ok(r.localAddressId, "a NEW address on a create gets a local id (so a dependent order can chain to it)");
  const cached = await getCachedCustomer(r.localCustomerId as string, "t1", "b1");
  assert.equal(cached?.pending_local, true, "selectable offline immediately");
  const addresses = (cached?.addresses as { id: string }[] | null) ?? [];
  assert.equal(addresses.length, 1);
  assert.equal(addresses[0].id, r.localAddressId);
});

test("offline ADD-ADDRESS to a pending-local customer appends a local address to its cached profile", async () => {
  const c = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", phone: "03999", name: "Ada" }, clientOpId: "op-create-2" });
  const a = await captureCustomerUpsertOffline({
    scope: SCOPE,
    upsert: { id: c.localCustomerId, branch_id: "b1", address: { street: "2nd St" } },
    clientOpId: "op-addr-2",
  });
  assert.equal(a.localCustomerId, null, "an edit mints no new customer");
  assert.ok(a.localAddressId, "a NEW address on an edit still gets a local id");
  const cached = await getCachedCustomer(c.localCustomerId as string, "t1", "b1");
  const addresses = (cached?.addresses as { id: string }[] | null) ?? [];
  assert.equal(addresses.length, 1, "the local address is appended so it is selectable offline");
  assert.equal(addresses[0].id, a.localAddressId);
  // The op carries local_address_id so the replay handler remaps it to the canonical address id.
  const op = await getOperation("customer:op-addr-2");
  assert.equal((op?.payload as { local_address_id?: string }).local_address_id, a.localAddressId);
});

test("offline ADD-ADDRESS to a CANONICAL (uncached) customer never re-marks it pending-local", async () => {
  const a = await captureCustomerUpsertOffline({
    scope: SCOPE,
    upsert: { id: "SRV-CUST-X", branch_id: "b1", address: { street: "3rd" } },
    clientOpId: "op-addr-3",
  });
  assert.ok(a.localAddressId, "the address id is minted + carried for replay remap");
  assert.equal(await getCachedCustomer("SRV-CUST-X", "t1", "b1"), undefined, "a canonical customer is not turned pending-local");
});

test("evaluateCustomerWriteOfflineReady: offline-ready + permission allows; not-ready blocks; no permission blocks", () => {
  const base = { online: false, canManageCustomers: false, canCreateOrders: true };
  assert.equal(evaluateCustomerWriteOfflineReady({ ...base, offlineReady: true, hasScope: true }).allowed, true);
  assert.equal(evaluateCustomerWriteOfflineReady({ ...base, offlineReady: false, hasScope: true }).allowed, false);
  assert.equal(evaluateCustomerWriteOfflineReady({ ...base, offlineReady: true, hasScope: false }).allowed, false);
  assert.equal(
    evaluateCustomerWriteOfflineReady({ online: false, offlineReady: true, hasScope: true, canManageCustomers: false, canCreateOrders: false }).allowed,
    false,
    "no create/manage permission is never upgraded",
  );
});

// --- loader wiring (source-asserted) ----------------------------------------

test("Dine-In Floor Map: pre-hydrated on POS entry, and no raw fetch error offline", () => {
  const pw = srcOf("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /const r = await prewarmFloorCache\(ctx\)/, "floor pre-hydrated (awaited + confirmed) during online POS use");
  assert.match(pw, /canViewTables\(pos\.access\)\.allowed\) void useTables\.getState\(\)\.refresh\(ctx\)/, "table map pre-hydrated too");
  const floor = srcOf("src/state/floor.ts");
  assert.match(floor, /isBackendReachable/, "the no-cache branch classifies offline vs a real fault");
  assert.match(floor, /isn't saved for offline use yet/, "a controlled readiness message replaces a raw 'Failed to fetch'");
});

test("Delivery customer: the live UI routes to the offline-aware Phase-E path", () => {
  const dw = srcOf("src/screens/pos/DeliveryWorkspace.tsx");
  assert.match(dw, /searchCustomersOfflineAware/, "lookup is offline-aware (no raw fetch)");
  assert.match(dw, /upsertCustomerOfflineAware/, "create/edit/address capture offline");
  assert.match(dw, /customerOfflineReady = Boolean\(pos\.tenantId && pos\.userId\)/, "offline-ready signal");
  assert.match(dw, /!gate\.allowed &&\s*!online &&\s*customerOfflineReady/, "writeGate is upgraded offline when ready");
});

test("Transfer Center + Force End: modal opens offline with a controlled message and runs no loader", () => {
  const tc = srcOf("src/components/pos/TransferCenterModal.tsx");
  assert.match(tc, /online: boolean;/, "takes an online prop");
  assert.match(tc, /\{!online \?/, "short-circuits to the offline branch before any tab loader mounts");
  assert.match(tc, /Transfer Center needs a connection\./);
  const fem = srcOf("src/components/pos/ForceEndShiftModal.tsx");
  assert.match(fem, /\{!online \?/);
  assert.match(fem, /Force End Shift needs a connection\./);
  const feb = srcOf("src/components/pos/ForceEndShiftBrowser.tsx");
  assert.match(feb, /if \(!open \|\| !online\)/, "the browser does not fetch offline");
  assert.match(feb, /Force-End needs a connection\./);
});

// --- A: Dine-In Floor pre-hydration (CASE A/B/C/D) ---------------------------

const FLOOR_CTX = { tenantId: "t1", branchId: "b1" };
const SAMPLE_LAYOUT = { hasPublished: true, sections: [{ id: "sec1", name: "Main" }], elements: [] } as never;

test("CASE A — MANAGER operational access: prewarm caches the published floor WITHOUT visiting Dine-In; read-key matches", async () => {
  // The prewarm's only gate is the published-floor READ entitlement (canViewFloor = pos.tables.view +
  // the pos.floor_map sub-feature) — NEVER the designer/manage authority. A stubbed online load stands
  // in for floor_service_layout (staging-proven to succeed for a manager on pos.tables.view).
  const r = await prewarmFloorCache(FLOOR_CTX, async () => SAMPLE_LAYOUT);
  assert.equal(r, "READY", "prewarm confirms the durable write committed (floorCache=READY is truthful)");
  // The EXACT production read path used by the floor store offline:
  const read = await readCachedFloor("t1", "b1");
  assert.ok(read, "readCachedFloor finds the prewarmed floor");
  assert.deepEqual(read?.layout, SAMPLE_LAYOUT, "write key == read key (same tenant+branch)");
  // The POS pre-hydration gate is the READ entitlement, not the designer authority.
  const pw = srcOf("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /canViewFloor\(pos\.access\)\.allowed/, "gated on the floor READ entitlement");
  assert.doesNotMatch(pw, /canManageFloor/, "never gated on designer/manage authority");
});

test("CASE B — delayed branch resolution: NO_SCOPE until the branch resolves, then READY", async () => {
  assert.equal(await prewarmFloorCache({ tenantId: "t1", branchId: null }, async () => SAMPLE_LAYOUT), "NO_SCOPE");
  assert.equal(await readCachedFloor("t1", "b1"), null, "nothing cached under a null branch");
  // Branch resolves → prewarm runs and caches. The effect re-runs because pos.branch.id is a dependency.
  assert.equal(await prewarmFloorCache(FLOOR_CTX, async () => SAMPLE_LAYOUT), "READY");
  const pw = srcOf("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /\[pos\.allowed, tenantId, pos\.branch\.id, online\]/, "effect re-runs when branch/online resolve");
});

test("CASE C — cold restart: the cache survives store recreation and reads back on the same key", async () => {
  await prewarmFloorCache(FLOOR_CTX, async () => SAMPLE_LAYOUT);
  const { useFloor } = await import("@/state/floor");
  useFloor.getState().reset();
  const read = await readCachedFloor("t1", "b1");
  assert.deepEqual(read?.layout, SAMPLE_LAYOUT, "same floor/layout restores offline after restart");
});

test("CASE D — OU isolation: a floor cached for branch A is never served for branch B", async () => {
  await prewarmFloorCache({ tenantId: "t1", branchId: "A" }, async () => SAMPLE_LAYOUT);
  assert.ok(await readCachedFloor("t1", "A"), "branch A is cached");
  assert.equal(await readCachedFloor("t1", "B"), null, "branch B never serves branch A's floor");
  assert.equal(await readCachedFloor("t2", "A"), null, "a different tenant never serves it either");
});

test("floor prewarm returns a PRECISE checkpoint code (LOAD_FAILED / WRITE_FAILED / EMPTY), never throws", async () => {
  assert.equal(await prewarmFloorCache(FLOOR_CTX, async () => { throw new TypeError("Failed to fetch"); }), "LOAD_FAILED");
  assert.equal(await readCachedFloor("t1", "b1"), null, "a failed load leaves the cache absent");
  // A branch with NO published floor caches an empty layout (offline shows 'no floor published', not an error).
  const empty = await prewarmFloorCache(FLOOR_CTX, async () => ({ hasPublished: false, sections: [], elements: [] } as never));
  assert.equal(empty, "EMPTY");
  assert.ok(await readCachedFloor("t1", "b1"), "EMPTY still writes a (present) cache");
});

// --- B: Delivery Orders offline continuity (TEST 3 / 4 / 5 / 6) --------------

const CANON_ORDER: DeliveryQueueOrder = {
  id: "SRV-1", order_number: "D-100", status: "sent_to_kitchen", payment_status: "unpaid", payment_method: null,
  subtotal: 10, discount_amount: null, total_amount: 10, currency: "USD", customer_id: "c0", address_id: "a0",
  notes: null, shift_id: "s1", created_at: "2026-10-17T09:00:00.000Z",
};

test("TEST3 — online load writes the snapshot; offline load serves it with NO network call", async () => {
  // ONLINE (stubbed reachable + loader): write-through the snapshot.
  const online = await loadDeliveryQueueOfflineAware(
    { tenantId: "t1", branchId: "b1", shiftId: "s1", now: new Date() },
    { reachable: async () => true, load: async () => [CANON_ORDER] },
  );
  assert.equal(online.offline, false);
  assert.deepEqual(online.orders, [CANON_ORDER]);
  // OFFLINE: a loader that WOULD throw must never be called — the snapshot is served instead.
  const offline = await loadDeliveryQueueOfflineAware(
    { tenantId: "t1", branchId: "b1", shiftId: "s1", now: new Date() },
    { reachable: async () => false, load: async () => { throw new TypeError("Failed to fetch"); } },
  );
  assert.equal(offline.offline, true);
  assert.equal(offline.orders.length, 1);
  assert.equal(offline.orders[0].id, "SRV-1");
});

test("TEST4 — a local offline-created delivery order appears in the offline Orders list", async () => {
  await addPosOfflineTxn(deliveryTxn({ local_txn_id: "LOCAL-9", client_op_id: "op-9" }));
  const locals = await projectLocalDeliveryOrders("t1", "b1", "s1");
  assert.equal(locals.length, 1);
  assert.equal(locals[0].id, "LOCAL-9");
  assert.equal(locals[0].order_number, "OFF-LOCAL-");
  assert.equal(locals[0].payment_status, "unpaid");
  // And it is merged into the offline list alongside the canonical snapshot.
  await cacheDeliveryQueue([CANON_ORDER], "t1", "b1", "s1");
  const { orders } = await loadDeliveryQueueOfflineAware(
    { tenantId: "t1", branchId: "b1", shiftId: "s1", now: new Date() },
    { reachable: async () => false, load: async () => { throw new Error("no"); } },
  );
  assert.deepEqual(orders.map((o) => o.id).sort(), ["LOCAL-9", "SRV-1"]);
});

test("TEST5 — a local order that has fully synced does NOT double with its canonical row", async () => {
  // A synced local txn carrying its canonical server id; the snapshot already holds that canonical order.
  await addPosOfflineTxn(deliveryTxn({ local_txn_id: "LOCAL-5", client_op_id: "op-5", status: "synced", server_order_id: "SRV-1" }));
  await cacheDeliveryQueue([CANON_ORDER], "t1", "b1", "s1");
  const { orders } = await loadDeliveryQueueOfflineAware(
    { tenantId: "t1", branchId: "b1", shiftId: "s1", now: new Date() },
    { reachable: async () => false, load: async () => { throw new Error("no"); } },
  );
  assert.equal(orders.length, 1, "exactly one order — not local + canonical");
  assert.equal(orders[0].id, "SRV-1");
});

test("TEST6 — offline refresh serves local data and never calls the server loader (no raw fetch)", async () => {
  let loaderCalled = false;
  const { offline } = await loadDeliveryQueueOfflineAware(
    { tenantId: "t1", branchId: "b1", shiftId: "s1", now: new Date() },
    { reachable: async () => false, load: async () => { loaderCalled = true; return []; } },
  );
  assert.equal(offline, true);
  assert.equal(loaderCalled, false, "the server loader is never invoked offline");
});

test("mergeDeliveryQueue de-dupes by id and sorts newest-first", () => {
  const a: DeliveryQueueOrder = { ...CANON_ORDER, id: "A", created_at: "2026-10-17T08:00:00.000Z" };
  const b: DeliveryQueueOrder = { ...CANON_ORDER, id: "B", created_at: "2026-10-17T10:00:00.000Z" };
  const dupA: DeliveryQueueOrder = { ...CANON_ORDER, id: "A", created_at: "2026-10-17T08:00:00.000Z" };
  const merged = mergeDeliveryQueue([a], [b, dupA]);
  assert.deepEqual(merged.map((o) => o.id), ["B", "A"]);
});

test("Delivery Orders loader is offline-aware in the UI, with a controlled offline empty state", () => {
  const dw = srcOf("src/screens/pos/DeliveryWorkspace.tsx");
  assert.match(dw, /loadDeliveryQueueOfflineAware/, "refreshQueue uses the offline-aware loader");
  assert.match(dw, /setQueueOffline/, "tracks offline provenance for the empty state");
  const q = srcOf("src/components/pos/DeliveryOrderQueue.tsx");
  assert.match(q, /No delivery orders saved on this device yet/, "controlled offline empty message");
});

test("PosWorkspace pre-hydrates the floor + delivery queue during online POS use and surfaces floorCache diagnostics", () => {
  const pw = srcOf("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /prewarmFloorCache\(ctx\)/, "floor prewarm wired");
  assert.match(pw, /rcSetFloorHydrate\(r\)/, "floorHydrate diagnostic set to the precise checkpoint code");
  assert.match(pw, /floorPrewarmCached\(r\)/, "retries until the cache is present (READY/EMPTY)");
  assert.match(pw, /rcSetFloorHydrate\("SKIP_ACCESS"\)/, "records when the floor READ entitlement is missing");
  assert.match(pw, /prewarmDeliveryQueue\(\{ tenantId, branchId: pos\.branch\.id, shiftId, now: new Date\(\) \}\)/, "delivery queue prewarm wired with the shift-matching key");
});
