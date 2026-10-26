// 1.0.38 — local data preservation on the in-app update 1.0.37 → 1.0.38 (Bug 8 durability).
//
// The installed 1.0.37 fleet holds an IndexedDB "breadee-desktop" at Dexie schema v11 (the full Phase B–F
// offline store: typed operation log, entity map, sync history, dine drafts, proofs, receipts) plus
// localStorage (device/terminal identity, offline authority, operational-branch pin, printers). The update
// keeps the SAME bundle identity (app.breadee.desktop) → the same WebView2 data folder; 1.0.38 opens the
// existing database with its own `localdb`.
//
// This test seeds a database with the EXACT production 1.0.37 schema (v1..v11, verbatim from
// src/lib/offline/db.ts @ 911f2be) and realistic 1.0.37 state, then proves:
//   1. the 1.0.38 open preserves every row byte-for-byte (no Dexie upgrade side effect), every 1.0.37
//      store + index still exists, and localStorage is untouched;
//   2. the first 1.0.38 runtime touches that WRITE (migration bridge, historical recovery, legacy/draft
//      reconcile, synced-op GC, summaries) never remove/duplicate unsettled work, and are idempotent;
//   3. the first ONLINE drain against an unreachable backend performs only the legitimate replay
//      bookkeeping transitions (listed exactly), re-evaluates the 1.0.37 dependency_failed chains
//      deterministically (C2), replays the op left `syncing` by a crash, and a second drain is a no-op;
//   4. a restart (close/reopen) yields the identical state.

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import Dexie from "dexie";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
  dump(): Record<string, string> { return Object.fromEntries([...this.m.entries()].sort(([a], [b]) => a.localeCompare(b))); }
}
const storage = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;

/** The production 1.0.37 database, schema v1..v11 VERBATIM (src/lib/offline/db.ts @ 911f2be). */
const SCHEMA_1037: [number, Record<string, string>][] = [
  [1, {
    outbox: "++id, kind, status, tenant_id, branch_id, created_at",
    snapshots: "key, tenant_id, branch_id",
    audit: "++id, action, tenant_id, at, sync_status",
  }],
  [2, { posOfflineTxns: "local_txn_id, client_op_id, tenant_id, branch_id, status, created_at, cashier_user_id" }],
  [3, { posCustomers: "id, tenant_id, branch_id, phone_e164, name" }],
  [4, { pendingShifts: "local_shift_id, client_op_id, tenant_id, branch_id, status, cashier_user_id, opened_at" }],
  [5, {
    operations: "operation_id, status, operation_type, created_at, client_op_id, local_entity_id",
    entityMap: "local_entity_id, entity_type, tenant_id",
    syncHistory: "++id, operation_id, tenant_id, branch_id, at, status",
  }],
  [6, { dineDrafts: "local_session_id, tenant_id, branch_id, table_id, status, cashier_user_id, device_id, updated_at" }],
  [7, { paidOrderProofs: "order_id, tenant_id, branch_id, shift_id, payment_status, cashier_user_id, device_id, cached_at" }],
  [8, { payoutSourceProofs: "proof_key, source_type, source_id, tenant_id, branch_id, cashier_user_id, device_id, cached_at" }],
  [9, { printRoutes: "key, branch_id, purpose, order_source, cached_at" }],
  [10, { receivableProofs: "order_id, tenant_id, branch_id, customer_id, cached_at" }],
  [11, { receipts: "ref, tenant_id, branch_id, created_at" }],
];
const STORES_1037 = Object.assign({}, ...SCHEMA_1037.map(([, s]) => s)) as Record<string, string>;

function open1037(): Dexie {
  const db = new Dexie("breadee-desktop");
  for (const [v, s] of SCHEMA_1037) db.version(v).stores(s);
  return db;
}

// ---------------------------------------------------------------------------------------------------
// Snapshot + diff helpers (every store, keyed by its inline primary key).
// ---------------------------------------------------------------------------------------------------
type Dump = Record<string, Record<string, unknown>>;
const pkOf = (spec: string) => spec.split(",")[0].trim().replace(/^\+\+/, "");

async function dumpDb(db: Dexie, stores: string[]): Promise<Dump> {
  const out: Dump = {};
  for (const s of stores) {
    const pk = pkOf(STORES_1037[s] ?? db.table(s).schema.primKey.src);
    const rows = await db.table(s).toArray();
    const m: Record<string, unknown> = {};
    for (const r of rows) {
      const k = String((r as Record<string, unknown>)[pk]);
      assert.ok(!(k in m), `${s}: duplicate primary key ${k}`);
      m[k] = r;
    }
    out[s] = Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
  }
  return out;
}
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x)) as X;

