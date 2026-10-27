// Final Foundation (PERF, Track 10) — hot-path query changes keep their exact results:
//   - Dexie v12 is ADDITIVE (every v11 index kept, new indexes present, no new store);
//   - loadShiftOrders / loadOrdersForDay return the NEWEST page (oldest-first), page back by keyset, and
//     hydrate names in parallel (the 1.0.38-dev ASC LIMIT dropped the newest orders);
//   - the bounded Sync Center rows equal the old whole-log algorithm row for row;
//   - the scopedOperations / customer read caches invalidate on every write;
//   - bulk / indexed rewrites (canonicalIds, localAliasesOf, resumable txns, latest receipt) are identical.

import "fake-indexeddb/auto";
import { register } from "node:module";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

register("./support/perf-supabase-hook.mjs", import.meta.url);

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

const fake = await import("./support/perfSupabaseFake.ts");
const { localdb, listCachedCustomers, cacheCustomers, listResumablePosTxns, readLatestReceiptSnapshot } = await import("@/lib/offline/db");
const SOS = await import("@/lib/pos/shiftOrderSummary");
const QF = await import("@/lib/offline/queueForensics");
const { scopedOperations, localAliasesOf } = await import("@/lib/offline/operationalProjection");
const { canonicalIds } = await import("@/lib/offline/entityMap");

const T = "t1", B = "b1", U = "u1", DEV = "d1", TERM = "term1";
const SC = { tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U };
const PS = { tenantId: T, branchId: B, cashierUserId: U, deviceId: DEV, terminalId: TERM };

beforeEach(async () => {
  for (const t of localdb.tables) await t.clear();
  fake.queries.length = 0;
  for (const k of Object.keys(fake.tables)) delete fake.tables[k];
});

test("Dexie v12 is additive: every 1.0.37 (v11) index kept, the new indexes exist, no new store", async () => {
  await localdb.open();
  assert.equal(localdb.verno, 12);
  const idb = localdb.backendDB();
  const has = (store: string, idx: string) => idb.transaction(store, "readonly").objectStore(store).indexNames.contains(idx);
  for (const [s, idx] of [
    ["operations", ["status", "operation_type", "created_at", "client_op_id", "local_entity_id", "[status+synced_at]"]],
    ["entityMap", ["entity_type", "tenant_id", "canonical_id", "resolved_at"]],
    ["posOfflineTxns", ["client_op_id", "tenant_id", "branch_id", "status", "created_at", "cashier_user_id", "[tenant_id+status]"]],
    ["dineDrafts", ["tenant_id", "branch_id", "table_id", "status", "cashier_user_id", "device_id", "updated_at", "[tenant_id+status]"]],
    ["posCustomers", ["tenant_id", "branch_id", "phone_e164", "name", "[tenant_id+branch_id]"]],
  ] as [string, string[]][]) {
    for (const i of idx) assert.ok(has(s, i), `${s}.${i}`);
  }
  assert.deepEqual([...idb.objectStoreNames].sort(), ["audit", "dineDrafts", "entityMap", "operations", "outbox", "paidOrderProofs", "payoutSourceProofs", "pendingShifts", "posCustomers", "posOfflineTxns", "printRoutes", "receipts", "receivableProofs", "snapshots", "syncHistory"]);
});

const orderRow = (i: number, extra: Record<string, unknown> = {}) => ({
  id: `O-${String(i).padStart(4, "0")}`, order_number: `N${i}`, order_type: "takeaway", status: "completed", payment_status: "paid", payment_method: "cash",
  subtotal: 10, discount_amount: 0, total_amount: 10, primary_currency_snapshot: "USD", table_id: null, customer_id: i % 50 === 0 ? `C-${i}` : null,
  cashier_user_id: "staff-1", notes: null, created_at: new Date(Date.UTC(2026, 9, 27, 8, 0, 0) + i * 60_000).toISOString(), merged_into_order_id: null, merged_into_merge_id: null,
  tenant_id: T, shift_id: "SH-1", branch_id: B, ...extra,
});

