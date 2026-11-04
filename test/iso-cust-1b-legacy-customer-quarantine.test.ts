// ISO-CUST-1b — legacy customer-cache rows are QUARANTINED before any online hydrate.
//
// Native 2026-11-04: after the 1.0.46 update, BEFORE the first online hydrate, a Main-only cashier could
// still read a QA-only customer that 1.0.45 had filed under Main. The ISO-CUST-1 cleanse ran only on a
// successful, complete online hydrate. Now every server-derived row carries the scope rule it was written
// under, and every offline read serves only rule-2 rows or this device's own offline-created rows — so a
// device that updates and starts OFFLINE never serves a legacy row. Real Dexie via fake-indexeddb.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import {
  localdb,
  clearCachedCustomers,
  getCachedCustomer,
  listCachedCustomers,
  findCachedCustomersByPhoneE164,
  promotePendingLocalCustomer,
  CUSTOMER_SCOPE_RULE,
  isScopeVerifiedCustomer,
  type CachedCustomer,
} from "@/lib/offline/db";
import {
  cacheCustomerMatches,
  hydrateBranchCustomers,
  searchCachedCustomers,
  CUSTOMER_HYDRATE_LIMIT,
  type CustomerScope,
  type HydrateClient,
} from "@/lib/offline/customerCache";

const MAIN: CustomerScope = { tenantId: "t1", branchId: "MAIN" };
const QA: CustomerScope = { tenantId: "t1", branchId: "QA" };
const now = () => new Date().toISOString();

/** A row exactly as 1.0.45 wrote it: no scope_rule, stamped with the SESSION's OU. */
const legacy = (over: Partial<CachedCustomer>): CachedCustomer => ({
  id: "X", tenant_id: "t1", branch_id: "MAIN", name: null, phone: null, phone_e164: null,
  addresses: [{ id: "A1", street: "QA Test Street" }], notes: null, has_profile: true, cached_at: now(), ...over,
});

/** Seed the actual 1.0.45 cache state on this terminal, written directly (bypassing the rule stamp). */
async function seed145(): Promise<void> {
  await localdb.posCustomers.bulkPut([
    // The leak: a QA-only customer that an owner's search on Main filed under MAIN.
    legacy({ id: "C-QA", name: "QA Offline 1045", phone: "70104511", phone_e164: "+96170104511" }),
    // A genuine Main customer cached by 1.0.45 — also unverified, so also quarantined until rewritten.
    legacy({ id: "C-MAIN", name: "QA Delivery DF", phone: "70999111", phone_e164: "+96170999111" }),
    // This device's own offline-created customer (pending sync) — legitimate local work, never quarantined.
    { ...legacy({ id: "LOCAL-1", name: "Walk-in Pending", phone: "70555666", phone_e164: "+96170555666" }), pending_local: true },
  ]);
}

beforeEach(async () => {
  await localdb.open();
  await clearCachedCustomers();
});

test("upgrade from the 1.0.45 cache, NO online hydrate: the Main cashier's first offline search never sees the mis-filed QA customer", async () => {
  await seed145();
  assert.deepEqual(await searchCachedCustomers(MAIN, "QA Offline"), [], "by name");
  assert.deepEqual(await searchCachedCustomers(MAIN, "70104511"), [], "by phone (E.164 index path)");
  assert.deepEqual(await findCachedCustomersByPhoneE164("t1", "MAIN", "+96170104511"), [], "phone index");
  assert.equal(await getCachedCustomer("C-QA", "t1", "MAIN"), undefined, "profile / cached detail view lookup");
});

test("quarantine is fail-closed: unverified legacy rows are unreadable even when correctly stamped; pending-local work stays readable", async () => {
  await seed145();
  assert.deepEqual(await searchCachedCustomers(MAIN, "QA Delivery"), [], "legacy Main row waits for an online rewrite");
  assert.deepEqual((await searchCachedCustomers(MAIN, "Walk-in")).map((c) => c.id), ["LOCAL-1"], "offline-created customer kept");
  assert.deepEqual((await listCachedCustomers("t1", "MAIN")).map((c) => c.id), ["LOCAL-1"]);
  // Nothing was deleted: rows needed by queued orders (bulk display lookups) and the local work remain on disk.
  assert.equal(await localdb.posCustomers.count(), 3);
});

