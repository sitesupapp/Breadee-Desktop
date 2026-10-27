// Final Foundation (PERF, Track 10) — bounded local retention (src/lib/offline/retention.ts).
//
// Proves: (1) nothing REQUIRED is ever removed — unsettled / parked / conflict / legacy-quarantine ops,
// anything they reference (transitively), open-shift work, legacy rows + their migrated ops, open or
// unsettled dine-in sessions, entity mappings still named anywhere, and the sync-history events the
// orchestrator's provenGoneSynced reads; (2) the 1.0.37 → 1.0.38 upgrade fixture semantics hold when the
// whole fixture is OLD (every chain still drains exactly as before); (3) unbounded growth stops: a
// simulated 150-day tenure stays bounded; (4) drainOffline runs it under the lock, throttled.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
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
const storage = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;

const { localdb } = await import("@/lib/offline/db");
const R = await import("@/lib/offline/retention");
const { drainOffline, __resetDrainLockForTests } = await import("@/lib/offline/orchestrator");

const T = "t1", B = "b1", DEV = "dev-1", TERM = "TERM-1", U = "u1";
const SC = { tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U };
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function op(id: string, type: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation_id: id, operation_type: type, schema_version: 1, scope: { ...SC }, created_at: ago(100 * DAY), client_op_id: "cop-" + id,
    local_entity_id: null, canonical_entity_id: null, dependency_ids: [], depends_on_local_entities: [], payload: {}, status: "synced",
    retry_count: 1, last_attempt_at: ago(100 * DAY), last_error_code: null, last_error_message: null, result_meta: null, synced_at: ago(100 * DAY), ...over,
  };
}
const mapping = (local: string, canonical: string, at: number) => ({ local_entity_id: local, entity_type: "order", canonical_id: canonical, resolved_at: ago(at), ...SC });
const hist = (operation_id: string, status: string, at: number, extra: Record<string, unknown> = {}) => ({
  at: ago(at), operation_id, operation_type: "x", action_label: "x", tenant_id: T, branch_id: B, device_id: DEV, cashier_user_id: U, local_ref: null, canonical_ref: null, status, retry_count: 1, error_summary: null, synced_at: null, ...extra,
});
const txn = (id: string, status: string, at: number, over: Record<string, unknown> = {}) => ({
  local_txn_id: id, client_op_id: "cop-txn-" + id, tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U, cashier_user_name: "x",
  shift_id: "SH-OLD", created_at: ago(at), order_payload: { order_type: "takeaway", shift_id: "SH-OLD" }, payment_intent: { method: "cash", currency: "USD" }, sent_to_kitchen: true,
  currency: "USD", total: 12, status, attempts: 1, ...over,
});
const draft = (id: string, status: string, at: number, over: Record<string, unknown> = {}) => ({
  local_session_id: id, tenant_id: T, branch_id: B, cashier_user_id: U, device_id: DEV, terminal_id: TERM, floor_id: null, section_id: null, table_id: "TB-" + id,
  table_name: id, currency: "USD", open_operation_id: "open-" + id, canonical_order_id: null, origin: "offline", base_order_version: null, status, shift_id: "SH-OLD",
  shift_local: null, lines: [], rounds: [], draft_revision: 1, notes: null, created_at: ago(at), updated_at: ago(at), ...over,
});

async function clearAll() {
  for (const t of localdb.tables) await t.clear();
  storage.clear();
  R.__resetRetentionForTests();
  __resetDrainLockForTests();
}
beforeEach(clearAll);

const ids = async (table: { toCollection(): { primaryKeys(): Promise<unknown[]> } }) => ((await table.toCollection().primaryKeys()) as string[]).map(String).sort();

