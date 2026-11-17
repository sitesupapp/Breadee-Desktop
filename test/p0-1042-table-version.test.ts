// 1.0.42 (P0 incident 2026-11-17, #2123) — Production's pos_table_map carries NO table pos_entity_version
// (Staging migration 20261013200551 never reached Production). Through 1.0.41 the parser's placeholder 0 was
// sent as the offline open's expected_version, so pos_open_table_core refused EVERY offline open of a table
// at version > 0 (VERSION_CONFLICT) and parked its rounds + payments; the Sync Center rebase re-armed it with
// 0 again, so it could never recover.
//
// Real Dexie (fake-indexeddb), the REAL orchestrator, handlers, capture engine and rebase; server RPCs
// injected. Synthetic fixtures only (TBL-X / t1 / b1 / u1). No network, no Staging, no Production.

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

import { localdb } from "@/lib/offline/db";
import { getOperation, type OfflineOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { useShift, shiftNet } from "@/state/shift";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { openTableOffline, addDraftLine, sendRoundOffline, settleTableOffline, reconcileDineDraftsFromOperations } from "@/lib/offline/dineinOffline";
import { captureEndShiftOffline } from "@/lib/offline/endShiftOffline";
import { rebaseRefusedOpen, type RebaseDeps } from "@/lib/offline/openRebase";
import { OPEN_VERSION_UNKNOWN_TABLE_BUSY, OPEN_VERSION_UNKNOWN_UNVERIFIED } from "@/lib/offline/handlers";
import { parseTableMap, knownTableVersion } from "@/lib/pos/tables";
import { getDeviceIdentity } from "@/lib/device";
import type { ActiveShift } from "@/types/pos";
import type { TableSummary } from "@/types/tables";

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const DSCOPE = { ...SCOPE, shiftId: "SRV-SHIFT" };
const CTX = { ...SCOPE, online: true };
const SHIFT: ActiveShift = { id: "SRV-SHIFT", status: "open", opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 0, branch_id: "b1" } as ActiveShift;
const VERSION_CONFLICT = "This table changed since it was loaded. Reload the table map and retry.";

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.posCustomers.clear(),
  ]);
  __resetDrainLockForTests();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  useShift.setState({ shift: SHIFT, pendingLocalId: null, loading: false });
  shiftNet.findOpenShift = async () => SHIFT;
  shiftNet.getCashBox = async () => null as never;
  shiftNet.reachable = async () => true;
  shiftNet.openShift = async () => { throw new Error("openShift must not be called"); };
});

type Call = { name: string; arg: unknown };
/** The Production server: a table at version 24 and a CAS identical to pos_open_table_core
 *  (`where v_expected is null or pos_entity_version = v_expected`, else VERSION_CONFLICT before any write). */
function prodServer(calls: Call[], opts: { liveRow?: TableSummary | null; receipt?: boolean; guard?: boolean; guardThrows?: boolean; serverVersion?: number } = {}): PosTxnSyncDeps {
  let version = opts.serverVersion ?? 24;
  const guard = {
    readTable: async (b: string | null, t: string) => { calls.push({ name: "read_table", arg: `${b}:${t}` }); if (opts.guardThrows) throw new TypeError("Failed to fetch"); return opts.liveRow === undefined ? freeRowNoVersion() : opts.liveRow; },
    hasReceipt: async (_t: string, id: string) => { calls.push({ name: "receipt", arg: id }); if (opts.guardThrows) throw new TypeError("Failed to fetch"); return opts.receipt === true; },
  };
  return {
    submit: async () => ({ order_id: "SRV-ORD", order_number: "N-1" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "SRV-SHIFT", reused: true }),
    openTable: async (p: { expected_version?: number | null }) => {
      calls.push({ name: "open_table", arg: p });
      const expected = p.expected_version ?? null;
      if (expected !== null && expected !== version) throw Object.assign(new Error(VERSION_CONFLICT), { code: "P0001", details: '{"pos_error_code" : "VERSION_CONFLICT"}' });
      version += 1;
      return { table_id: "TBL-X", pos_entity_version: version };
    },
    submitRound: async (p: unknown) => { calls.push({ name: "round", arg: p }); return { order_id: "ORD-A", order_number: "N", batch_no: 1, appended: false, idempotent: false }; },
    orderItemMap: async () => [],
    payTable: async (a: unknown) => { calls.push({ name: "pay_table", arg: a }); return { ok: true, amount: 1, idempotent: false, pos_entity_version: version + 1 }; },
    payOrderOp: async (a: { orderId: string }) => ({ order_id: a.orderId, paid: true, amount: 1, idempotent: false }),
    onAccountTable: async () => ({ ok: true, idempotent: false }),
    onAccountOrder: async () => ({ ok: true, idempotent: false }),
    upsertCustomer: async () => ({ customer_id: "C", address_id: "A", is_new: true }),
    editOrderLine: async () => ({ ok: true, idempotent: false, replacement_order_item_id: "R", pos_entity_version: 1 }),
    endShiftOp: async (a: { shiftId: string }) => ({ shift_id: a.shiftId, idempotent: false }),
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
    // explicit undefined: the orchestrator layers injected deps over the live ones
    tableGuard: opts.guard === false ? undefined : guard,
  } as unknown as PosTxnSyncDeps;
}

