// ISO-CUST-1 — the offline customer cache files every server row under the customer's OWN operating unit.
//
// Native 2026-11-04 (Staging 1.0.45, Franks): the owner (all branches) searched while on Main, RLS returned
// a QA-only customer, and the cache stamped it with the session's OU (Main). A Main-only cashier then signed
// in OFFLINE on the same terminal and found that QA customer (name + phone) — data RLS hides from them online.
// Exercises the REAL Dexie store via fake-indexeddb.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, cacheCustomers, clearCachedCustomers, getCachedCustomer, dropCachedCustomers, listCachedCustomers } from "@/lib/offline/db";
import { cacheCustomerMatches, cacheCustomerProfile, cachedBranchFor, searchCachedCustomers, type CustomerScope } from "@/lib/offline/customerCache";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const MAIN: CustomerScope = { tenantId: "t1", branchId: "MAIN" };
const QA: CustomerScope = { tenantId: "t1", branchId: "QA" };

beforeEach(async () => {
  await localdb.open();
  await clearCachedCustomers();
});

test("cachedBranchFor: the row's own OU wins; a tenant-wide or unread branch keeps the session scope", () => {
  assert.equal(cachedBranchFor("QA", MAIN), "QA");
  assert.equal(cachedBranchFor(null, MAIN), "MAIN");
  assert.equal(cachedBranchFor(undefined, MAIN), "MAIN");
});

test("an owner's search on Main that returns a QA customer caches it under QA — a Main-scope offline search never sees it", async () => {
  await cacheCustomerMatches(
    [
      { id: "C-QA", name: "QA Offline 1045", phone: "70104511", phone_e164: "+96170104511", branch_id: "QA" },
      { id: "C-MAIN", name: "QA Delivery DF", phone: "70999111", phone_e164: "+96170999111", branch_id: "MAIN" },
    ],
    MAIN,
  );
  assert.deepEqual((await searchCachedCustomers(MAIN, "QA")).map((c) => c.id), ["C-MAIN"], "Main sees only Main");
  assert.deepEqual((await searchCachedCustomers(MAIN, "70104511")).map((c) => c.id), [], "nor by phone");
  assert.deepEqual((await searchCachedCustomers(QA, "QA Offline")).map((c) => c.id), ["C-QA"], "QA keeps its own customer");
  assert.equal((await getCachedCustomer("C-QA", "t1", "QA"))?.branch_id, "QA");
});

test("a full profile is cached under the customer's own OU too", async () => {
  await cacheCustomerProfile(
    { id: "C-QA", name: "QA Offline 1045", phone: "70104511", phone_e164: "+96170104511", notes: null, addresses: [], orders: [], branch_id: "QA" },
    MAIN,
  );
  assert.equal(await getCachedCustomer("C-QA", "t1", "MAIN"), undefined);
  assert.equal((await getCachedCustomer("C-QA", "t1", "QA"))?.has_profile, true);
});

test("legacy callers without branch_id keep the session scope (no behaviour change for single-OU reads)", async () => {
  await cacheCustomerMatches([{ id: "C1", name: "Rana", phone: "03123456", phone_e164: "+9613123456" }], MAIN);
  assert.equal((await getCachedCustomer("C1", "t1", "MAIN"))?.branch_id, "MAIN");
});

test("dropCachedCustomers removes exactly the given rows and invalidates the scope memo", async () => {
  await cacheCustomers([
    { id: "A", tenant_id: "t1", branch_id: "MAIN", name: "A", phone: null, phone_e164: null, addresses: null, notes: null, has_profile: false, cached_at: new Date().toISOString() },
    { id: "B", tenant_id: "t1", branch_id: "MAIN", name: "B", phone: null, phone_e164: null, addresses: null, notes: null, has_profile: false, cached_at: new Date().toISOString() },
  ]);
  assert.equal((await listCachedCustomers("t1", "MAIN")).length, 2);
  await dropCachedCustomers(["A"]);
  assert.deepEqual((await listCachedCustomers("t1", "MAIN")).map((c) => c.id), ["B"]);
  await dropCachedCustomers([]);
});

test("source: search, profile and provisioning hydrate all read branch_id and file rows by cachedBranchFor", () => {
  const customers = src("src/lib/pos/customers.ts");
  assert.match(customers, /const MATCH_COLUMNS = "id, name, phone, phone_e164, branch_id"/);
  assert.match(customers, /select\("id, name, phone, phone_e164, notes, branch_id"\)/, "profile reads its OU");
  const cache = src("src/lib/offline/customerCache.ts");
  assert.match(cache, /select\("id, name, phone, phone_e164, notes, branch_id"\)\.order\("last_activity_at"/, "hydrate reads its OU");
  assert.match(cache, /branch_id: cachedBranchFor\(r\.branch_id, scope\)/, "hydrate files by the row's OU");
  assert.match(cache, /branch_id: cachedBranchFor\(profile\.branch_id, scope\)/, "profile files by the row's OU");
  assert.doesNotMatch(cache, /tenant_id: scope\.tenantId,\s*branch_id: scope\.branchId,\s*name: m\.name/, "matches never stamp the session OU");
});

test("source: a complete hydrate drops server rows cached under this OU that the server no longer returns — never pending-local rows", () => {
  const cache = src("src/lib/offline/customerCache.ts");
  assert.match(cache, /if \(rows\.length < CUSTOMER_HYDRATE_LIMIT\) \{[\s\S]{0,400}c\.pending_local !== true && !returned\.has\(c\.id\)[\s\S]{0,80}dropCachedCustomers/);
});