test("loadShiftOrders: a >200-order shift returns its NEWEST 200 (oldest-first) and pages back by keyset", async () => {
  fake.tables.pos_orders = Array.from({ length: 450 }, (_, i) => orderRow(i));
  fake.tables.pos_customers = [{ id: "C-400", name: "Rana", phone: "70" }];
  fake.tables.profiles = [{ id: "staff-1", full_name: "Cashier One" }];
  const page = await SOS.loadShiftOrders({ tenantId: T, shiftId: "SH-1" });
  assert.equal(page.length, 200);
  assert.equal(page[page.length - 1].id, "O-0449", "the NEWEST order is included (the panel's default selection)");
  assert.equal(page[0].id, "O-0250");
  assert.ok(page.every((o, i) => i === 0 || (page[i - 1].created_at ?? "") <= (o.created_at ?? "")), "oldest-first, as before");
  assert.equal(page.find((o) => o.id === "O-0400")?.customer_name, "Rana", "customer hydrated");
  assert.ok(page.every((o) => o.staff_name === "Cashier One"), "staff hydrated");
  const older = await SOS.loadShiftOrders({ tenantId: T, shiftId: "SH-1", before: page[0].created_at });
  assert.equal(older.length, 200);
  assert.equal(older[older.length - 1].id, "O-0249");
  const oldest = await SOS.loadShiftOrders({ tenantId: T, shiftId: "SH-1", before: older[0].created_at });
  assert.deepEqual([oldest.length, oldest[0].id, oldest[oldest.length - 1].id], [50, "O-0000", "O-0049"]);
  // ≤ 200: the whole shift, unchanged.
  fake.tables.pos_orders = Array.from({ length: 30 }, (_, i) => orderRow(i));
  const small = await SOS.loadShiftOrders({ tenantId: T, shiftId: "SH-1" });
  assert.deepEqual(small.map((o) => o.id), fake.tables.pos_orders.map((o) => o.id));
});

test("loadOrdersForDay: a >500-order day returns its newest 500; the hydrate reads run in parallel", async () => {
  fake.tables.pos_orders = Array.from({ length: 700 }, (_, i) => orderRow(i, { created_at: new Date(2026, 9, 27, 0, 0, 0).getTime() + i * 60_000 }))
    .map((r) => ({ ...r, created_at: new Date(r.created_at as number).toISOString() }));
  fake.tables.profiles = [{ id: "staff-1", full_name: "Cashier One" }];
  const day = await SOS.loadOrdersForDay({ tenantId: T, branchId: B, day: "2026-10-27" });
  assert.equal(day.length, 500);
  assert.equal(day[day.length - 1].id, "O-0699");
  assert.equal(day[0].id, "O-0200");
  // The three hydrate reads (merge targets: none needed; customers; profiles) were all issued.
  assert.ok(fake.queries.some((q) => q.table === "profiles"));
  assert.ok(fake.queries.some((q) => q.table === "pos_customers"));
});

function op(id: string, type: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: id, operation_type: type, schema_version: 2, scope: { ...SC }, created_at: new Date(Date.UTC(2026, 9, 1) + Number(id.replace(/\D/g, "") || 0) * 1000).toISOString(),
    client_op_id: "cop-" + id, local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "pending",
    retry_count: 0, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: null, synced_at: null, ...over,
  };
}

/** The 1.0.38-dev loadSyncCenterRows (whole-log read) — the reference the bounded one must equal. */
async function referenceRows(input: { tenantId: string; branchId: string | null; currentBuild: string | null; currentShiftId: string | null }) {
  const inScope = (o: { scope: { tenant_id: string; branch_id: string | null } }) => o.scope.tenant_id === input.tenantId && (input.branchId == null || (o.scope.branch_id ?? null) === input.branchId);
  const all = await localdb.operations.toArray();
  const scoped = all.filter(inScope);
  const UNS = ["pending", "blocked_dependency", "syncing", "retryable", "needs_attention"];
  const unsettled = scoped.filter((o) => UNS.includes(o.status));
  const synced = scoped.filter((o) => o.status === "synced").sort((a, b) => (b.synced_at ?? b.created_at).localeCompare(a.synced_at ?? a.created_at)).slice(0, 30);
  const ordered = [...unsettled, ...synced].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const diag = QF.buildDiagnostic(ordered, input.currentBuild, { currentShiftId: input.currentShiftId, allOps: all });
  const rank = (s: string) => (s === "needs_attention" ? 0 : s === "synced" ? 2 : 1);
  return diag
    .map((r, i) => ({ ...r, operation_id: ordered[i].operation_id, label: String(ordered[i].operation_type).replace(/_/g, " ") }))
    .sort((a, b) => rank(a.status) - rank(b.status) || b.created_at.localeCompare(a.created_at));
}

