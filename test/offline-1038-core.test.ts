// 1.0.38 Workstream A — replay core (Bugs 2 + 8; shared causes C1, C2/D1, C4, C5, C6, D5).
// Drives the REAL Dexie stores via fake-indexeddb; every server call is injected.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, addPosOfflineTxn, updatePosOfflineTxn, type PosOfflineTxn } from "@/lib/offline/db";
import { migrateLegacyToOperations, reconcileLegacyFromOperations } from "@/lib/offline/migration";
import { drainOperations, drainOffline, __resetDrainLockForTests, __setReplayTimeoutForTests, serverRetryBudget } from "@/lib/offline/orchestrator";
import {
  type OfflineOperation,
  addOperation,
  getOperation,
  requeueOperation,
  onDrainRequested,
  gcSyncedOperations,
  summarizeOperations,
  unsettledOperationCountForDevice,
  localEntityIdsNeededByUnsettledOps,
} from "@/lib/offline/operationLog";
import { resolveEntity } from "@/lib/offline/entityMap";
import { classifyReplayError, terminalKind, type PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { PosRpcError } from "@/lib/pos/rpc";

const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };
const SCOPE = { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" };
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

let seq = 0;
function op(id: string, type: string, over: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: id,
    operation_type: type,
    schema_version: 1,
    scope: { ...SCOPE },
    created_at: new Date(Date.UTC(2026, 9, 26, 10, 0, 0, seq++)).toISOString(),
    client_op_id: "c-" + id,
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: {},
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    ...over,
  };
}
const payOrder = (id: string, over: Partial<OfflineOperation> = {}) =>
  op(id, "pay_order", { payload: { order_id: "SRV-" + id, order_local: null, method: "cash", currency: "USD" }, ...over });

type Log = { pays: string[]; submits: number; cashPays: number; refreshes: number };
function deps(log: Log, over: Partial<PosTxnSyncDeps> = {}): Partial<PosTxnSyncDeps> {
  return {
    payOrderOp: async (a) => { log.pays.push(a.orderId); return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; },
    submit: async () => { log.submits++; return { order_id: "SRV-ORDER-" + log.submits, order_number: "N" + log.submits }; },
    pay: async () => { log.cashPays++; return {}; },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    refreshSession: async () => { log.refreshes++; return true; },
    ...over,
  };
}
const newLog = (): Log => ({ pays: [], submits: 0, cashPays: 0, refreshes: 0 });
/** Clear the backoff window so the next drain re-attempts a retryable op. */
async function expireBackoff(id: string) {
  await localdb.operations.update(id, { last_attempt_at: new Date(Date.now() - 3600_000).toISOString() });
}

beforeEach(async () => {
  for (const t of [localdb.posOfflineTxns, localdb.pendingShifts, localdb.outbox, localdb.operations, localdb.entityMap, localdb.syncHistory, localdb.posCustomers]) await t.clear();
  __resetDrainLockForTests();
  __setReplayTimeoutForTests(45_000);
});

// ---------------- C1: one classifier ----------------

const rpcErr = (message: string, status: number | null, code: string | null, details: string | null = null) =>
  new PosRpcError("pos_pay_order", message, { status, code, details });

test("C1 classification table", () => {
  const table: [unknown, string][] = [
    [new TypeError("Failed to fetch"), "transport"],
    [rpcErr("Bad Gateway", 502, null), "transient"],
    [rpcErr("<html>error code: 522</html>", 522, null), "transient"],
    [rpcErr("Request Timeout", 408, null), "transport"], // "timeout" wording is already transport-retryable
    [rpcErr("Request rejected", 408, null), "transient"],
    [rpcErr("Too Many Requests", 429, null), "transient"],
    [rpcErr("deadlock detected", 500, "40P01"), "transient"],
    [rpcErr("could not serialize access due to concurrent update", 500, "40001"), "transient"],
    [rpcErr("cannot execute INSERT in a read-only transaction", 500, "25006"), "transient"],
    [rpcErr("could not obtain lock on row", 500, "55P03"), "transient"],
    [rpcErr("MERGE_SHIFT_BUSY: a table is being changed", 400, "P0001"), "transient"],
    [new Error("upstream connect error or disconnect/reset before headers"), "transient"],
    [rpcErr("JWT expired", 401, "PGRST301"), "auth"],
    [new Error("invalid JWT"), "auth"],
    // RC-AUTH-1: 401 + 42501 = the request had no valid session (anonymous) → re-authenticate, not a refusal.
    [rpcErr("permission denied for function pos_pay_order", 401, "42501"), "auth"],
    [rpcErr("permission denied for function pos_pay_order", 403, "42501"), "business"],
    [rpcErr("You do not have permission to take payments", 403, "42501"), "business"],
    [rpcErr("This order changed since it was loaded.", 400, "P0001", "VERSION_CONFLICT"), "business"],
    [rpcErr("Invalid discount value", 400, "22023"), "business"],
    [new Error('The refundable amount changed. {"pos_error_code":"REFUND_AMOUNT_MISMATCH"}'), "business"],
    [new Error("CUSTOMER_IDENTITY_CONFLICT: a different customer already has this number"), "business"],
    [new Error("You do not have permission to open a shift"), "business"],
    [new Error("Shift not found for this tenant/branch"), "business"],
    [new Error("something odd happened"), "unknown"],
  ];
  for (const [e, kind] of table) assert.equal(classifyReplayError(e), kind, String((e as Error).message));
  // terminalKind no longer calls a read-only failover / bad JWT a validation refusal.
  assert.equal(terminalKind("cannot execute INSERT in a read-only transaction"), null);
  assert.equal(terminalKind("invalid JWT"), null);
  assert.equal(terminalKind("Invalid discount value"), "validation");
});

