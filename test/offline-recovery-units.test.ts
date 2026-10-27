// Offline-first recovery — unit coverage of the lower layers the twelve bugs share:
//   * Bug 12 Drawer: visibility from durable local state + the provisional offline projection;
//   * Bug 06/10 per-cashier POS-session snapshots (a user switch never loses the other's shift);
//   * Domain 3: every POS read RPC + the auth token endpoint are bounded; writes are not;
//   * raw transport text never reaches a cashier; measured timings summarise to p50/p95/p99.

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
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const { canSeeDrawer, buildOfflineDrawerView, cacheServerCashBox, readCachedServerCashBox, extractTakeawayCashMovements, DRAWER_PERMISSION } = await import("@/lib/pos/offlineDrawer");
const posSession = await import("@/lib/offline/posSession");
const { requestTimeoutMs, READ_TIMEOUT_MS, AUTH_TOKEN_TIMEOUT_MS } = await import("@/lib/net/timeoutFetch");
const { classifyError, OFFLINE_MESSAGE } = await import("@/lib/pos/errors");
const { summarize } = await import("@/lib/perf/timings");

type Op = import("@/lib/offline/operationLog").OfflineOperation;

const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "d1", terminalId: "T1" };
const T0 = Date.parse("2026-10-27T08:00:00Z");

function op(id: string, type: string, payload: Record<string, unknown>, atMs: number, over: Partial<Op> = {}): Op {
  return {
    operation_id: id,
    operation_type: type,
    schema_version: 1,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "d1", terminal_id: "T1", cashier_user_id: "u1" },
    created_at: new Date(atMs).toISOString(),
    client_op_id: `c-${id}`,
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload,
    status: "pending",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
    ...over,
  } as Op;
}

beforeEach(() => (globalThis as unknown as { localStorage: MemStorage }).localStorage.clear());

// --- Bug 12: Drawer --------------------------------------------------------------------------

test("Drawer visibility comes from the cached permission + own open shift, never from a server read", () => {
  assert.equal(canSeeDrawer({ [DRAWER_PERMISSION]: true }, true), true);
  assert.equal(canSeeDrawer({ [DRAWER_PERMISSION]: true }, false), false, "no shift → no drawer");
  assert.equal(canSeeDrawer({ "pos.access": true }, true), false, "an unpermitted user stays blocked offline");
  assert.equal(canSeeDrawer({ [DRAWER_PERMISSION]: false }, true), false);
});

test("offline drawer = last server figure + cash movements captured AFTER it (scope-exact, none guessed)", () => {
  cacheServerCashBox("S1", { expected_cash: 120 } as never, T0);
  const server = readCachedServerCashBox("S1");
  assert.deepEqual(server, { shiftId: "S1", expectedCashUsd: 120, fetchedAtMs: T0 });
  const ops = [
    op("before", "pay_table", { method: "cash", cash_amount_usd: 50 }, T0 - 1000), // already in the server figure
    op("sale", "pay_table", { method: "cash", cash_amount_usd: 30 }, T0 + 1000),
    op("card", "pay_order", { method: "card", cash_amount_usd: 15 }, T0 + 2000), // non-cash: not in the drawer
    op("payout", "payout", { amount_usd: 10, method: "cash" }, T0 + 3000),
    op("refund", "void_refund", { refund: true, tender: "cash", expected_refund_usd: 5 }, T0 + 4000),
    op("ta", "takeaway_sale", { payment_intent: { method: "cash", currency: "USD" }, total: 12.5, currency: "USD" }, T0 + 5000),
    op("ta-disc", "takeaway_sale", { payment_intent: { method: "cash", currency: "USD", discount: { discount_type: "percent", discount_value: 10 } }, total: 20, currency: "USD" }, T0 + 6000),
    op("other-cashier", "pay_table", { method: "cash", cash_amount_usd: 999 }, T0 + 7000, { scope: { tenant_id: "t1", branch_id: "b1", device_id: "d1", terminal_id: "T1", cashier_user_id: "u2" } }),
    op("cancelled", "pay_table", { method: "cash", cash_amount_usd: 999 }, T0 + 8000, { status: "cancelled" }),
  ];
  const v = buildOfflineDrawerView({ ops, scope: SCOPE, server, openingFloatUsd: null, shiftOpenedAtMs: T0 - 3600_000, usdRate: 89_500 });
  assert.equal(v.baseSource, "server");
  assert.equal(v.cashInUsd, 42.5); // 30 + 12.5
  assert.equal(v.cashOutUsd, 15); // 10 + 5
  assert.equal(v.projectedUsd, 147.5); // 120 + 42.5 − 15
  assert.equal(v.unknownAmountCount, 1, "the discounted takeaway is counted, not guessed");
});