test("retention keeps every op that is still required and prunes only old, unreferenced synced ops", async () => {
  await localdb.operations.bulkAdd([
    op("old-free", "payout"), // old, synced, unreferenced → pruned
    op("old-dep-root", "dinein_open_table"), // transitive prerequisite of a parked op → kept
    op("old-dep", "dinein_send_round", { dependency_ids: ["old-dep-root"] }), // prerequisite of a parked op → kept
    op("old-version-src", "edit_order_line"), // version source of a pending op → kept
    op("old-line-src", "add_order_items"), // line source of a pending op → kept
    op("old-open-shift-work", "payout", { payload: { shift_id: "SH-OPEN" } }), // inside the persisted open shift → kept
    op("mig:shift:LS-1", "open_shift", { local_entity_id: "LS-1" }), // pendingShifts never pruned → kept
    op("recent", "payout", { created_at: ago(5 * DAY), synced_at: ago(5 * DAY) }), // within 30 days → kept
    op("old-cancelled", "payout", { status: "cancelled", synced_at: null }), // terminal non-synced → kept
    op("parked", "pay_table", { status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "old-dep", dependency_ids: ["old-dep"] }),
    op("conflict", "pay_table", { status: "needs_attention", last_error_code: "pay_amount_changed" }),
    op("mig:outbox:1", "legacy_outbox:pos.save_order", { status: "needs_attention", last_error_code: "unknown_handler" }),
    op("pending-edit", "edit_order_line", { status: "pending", payload: { version_after_op: "old-version-src", target_ref: { kind: "after", op_id: "old-line-src" } } }),
    op("retry", "takeaway_sale", { status: "retryable" }),
    op("blocked", "takeaway_sale", { status: "blocked_dependency" }),
    op("syncing", "takeaway_sale", { status: "syncing" }),
  ] as never);
  storage.setItem("breadee-desktop-pos-session", JSON.stringify({ version: 1, source: "server", savedAt: Date.now(), device_id: DEV, tenant_id: T, cashier_user_id: U, branch_id: B, branch_name: "Main", currency: "USD", shift: { id: "SH-OPEN", status: "open", opened_at: null, opening_cash_amount: 0, branch_id: B } }));
  await localdb.pendingShifts.add({ local_shift_id: "LS-1", client_op_id: "c", tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U, opening_cash_amount: 0, currency: "USD", opened_at: ago(100 * DAY), status: "synced", server_shift_id: "SH-X", attempts: 1 } as never);

  const r = await R.runRetention({ now: NOW });
  assert.equal(r.operations, 1);
  assert.deepEqual(await ids(localdb.operations), [
    "blocked", "conflict", "mig:outbox:1", "mig:shift:LS-1", "old-cancelled", "old-dep", "old-dep-root", "old-line-src", "old-open-shift-work", "old-version-src", "parked", "pending-edit", "recent", "retry", "syncing",
  ]);
  // Idempotent.
  assert.equal((await R.runRetention({ now: NOW })).operations, 0);
});

test("legacy offline sales are pruned only when synced + reconciled + old, together with their migrated op", async () => {
  await localdb.posOfflineTxns.bulkAdd([
    txn("TX-OLD", "synced", 60 * DAY), // pruned with mig:txn:TX-OLD
    txn("TX-RECENT", "synced", 3 * DAY), // kept (window)
    // Unsynced legacy sales (their shift is unsynced work too — a different shift here).
    txn("TX-QUEUED", "queued", 60 * DAY, { shift_id: "SH-Q", order_payload: { shift_id: "SH-Q" } }), // kept (not synced)
    txn("TX-ATTN", "needs_attention", 60 * DAY, { shift_id: "SH-Q", order_payload: { shift_id: "SH-Q" } }), // kept
    txn("TX-OPENSHIFT", "synced", 60 * DAY, { shift_id: "SH-LIVE", order_payload: { shift_id: "SH-LIVE" } }), // kept: shift still has live work
  ] as never);
  await localdb.operations.bulkAdd([
    op("mig:txn:TX-OLD", "takeaway_sale", { local_entity_id: "TX-OLD" }),
    op("mig:txn:TX-RECENT", "takeaway_sale", { local_entity_id: "TX-RECENT", synced_at: ago(3 * DAY) }),
    op("mig:txn:TX-QUEUED", "takeaway_sale", { local_entity_id: "TX-QUEUED" }), // synced op + QUEUED row = C5 bridge → kept
    op("mig:txn:TX-ATTN", "takeaway_sale", { local_entity_id: "TX-ATTN", status: "needs_attention", synced_at: null }),
    op("mig:txn:TX-OPENSHIFT", "takeaway_sale", { local_entity_id: "TX-OPENSHIFT" }),
    op("live-in-shift", "payout", { status: "pending", payload: { shift_id: "SH-LIVE" } }),
  ] as never);
  await localdb.entityMap.bulkAdd([mapping("TX-OLD", "ORD-OLD", 60 * DAY), mapping("TX-QUEUED", "ORD-Q", 60 * DAY)] as never);

  const r = await R.runRetention({ now: NOW });
  assert.equal(r.posOfflineTxns, 1);
  assert.deepEqual(await ids(localdb.posOfflineTxns), ["TX-ATTN", "TX-OPENSHIFT", "TX-QUEUED", "TX-RECENT"]);
  assert.deepEqual(await ids(localdb.operations), ["live-in-shift", "mig:txn:TX-ATTN", "mig:txn:TX-OPENSHIFT", "mig:txn:TX-QUEUED", "mig:txn:TX-RECENT"]);
  // The pruned sale's mapping is no longer named anywhere → pruned; the queued sale's mapping is kept.
  assert.deepEqual(await ids(localdb.entityMap), ["TX-QUEUED"]);
  // A migrate after retention re-stages NOTHING (no churn): the legacy row went with its op.
  const { migrateLegacyToOperations } = await import("@/lib/offline/migration");
  const m = await migrateLegacyToOperations();
  assert.equal(m.txnsMigrated, 0);
});