test("C1 PosRpcError keeps HTTP status + PG code + details", () => {
  const e = rpcErr("x", 503, "40001", "d");
  assert.equal(e.status, 503);
  assert.equal(e.code, "40001");
  assert.equal(e.details, "d");
  assert.equal(new PosRpcError("pos_pay_order", "y").status, null);
});

test("C1 a 5xx replay stays retryable (bounded), a structured refusal parks, unknown retries then parks", async () => {
  await addOperation(payOrder("P5"));
  await addOperation(payOrder("PB"));
  await addOperation(payOrder("PU"));
  const log = newLog();
  const d = deps(log, {
    payOrderOp: async (a) => {
      if (a.orderId === "SRV-P5") throw rpcErr("Service Unavailable", 503, null);
      if (a.orderId === "SRV-PB") throw rpcErr("Invalid tender for this order", 400, "P0001", "TENDER_INVALID");
      throw new Error("something odd happened");
    },
  });
  await drainOperations(CTX, "t", d);
  assert.equal((await getOperation("P5"))?.status, "retryable");
  assert.equal((await getOperation("P5"))?.last_error_code, "server_transient");
  assert.equal((await getOperation("PB"))?.status, "needs_attention");
  assert.equal((await getOperation("PU"))?.status, "retryable");
  assert.equal((await getOperation("PU"))?.last_error_code, "unclassified_error");
  // Unknown: bounded (3 attempts) then needs_attention, never infinite.
  for (let i = 1; i < serverRetryBudget("unclassified_error"); i++) {
    await expireBackoff("PU");
    await expireBackoff("P5");
    await drainOperations(CTX, "t", d);
  }
  const pu = await getOperation("PU");
  assert.equal(pu?.status, "needs_attention");
  assert.equal(pu?.last_error_code, "retry_exhausted");
  assert.match(pu?.last_error_message ?? "", /^unclassified_error: something odd/);
  // The transient one is still retrying (larger budget) — not parked after 3.
  assert.equal((await getOperation("P5"))?.status, "retryable");
  assert.equal((await getOperation("P5"))?.server_retry_count, 3);
});

test("C1 an expired JWT refreshes the session once per pass and stays retryable; success resets the budget", async () => {
  await addOperation(payOrder("J1"));
  await addOperation(payOrder("J2"));
  const log = newLog();
  let expired = true;
  const d = deps(log, {
    payOrderOp: async (a) => {
      if (expired) throw rpcErr("JWT expired", 401, "PGRST301");
      log.pays.push(a.orderId);
      return { order_id: a.orderId, paid: true, amount: 1, idempotent: false };
    },
  });
  await drainOperations(CTX, "t", d);
  assert.equal((await getOperation("J1"))?.status, "retryable");
  assert.equal((await getOperation("J1"))?.last_error_code, "auth_expired");
  assert.equal(log.refreshes, 1, "one refresh per pass, not per op");
  expired = false;
  await expireBackoff("J1");
  await expireBackoff("J2");
  await drainOperations(CTX, "t", d);
  assert.equal((await getOperation("J1"))?.status, "synced");
  assert.equal((await getOperation("J1"))?.server_retry_count, 0);
  assert.deepEqual(log.pays.sort(), ["SRV-J1", "SRV-J2"]);
});

