// Offline-first recovery — MEASURED release-gate timings for the local paths (real Dexie on
// fake-indexeddb, which is slower than WebView2's IndexedDB, so these are upper bounds):
//   * local customer search over a fully hydrated branch (2000 customers): p95 ≤ 100 ms;
//   * local sign-in verification at the SHIPPED PBKDF2 cost: one check well under a second;
//   * the offline Drawer projection over a large operation log: bounded.

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const { cacheCustomers } = await import("@/lib/offline/db");
const { searchCachedCustomers, CUSTOMER_HYDRATE_LIMIT } = await import("@/lib/offline/customerCache");
const { createVerifier, checkVerifier, VERIFIER_ITERATIONS } = await import("@/lib/security/offlineVault");
const { buildOfflineDrawerView } = await import("@/lib/pos/offlineDrawer");
const { summarize } = await import("@/lib/perf/timings");

const report: Record<string, unknown> = {};
const stats = (name: string, ms: number[]) => summarize(ms.map((x) => ({ name, ms: x, at: 0, offline: true })))[name];

test("local customer search over a fully hydrated branch: p95 ≤ 100 ms", async () => {
  const scope = { tenantId: "t1", branchId: "b1" };
  const rows = Array.from({ length: CUSTOMER_HYDRATE_LIMIT }, (_, i) => ({
    id: `c${i}`, tenant_id: "t1", branch_id: "b1", name: `Customer ${i} ${["Hassan", "Maya", "Karim", "Nour"][i % 4]}`,
    phone: `03${String(100000 + i).padStart(6, "0")}`, phone_e164: `+9613${String(100000 + i).padStart(6, "0")}`,
    addresses: [{ id: `a${i}`, area: "Hamra", street: "Bliss", is_default: true }], notes: null, has_profile: true, cached_at: new Date().toISOString(),
  }));
  await cacheCustomers(rows as never);
  const queries = ["Hassan", "Maya", "03100", "Karim 19", "+96131001", "Nour", "Customer 1999", "Zzz", "1234", "Hamra"];
  const ms: number[] = [];
  for (let r = 0; r < 10; r++) {
    for (const q of queries) {
      const t0 = performance.now();
      await searchCachedCustomers(scope, q);
      ms.push(performance.now() - t0);
    }
  }
  const s = stats("customer.search.local", ms);
  report["customer.search.local"] = s;
  assert.ok(s.p95 <= 100, `p95 ${s.p95} ms`);
  assert.equal((await searchCachedCustomers(scope, "Customer 1999 Nour")).length, 1, "a real hit among 2000");
});

test("local sign-in verification at the shipped PBKDF2 cost stays well under a second", async () => {
  const v = await createVerifier("correct horse battery", VERIFIER_ITERATIONS);
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    assert.equal(await checkVerifier(v, "correct horse battery"), true);
    ms.push(performance.now() - t0);
  }
  const s = stats("auth.verifier.check", ms);
  report["auth.verifier.check"] = { ...s, iterations: VERIFIER_ITERATIONS };
  assert.ok(s.max < 1000, `max ${s.max} ms`);
});

test("offline Drawer projection over a 5000-operation log is bounded (≤ 50 ms)", () => {
  const T0 = Date.now() - 3_600_000;
  const ops = Array.from({ length: 5000 }, (_, i) => ({
    operation_id: `o${i}`, operation_type: i % 3 === 0 ? "takeaway_sale" : "pay_table", schema_version: 1,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "d1", terminal_id: "T1", cashier_user_id: i % 2 ? "u1" : "u2" },
    created_at: new Date(T0 + i * 1000).toISOString(), client_op_id: `c${i}`, local_entity_id: null, canonical_entity_id: null,
    dependency_ids: [], depends_on_local_entities: [],
    payload: i % 3 === 0 ? { payment_intent: { method: "cash", currency: "USD" }, total: 5, currency: "USD" } : { method: "cash", cash_amount_usd: 3 },
    status: "pending", retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null,
  }));
  const ms: number[] = [];
  for (let r = 0; r < 20; r++) {
    const t0 = performance.now();
    buildOfflineDrawerView({ ops: ops as never, scope: { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "d1", terminalId: "T1" }, server: null, openingFloatUsd: 100, shiftOpenedAtMs: T0 - 1, usdRate: 89_500 });
    ms.push(performance.now() - t0);
  }
  const s = stats("drawer.projection", ms);
  report["drawer.projection"] = s;
  assert.ok(s.p95 <= 50, `p95 ${s.p95} ms`);
  console.log("PERF_REPORT " + JSON.stringify(report));
});