test("dine-in sessions: only settled/closed old sessions with no unsettled work are pruned; their ops follow", async () => {
  await localdb.dineDrafts.bulkAdd([
    draft("S-OLD", "settled", 60 * DAY, { settled_operation_id: "settle-S-OLD", rounds: [{ round_local_id: "r1", operation_id: "round-S-OLD", seq: 1, line_ids: [], print_state: "printed", sent_at: ago(60 * DAY) }] }),
    draft("S-OPEN", "open", 60 * DAY, { shift_id: "SH-OPENDRAFT" }), // open → kept, and its ops stay
    draft("S-PARKED", "settled", 60 * DAY, { settled_operation_id: "settle-S-PARKED" }), // settle still parked → kept
    draft("S-RECENT", "closed", 2 * DAY),
  ] as never);
  await localdb.operations.bulkAdd([
    op("open-S-OLD", "dinein_open_table"),
    op("round-S-OLD", "dinein_send_round", { dependency_ids: ["open-S-OLD"] }),
    op("settle-S-OLD", "pay_table"),
    op("open-S-OPEN", "dinein_open_table"),
    op("open-S-PARKED", "dinein_open_table"),
    op("settle-S-PARKED", "pay_table", { status: "needs_attention", last_error_code: "retry_exhausted" }),
    op("open-S-RECENT", "dinein_open_table"),
  ] as never);
  const r = await R.runRetention({ now: NOW });
  assert.equal(r.dineDrafts, 1);
  assert.deepEqual(await ids(localdb.dineDrafts), ["S-OPEN", "S-PARKED", "S-RECENT"]);
  // The pruned session's ops go; ops a KEPT session names stay (sessionWorkOps would count them missing).
  assert.deepEqual(await ids(localdb.operations), ["open-S-OPEN", "open-S-PARKED", "open-S-RECENT", "settle-S-PARKED"]);
});