type StoreDiff = { added: string[]; removed: string[]; changed: Record<string, string[]> };
function diff(a: Dump, b: Dump): Record<string, StoreDiff> {
  const out: Record<string, StoreDiff> = {};
  for (const s of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[s] ?? {}, y = b[s] ?? {};
    const d: StoreDiff = { added: [], removed: [], changed: {} };
    for (const k of Object.keys(y)) if (!(k in x)) d.added.push(k);
    for (const k of Object.keys(x)) if (!(k in y)) d.removed.push(k);
    for (const k of Object.keys(x)) {
      if (!(k in y)) continue;
      const rx = x[k] as Record<string, unknown>, ry = y[k] as Record<string, unknown>;
      const fields = [...new Set([...Object.keys(rx), ...Object.keys(ry)])].filter((f) => JSON.stringify(rx[f]) !== JSON.stringify(ry[f]));
      if (fields.length) d.changed[k] = fields.sort();
    }
    if (d.added.length || d.removed.length || Object.keys(d.changed).length) out[s] = d;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Realistic 1.0.37 terminal state.
// ---------------------------------------------------------------------------------------------------
const T = "tenant-prod-1";
const B = "branch-prod-1";
const DEV = "5f0c2a9e-6b1d-4a57-9d1e-0a1b2c3d4e5f";
const TERM = "TERM-7";
const U = "user-cashier-1";
const U2 = "user-cashier-2";
const SC = { tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U };
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const SHIFT = "SH-CANON-1";
const L1 = "0b8f7a52-3c1e-4f6a-9b2d-11aa22bb33cc";
const L2 = "6d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";

const orderPayload = (ref: string, extra: Record<string, unknown> = {}) => ({
  order_type: "takeaway",
  shift_id: SHIFT,
  branch_id: B,
  currency: "USD",
  items: [{ menu_item_id: "m-pizza", quantity: 1, base_price: 12, modifiers: [], note: ref }],
  ...extra,
});
const cash = { method: "cash" as const, currency: "USD" };

function op(id: string, type: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    operation_id: id,
    operation_type: type,
    schema_version: 1,
    scope: { ...SC },
    created_at: ago(HOUR),
    client_op_id: "cop-" + id,
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
    captured_build: "911f2be",
    ...over,
  };
}
function legacyTxn(id: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    local_txn_id: id, client_op_id: "cop-txn-" + id, tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM,
    cashier_user_id: U, cashier_user_name: "Rana", shift_id: SHIFT, created_at: ago(HOUR),
    order_payload: orderPayload(id), payment_intent: cash, sent_to_kitchen: true, currency: "USD", total: 12,
    status: "queued", attempts: 0, last_attempt_at: null, ...over,
  };
}
function takeawayOp(id: string, t: Record<string, unknown>, over: Record<string, unknown>) {
  return op(`mig:txn:${id}`, "takeaway_sale", {
    client_op_id: t.client_op_id, local_entity_id: id, created_at: t.created_at,
    payload: { order_payload: t.order_payload, payment_intent: t.payment_intent, paid: t.paid === true, shift_local: null, customer_local: (t.customer_local as string) ?? null, address_local: (t.address_local as string) ?? null },
    ...over,
  });
}
const mapping = (local: string, type: string, canonical: string, at: string) => ({ local_entity_id: local, entity_type: type, canonical_id: canonical, resolved_at: at, ...SC });
const hist = (operation_id: string, type: string, label: string, status: string, at: string, extra: Record<string, unknown> = {}) => ({
  at, operation_id, operation_type: type, action_label: label, tenant_id: T, branch_id: B, device_id: DEV, cashier_user_id: U,
  local_ref: null, canonical_ref: null, status, retry_count: 1, error_summary: null, synced_at: null, ...extra,
});