test("offline-opened shift: opening float (LBP → USD at the cached rate) is the base; unknown rate → no fabricated figure", () => {
  const ops = [op("sale", "takeaway_sale", { payment_intent: { method: "cash", currency: "LBP" }, total: 895_000, currency: "LBP" }, T0 + 1000)];
  const withRate = buildOfflineDrawerView({ ops, scope: SCOPE, server: null, openingFloatUsd: 50, shiftOpenedAtMs: T0, usdRate: 89_500 });
  assert.equal(withRate.baseSource, "opening_float");
  assert.equal(withRate.projectedUsd, 60);
  const noRate = extractTakeawayCashMovements(ops, SCOPE, null);
  assert.equal(noRate.movements.length, 0);
  assert.equal(noRate.unknownAmountCount, 1);
  const noBase = buildOfflineDrawerView({ ops, scope: SCOPE, server: null, openingFloatUsd: null, shiftOpenedAtMs: T0, usdRate: null });
  assert.equal(noBase.projectedUsd, null, "never invent a base");
});

// --- Bugs 06 / 10: per-cashier POS-session snapshots ------------------------------------------

function snap(cashier: string, shiftId: string) {
  return { version: 1 as const, source: "server" as const, savedAt: Date.now(), device_id: "d1", tenant_id: "t1", cashier_user_id: cashier, branch_id: "b1", branch_name: "Main", currency: "USD", shift: { id: shiftId, status: "open" as const, opened_at: null, opening_cash_amount: 0, branch_id: "b1" } };
}

test("each cashier keeps their own shift snapshot; a user switch never overwrites the other's", () => {
  posSession.savePosSessionSnapshot(snap("A", "SA"));
  posSession.savePosSessionSnapshot(snap("B", "SB"));
  assert.equal(posSession.readPosSessionSnapshot("A")?.shift.id, "SA");
  assert.equal(posSession.readPosSessionSnapshot("B")?.shift.id, "SB");
  assert.equal(posSession.readAllPosSessionSnapshots().length, 2);
  posSession.clearPosSessionSnapshot("A");
  assert.equal(posSession.readPosSessionSnapshot("A"), null);
  assert.equal(posSession.readPosSessionSnapshot("B")?.shift.id, "SB", "clearing A leaves B intact");
  const restored = posSession.restoreShiftFromSnapshot(posSession.readPosSessionSnapshot("B"), { deviceId: "d1", tenantId: "t1", cashierUserId: "B", branchId: "b1" });
  assert.equal(restored?.id, "SB");
});

test("a pre-recovery single-key snapshot is still restored for its own cashier only", () => {
  localStorage.setItem("breadee-desktop-pos-session", JSON.stringify(snap("A", "LEGACY")));
  assert.equal(posSession.readPosSessionSnapshot("A")?.shift.id, "LEGACY");
  assert.equal(posSession.readPosSessionSnapshot("B"), null);
  posSession.savePosSessionSnapshot(snap("A", "SA2"));
  assert.equal(localStorage.getItem("breadee-desktop-pos-session"), null, "migrated to A's own key");
  assert.equal(posSession.readPosSessionSnapshot("A")?.shift.id, "SA2");
});

// --- Domain 3: bounded reads -------------------------------------------------------------------

test("every POS read RPC and the auth token endpoint are bounded; money-moving writes are not", () => {
  const rpc = (n: string) => `https://x.supabase.co/rest/v1/rpc/${n}`;
  for (const n of ["pos_menu", "pos_table_map", "floor_service_layout", "pos_cash_box_shift", "pos_shift_expected", "pos_payout_list", "delivery_providers_operational"]) {
    assert.equal(requestTimeoutMs("POST", rpc(n)), READ_TIMEOUT_MS, n);
  }
  assert.equal(requestTimeoutMs("POST", "https://x.supabase.co/auth/v1/token?grant_type=refresh_token"), AUTH_TOKEN_TIMEOUT_MS);
  for (const n of ["pos_submit_order", "pos_pay_order", "pos_pay_table", "pos_end_shift", "pos_complete_on_account"]) {
    assert.equal(requestTimeoutMs("POST", rpc(n)), null, `${n} must never be aborted client-side`);
  }
  assert.equal(requestTimeoutMs("GET", "https://x.supabase.co/rest/v1/pos_orders"), READ_TIMEOUT_MS);
});

test("a transport failure or timeout never shows raw text to the cashier", () => {
  for (const e of [new TypeError("Failed to fetch"), new Error("Request timed out after 15000 ms"), new DOMException("signal is aborted without reason", "AbortError")]) {
    const c = classifyError(e);
    assert.equal(c.kind, "offline");
    assert.equal(c.message, OFFLINE_MESSAGE);
    assert.ok(!/fetch|timed out|abort/i.test(c.message));
  }
  assert.equal(classifyError(new Error("This order is already paid")).kind, "already_paid", "business refusals keep their wording");
});

test("timings summarise to p50 / p95 / p99 / max per interaction", () => {
  const s = summarize(Array.from({ length: 100 }, (_, i) => ({ name: "menu.render", ms: i + 1, at: 0, offline: true })));
  assert.deepEqual(s["menu.render"], { n: 100, p50: 50, p95: 95, p99: 99, max: 100 });
});