test("entity mappings are kept while any local row names them; history is trimmed but keeps what replay reads", async () => {
  await localdb.operations.bulkAdd([
    // A live delivery waiting on an offline customer (by local id) and on a GONE prerequisite.
    op("deliv", "takeaway_sale", { status: "blocked_dependency", dependency_ids: ["gone-shift-op"], depends_on_local_entities: ["CUST-L"], payload: { customer_local: "CUST-L", address_local: "ADDR-L" } }),
    op("recent-sale", "takeaway_sale", { local_entity_id: "L-RECENT", created_at: ago(DAY), synced_at: ago(DAY) }),
  ] as never);
  await localdb.posCustomers.add({ id: "PCUST", tenant_id: T, branch_id: B, name: "x", phone: null, phone_e164: null, addresses: null, notes: null, has_profile: false, cached_at: ago(DAY), pending_local: true, local_address_id: "ADDR-P" } as never);
  await localdb.entityMap.bulkAdd([
    mapping("CUST-L", "C-1", 60 * DAY), // named by a live op
    mapping("ADDR-L", "A-1", 60 * DAY), // named by a live op's payload
    mapping("SHIFT-L", "SH-1", 60 * DAY), // local_ref of the gone prerequisite's synced event (provenGoneSynced)
    mapping("L-RECENT", "O-R", 60 * DAY), // named by a kept (recent) synced op
    mapping("ADDR-P", "A-P", 60 * DAY), // named by a pending-local customer
    mapping("L-FREE", "O-F", 60 * DAY), // named by nothing → pruned
    mapping("L-NEW", "O-N", DAY), // too young → kept
  ] as never);
  await localdb.syncHistory.bulkAdd([
    hist("gone-shift-op", "synced", 200 * DAY, { local_ref: "SHIFT-L" }), // old, but a live op depends on it → kept
    hist("deliv", "pending", 120 * DAY), // the live op's own history → kept
    hist("ancient", "synced", 120 * DAY), // → pruned
    hist("ancient", "syncing", 121 * DAY), // → pruned
    hist("recentish", "synced", 30 * DAY), // within 90 days → kept
  ] as never);
  const r = await R.runRetention({ now: NOW });
  assert.equal(r.entityMap, 1);
  assert.equal(r.syncHistory, 2);
  assert.deepEqual(await ids(localdb.entityMap), ["ADDR-L", "ADDR-P", "CUST-L", "L-NEW", "L-RECENT", "SHIFT-L"]);
  const left = (await localdb.syncHistory.toArray()).map((e) => e.operation_id).sort();
  assert.deepEqual(left, ["deliv", "gone-shift-op", "recentish"]);
});

test("old snapshots / receipts: per-shift read caches of closed shifts and final receipts are pruned; open-shift + provisional kept", async () => {
  storage.setItem("breadee-desktop-pos-session", JSON.stringify({ version: 1, source: "server", savedAt: Date.now(), device_id: DEV, tenant_id: T, cashier_user_id: U, branch_id: B, branch_name: "Main", currency: "USD", shift: { id: "SH-OPEN", status: "open", opened_at: null, opening_cash_amount: 0, branch_id: B } }));
  await localdb.snapshots.bulkAdd([
    { key: "orders:shift:SH-OLD", tenant_id: T, branch_id: B, data: [], cached_at: ago(60 * DAY) },
    { key: "orders:shift:SH-OPEN", tenant_id: T, branch_id: B, data: [], cached_at: ago(60 * DAY) },
    { key: "delivery_lines:O-1", tenant_id: T, branch_id: B, data: [], cached_at: ago(60 * DAY) },
    { key: "tables:b1", tenant_id: T, branch_id: B, data: [], cached_at: ago(60 * DAY) },
    { key: "menu", tenant_id: T, branch_id: B, data: [], cached_at: ago(60 * DAY) },
  ] as never);
  await localdb.receipts.bulkAdd([
    { ref: "R-OLD", data: {}, tenant_id: T, branch_id: B, provisional: false, created_at: ago(60 * DAY) },
    { ref: "R-PROV", data: {}, tenant_id: T, branch_id: B, provisional: true, created_at: ago(60 * DAY) },
    { ref: "R-NEW", data: {}, tenant_id: T, branch_id: B, provisional: false, created_at: ago(DAY) },
  ] as never);
  await R.runRetention({ now: NOW });
  assert.deepEqual(await ids(localdb.snapshots), ["menu", "orders:shift:SH-OPEN", "tables:b1"]);
  assert.deepEqual(await ids(localdb.receipts), ["R-NEW", "R-PROV"]);
});