test("bounded Sync Center rows equal the whole-log algorithm (deps chains, parked roots, local producers, 200 synced)", async () => {
  const rows: Record<string, unknown>[] = [];
  // 200 old synced ops (only the newest 30 are shown) incl. producers of local entities.
  for (let i = 1; i <= 200; i++) {
    rows.push(op(`s${i}`, i % 3 === 0 ? "dinein_open_table" : i % 3 === 1 ? "dinein_send_round" : "customer_upsert", {
      status: "synced", synced_at: new Date(Date.UTC(2026, 9, 2) + i * 1000).toISOString(), local_entity_id: `L${i}`, canonical_entity_id: `C${i}`,
      dependency_ids: i > 1 && i % 3 === 1 ? [`s${i - 1}`] : [], payload: i % 3 === 1 ? { submit: { table_id: `C${i - 1}` }, table_local: `L${i - 1}`, round_seq: 1 } : {},
    }));
  }
  // A parked chain: refused open → dependency_failed round → dependency_failed pay naming it.
  rows.push(op("p1", "dinein_open_table", { status: "needs_attention", local_entity_id: "LT1", last_error_code: "version_conflict", last_error_message: "VERSION_CONFLICT" }));
  rows.push(op("p2", "dinein_send_round", { status: "needs_attention", dependency_ids: ["p1"], depends_on_local_entities: ["LT1"], last_error_code: "dependency_failed", last_error_message: "p1", payload: { table_local: "LT1", round_seq: 1 } }));
  rows.push(op("p3", "pay_table", { status: "needs_attention", dependency_ids: ["p2"], last_error_code: "dependency_failed", last_error_message: "p2", payload: { table_local: "LT1", covers: { session_local: "SESS-1", order_ids: ["C5"] } } }));
  // Waiting ops depending on OLD synced ops (not in the newest 30) and on local entities they produced.
  rows.push(op("w1", "dinein_send_round", { status: "blocked_dependency", dependency_ids: ["s3", "s9"], depends_on_local_entities: ["L3"], payload: { table_local: "L3", submit: { table_id: null }, round_seq: 2 } }));
  rows.push(op("w2", "pay_table", { status: "pending", dependency_ids: ["w1"], payload: { table_local: "L3", covers: { session_local: "L6", order_ids: [] } } }));
  rows.push(op("w3", "end_shift", { status: "blocked_dependency", dependency_ids: ["w2", "s12", "gone-1"], payload: { shift_id: "SH-1" } }));
  rows.push(op("w4", "edit_order_line", { status: "retryable", payload: { order_local: "L9", version_after_op: "s9", target_ref: { kind: "after", op_id: "s10" } } }));
  // Out of scope (other branch) — never shown.
  rows.push(op("x1", "payout", { status: "pending", scope: { ...SC, branch_id: "b2" } }));
  await localdb.operations.bulkAdd(rows as never);
  const input = { tenantId: T, branchId: B, currentBuild: "abc", currentShiftId: "SH-1" };
  const got = await QF.loadSyncCenterRows(input);
  const want = await referenceRows(input);
  assert.equal(got.length, 7 + 30);
  assert.deepEqual(got, want);
  // Tenant-wide (branch null) too.
  assert.deepEqual(await QF.loadSyncCenterRows({ ...input, branchId: null }), await referenceRows({ ...input, branchId: null }));
});

test("scopedOperations read cache: invalidated by add, update and delete (from any module)", async () => {
  await localdb.operations.add(op("a1", "payout") as never);
  assert.deepEqual((await scopedOperations(PS)).map((o) => o.operation_id), ["a1"]);
  assert.deepEqual((await scopedOperations(PS)).map((o) => o.operation_id), ["a1"], "cached");
  await localdb.operations.add(op("a2", "payout") as never);
  assert.deepEqual((await scopedOperations(PS)).map((o) => o.operation_id).sort(), ["a1", "a2"]);
  await localdb.operations.update("a1", { status: "synced" });
  assert.equal((await scopedOperations(PS)).find((o) => o.operation_id === "a1")?.status, "synced");
  await localdb.operations.where("operation_id").equals("a2").modify({ status: "needs_attention" });
  assert.equal((await scopedOperations(PS)).find((o) => o.operation_id === "a2")?.status, "needs_attention");
  await localdb.operations.delete("a2");
  assert.deepEqual((await scopedOperations(PS)).map((o) => o.operation_id), ["a1"]);
  const a = await scopedOperations(PS);
  a.push({} as never);
  assert.equal((await scopedOperations(PS)).length, 1, "callers get a fresh array");
});