test("after an online rewrite the legitimate Main customer is visible to Main and the QA customer only to QA (owner)", async () => {
  await seed145();
  // What an owner's online search on Main returns: both customers, each with its OWN branch.
  await cacheCustomerMatches(
    [
      { id: "C-QA", name: "QA Offline 1045", phone: "70104511", phone_e164: "+96170104511", branch_id: "QA" },
      { id: "C-MAIN", name: "QA Delivery DF", phone: "70999111", phone_e164: "+96170999111", branch_id: "MAIN" },
    ],
    MAIN,
  );
  assert.deepEqual((await searchCachedCustomers(MAIN, "QA")).map((c) => c.id), ["C-MAIN"], "Main sees only Main");
  assert.deepEqual(await searchCachedCustomers(MAIN, "70104511"), [], "QA phone still hidden from Main");
  assert.deepEqual((await searchCachedCustomers(QA, "QA Offline")).map((c) => c.id), ["C-QA"], "owner on QA sees it");
  const row = await localdb.posCustomers.get("C-QA");
  assert.equal(row?.branch_id, "QA");
  assert.equal(row?.scope_rule, CUSTOMER_SCOPE_RULE);
});

test("promoting a synced offline customer never adopts a legacy row's OU", async () => {
  await localdb.posCustomers.bulkPut([
    legacy({ id: "SRV-9", name: "Other OU person", branch_id: "MAIN" }),
    { ...legacy({ id: "LOCAL-9", name: "Created on QA", branch_id: "QA", addresses: null }), pending_local: true },
  ]);
  await promotePendingLocalCustomer("LOCAL-9", "SRV-9", {});
  const p = await localdb.posCustomers.get("SRV-9");
  assert.equal(p?.branch_id, "QA", "the OU the customer was created in");
  assert.equal(p?.name, "Created on QA");
  assert.equal(p && isScopeVerifiedCustomer(p), true);
  assert.deepEqual(await searchCachedCustomers(MAIN, "Created"), []);
});

// ---------------------------------------------------------------- the provisioning hydrate (real code, fake client)

function fakeClient(rows: Record<string, unknown>[]): HydrateClient {
  return {
    from: (t: string) => ({
      select: () => ({
        order: () => ({ limit: async () => (t === "pos_customers" ? { data: rows, error: null } : { data: [], error: null }) }),
        in: async () => ({ data: [], error: null }),
      }),
    }),
  };
}
const server = (n: number, branch: string, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, name: `${prefix} ${i}`, phone: null, phone_e164: null, notes: null, branch_id: branch }));

test("online rehydration (cashier, below the cap): returned rows become readable under their own OU; the legacy QA row stays hidden", async () => {
  await seed145();
  const cashierRows = [{ id: "C-MAIN", name: "QA Delivery DF", phone: "70999111", phone_e164: "+96170999111", notes: null, branch_id: "MAIN" }];
  const n = await hydrateBranchCustomers({ tenantId: "t1", branchId: "MAIN" }, fakeClient(cashierRows));
  assert.equal(n, 1);
  assert.deepEqual((await searchCachedCustomers(MAIN, "QA")).map((c) => c.id), ["C-MAIN"]);
  assert.equal(await getCachedCustomer("C-QA", "t1", "MAIN"), undefined);
});

test("the 2,000-row boundary: a CAPPED hydrate skips housekeeping, yet the legacy mis-filed row is still unreadable", async () => {
  await localdb.posCustomers.put(legacy({ id: "C-QA", tenant_id: "t2", branch_id: "MAIN", name: "QA Offline 1045", phone: "70104511", phone_e164: "+96170104511" }));
  const rows = server(CUSTOMER_HYDRATE_LIMIT, "MAIN", "M");
  const n = await hydrateBranchCustomers({ tenantId: "t2", branchId: "MAIN" }, fakeClient(rows));
  assert.equal(n, CUSTOMER_HYDRATE_LIMIT);
  const scope = { tenantId: "t2", branchId: "MAIN" };
  assert.deepEqual(await searchCachedCustomers(scope, "QA Offline"), [], "no cleanse ran, the read gate still holds");
  assert.equal((await listCachedCustomers("t2", "MAIN")).length, CUSTOMER_HYDRATE_LIMIT, "only rule-2 rows are served");
  assert.ok(await localdb.posCustomers.get("C-QA"), "quarantined, not deleted");
});

test("an owner's capped hydrate files every row under its OWN OU: nothing foreign lands in the selected OU", async () => {
  const rows = [...server(CUSTOMER_HYDRATE_LIMIT - 1, "MAIN", "OM"), { id: "OQ-1", name: "QA only", phone: null, phone_e164: null, notes: null, branch_id: "QA" }];
  await hydrateBranchCustomers({ tenantId: "t3", branchId: "MAIN" }, fakeClient(rows));
  assert.deepEqual(await searchCachedCustomers({ tenantId: "t3", branchId: "MAIN" }, "QA only"), []);
  assert.deepEqual((await searchCachedCustomers({ tenantId: "t3", branchId: "QA" }, "QA only")).map((c) => c.id), ["OQ-1"]);
});