/** What Production's pos_table_map returns today for a free table: no pos_entity_version key at all. */
const PROD_MAP_RAW = { tables: [{ id: "TBL-X", name: "alpha", seats: 4, occupied: false, status: "available", canonical: true, configured: true, sort_order: 1, orders: 0, order_number: null, opened_at: null, total: null, currency: null, mixed_currency: false, merged_sources: [] }], total: 1, occupied: 0, available: 1, configured: 1, legacy_hidden: 0 };
const freeRowNoVersion = (): TableSummary => parseTableMap(PROD_MAP_RAW).tables[0];
const busyRowNoVersion = (): TableSummary => ({ ...freeRowNoVersion(), occupied: true, status: "occupied", orders: 1, order_number: "261117-0099", total: 9 });
const freeRowWithVersion = (v: number): TableSummary => parseTableMap({ ...PROD_MAP_RAW, tables: [{ ...PROD_MAP_RAW.tables[0], pos_entity_version: v }] }).tables[0];

/** An offline dine-in session captured from the Production map (the incident): open + one round. */
async function captureFromProdMap(row: TableSummary) {
  const d = await openTableOffline({ scope: DSCOPE, tableId: "TBL-X", tableName: "alpha", seats: 4, currency: "USD", baseOrderVersion: knownTableVersion(row), baseVersionKnown: knownTableVersion(row) != null });
  await addDraftLine(d.local_session_id, { menu_item_id: "m1", name: "Burger", base_price: 6, quantity: 1, modifiers: [], kitchen_note: null });
  await sendRoundOffline(d.local_session_id);
  const all = await localdb.operations.toArray();
  return { d, open: all.find((o) => o.operation_type === "dinein_open_table")!, round: all.find((o) => o.operation_type === "dinein_send_round")! };
}

// ============================================================ parser contract

test("P0-1 parser: a Production row WITHOUT pos_entity_version is 'unknown', never a CAS 0; a real 0 / 24 stays known", () => {
  const prod = freeRowNoVersion();
  assert.equal(prod.pos_entity_version, 0, "the placeholder is unchanged for display-only consumers");
  assert.equal(prod.pos_entity_version_known, false);
  assert.equal(knownTableVersion(prod), null);
  assert.equal(knownTableVersion(freeRowWithVersion(24)), 24);
  assert.equal(knownTableVersion(freeRowWithVersion(0)), 0, "a genuine version 0 is still a real token");
  assert.equal(knownTableVersion({ pos_entity_version: 7 }), 7, "fixtures without the flag keep their version");
  assert.equal(knownTableVersion(null), null);
});

// ============================================================ the incident, reproduced and fixed

test("P0-2 INCIDENT REPRO (1.0.41 behaviour): the placeholder 0 sent as expected_version is refused at version 24", async () => {
  // exactly what 1.0.41 did: baseOrderVersion = raw.pos_entity_version (0) with no known-flag
  await openTableOffline({ scope: DSCOPE, tableId: "TBL-X", tableName: "alpha", seats: 4, currency: "USD", baseOrderVersion: freeRowNoVersion().pos_entity_version });
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", prodServer(calls));
  const open = (await localdb.operations.toArray()).find((o) => o.operation_type === "dinein_open_table")!;
  assert.equal((calls.find((c) => c.name === "open_table")!.arg as { expected_version: number }).expected_version, 0);
  assert.equal(open.status, "needs_attention");
  assert.equal(open.last_error_code, "version_conflict");
});