test("upgrade fixture semantics hold when the whole 1.0.37 fixture is OLD: no unsettled chain loses a link", async () => {
  // The upgrade fixture's shape (test/upgrade-1037-to-1038.test.ts), aged past every window.
  const old = 120 * DAY;
  const SH = "SH-CANON-1";
  await localdb.pendingShifts.add({ local_shift_id: "LS-SYNC", client_op_id: "cop-shift-1", tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U, opening_cash_amount: 50, currency: "USD", opened_at: ago(old), status: "synced", server_shift_id: SH, attempts: 1 } as never);
  await localdb.posOfflineTxns.bulkAdd([txn("TX-SYNCED", "synced", old, { shift_id: "SH-PAST", order_payload: { shift_id: "SH-PAST" } }), txn("TX-PEND", "queued", old)] as never);
  await localdb.operations.bulkAdd([
    op("mig:shift:LS-SYNC", "open_shift", { local_entity_id: "LS-SYNC", canonical_entity_id: SH }),
    op("op-payout-old", "payout"),
    op("mig:txn:TX-SYNCED", "takeaway_sale", { local_entity_id: "TX-SYNCED", canonical_entity_id: "ORD-SYNCED-1" }),
    op("mig:txn:TX-PEND", "takeaway_sale", { local_entity_id: "TX-PEND", status: "pending", synced_at: null }),
    op("op-cust", "customer_upsert", { status: "pending", local_entity_id: "CUST-LOCAL-1", payload: { local_address_id: "ADDR-LOCAL-1" }, synced_at: null }),
    op("op-A1", "dinein_open_table", { status: "needs_attention", local_entity_id: "TBL-A-LOCAL", last_error_code: "version_conflict" }),
    op("op-A2", "dinein_send_round", { status: "needs_attention", dependency_ids: ["op-A1"], depends_on_local_entities: ["TBL-A-LOCAL"], last_error_code: "dependency_failed", last_error_message: "op-A1" }),
    op("op-B1", "dinein_open_table", { local_entity_id: "TBL-B-LOCAL", canonical_entity_id: "TABLE-B-CANON" }),
    op("op-B2", "dinein_send_round", { status: "needs_attention", dependency_ids: ["op-B1"], depends_on_local_entities: ["TBL-B-LOCAL"], last_error_code: "dependency_failed", last_error_message: "op-B1", payload: { table_local: "TBL-B-LOCAL" } }),
    op("op-B3", "pay_table", { status: "needs_attention", dependency_ids: ["op-B1", "op-B2"], last_error_code: "dependency_failed", last_error_message: "op-B2", payload: { table_local: "TBL-B-LOCAL" } }),
    op("mig:outbox:1", "legacy_outbox:pos.save_order", { status: "needs_attention", last_error_code: "unknown_handler" }),
    op("op-other-cashier", "payout", { status: "pending", scope: { ...SC, cashier_user_id: "u2" }, synced_at: null }),
  ] as never);
  await localdb.entityMap.bulkAdd([mapping("LS-SYNC", SH, old), mapping("TX-SYNCED", "ORD-SYNCED-1", old), mapping("TBL-B-LOCAL", "TABLE-B-CANON", old)] as never);
  await localdb.dineDrafts.bulkAdd([
    draft("SESS-A", "open", old, { open_operation_id: "op-A1", rounds: [{ round_local_id: "RND-A-1", operation_id: "op-A2", seq: 1, line_ids: [], print_state: "printed", sent_at: ago(old) }] }),
    draft("SESS-B", "settled", old, { open_operation_id: "op-B1", settled_operation_id: "op-B3", rounds: [{ round_local_id: "RND-B-1", operation_id: "op-B2", seq: 1, line_ids: [], print_state: "printed", sent_at: ago(old) }] }),
  ] as never);
  await localdb.syncHistory.bulkAdd([hist("op-B1", "synced", old, { local_ref: "TBL-B-LOCAL" }), hist("op-payout-old", "synced", old), hist("op-A1", "needs_attention", old)] as never);
  const unsettledBefore = (await localdb.operations.toArray()).filter((o) => o.status !== "synced").map((o) => o.operation_id).sort();

  const r = await R.runRetention({ now: NOW });
  // Pruned: the free old payout, the reconciled old legacy sale WITH its migrated op, and that sale's
  // mapping. Everything else is required by live work and stays.
  assert.deepEqual(await ids(localdb.posOfflineTxns), ["TX-PEND"]);
  const left = await ids(localdb.operations);
  for (const id of unsettledBefore) assert.ok(left.includes(id), `unsettled ${id} kept`);
  assert.ok(left.includes("op-B1"), "old synced prerequisite of the parked B chain is kept (C2 re-open needs it)");
  assert.ok(left.includes("mig:shift:LS-SYNC"), "pendingShifts are never pruned → their migrated op stays (no re-stage churn)");
  assert.ok(!left.includes("op-payout-old") && !left.includes("mig:txn:TX-SYNCED"));
  assert.deepEqual(await ids(localdb.entityMap), ["LS-SYNC", "TBL-B-LOCAL"]);
  assert.deepEqual(await ids(localdb.dineDrafts), ["SESS-A", "SESS-B"], "settled SESS-B has parked work → kept");
  assert.equal(r.syncHistory, 1, "only the free payout's event is trimmed");

  // The chain still recovers exactly as in the upgrade test: B1 is synced → B2/B3 re-open on the next drain.
  const rep = await drainOffline({ tenantId: T, branchId: B, cashierUserId: U, deviceId: DEV, terminalId: TERM, online: true }, "retention-upgrade", {
    hasSession: async () => true,
    refreshSession: async () => false,
    isTransport: (e: unknown) => e instanceof TypeError,
    submitRound: async () => { throw new TypeError("Failed to fetch"); },
    submit: async () => { throw new TypeError("Failed to fetch"); },
    upsertCustomer: async () => { throw new TypeError("Failed to fetch"); },
  } as never);
  assert.deepEqual((rep.reopened ?? []).slice().sort(), ["op-B2", "op-B3"]);
  assert.equal((await localdb.operations.get("op-A2"))?.status, "needs_attention", "A chain still parked (its root is a real refusal)");
});