async function seed1037(db: Dexie): Promise<void> {
  // localStorage — the REAL keys the app reads (src/lib/device.ts, offlineAuthority.ts, printers.ts,
  // state/operationalBranch.ts, offline/posSession.ts, offline/branchContext.ts, whatsNew.ts).
  storage.setItem("breadee-desktop-device", JSON.stringify({ device_id: DEV, terminal_id: TERM, device_name: "Cashier PC 1", created_at: ago(60 * DAY) }));
  storage.setItem("breadee-desktop-context", JSON.stringify({ userId: U, email: "rana@example.test", isPlatformUser: false, tenant: { id: T, name: "Classic Pizza" }, membership: { role: "cashier", branch_id: null }, features: { pos: true }, permissions: { "pos.sell": true }, currency: { primary: "USD" }, cachedAt: NOW - HOUR }));
  storage.setItem("breadee-desktop-printers", JSON.stringify({ printers: [{ id: "p1", name: "EPSON-TM20", connection: "system", paper: "80mm", role: "cashier", is_default: true }, { id: "p2", name: "KITCHEN-1", connection: "network", address: "10.0.0.20:9100", paper: "80mm", role: "kitchen", is_default: false }], categoryRouting: { "cat-drinks": "bar" }, itemOverrides: {} }));
  storage.setItem("breadee.operationalBranch.v1", JSON.stringify({ [`${T}:${U}`]: B }));
  storage.setItem("breadee-desktop-pos-session", JSON.stringify({ tenantId: T, branchId: B, userId: U, shift: { id: SHIFT, status: "open" }, savedAt: NOW - HOUR }));
  storage.setItem("breadee-desktop-branch-context", JSON.stringify({ entries: [{ tenantId: T, userId: U, branchId: B, at: NOW - HOUR }] }));
  storage.setItem("whatsNewSeenVersion", "1.0.37");

  // --- legacy stores ---
  // A shift synced before the Phase-B migration (staged as `synced` by migrate, then untouched).
  const shift = { local_shift_id: "LS-SYNC", client_op_id: "cop-shift-1", tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, cashier_user_id: U, opening_cash_amount: 50, currency: "USD", opened_at: ago(10 * DAY), status: "synced", server_shift_id: SHIFT, attempts: 1, last_error: null };
  await db.table("pendingShifts").add(shift);

  const txSynced = legacyTxn("TX-SYNCED", { created_at: ago(2 * DAY), status: "synced", attempts: 1, last_attempt_at: ago(2 * DAY - MIN), server_order_id: "ORD-SYNCED-1", server_order_number: "261024-0007", paid: true, last_error: null, review_reason: null });
  const txPend = legacyTxn("TX-PEND", { created_at: ago(30 * MIN) });
  const txRetry = legacyTxn("TX-RETRY", { created_at: ago(25 * MIN), attempts: 6 });
  const txCrash = legacyTxn("TX-CRASH", { created_at: ago(20 * MIN), attempts: 1 });
  const txDeliv = legacyTxn("TX-DELIV", { created_at: ago(14 * MIN), order_payload: orderPayload("TX-DELIV", { order_type: "delivery", customer_id: null, address_id: null }), payment_intent: null, sent_to_kitchen: true, customer_local: "CUST-LOCAL-1", address_local: "ADDR-LOCAL-1", party_snapshot: { customer_name: "Walid", customer_phone: "+96170111222", address_text: "Hamra, Bliss St" } });
  const txUnstaged = legacyTxn("TX-UNSTAGED", { created_at: ago(5 * MIN) }); // captured after the last 1.0.37 drain
  await db.table("posOfflineTxns").bulkAdd([txSynced, txPend, txRetry, txCrash, txDeliv, txUnstaged]);

  await db.table("posCustomers").bulkAdd([
    { id: "C-CANON-1", tenant_id: T, branch_id: B, name: "Rana", phone: "03123456", phone_e164: "+9613123456", addresses: [{ id: "A-1", line1: "Achrafieh" }], notes: null, has_profile: true, cached_at: ago(DAY) },
    { id: "CUST-LOCAL-1", tenant_id: T, branch_id: B, name: "Walid", phone: "70111222", phone_e164: "+96170111222", addresses: [{ id: "ADDR-LOCAL-1", line1: "Hamra, Bliss St" }], notes: null, has_profile: true, cached_at: ago(15 * MIN), pending_local: true, local_address_id: "ADDR-LOCAL-1" },
  ]);
  // A dormant legacy outbox row (1.0.37's syncNow flipped it to "review"); quarantined as mig:outbox:1.
  await db.table("outbox").add({ kind: "pos.save_order", payload: { x: 1 }, user_id: U, user_name: "Rana", tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, created_at: ago(40 * DAY), status: "review", attempts: 1 });
  await db.table("audit").add({ action: "sync.run", user_id: U, tenant_id: T, branch_id: B, device_id: DEV, terminal_id: TERM, at: ago(DAY), sync_status: "local", detail: { synced: 0, review: 1, failed: 0 } });

  // --- the typed operation log ---
  const ops = [
    // Synced, migrated legacy shift (exactly as migrate staged it: no build stamp, last_attempt null).
    { operation_id: "mig:shift:LS-SYNC", operation_type: "open_shift", schema_version: 1, scope: { ...SC }, created_at: shift.opened_at, client_op_id: shift.client_op_id, local_entity_id: "LS-SYNC", canonical_entity_id: SHIFT, dependency_ids: [], depends_on_local_entities: [], payload: { branchId: B, openingCash: 50 }, status: "synced", retry_count: 1, last_attempt_at: null, last_error_code: null, last_error_message: null, result_meta: { shift_id: SHIFT }, synced_at: shift.opened_at },
    // Synced history, old and unreferenced (legitimately GC-eligible).
    op("op-payout-old", "payout", { created_at: ago(9 * DAY), payload: { shift_id: SHIFT, amount: 5, source_type: "expense", source_id: "EXP-1", note: null }, status: "synced", retry_count: 1, last_attempt_at: ago(9 * DAY), result_meta: { payout_id: "PO-1" }, synced_at: ago(9 * DAY) }),
    // Synced takeaway (recent).
    takeawayOp("TX-SYNCED", txSynced, { canonical_entity_id: "ORD-SYNCED-1", payload: { order_payload: txSynced.order_payload, payment_intent: cash, paid: true, shift_local: null, customer_local: null, address_local: null }, status: "synced", retry_count: 1, last_attempt_at: ago(2 * DAY - MIN), result_meta: { order_number: "261024-0007", paid: true }, synced_at: ago(2 * DAY - MIN) }),
    // Pending (never attempted).
    takeawayOp("TX-PEND", txPend, {}),
    // Retryable with an active backoff window (attempted moments before the app was closed for the update).
    takeawayOp("TX-RETRY", txRetry, { status: "retryable", retry_count: 6, last_attempt_at: new Date(NOW).toISOString(), last_error_code: "order: transport", last_error_message: "Failed to fetch" }),
    // Left `syncing` by a crash / kill mid-replay (the updater stops the app).
    takeawayOp("TX-CRASH", txCrash, { status: "syncing", retry_count: 1, last_attempt_at: ago(20 * MIN) }),
    // Offline-created customer (pending-local) + the delivery order chained to it.
    op("op-cust", "customer_upsert", { created_at: ago(15 * MIN), local_entity_id: "CUST-LOCAL-1", payload: { upsert: { branch_id: B, name: "Walid", phone: "70111222", notes: null, address: { line1: "Hamra, Bliss St" } }, local_address_id: "ADDR-LOCAL-1" } }),
    takeawayOp("TX-DELIV", txDeliv, { depends_on_local_entities: ["CUST-LOCAL-1"] }),
    // Chain A — a REAL server refusal (version conflict) + its dependency_failed round: must stay parked.
    op("op-A1", "dinein_open_table", { created_at: ago(3 * HOUR), local_entity_id: "TBL-A-LOCAL", payload: { branch_id: B, name: "A1", seats: 4, expected_version: 3 }, status: "needs_attention", retry_count: 1, last_attempt_at: ago(3 * HOUR), last_error_code: "version_conflict", last_error_message: "VERSION_CONFLICT: table changed" }),
    op("op-A2", "dinein_send_round", { created_at: ago(3 * HOUR - MIN), local_entity_id: "RND-A-1", dependency_ids: ["op-A1"], depends_on_local_entities: ["TBL-A-LOCAL"], payload: { submit: { ...orderPayload("A"), order_type: "dine_in", table_id: null, items: [{ menu_item_id: "m-pizza", quantity: 2, base_price: 12, modifiers: [], client_line_id: L1 }] }, table_local: "TBL-A-LOCAL", session_local: null, shift_local: null, table_name: "A1", round_seq: 1 }, status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "op-A1" }),
    // Chain B — the 1.0.37 sticky dependency_failed bug (C2): the open was retried by the operator and
    // SYNCED, but its round + settle stayed parked forever. The open is old (> 7 d) but referenced (C6).
    op("op-B1", "dinein_open_table", { created_at: ago(9 * DAY), local_entity_id: "TBL-B-LOCAL", canonical_entity_id: "TABLE-B-CANON", payload: { branch_id: B, name: "B2", seats: 2, expected_version: null }, status: "synced", retry_count: 2, last_attempt_at: ago(8 * DAY), result_meta: { table_id: "TABLE-B-CANON", pos_entity_version: 7 }, synced_at: ago(8 * DAY) }),
    op("op-B2", "dinein_send_round", { created_at: ago(9 * DAY - MIN), local_entity_id: "RND-B-1", dependency_ids: ["op-B1"], depends_on_local_entities: ["TBL-B-LOCAL"], payload: { submit: { ...orderPayload("B"), order_type: "dine_in", table_id: null, items: [{ menu_item_id: "m-pizza", quantity: 1, base_price: 12, modifiers: [], client_line_id: L2 }] }, table_local: "TBL-B-LOCAL", session_local: null, shift_local: null, table_name: "B2", round_seq: 1 }, status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "op-B1" }),
    op("op-B3", "pay_table", { created_at: ago(9 * DAY - 2 * MIN), dependency_ids: ["op-B1", "op-B2"], payload: { table_id: null, table_local: "TBL-B-LOCAL", method: "cash", currency: "USD", table_name: "B2" }, status: "needs_attention", last_error_code: "dependency_failed", last_error_message: "op-B2" }),
    // Legacy outbox quarantine (never replayed).
    op("mig:outbox:1", "legacy_outbox:pos.save_order", { created_at: ago(40 * DAY), client_op_id: "outbox-1", payload: { kind: "pos.save_order", note: null }, status: "needs_attention", last_error_code: "unknown_handler", last_error_message: "legacy outbox record — quarantined, not replayed", captured_build: undefined }),
    // Another cashier's pending work on this shared device (deferred, never replayed under U).
    op("op-other-cashier", "payout", { created_at: ago(HOUR), scope: { ...SC, cashier_user_id: U2 }, payload: { shift_id: "SH-OTHER", amount: 3, source_type: "expense", source_id: "EXP-2", note: null } }),
  ].map((o) => JSON.parse(JSON.stringify(o)) as Record<string, unknown>); // drop undefined fields like IndexedDB would
  await db.table("operations").bulkAdd(ops);

  await db.table("entityMap").bulkAdd([
    mapping("LS-SYNC", "shift", SHIFT, ago(10 * DAY)),
    mapping("TX-SYNCED", "order", "ORD-SYNCED-1", ago(2 * DAY)),
    mapping("TBL-B-LOCAL", "table", "TABLE-B-CANON", ago(8 * DAY)),
  ]);
  await db.table("syncHistory").bulkAdd([
    hist("op-payout-old", "payout", "Cash payout", "synced", ago(9 * DAY), { synced_at: ago(9 * DAY) }),
    hist("op-B1", "dinein_open_table", "Open Table B2", "needs_attention", ago(9 * DAY), { error_summary: "temporary server issue" }),
    hist("op-B2", "dinein_send_round", "Kitchen round — Table B2", "needs_attention", ago(9 * DAY), { error_summary: "a prerequisite could not be completed" }),
    hist("op-B3", "pay_table", "Pay table B2", "needs_attention", ago(9 * DAY), { error_summary: "a prerequisite could not be completed" }),
    hist("op-B1", "dinein_open_table", "Open Table B2", "synced", ago(8 * DAY), { local_ref: "TBL-B-LOCAL", canonical_ref: "TABLE-B-CANON", synced_at: ago(8 * DAY), retry_count: 2 }),
    hist("mig:txn:TX-SYNCED", "takeaway_sale", "Takeaway Cash Sale", "synced", ago(2 * DAY), { local_ref: "TX-SYNCED", canonical_ref: "ORD-SYNCED-1", synced_at: ago(2 * DAY) }),
    hist("op-A1", "dinein_open_table", "Open Table A1", "needs_attention", ago(3 * HOUR), { error_summary: "conflict on the server" }),
    hist("op-A2", "dinein_send_round", "Kitchen round — Table A1", "needs_attention", ago(3 * HOUR), { error_summary: "a prerequisite could not be completed" }),
    hist("mig:txn:TX-RETRY", "takeaway_sale", "Takeaway Cash Sale", "retryable", ago(MIN), { retry_count: 6, error_summary: "waiting for connection" }),
    hist("mig:txn:TX-CRASH", "takeaway_sale", "Takeaway Cash Sale", "syncing", ago(20 * MIN)),
  ]);

  const line = (id: string, sent: number | null, qty = 1) => ({ line_id: id, menu_item_id: "m-pizza", name: "Pizza", base_price: 12, quantity: qty, modifiers: [], kitchen_note: null, sent_round: sent });
  const draft = (id: string, over: Record<string, unknown>) => ({
    local_session_id: id, tenant_id: T, branch_id: B, cashier_user_id: U, device_id: DEV, terminal_id: TERM, floor_id: "F1", section_id: null,
    currency: "USD", canonical_order_id: null, origin: "offline", base_order_version: null, shift_id: SHIFT, shift_local: null,
    draft_revision: 3, notes: null, ...over,
  });
  await db.table("dineDrafts").bulkAdd([
    // OPEN session (table A1) with a sent round + an unsent draft line.
    draft("SESS-A", { table_id: "TBL-A-LOCAL", table_name: "A1", open_operation_id: "op-A1", status: "open", lines: [line(L1, 1, 2), line("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", null)], rounds: [{ round_local_id: "RND-A-1", operation_id: "op-A2", seq: 1, line_ids: [L1], print_state: "printed", sent_at: ago(3 * HOUR) }], created_at: ago(3 * HOUR), updated_at: ago(2 * HOUR) }),
    // SETTLED session (table B2): paid offline, settle parked behind the sticky dependency_failed chain.
    draft("SESS-B", { table_id: "TBL-B-LOCAL", table_name: "B2", open_operation_id: "op-B1", status: "settled", settled_operation_id: "op-B3", settled_at: ago(9 * DAY - 2 * MIN), lines: [line(L2, 1)], rounds: [{ round_local_id: "RND-B-1", operation_id: "op-B2", seq: 1, line_ids: [L2], print_state: "printed", sent_at: ago(9 * DAY) }], created_at: ago(9 * DAY), updated_at: ago(9 * DAY - 2 * MIN) }),
  ]);

  await db.table("snapshots").bulkAdd([
    { key: "menu", tenant_id: T, branch_id: B, data: { items: [{ id: "m-pizza", name: "Pizza", price: 12 }] }, cached_at: ago(HOUR) },
    { key: `tables:${B}`, tenant_id: T, branch_id: B, data: { tables: [{ id: "TABLE-B-CANON", name: "B2" }] }, cached_at: ago(HOUR) },
    { key: "auth.context", tenant_id: T, branch_id: null, data: JSON.parse(storage.getItem("breadee-desktop-context") as string), cached_at: ago(HOUR) },
  ]);
  await db.table("paidOrderProofs").add({ order_id: "ORD-SYNCED-1", order_number: "261024-0007", tenant_id: T, branch_id: B, shift_id: SHIFT, pos_entity_version: 4, payment_status: "paid", status: "completed", refundable_usd: 12, currency: "USD", cashier_user_id: U, device_id: DEV, terminal_id: TERM, cached_at: ago(2 * DAY) });
  await db.table("payoutSourceProofs").add({ proof_key: `${T}|${B}|${U}|${DEV}|${TERM}|expense|EXP-1`, source_type: "expense", source_id: "EXP-1", label: "Gas refill", sublabel: null, tenant_id: T, branch_id: B, cashier_user_id: U, device_id: DEV, terminal_id: TERM, cached_at: ago(DAY) });
  await db.table("printRoutes").add({ key: `${B}:kitchen_ticket:dine_in`, branch_id: B, purpose: "kitchen_ticket", order_source: "dine_in", route: { printer: "KITCHEN-1", copies: 1 }, cached_at: ago(DAY) });
  await db.table("receivableProofs").add({ order_id: "ORD-ACC-1", order_number: "261020-0003", tenant_id: T, branch_id: B, customer_id: "C-CANON-1", customer_name: "Rana", outstanding_amount: 40, currency: "USD", cached_at: ago(DAY) });
  await db.table("receipts").add({ ref: "261024-0007", data: { order_number: "261024-0007", total: 12, lines: [{ name: "Pizza", qty: 1 }] }, tenant_id: T, branch_id: B, provisional: false, created_at: ago(2 * DAY) });
}