// ---------------- C2 / D1: dependents recover ----------------

test("C2 dependency_failed dependents re-open automatically once the prerequisite recovers (whole chain)", async () => {
  await addOperation(payOrder("A", { status: "needs_attention", last_error_code: "validation", last_error_message: "x" }));
  await addOperation(payOrder("B", { dependency_ids: ["A"] }));
  await addOperation(payOrder("C", { dependency_ids: ["B"] }));
  const log = newLog();
  await drainOperations(CTX, "t", deps(log));
  assert.equal((await getOperation("B"))?.last_error_code, "dependency_failed");
  assert.equal((await getOperation("C"))?.last_error_code, "dependency_failed");
  // The root is resolved (e.g. synced through another path) — the next pass re-opens B then C and replays both.
  await localdb.operations.update("A", { status: "synced", synced_at: new Date().toISOString(), last_error_code: null });
  const r = await drainOperations(CTX, "t", deps(log));
  assert.deepEqual(r.reopened, ["B", "C"]);
  assert.equal((await getOperation("B"))?.status, "synced");
  assert.equal((await getOperation("C"))?.status, "synced");
  assert.deepEqual(log.pays, ["SRV-B", "SRV-C"]);
});

test("C2 a dependent whose prerequisite is STILL parked stays parked (no churn, no replay)", async () => {
  await addOperation(payOrder("A", { status: "needs_attention", last_error_code: "validation" }));
  await addOperation(payOrder("B", { status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "A", dependency_ids: ["A"] }));
  const log = newLog();
  const r = await drainOperations(CTX, "t", deps(log));
  assert.equal(r.reopened, undefined);
  assert.equal((await getOperation("B"))?.status, "needs_attention");
  assert.equal(log.pays.length, 0);
});

test("C2 operator Retry cascades to the dependency_failed chain only, and requests a drain", async () => {
  await addOperation(payOrder("A", { status: "needs_attention", last_error_code: "server_transient" }));
  await addOperation(payOrder("B", { status: "needs_attention", last_error_code: "dependency_failed", dependency_ids: ["A"] }));
  await addOperation(payOrder("C", { status: "needs_attention", last_error_code: "dependency_failed", dependency_ids: ["B"] }));
  await addOperation(payOrder("X", { status: "needs_attention", last_error_code: "validation" }));
  await addOperation(payOrder("Y", { status: "needs_attention", last_error_code: "dependency_failed", dependency_ids: ["X"] }));
  // A foreign-scope dependent is never touched.
  await addOperation(payOrder("F", { status: "needs_attention", last_error_code: "dependency_failed", dependency_ids: ["A"], scope: { ...SCOPE, cashier_user_id: "u2" } }));
  const reasons: string[] = [];
  const off = onDrainRequested((r) => reasons.push(r));
  try {
    assert.equal(await requeueOperation("A"), true);
  } finally {
    off();
  }
  for (const id of ["A", "B", "C"]) assert.equal((await getOperation(id))?.status, "pending", id);
  for (const id of ["X", "Y", "F"]) assert.equal((await getOperation(id))?.status, "needs_attention", id);
  assert.deepEqual(reasons, ["operator-retry"]);
  // And the requested drain settles the whole chain.
  const log = newLog();
  await drainOperations(CTX, "t", deps(log));
  assert.deepEqual(log.pays, ["SRV-A", "SRV-B", "SRV-C"]);
});

test("D1 a local-entity dependency whose producer is parked surfaces as dependency_failed naming it (not waiting forever)", async () => {
  await addOperation(op("CU", "customer_upsert", { local_entity_id: "cust-local", status: "needs_attention", last_error_code: "customer_identity_conflict", payload: { upsert: {}, local_address_id: "addr-local" } }));
  await addOperation(op("ORD", "pay_order", { depends_on_local_entities: ["cust-local"], payload: { order_id: "SRV-O", order_local: null, method: "cash", currency: "USD" } }));
  // Address-only dependency (not in depends_on_local_entities) escalates too.
  await addOperation(op("ORD2", "takeaway_sale", { payload: { order_payload: { items: [] }, payment_intent: null, address_local: "addr-local" } }));
  const log = newLog();
  await drainOperations(CTX, "t", deps(log));
  const o = await getOperation("ORD");
  assert.equal(o?.status, "needs_attention");
  assert.equal(o?.last_error_code, "dependency_failed");
  assert.equal(o?.last_error_message, "CU");
  assert.equal((await getOperation("ORD2"))?.last_error_message, "CU");
  assert.equal(log.pays.length + log.submits, 0);
  // Retrying the customer create cascades through the entity edge.
  await requeueOperation("CU");
  assert.equal((await getOperation("ORD"))?.status, "pending");
  assert.equal((await getOperation("ORD2"))?.status, "pending");
});