test("P0-3 FIXED capture: an unknown version is recorded as version_unknown (expected_version null), never 0", async () => {
  const { open } = await captureFromProdMap(freeRowNoVersion());
  const p = open.payload as { expected_version: number | null; version_unknown?: boolean };
  assert.equal(p.expected_version, null);
  assert.equal(p.version_unknown, true);
  // a known version keeps the 1.0.41 CAS contract exactly
  await localdb.operations.clear(); await localdb.dineDrafts.clear();
  const known = await captureFromProdMap(freeRowWithVersion(24));
  const kp = known.open.payload as { expected_version: number | null; version_unknown?: boolean };
  assert.equal(kp.expected_version, 24);
  assert.equal(kp.version_unknown, undefined);
});

test("P0-4 FIXED replay, table FREE on Breadee: receipt checked, table proved free, opened ONCE; the round follows; same client_op_id", async () => {
  const { open } = await captureFromProdMap(freeRowNoVersion());
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", prodServer(calls));
  assert.deepEqual(calls.map((c) => c.name), ["receipt", "read_table", "open_table", "round"]);
  assert.equal((calls[2].arg as { expected_version: number | null }).expected_version, null, "the live map has no version: opened under the free-table proof");
  assert.equal((calls[2].arg as { client_op_id: string }).client_op_id, open.client_op_id);
  const after = await localdb.operations.toArray();
  assert.equal(after.every((o) => o.status === "synced"), true);
});

test("P0-5 FIXED replay after the server fix (S-TABLEMAP_01): the LIVE version is used as the CAS token", async () => {
  await captureFromProdMap(freeRowNoVersion());
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", prodServer(calls, { liveRow: freeRowWithVersion(24) }));
  assert.equal((calls.find((c) => c.name === "open_table")!.arg as { expected_version: number | null }).expected_version, 24);
  assert.equal((await localdb.operations.toArray()).every((o) => o.status === "synced"), true);
});

test("P0-6 FIXED replay, table OCCUPIED on Breadee: NOT sent (never joins someone else's bill); round parked; no business call", async () => {
  const { open, round } = await captureFromProdMap(freeRowNoVersion());
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", prodServer(calls, { liveRow: busyRowNoVersion() }));
  assert.equal(calls.some((c) => c.name === "open_table" || c.name === "round"), false);
  const o = (await getOperation(open.operation_id))!;
  assert.equal(o.status, "needs_attention");
  assert.equal(o.last_error_code, "table_busy");
  assert.equal(o.last_error_message, OPEN_VERSION_UNKNOWN_TABLE_BUSY);
  assert.equal(o.client_op_id, open.client_op_id, "the operation id and evidence are preserved");
  const r = (await getOperation(round.operation_id))!;
  assert.notEqual(r.status, "synced");
});

test("P0-7 FIXED replay, lost acknowledgement: Breadee holds the receipt → replayed without the table check (server returns the recorded open)", async () => {
  await captureFromProdMap(freeRowNoVersion());
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", prodServer(calls, { receipt: true, liveRow: busyRowNoVersion() }));
  assert.deepEqual(calls.slice(0, 2).map((c) => c.name), ["receipt", "open_table"], "an occupied table is OUR applied open — never misread as busy");
});

test("P0-8 fail closed: no guard available → parked 'table_unverified'; guard unreachable → stays retryable; nothing sent", async () => {
  const { open } = await captureFromProdMap(freeRowNoVersion());
  const calls: Call[] = [];
  await drainOffline(CTX, "reconnect", prodServer(calls, { guard: false }));
  assert.equal(calls.length, 0);
  const o = (await getOperation(open.operation_id))!;
  assert.equal(o.last_error_code, "table_unverified");
  assert.equal(o.last_error_message, OPEN_VERSION_UNKNOWN_UNVERIFIED);

  await localdb.operations.clear(); await localdb.dineDrafts.clear(); __resetDrainLockForTests();
  const second = await captureFromProdMap(freeRowNoVersion());
  const c2: Call[] = [];
  await drainOffline(CTX, "reconnect", prodServer(c2, { guardThrows: true }));
  assert.equal(c2.some((c) => c.name === "open_table"), false);
  const s = (await getOperation(second.open.operation_id))!;
  assert.notEqual(s.status, "synced");
  assert.notEqual(s.last_error_code, "table_busy", "an unreachable check is not a business refusal");
});

// ============================================================ full lifecycle on the Production contract