const UNSETTLED_1037 = ["mig:txn:TX-PEND", "mig:txn:TX-RETRY", "mig:txn:TX-CRASH", "op-cust", "mig:txn:TX-DELIV", "op-A1", "op-A2", "op-B2", "op-B3", "mig:outbox:1", "op-other-cashier"];
const UNSETTLED = ["pending", "blocked_dependency", "syncing", "retryable", "needs_attention"];
/** Replay bookkeeping fields the orchestrator may legitimately rewrite on an attempt / re-evaluation. */
const BOOKKEEPING = new Set(["status", "retry_count", "last_attempt_at", "last_error_code", "last_error_message", "server_retry_count"]);

function assertNoUnsettledLoss(before: Dump, after: Dump, phase: string) {
  for (const id of Object.keys(before.operations)) {
    const b = before.operations[id] as { status: string; client_op_id: string; payload: unknown; scope: unknown };
    if (!UNSETTLED.includes(b.status)) continue;
    const a = after.operations[id] as typeof b | undefined;
    assert.ok(a, `${phase}: unsettled op ${id} was REMOVED`);
    assert.equal(a.client_op_id, b.client_op_id, `${phase}: ${id} client_op_id rewritten`);
    assert.deepEqual(a.scope, b.scope, `${phase}: ${id} scope rewritten`);
    assert.deepEqual(a.payload, b.payload, `${phase}: ${id} payload rewritten`);
  }
  const cops = Object.values(after.operations).map((o) => (o as { client_op_id: string }).client_op_id);
  assert.equal(new Set(cops).size, cops.length, `${phase}: duplicate client_op_id in operations`);
  // Legacy capture rows, drafts, shifts, history are never removed.
  for (const s of ["posOfflineTxns", "pendingShifts", "dineDrafts", "entityMap", "outbox"]) {
    for (const k of Object.keys(before[s])) assert.ok(k in after[s], `${phase}: ${s}/${k} removed`);
  }
  const hb = Object.values(before.syncHistory), ha = Object.values(after.syncHistory);
  assert.ok(ha.length >= hb.length, `${phase}: sync history shrank`);
  for (const k of Object.keys(before.syncHistory)) assert.deepEqual(after.syncHistory[k], before.syncHistory[k], `${phase}: history event ${k} rewritten`);
}