test("D1 a local-entity dependency whose producer is still pending keeps waiting (unchanged)", async () => {
  await addOperation(op("CU", "customer_upsert", { local_entity_id: "cust-local", status: "retryable", last_attempt_at: new Date().toISOString(), retry_count: 1 }));
  await addOperation(op("ORD", "pay_order", { depends_on_local_entities: ["cust-local"], payload: { order_id: "SRV-O", order_local: null, method: "cash", currency: "USD" } }));
  await drainOperations(CTX, "t", deps(newLog()));
  assert.equal((await getOperation("ORD"))?.status, "blocked_dependency");
});

// ---------------- D5: watchdog + single flight ----------------

test("D5 a hung replay RPC times out, releases the drain lock, and later writes are ignored", async () => {
  __setReplayTimeoutForTests(40);
  await addOperation(payOrder("H"));
  const log = newLog();
  let release: () => void = () => {};
  const hung = new Promise<void>((r) => { release = r; });
  const r1 = await drainOffline(CTX, "t", deps(log, { payOrderOp: async (a) => { await hung; return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; } }));
  assert.deepEqual(r1.retryable, ["H"]);
  const h = await getOperation("H");
  assert.equal(h?.status, "retryable");
  assert.equal(h?.last_error_code, "replay_timeout");
  // The lock is free: a new pass runs (and replays the op idempotently).
  await expireBackoff("H");
  const r2 = await drainOffline(CTX, "t", deps(log));
  assert.deepEqual(r2.drained, ["H"]);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await getOperation("H"))?.status, "synced", "a late completion of the abandoned call never rewrites the op");
});

test("D5 drains are single-flight: a concurrent pass returns an empty report", async () => {
  await addOperation(payOrder("S"));
  const log = newLog();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const first = drainOffline(CTX, "t", deps(log, { payOrderOp: async (a) => { await gate; log.pays.push(a.orderId); return { order_id: a.orderId, paid: true, amount: 1, idempotent: false }; } }));
  await new Promise((r) => setTimeout(r, 20));
  const second = await drainOffline(CTX, "periodic", deps(log));
  assert.deepEqual(second.drained, []);
  release();
  await first;
  assert.deepEqual(log.pays, ["SRV-S"]);
});