test("the incremental operations mirror always equals toArray() (every write shape, aborts, clear, concurrency)", async () => {
  const { readAllOperationsMirrored } = await import("@/lib/offline/db");
  const same = async (why: string) => assert.deepEqual(await readAllOperationsMirrored(), await localdb.operations.toArray(), why);
  await localdb.operations.bulkAdd([op("m3", "payout"), op("m1", "payout"), op("m2", "payout")] as never);
  await same("bulkAdd (pk order)");
  await localdb.operations.update("m2", { status: "synced", synced_at: "2026-10-27T00:00:00.000Z" });
  await same("update");
  await localdb.operations.where("status").equals("pending").modify({ retry_count: 7 });
  await same("collection modify");
  await localdb.operations.put({ ...(op("m0", "payout") as object) } as never);
  await same("put new");
  await localdb.operations.bulkDelete(["m1"]);
  await same("bulkDelete");
  await localdb.operations.where("operation_id").startsWith("m3").delete();
  await same("collection delete");
  // An aborted transaction leaves the store (and the mirror) unchanged.
  await localdb
    .transaction("rw", localdb.operations, async () => {
      await localdb.operations.update("m2", { status: "needs_attention" });
      await localdb.operations.add(op("m9", "payout") as never);
      throw new Error("abort");
    })
    .catch(() => undefined);
  await same("aborted transaction");
  assert.equal((await localdb.operations.get("m2"))?.status, "synced");
  // Concurrent readers during a write never see a stale copy after the write resolved.
  const w = localdb.operations.add(op("m5", "payout") as never);
  const r1 = readAllOperationsMirrored();
  await w;
  const r2 = await readAllOperationsMirrored();
  await r1;
  assert.ok(r2.some((o) => o.operation_id === "m5"), "a read after the write resolved sees it");
  await same("after concurrency");
  await localdb.operations.clear();
  await same("clear");
});

test("customer scope cache: indexed, memoised, invalidated by every customer write; null branch falls back", async () => {
  const c = (id: string, branch: string | null, name: string) => ({ id, tenant_id: T, branch_id: branch, name, phone: null, phone_e164: null, addresses: null, notes: null, has_profile: false, cached_at: "x" });
  await cacheCustomers([c("c1", B, "A"), c("c2", "b2", "B"), c("c3", null, "C")] as never);
  assert.deepEqual((await listCachedCustomers(T, B)).map((x) => x.id), ["c1"]);
  assert.deepEqual((await listCachedCustomers(T, null)).map((x) => x.id), ["c3"]);
  await cacheCustomers([c("c4", B, "D")] as never);
  assert.deepEqual((await listCachedCustomers(T, B)).map((x) => x.id), ["c1", "c4"]);
  await localdb.posCustomers.delete("c1");
  assert.deepEqual((await listCachedCustomers(T, B)).map((x) => x.id), ["c4"]);
  await localdb.posCustomers.clear();
  assert.deepEqual(await listCachedCustomers(T, B), []);
});

test("indexed / bulk rewrites return exactly what the scans did", async () => {
  await localdb.entityMap.bulkAdd([
    { local_entity_id: "l1", entity_type: "order", canonical_id: "C1", resolved_at: "x", ...SC },
    { local_entity_id: "l2", entity_type: "order", canonical_id: "C1", resolved_at: "x", ...SC },
    { local_entity_id: "l3", entity_type: "order", canonical_id: "C3", resolved_at: "x", ...SC },
  ] as never);
  assert.deepEqual(await canonicalIds(["l1", "l3", "nope"]), { l1: "C1", l3: "C3", nope: null });
  assert.deepEqual((await localAliasesOf("C1")).sort(), ["l1", "l2"]);
  assert.deepEqual(await localAliasesOf("none"), []);
  const txn = (id: string, over: Record<string, unknown>) => ({ local_txn_id: id, client_op_id: id, tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U, cashier_user_name: "x", shift_id: "s", created_at: `2026-10-27T0${id.slice(-1)}:00:00.000Z`, order_payload: { order_type: "takeaway" }, payment_intent: null, sent_to_kitchen: true, currency: "USD", total: 1, status: "queued", attempts: 0, ...over });
  await localdb.posOfflineTxns.bulkAdd([txn("x3", {}), txn("x1", {}), txn("x2", { status: "synced" }), txn("x4", { tenant_id: "t2" }), txn("x5", { order_payload: { order_type: "delivery" } }), txn("x6", { paid: true })] as never);
  assert.deepEqual((await listResumablePosTxns(T, B, U)).map((t) => t.local_txn_id), ["x1", "x3"]);
  assert.deepEqual(await listResumablePosTxns(null, B, U), []);
  await localdb.receipts.bulkAdd([
    { ref: "r1", data: 1, tenant_id: T, branch_id: B, provisional: false, created_at: "2026-10-27T01:00:00.000Z" },
    { ref: "r2", data: 2, tenant_id: "t2", branch_id: B, provisional: false, created_at: "2026-10-27T03:00:00.000Z" },
    { ref: "r3", data: 3, tenant_id: T, branch_id: B, provisional: false, created_at: "2026-10-27T02:00:00.000Z" },
  ] as never);
  assert.equal((await readLatestReceiptSnapshot(T))?.ref, "r3");
  assert.equal((await readLatestReceiptSnapshot())?.ref, "r2");
});