test("1.0.37 → 1.0.38: the production local database survives the update and the first 1.0.38 runtime touches", async () => {
  // ---------------- 1.0.37 terminal ----------------
  const old = open1037();
  await old.open();
  assert.equal(old.verno, 11, "seeded at the production 1.0.37 schema");
  await seed1037(old);
  const S0 = await dumpDb(old, Object.keys(STORES_1037));
  const LS0 = storage.dump();
  old.close();

  // ---------------- 1.0.38 opens the SAME database ----------------
  const { localdb } = await import("@/lib/offline/db");
  await localdb.open();
  assert.ok(localdb.verno >= 11, `1.0.38 schema verno ${localdb.verno} >= 11`);
  // Every 1.0.37 store + primary key + index still exists in the physical database.
  const idb = localdb.backendDB();
  for (const [store, spec] of Object.entries(STORES_1037)) {
    assert.ok(idb.objectStoreNames.contains(store), `store ${store} exists`);
    const os = idb.transaction(store, "readonly").objectStore(store);
    const [pk, ...idx] = spec.split(",").map((x) => x.trim());
    assert.equal(os.keyPath, pk.replace(/^\+\+/, ""), `${store} primary key`);
    assert.equal(os.autoIncrement, pk.startsWith("++"), `${store} autoIncrement`);
    for (const i of idx) assert.ok(os.indexNames.contains(i), `${store}.${i} index retained`);
  }
  const newStores = localdb.tables.map((t) => t.name).filter((n) => !(n in STORES_1037));
  for (const n of newStores) assert.equal(await localdb.table(n).count(), 0, `new 1.0.38 store ${n} created empty`);

  const S1 = await dumpDb(localdb, Object.keys(STORES_1037));
  assert.deepEqual(S1, S0, "open at the 1.0.38 schema changed NO row in any store");
  assert.deepEqual(storage.dump(), LS0, "localStorage untouched by the open");

  const OL = await import("@/lib/offline/operationLog");
  const { migrateLegacyToOperations, reconcileLegacyFromOperations } = await import("@/lib/offline/migration");
  const { recoverHistoricalReplayFailures } = await import("@/lib/offline/queueForensics");
  const { reconcileDineDraftsFromOperations } = await import("@/lib/offline/dineinOffline");
  const { drainOffline, __resetDrainLockForTests, __setReplayTimeoutForTests } = await import("@/lib/offline/orchestrator");
  const { defaultDeps } = await import("@/lib/offline/posTxnSync");
  __resetDrainLockForTests();
  __setReplayTimeoutForTests(45_000);

  const FULL = { tenantId: T, branchId: B, cashierUserId: U, deviceId: DEV, terminalId: TERM };
  // Summaries are pure reads: the 1.0.37 queue is fully visible, incl. the not-yet-staged legacy sale.
  const sum0 = await OL.summarizeOperations(FULL);
  assert.deepEqual(sum0, { pending: 3, syncing: 1, retryable: 1, waiting_dependency: 0, needs_attention: 5, synced: 4, legacy_pending: 1, unsettled: 11 });
  assert.equal(await OL.unsettledOperationCountForDevice(DEV), 11 + 5 /* legacy rows queued: PEND RETRY CRASH DELIV UNSTAGED */, "device-wide unsettled (ops + legacy rows)");
  assert.deepEqual(await dumpDb(localdb, Object.keys(STORES_1037)), S0, "summaries wrote nothing");

  // The op left `syncing` by a crash is claimable (replayable) under its own scope; the other cashier's is not.
  const claim = (await OL.claimableOperations(FULL)).map((o) => o.operation_id);
  assert.ok(claim.includes("mig:txn:TX-CRASH"), "syncing-by-crash op is replayable");
  assert.ok(!claim.includes("op-other-cashier"));
  assert.deepEqual(claim, ["mig:txn:TX-PEND", "mig:txn:TX-RETRY", "mig:txn:TX-CRASH", "op-cust", "mig:txn:TX-DELIV"],"FIFO claim order, parked/synced excluded");

  // ---------------- first 1.0.38 launch, still OFFLINE ----------------
  // drainOffline with online=false = migrate bridge + historical recovery + (no replay) + reconcile.
  const offlineCtx = { ...FULL, online: false };
  const throwingDeps = () => {
    const calls: { dep: string; arg: unknown }[] = [];
    const d: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(defaultDeps)) {
      if (typeof v !== "function") continue;
      d[k] = async (arg: unknown) => {
        calls.push({ dep: k, arg });
        throw new TypeError("Failed to fetch"); // backend unreachable (hosts-blocked / no route)
      };
    }
    d.isTransport = (e: unknown) => e instanceof TypeError;
    d.hasSession = async () => true; // cached session present; only the API host is unreachable
    d.refreshSession = async () => false;
    return { deps: d as Partial<typeof defaultDeps>, calls };
  };
  const off = throwingDeps();
  const r0 = await drainOffline(offlineCtx, "upgrade-first-launch", off.deps);
  assert.equal(r0.migrateError, undefined);
  assert.equal(r0.reconcileError, undefined);
  assert.equal(off.calls.length, 0, "no server call while offline");
  const S2 = await dumpDb(localdb, Object.keys(STORES_1037));
  assertNoUnsettledLoss(S1, S2, "offline first launch");
  assert.deepEqual(diff(S1, S2), { operations: { added: ["mig:txn:TX-UNSTAGED"], removed: [], changed: {} } }, "offline first launch only STAGES the not-yet-migrated legacy sale");
  const staged = S2.operations["mig:txn:TX-UNSTAGED"] as { status: string; client_op_id: string; payload: { payment_intent: unknown } };
  assert.equal(staged.status, "pending");
  assert.equal(staged.client_op_id, "cop-txn-TX-UNSTAGED", "staged with the row's immutable client_op_id");
  assert.deepEqual(staged.payload.payment_intent, cash, "cash intent carried");

  // Idempotent: the same touches again (and each bridge function individually) change nothing.
  await drainOffline(offlineCtx, "upgrade-first-launch-2", off.deps);
  assert.deepEqual(await migrateLegacyToOperations(), { shiftsMigrated: 0, txnsMigrated: 0, outboxQuarantined: 0, skippedAlreadyMigrated: 8 });
  assert.deepEqual(await recoverHistoricalReplayFailures(), [], "no 1.0.37 op matches a historical-recovery category");
  await reconcileLegacyFromOperations();
  await reconcileDineDraftsFromOperations();
  assert.deepEqual(await dumpDb(localdb, Object.keys(STORES_1037)), S2, "second offline pass is a no-op");
  assert.equal((await localdb.dineDrafts.get("SESS-B"))?.status, "settled", "a settle parked behind a prerequisite keeps its bill CLOSED (not reopened)");

  // ---------------- synced-op GC (7-day window) ----------------
  // Never runs in the production drain path (drainOffline holds the lock → drainOperations skips GC), but it
  // is exported and invoked standalone; prove it cannot drop unsettled work or a referenced prerequisite.
  const removed = await OL.gcSyncedOperations();
  const S3 = await dumpDb(localdb, Object.keys(STORES_1037));
  assertNoUnsettledLoss(S2, S3, "gc");
  assert.equal(removed, 2);
  assert.deepEqual(diff(S2, S3), { operations: { added: [], removed: ["mig:shift:LS-SYNC", "op-payout-old"], changed: {} } }, "GC removes ONLY old, unreferenced SYNCED ops");
  assert.ok(S3.operations["op-B1"], "C6: an old synced prerequisite of a parked op is KEPT");
  // A GC'd migrated legacy op is re-staged (as synced, identical) by the next migrate — legacy rows are never
  // deleted, so this is churn, not loss; the synced history + entity map keep audit/remap continuity.
  await migrateLegacyToOperations();
  const S3b = await dumpDb(localdb, Object.keys(STORES_1037));
  assert.deepEqual(diff(S3, S3b), { operations: { added: ["mig:shift:LS-SYNC"], removed: [], changed: {} } });
  assert.deepEqual(S3b.operations["mig:shift:LS-SYNC"], S0.operations["mig:shift:LS-SYNC"], "re-staged identical to the 1.0.37 row");
  assert.equal(await OL.gcSyncedOperations(), 1, "GC again removes only the re-staged synced shift");
  await migrateLegacyToOperations();
  assert.deepEqual(await dumpDb(localdb, Object.keys(STORES_1037)), S3b, "GC → migrate converges (idempotent cycle)");
  const sum1 = await OL.summarizeOperations(FULL);
  assert.deepEqual(sum1, { pending: 4, syncing: 1, retryable: 1, waiting_dependency: 0, needs_attention: 5, synced: 3, legacy_pending: 0, unsettled: 11 });

  // ---------------- first ONLINE drain, backend unreachable ----------------
  const on = throwingDeps();
  const onlineCtx = { ...FULL, online: true };
  const r1 = await drainOffline(onlineCtx, "upgrade-first-online", on.deps);
  assert.equal(r1.migrateError, undefined);
  assert.equal(r1.reconcileError, undefined);
  const S4 = await dumpDb(localdb, Object.keys(STORES_1037));
  assertNoUnsettledLoss(S3b, S4, "first online drain");
  const d4 = diff(S3b, S4);
  // Only operations (bookkeeping fields) + appended history changed; every other store is identical.
  assert.deepEqual(Object.keys(d4).sort(), ["operations", "syncHistory"]);
  assert.deepEqual(d4.operations.added, []);
  assert.deepEqual(d4.operations.removed, []);
  assert.deepEqual(d4.syncHistory.removed, []);
  assert.deepEqual(d4.syncHistory.changed, {});
  for (const [id, fields] of Object.entries(d4.operations.changed)) {
    for (const f of fields) assert.ok(BOOKKEEPING.has(f), `${id}: non-bookkeeping field ${f} changed`);
  }
  const st = (id: string) => (S4.operations[id] as { status: string }).status;
  const statuses = Object.fromEntries(Object.keys(S4.operations).map((id) => [id, st(id)]));
  assert.deepEqual(statuses, {
    "mig:outbox:1": "needs_attention", // quarantine — never replayed
    "mig:shift:LS-SYNC": "synced",
    "mig:txn:TX-CRASH": "retryable", // syncing (crash) → replayed → transport → retryable
    "mig:txn:TX-DELIV": "blocked_dependency", // waits for its offline customer
    "mig:txn:TX-PEND": "retryable",
    "mig:txn:TX-RETRY": "retryable", // inside its backoff window: not attempted
    "mig:txn:TX-SYNCED": "synced",
    "mig:txn:TX-UNSTAGED": "retryable",
    "op-A1": "needs_attention", // real refusal: untouched
    "op-A2": "needs_attention", // its prerequisite is still refused → stays dependency_failed (deterministic)
    "op-B1": "synced",
    "op-B2": "retryable", // C2: prerequisite synced → re-opened → replayed → transport → retryable
    "op-B3": "blocked_dependency", // C2: re-opened → now waits for B2 (no longer terminal)
    "op-cust": "retryable",
    "op-other-cashier": "pending", // another cashier's scope: deferred, untouched
  });
  assert.deepEqual(Object.keys(d4.operations.changed).sort(), ["mig:txn:TX-CRASH", "mig:txn:TX-DELIV", "mig:txn:TX-PEND", "mig:txn:TX-UNSTAGED", "op-B2", "op-B3", "op-cust"]);
  assert.deepEqual(S4.operations["op-A2"], S3b.operations["op-A2"]);
  assert.deepEqual((r1.reopened ?? []).slice().sort(), ["op-B2", "op-B3"], "C2 pre-pass re-opened exactly the recoverable chain");
  // Exactly one canonical attempt per replayable op, each with its immutable payload; nothing else called.
  assert.deepEqual(on.calls.map((c) => c.dep).sort(), ["submit", "submit", "submit", "submitRound", "upsertCustomer"]);
  const submitted = on.calls.filter((c) => c.dep === "submit").map((c) => (c.arg as { items: { note: string }[] }).items[0].note).sort();
  assert.deepEqual(submitted, ["TX-CRASH", "TX-PEND", "TX-UNSTAGED"]);
  assert.equal((on.calls.find((c) => c.dep === "submitRound")?.arg as { table_id: string }).table_id, "TABLE-B-CANON", "round remapped to the canonical table");
  const newEvents = d4.syncHistory.added.map((k) => S4.syncHistory[k] as { operation_id: string; status: string });
  for (const e of newEvents) {
    assert.ok(Object.keys(d4.operations.changed).includes(e.operation_id), `history only for transitioned ops (${e.operation_id})`);
    assert.notEqual(e.status, "synced", "nothing claims synced while the backend is unreachable");
  }
  // Legacy rows / drafts untouched by reconcile (no terminal transition happened).
  assert.equal((await localdb.dineDrafts.get("SESS-B"))?.status, "settled");
  assert.equal((await localdb.dineDrafts.get("SESS-A"))?.status, "open");

  // Second online drain right away: everything is in backoff or waiting → a pure no-op (idempotent).
  const on2 = throwingDeps();
  await drainOffline(onlineCtx, "upgrade-second-online", on2.deps);
  assert.equal(on2.calls.length, 0, "no re-attempt inside backoff (no hot loop)");
  assert.deepEqual(await dumpDb(localdb, Object.keys(STORES_1037)), S4, "second drain is a no-op");

  // ---------------- restart (close / reopen) ----------------
  localdb.close();
  await localdb.open();
  assert.ok(localdb.verno >= 11);
  assert.deepEqual(await dumpDb(localdb, Object.keys(STORES_1037)), S4, "identical state after restart");
  assert.deepEqual(storage.dump(), LS0, "localStorage untouched across the whole upgrade + first runtime");
  for (const id of UNSETTLED_1037) assert.ok(await localdb.operations.get(id), `1.0.37 unsettled op ${id} still present after restart`);
  const sum2 = await OL.summarizeOperations(FULL);
  assert.deepEqual(sum2, { pending: 0, syncing: 0, retryable: 6, waiting_dependency: 2, needs_attention: 3, synced: 3, legacy_pending: 0, unsettled: 11 });
  assert.deepEqual(await OL.summarizeOperations({ tenantId: T, branchId: B }), { ...sum2, pending: 1, unsettled: 12 }, "other cashier's op still counted tenant/branch-wide");
});