test("D5 source: periodic drain is bounded, online-only, scoped, single-flight; operator retry triggers a drain", () => {
  const s = src("src/screens/pos/PosWorkspace.tsx");
  assert.match(s, /window\.setInterval\(\(\) => void tick\(\), 45_000\)/);
  assert.match(s, /if \(periodicBusy\.current\) return;/);
  assert.match(s, /onDrainRequested\(\(\) => \{\s*void drainWithFreshContext\("operator-retry"\)/);
  assert.match(s, /sum\.pending \+ sum\.syncing \+ sum\.retryable \+ sum\.waiting_dependency \+ sum\.legacy_pending > 0/);
  assert.ok(!s.includes("pendingCount()"), "the dormant outbox count is gone from the POS badge");
});

// ---------------- C4: drain in the capture (pinned) branch ----------------

test("C4 source: the drain context and the customer scope use the pinned operational branch", () => {
  const ws = src("src/screens/pos/PosWorkspace.tsx");
  assert.match(ws, /branchId: resolveBranchId\(s\.tenant, s\.membership, useOperationalBranch\.getState\(\)\.getBranch\(t, u\)\)/);
  const cc = src("src/lib/offline/customerCache.ts");
  assert.match(cc, /resolveBranchId\(s\.tenant, s\.membership, pinned\)/);
});

test("C4 ops captured in a pinned non-Main branch replay under that branch's context (and are deferred under Main)", async () => {
  await addOperation(payOrder("PIN", { scope: { ...SCOPE, branch_id: "b-pinned" } }));
  const log = newLog();
  const main = await drainOperations({ ...CTX, branchId: "b-main" }, "t", deps(log));
  assert.deepEqual(main.deferred, ["PIN"]);
  const pinned = await drainOperations({ ...CTX, branchId: "b-pinned" }, "t", deps(log));
  assert.deepEqual(pinned.drained, ["PIN"]);
});

test("C4 Device Settings locks the terminal id while this device holds unsettled work", async () => {
  assert.equal(await unsettledOperationCountForDevice("dev1"), 0);
  await addOperation(payOrder("D1", { status: "needs_attention" }));
  await addOperation(payOrder("D2", { status: "synced" }));
  await addOperation(payOrder("D3", { scope: { ...SCOPE, device_id: "other" } }));
  assert.equal(await unsettledOperationCountForDevice("dev1"), 1);
  const s = src("src/screens/settings/DeviceSettings.tsx");
  assert.match(s, /disabled=\{terminalLocked\}/);
  assert.match(s, /const terminalId = n === 0 \? terminal\.trim\(\) \|\| dev\.terminal_id : dev\.terminal_id;/);
});

// ---------------- C5: payment after a flap ----------------

function txn(over: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  const id = over.local_txn_id ?? "T1";
  return { local_txn_id: id, client_op_id: "op-" + id, tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1", cashier_user_name: "C", shift_id: "SRV-SHIFT", created_at: new Date().toISOString(), order_payload: { client_op_id: "op-" + id, order_type: "takeaway", shift_id: "SRV-SHIFT", items: [] }, payment_intent: null, currency: "USD", total: 10, status: "queued", attempts: 0, pending_shift_local_id: null, ...over } as PosOfflineTxn;
}

test("C5 flap: send offline → partial drain → pay offline → drain: the payment replays exactly once", async () => {
  await addPosOfflineTxn(txn());
  const log = newLog();
  // 1. Brief reconnect: migrated (payment_intent null) but the submit fails on transport.
  await drainOffline(CTX, "flap", deps(log, { submit: async () => { throw new TypeError("Failed to fetch"); } }));
  assert.equal((await getOperation("mig:txn:T1"))?.status, "retryable");
  // 2. Offline again: the cashier takes cash; only the LEGACY row learns about it.
  await updatePosOfflineTxn("T1", { payment_intent: { method: "cash", currency: "USD" }, status: "queued", paid: false });
  // 3. Reconnect: the bridge merges the intent into the not-yet-synced op, then it submits + pays.
  await expireBackoff("mig:txn:T1");
  await drainOffline(CTX, "reconnect", deps(log));
  const o = await getOperation("mig:txn:T1");
  assert.equal(o?.status, "synced");
  assert.equal((o?.payload as { paid?: boolean }).paid, true);
  assert.equal(log.submits, 1);
  assert.equal(log.cashPays, 1);
  assert.equal((await localdb.posOfflineTxns.get("T1"))?.status, "synced");
  // 4. Idempotent: further drains/migrations never pay again.
  await drainOffline(CTX, "again", deps(log));
  await migrateLegacyToOperations();
  await drainOffline(CTX, "again", deps(log));
  assert.equal(log.cashPays, 1);
  assert.equal(log.submits, 1);
});

test("C5 the bridge also reaches a parked (needs_attention) op, exactly once, without changing its status", async () => {
  await addPosOfflineTxn(txn());
  await migrateLegacyToOperations();
  await localdb.operations.update("mig:txn:T1", { status: "needs_attention", last_error_code: "validation" });
  await updatePosOfflineTxn("T1", { payment_intent: { method: "cash", currency: "USD" }, status: "queued" });
  await migrateLegacyToOperations();
  const a = await getOperation("mig:txn:T1");
  assert.equal(a?.status, "needs_attention");
  assert.deepEqual((a?.payload as { payment_intent: unknown }).payment_intent, { method: "cash", currency: "USD" });
  const r = await migrateLegacyToOperations();
  assert.equal(r.skippedAlreadyMigrated, 1, "second migrate is a no-op");
});

test("C5 race: a payment captured while the op replayed submit-only is not reconciled away", async () => {
  await addPosOfflineTxn(txn());
  await migrateLegacyToOperations();
  // The op synced submit-only, and the legacy row gained the payment in the meantime.
  await localdb.operations.update("mig:txn:T1", { status: "synced", canonical_entity_id: "SRV-ORDER-1", synced_at: new Date().toISOString() });
  await updatePosOfflineTxn("T1", { payment_intent: { method: "cash", currency: "USD" }, status: "queued" });
  await reconcileLegacyFromOperations();
  assert.equal((await localdb.posOfflineTxns.get("T1"))?.status, "queued", "row stays queued for the bridge");
  // The badge shows it as still to sync.
  assert.equal((await summarizeOperations({ tenantId: "t1" })).legacy_pending, 1);
  const log = newLog();
  await drainOffline(CTX, "r", deps(log));
  assert.equal(log.submits, 0, "never re-submitted");
  assert.equal(log.cashPays, 1);
});

// ---------------- C6: GC reference safety ----------------

test("C6 GC keeps a synced op that an unsettled op still references; deletes unreferenced old ones", async () => {
  const old = new Date(Date.now() - 9 * 24 * 3600_000).toISOString();
  await addOperation(payOrder("S-REF", { status: "synced", synced_at: old }));
  await addOperation(payOrder("S-VER", { status: "synced", synced_at: old }));
  await addOperation(payOrder("S-OLD", { status: "synced", synced_at: old }));
  await addOperation(payOrder("W", { status: "needs_attention", dependency_ids: ["S-REF"] }));
  await addOperation(op("E", "edit_order_line", { payload: { payload: {}, order_local: null, version_after_op: "S-VER" } }));
  assert.equal(await gcSyncedOperations(), 1);
  assert.ok(await getOperation("S-REF"));
  assert.ok(await getOperation("S-VER"));
  assert.equal(await getOperation("S-OLD"), undefined);
});

test("C6 a dependency GC'd after it synced (proven by history + entity map) does not park a new op", async () => {
  await localdb.syncHistory.add({ at: new Date().toISOString(), operation_id: "GONE", operation_type: "dinein_open_table", action_label: "Open Table", tenant_id: "t1", branch_id: "b1", device_id: "dev1", cashier_user_id: "u1", local_ref: "table-local", canonical_ref: "SRV-T", status: "synced", retry_count: 1, error_summary: null, synced_at: new Date().toISOString() });
  await resolveEntity({ local_entity_id: "table-local", entity_type: "table", canonical_id: "SRV-T", resolved_at: new Date().toISOString(), ...SCOPE });
  await addOperation(payOrder("NEW", { dependency_ids: ["GONE"] }));
  // An unproven missing dependency still parks (never assumed done).
  await addOperation(payOrder("BAD", { dependency_ids: ["NEVER-EXISTED"] }));
  const log = newLog();
  await drainOperations(CTX, "t", deps(log));
  assert.equal((await getOperation("NEW"))?.status, "synced");
  assert.equal((await getOperation("BAD"))?.last_error_code, "missing_dependency");
});

// ---------------- summary helper + sign-out keep set ----------------

test("summarizeOperations counts per state (scoped; branch null = tenant-wide) incl. unstaged legacy rows", async () => {
  await addOperation(payOrder("p1"));
  await addOperation(payOrder("p2", { status: "retryable" }));
  await addOperation(payOrder("p3", { status: "blocked_dependency" }));
  await addOperation(payOrder("p4", { status: "needs_attention" }));
  await addOperation(payOrder("p5", { status: "synced" }));
  await addOperation(payOrder("p6", { status: "syncing" }));
  await addOperation(payOrder("o1", { scope: { ...SCOPE, branch_id: "b2" } }));
  await addPosOfflineTxn(txn({ local_txn_id: "UNSTAGED" }));
  const s = await summarizeOperations({ tenantId: "t1", branchId: "b1" });
  assert.deepEqual(s, { pending: 1, syncing: 1, retryable: 1, waiting_dependency: 1, needs_attention: 1, synced: 1, legacy_pending: 1, unsettled: 6 });
  assert.equal((await summarizeOperations({ tenantId: "t1", branchId: null })).pending, 2);
  assert.equal((await summarizeOperations({ tenantId: "t1" }, { includeSynced: false })).synced, 0);
  assert.equal((await summarizeOperations({ tenantId: "other" })).unsettled, 0);
});

test("sign-out keeps offline-created customers that unsettled work still needs", async () => {
  await addOperation(op("CU", "customer_upsert", { local_entity_id: "cust-local", payload: { upsert: {}, local_address_id: "addr-local" } }));
  await addOperation(payOrder("PO", { depends_on_local_entities: ["cust-2"] }));
  await addOperation(op("DONE", "customer_upsert", { local_entity_id: "cust-synced", status: "synced" }));
  const keep = await localEntityIdsNeededByUnsettledOps();
  assert.ok(keep.has("cust-local") && keep.has("addr-local") && keep.has("cust-2"));
  assert.ok(!keep.has("cust-synced"));
  const s = src("src/state/session.ts");
  assert.match(s, /await dropCachedCustomersKeepingUnsettled\(\)\.catch/);
  assert.ok(!/await clearCachedCustomers\(\)\.catch/.test(s), "sign-out no longer clears every customer");
});