test("unbounded growth stops: a 120-day simulated tenure stays bounded by the retention windows", async () => {
  const perDay = 8;
  const DAYS = 120;
  const counts: number[] = [];
  for (let day = 0; day < DAYS; day++) {
    const now = NOW - (DAYS - day) * DAY;
    const iso = (ms: number) => new Date(ms).toISOString();
    const shift = `SH-D${day}`;
    const rows = [];
    const maps = [];
    const evs = [];
    for (let i = 0; i < perDay; i++) {
      const id = `d${day}-${i}`;
      rows.push(op(id, "takeaway_sale", { created_at: iso(now), synced_at: iso(now + 60_000), local_entity_id: `L-${id}`, canonical_entity_id: `C-${id}`, payload: { order_payload: { shift_id: shift } } }));
      maps.push({ ...mapping(`L-${id}`, `C-${id}`, 0), resolved_at: iso(now + 60_000) });
      for (const s of ["pending", "syncing", "synced"]) evs.push({ ...hist(id, s, 0), at: iso(now) });
    }
    await localdb.operations.bulkAdd(rows as never);
    await localdb.entityMap.bulkAdd(maps as never);
    await localdb.syncHistory.bulkAdd(evs as never);
    await localdb.dineDrafts.add(draft(`S-${day}`, "closed", 0, { created_at: iso(now), updated_at: iso(now), shift_id: shift }) as never);
    await R.runRetention({ now: now + DAY - 1 });
    counts.push(await localdb.operations.count());
  }
  const ops = await localdb.operations.count();
  const evs = await localdb.syncHistory.count();
  const maps = await localdb.entityMap.count();
  const drafts = await localdb.dineDrafts.count();
  // Bounded by the windows (+1 day of slack), never by tenure.
  assert.ok(ops <= 31 * perDay, `ops ${ops}`);
  assert.ok(maps <= 31 * perDay, `entity map ${maps}`);
  assert.ok(evs <= 91 * perDay * 3, `history ${evs}`);
  assert.ok(drafts <= 31, `drafts ${drafts}`);
  // Plateau: once past the 30-day window the op count no longer grows with tenure.
  assert.equal(counts[DAYS - 1], counts[59], "op count flat once past the window");
  assert.ok(counts[DAYS - 1] < DAYS * perDay / 3, "far below the unpruned tenure");
});

test("drainOffline runs retention under the drain lock, at most once per interval, and never fails the drain", async () => {
  await localdb.operations.bulkAdd([op("old-free", "payout"), op("old-free-2", "payout")] as never);
  const ctx = { tenantId: T, branchId: B, cashierUserId: U, deviceId: DEV, terminalId: TERM, online: false };
  const r1 = await drainOffline(ctx, "t1");
  assert.equal(r1.migrateError, undefined);
  assert.equal(R.lastRetentionReport()?.operations, 2);
  await localdb.operations.add(op("old-free-3", "payout") as never);
  await drainOffline(ctx, "t2");
  assert.ok(await localdb.operations.get("old-free-3"), "throttled: the second drain inside the interval does not prune");
});