test("P0-LC offline open → round → CASH pay → RESTART → reconnect → sync → shift close: table usable, each call exactly once, payment once, shift closes last", async () => {
  const { d } = await captureFromProdMap(freeRowNoVersion());
  const pay = await settleTableOffline({ sessionId: d.local_session_id, method: "cash", covers: { orderIds: [], summary: false }, expectedAmount: 6 });
  const end = await captureEndShiftOffline({ scope: SCOPE, shiftId: "SRV-SHIFT", shiftLocal: null, actualCashCounted: 6, notes: null, shiftOpenedAt: SHIFT.opened_at });
  // restart before the connection returns: every op and the session survive
  localdb.close();
  await localdb.open();
  await reconcileDineDraftsFromOperations();
  __resetDrainLockForTests();
  const calls: Call[] = [];
  const server = prodServer(calls);
  (server as unknown as { endShiftOp: (a: { shiftId: string }) => Promise<unknown> }).endShiftOp = async (a) => { calls.push({ name: "end_shift", arg: a }); return { shift_id: a.shiftId, idempotent: false }; };
  await drainOffline(CTX, "reconnect", server);
  const names = calls.map((c) => c.name);
  assert.deepEqual(names.filter((n) => n !== "receipt" && n !== "read_table"), ["open_table", "round", "pay_table", "end_shift"], "dependency order kept; the shift closes only after the sale and its payment");
  assert.equal(names.filter((n) => n === "pay_table").length, 1, "the cash is booked exactly once");
  assert.equal((await getOperation(pay.operationId))!.status, "synced");
  assert.equal((await getOperation(end.operationId))!.status, "synced");
  // a second reconnect sends nothing (exactly-once across restart + reconnect)
  __resetDrainLockForTests();
  const again: Call[] = [];
  await drainOffline(CTX, "reconnect", prodServer(again));
  assert.equal(again.filter((c) => ["open_table", "round", "pay_table"].includes(c.name)).length, 0);
});

// ============================================================ recovery of ALREADY-REFUSED 1.0.41 captures

const rebaseDeps = (row: TableSummary | null, receipt = false): RebaseDeps => ({
  readTable: async () => row,
  hasReceipt: async () => receipt,
  salesSince: async () => [],
});

test("P0-9 Retry of a 1.0.41 open refused on its placeholder 0: re-armed as version_unknown (not 0 again), audit records to_version null; then syncs once", async () => {
  await openTableOffline({ scope: DSCOPE, tableId: "TBL-X", tableName: "alpha", seats: 4, currency: "USD", baseOrderVersion: 0 });
  await drainOffline(CTX, "reconnect", prodServer([]));
  const refused = (await localdb.operations.toArray()).find((o) => o.operation_type === "dinein_open_table")!;
  assert.equal(refused.last_error_code, "version_conflict");
  const r = await rebaseRefusedOpen(refused.operation_id, rebaseDeps(freeRowNoVersion()), "u1", { drain: false });
  assert.deepEqual(r, { kind: "rebased", fromVersion: 0, toVersion: null });
  const o = (await getOperation(refused.operation_id))! as OfflineOperation;
  assert.equal((o.payload as { expected_version: number | null }).expected_version, null);
  assert.equal((o.payload as { version_unknown?: boolean }).version_unknown, true);
  assert.equal(o.rebases?.[0].to_version, null);
  assert.equal(o.client_op_id, refused.client_op_id);
  __resetDrainLockForTests();
  const calls: Call[] = [];
  await drainOffline(CTX, "operator-retry", prodServer(calls));
  assert.equal(calls.filter((c) => c.name === "open_table").length, 1);
  assert.equal((await getOperation(refused.operation_id))!.status, "synced");
});

test("P0-10 Retry still fails closed on a busy table or a server receipt (unchanged 1.0.41 guards)", async () => {
  await openTableOffline({ scope: DSCOPE, tableId: "TBL-X", tableName: "alpha", seats: 4, currency: "USD", baseOrderVersion: 0 });
  await drainOffline(CTX, "reconnect", prodServer([]));
  const refused = (await localdb.operations.toArray()).find((o) => o.operation_type === "dinein_open_table")!;
  const before = JSON.stringify(await localdb.operations.toArray());
  assert.equal((await rebaseRefusedOpen(refused.operation_id, rebaseDeps(busyRowNoVersion()), "u1", { drain: false })).kind, "table_busy");
  assert.equal((await rebaseRefusedOpen(refused.operation_id, rebaseDeps(freeRowNoVersion(), true), "u1", { drain: false })).kind, "receipt_found");
  assert.equal(JSON.stringify(await localdb.operations.toArray()), before, "nothing changed");
});
