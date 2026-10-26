// Desktop 1.0.38 (Bug 3) — offline CLOSE(N) → OPEN(N+1). Real Dexie (fake-indexeddb), the REAL shift store,
// the REAL capture paths, the REAL single orchestrator + handlers; only the server RPCs are a small fake that
// models pos_open_shift's single-open rule + client_op_id replay ledger and pos_end_shift.
//
//   G  close → open next shift offline (deterministic, chained identity; ops bound per shift)
//   H  restart between shifts (offline restart + not-yet-synced server read surface N+1)
//   I  reconnect both shifts: close(N) → open(N+1) → N+1's work; one canonical shift each; float once;
//      lost-response replay; second reconnect zero
//   F  a foreign shift opened elsewhere → fail-closed CONFLICT (never adopted), recoverable after resolution
//   R  close refused → open(N+1) blocked (dependency_failed), N+1 work retained
//   A  approval-required / unknown branch → chained open refused at capture

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

import { localdb, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, requeueOperation } from "@/lib/offline/operationLog";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";
import { useShift, shiftNet, localCloseStateOf, ShiftStillClosingError } from "@/state/shift";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { cacheEndShiftApprovalRequired, createLocalPendingShift, readCachedEndShiftApprovalRequired } from "@/lib/offline/pendingShift";
import { resolveOperationalShift } from "@/lib/offline/shiftIdentity";
import { migrateLegacyToOperations } from "@/lib/offline/migration";
import { getDeviceIdentity } from "@/lib/device";
import type { ActiveShift } from "@/types/pos";

const DEV = getDeviceIdentity();
const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: DEV.device_id, terminalId: DEV.terminal_id ?? null };
const CTX = { ...SCOPE, online: true };
const N: ActiveShift = { id: "SRV-N", status: "open", opened_at: new Date(Date.now() - 3_600_000).toISOString(), opening_cash_amount: 40, branch_id: "b1" } as ActiveShift;
const OPEN = { tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 25, currency: "LBP" };
const offline = async () => { throw new TypeError("Failed to fetch"); };

beforeEach(async () => {
  await Promise.all([
    localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(),
    localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.posCustomers.clear(),
  ]);
  __resetDrainLockForTests();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  shiftNet.findOpenShift = offline;
  shiftNet.getCashBox = async () => null as never;
  shiftNet.reachable = async () => false;
  shiftNet.openShift = async () => { throw new Error("online openShift must not be called"); };
  shiftNet.endShiftApprovalRequired = null;
});

type Call = { name: string; arg: Record<string, unknown> };

/** The server: pos_open_shift (single-open + client_op_id ledger + optional require_new), pos_end_shift
 *  (approval_required=false → closed), pos_submit_order / pos_pay_order. */
function fakeServer(init: { open?: string | null; approvalRequired?: boolean } = {}) {
  const calls: Call[] = [];
  const ledger = new Map<string, { shiftId: string; reused: boolean }>();
  const floats: { shiftId: string; openingCash: number }[] = [];
  const s = { open: init.open ?? null as string | null, seq: 0, dropNextOpenResponse: false, honourRequireNew: true };
  const deps = {
    openShift: async (a: { branchId: string | null; openingCash: number; clientOpId: string; requireNew?: boolean }) => {
      calls.push({ name: "open_shift", arg: a as unknown as Record<string, unknown> });
      const cached = ledger.get(a.clientOpId);
      if (cached) return cached; // pos_op_replay: this op's OWN recorded result
      let r: { shiftId: string; reused: boolean };
      if (s.open) {
        if (a.requireNew && s.honourRequireNew) {
          throw Object.assign(new Error("Another shift is already open for this cashier on this branch."), { details: JSON.stringify({ pos_error_code: "SHIFT_ALREADY_OPEN" }) });
        }
        r = { shiftId: s.open, reused: true };
      } else {
        s.seq += 1;
        r = { shiftId: `SRV-NEW-${s.seq}`, reused: false };
        s.open = r.shiftId;
        floats.push({ shiftId: r.shiftId, openingCash: a.openingCash });
      }
      ledger.set(a.clientOpId, r);
      if (s.dropNextOpenResponse) { s.dropNextOpenResponse = false; throw new TypeError("Failed to fetch"); }
      return r;
    },
    endShiftOp: async (a: { shiftId: string }) => {
      calls.push({ name: "end_shift", arg: a as unknown as Record<string, unknown> });
      if (s.open === a.shiftId) s.open = null;
      return { shift_id: a.shiftId, idempotent: false, approval_required: init.approvalRequired ?? false };
    },
    submit: async (p: Record<string, unknown>) => { calls.push({ name: "submit", arg: p }); return { order_id: `ORD-${calls.length}`, order_number: `N-${calls.length}` }; },
    pay: async (a: Record<string, unknown>) => { calls.push({ name: "pay", arg: a }); return { paid: true }; },
    isTransport: (e: unknown) => e instanceof TypeError,
    hasSession: async () => true,
  };
  return { calls, floats, state: s, deps: deps as unknown as PosTxnSyncDeps };
}

/** A takeaway cash sale captured offline against `shiftId` (canonical) or a local pending shift. */
async function sale(shiftId: string, local: boolean, total: number) {
  const id = crypto.randomUUID();
  const op = crypto.randomUUID();
  await localdb.posOfflineTxns.add({
    local_txn_id: id, client_op_id: op, tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, terminal_id: DEV.terminal_id ?? "",
    cashier_user_id: "u1", cashier_user_name: "A", shift_id: shiftId, created_at: new Date().toISOString(),
    order_payload: { client_op_id: op, order_type: "takeaway", shift_id: shiftId, branch_id: "b1", status: "sent_to_kitchen", notes: null, items: [] },
    payment_intent: { method: "cash", currency: "LBP" }, currency: "LBP", total, status: "queued", attempts: 0,
    pending_shift_local_id: local ? shiftId : null,
  } as PosOfflineTxn);
  return id;
}

/** N (hydrated) with one sale, closed offline; the next shift opened offline with one sale. */
async function closeNThenOpenNext() {
  await cacheEndShiftApprovalRequired("t1", "b1", false);
  useShift.setState({ shift: N, pendingLocalId: null, loading: false });
  await sale("SRV-N", false, 100);
  const ended = await useShift.getState().closeOffline({ scope: SCOPE, actualCashCounted: 140, notes: null });
  await useShift.getState().open(OPEN);
  const next = useShift.getState().pendingLocalId as string;
  await sale(next, true, 70);
  return { endOpId: ended.operationId, next };
}

// ================================================================ G — close → open next offline

test("G close(N) → open(N+1) offline: deterministic chained identity, persisted context, ops bound per shift", async () => {
  const { endOpId, next } = await closeNThenOpenNext();
  assert.ok(next, "N+1 is the active (offline) shift");
  assert.notEqual(next, "SRV-N");
  assert.equal(useShift.getState().shift?.id, next);
  assert.equal(localCloseStateOf(await getOperation(endOpId)), "CLOSED_LOCAL_PENDING_SYNC");
  const row = await localdb.pendingShifts.get(next);
  assert.equal(row?.after_end_op_id, endOpId);
  assert.equal(row?.opening_cash_amount, 25);
  assert.deepEqual([row?.tenant_id, row?.branch_id, row?.cashier_user_id, row?.device_id, row?.terminal_id], ["t1", "b1", "u1", DEV.device_id, DEV.terminal_id]);
  assert.ok(row?.opened_at && row.generation === 2);
  // double tap / repeated open → the SAME N+1 (deterministic from the close), never a second row
  await useShift.getState().open(OPEN);
  assert.equal(useShift.getState().pendingLocalId, next);
  const again = await createLocalPendingShift({ tenantId: "t1", branchId: "b1", cashierUserId: "u1", openingCashAmount: 25, currency: "LBP", afterEndOpId: endOpId });
  assert.equal(again.local_shift_id, next);
  assert.equal(await localdb.pendingShifts.count(), 1);
  // binding: N's work stays canonical N; N+1's travels as its local id (remapped exactly to its own canonical)
  assert.deepEqual(await resolveOperationalShift("SRV-N"), { shift_id: "SRV-N", shift_local: null });
  assert.deepEqual(await resolveOperationalShift(next), { shift_id: null, shift_local: next });
  // the open(N+1) op replays strictly after end(N) and must create (never adopt)
  await migrateLegacyToOperations();
  const openOp = await getOperation(`mig:shift:${next}`);
  assert.deepEqual(openOp?.dependency_ids, [endOpId]);
  assert.equal((openOp?.payload as { require_new?: boolean }).require_new, true);
  // N's close barrier never contains N+1's work
  const end = await getOperation(endOpId);
  assert.equal(end?.dependency_ids.some((d) => d === `mig:shift:${next}` || d.includes(next)), false);
});

test("G2 an offline-OPENED N closed offline: N+1 ≠ N, chain open(N) → end(N) → open(N+1)", async () => {
  await cacheEndShiftApprovalRequired("t1", "b1", false);
  await useShift.getState().open(OPEN);
  const n = useShift.getState().pendingLocalId as string;
  const ended = await useShift.getState().closeOffline({ scope: SCOPE, actualCashCounted: 25, notes: null });
  await useShift.getState().open(OPEN);
  const n1 = useShift.getState().pendingLocalId as string;
  assert.ok(n && n1 && n1 !== n, "through 1.0.37 the next open returned the SAME pending row");
  assert.equal((await localdb.pendingShifts.get(n1))?.after_end_op_id, ended.operationId);
  assert.equal((await localdb.pendingShifts.get(n1))?.generation, 2);
  const srv = fakeServer();
  await drainOffline(CTX, "reconnect", srv.deps);
  assert.deepEqual(srv.calls.map((c) => c.name), ["open_shift", "end_shift", "open_shift"]);
  assert.equal(srv.calls[1].arg.shiftId, "SRV-NEW-1");
  assert.equal(srv.calls[2].arg.requireNew, true);
  assert.equal((await localdb.entityMap.get(n1))?.canonical_id, "SRV-NEW-2");
});

test("G3 CLOSING_LOCAL: an Open Shift racing an in-flight End Shift capture is refused", async () => {
  await cacheEndShiftApprovalRequired("t1", "b1", false);
  useShift.setState({ closingLocal: true });
  await assert.rejects(useShift.getState().open(OPEN), (e: Error) => e instanceof ShiftStillClosingError && /being recorded/.test(e.message));
  assert.equal(await localdb.pendingShifts.count(), 0);
  assert.equal(localCloseStateOf(null, true), "CLOSING_LOCAL");
  assert.equal(localCloseStateOf(null), "OPEN");
});

// ================================================================ H — restart between shifts

test("H restart between shifts: an offline restart and a not-yet-synced server read both surface N+1 (never N)", async () => {
  const { endOpId, next } = await closeNThenOpenNext();
  useShift.getState().clear();
  await useShift.getState().refresh("t1", "u1", "b1"); // offline restart
  assert.equal(useShift.getState().shift?.id, next);
  assert.equal(useShift.getState().pendingLocalId, next);
  assert.equal(useShift.getState().endedPendingSync?.operationId, endOpId, "the previous close is still shown as pending sync");
  // back online before the drain: the server still reports N open (its close has not replayed)
  useShift.getState().clear();
  shiftNet.findOpenShift = async () => N;
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, next, "through 1.0.37 this hid N+1 (shift: null)");
  assert.equal(useShift.getState().pendingLocalId, next);
});

test("H2 an offline-OPENED N whose open synced but whose close did not: the server's canonical N is never resurrected; N+1 is active", async () => {
  await cacheEndShiftApprovalRequired("t1", "b1", false);
  await useShift.getState().open(OPEN);
  const n = useShift.getState().pendingLocalId as string;
  await useShift.getState().closeOffline({ scope: SCOPE, actualCashCounted: 25, notes: null });
  await useShift.getState().open(OPEN);
  const n1 = useShift.getState().pendingLocalId as string;
  // open(N) reached the server (entity map) but end(N) has not
  await localdb.entityMap.put({ local_entity_id: n, entity_type: "shift", canonical_id: "SRV-N-CANON", resolved_at: new Date().toISOString(), tenant_id: "t1", branch_id: "b1", device_id: DEV.device_id, cashier_user_id: "u1", terminal_id: DEV.terminal_id ?? "" } as never);
  useShift.getState().clear();
  shiftNet.findOpenShift = async () => ({ ...N, id: "SRV-N-CANON" });
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, n1, "the canonical N is closed on this device (its close is pending)");
});

// ================================================================ I — reconnect both shifts

test("I reconnect: close(N) replays before open(N+1), then N+1's sale; one canonical shift each; float once; no cash leakage", async () => {
  const { next } = await closeNThenOpenNext();
  const srv = fakeServer({ open: "SRV-N" });
  await drainOffline(CTX, "reconnect", srv.deps);
  const names = srv.calls.map((c) => c.name);
  assert.deepEqual(names, ["submit", "pay", "end_shift", "open_shift", "submit", "pay"]);
  assert.equal(srv.calls[0].arg.shift_id, "SRV-N", "N's sale stays in N");
  assert.equal(srv.calls[2].arg.shiftId, "SRV-N");
  assert.equal(srv.calls[3].arg.requireNew, true);
  assert.equal(srv.calls[4].arg.shift_id, "SRV-NEW-1", "N+1's sale lands in N+1, never in N");
  assert.deepEqual(srv.floats, [{ shiftId: "SRV-NEW-1", openingCash: 25 }], "exactly one new canonical shift, opening float once");
  assert.equal((await localdb.entityMap.get(next))?.canonical_id, "SRV-NEW-1");
  assert.equal(await readCachedEndShiftApprovalRequired("t1", "b1"), false, "the close's approval rule is recorded");
  // second reconnect: zero business effects
  const again = fakeServer({ open: "SRV-NEW-1" });
  await drainOffline(CTX, "reconnect", again.deps);
  assert.equal(again.calls.length, 0);
  // and the store now shows the canonical N+1
  shiftNet.findOpenShift = async () => ({ ...N, id: "SRV-NEW-1" });
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, "SRV-NEW-1");
  assert.equal(useShift.getState().pendingLocalId, null);
});

test("I2 a lost open(N+1) response replays to its OWN recorded shift (exactly one canonical shift)", async () => {
  const { next } = await closeNThenOpenNext();
  const srv = fakeServer({ open: "SRV-N" });
  srv.state.dropNextOpenResponse = true;
  await drainOffline(CTX, "reconnect", srv.deps);
  assert.equal((await getOperation(`mig:shift:${next}`))?.status, "retryable", "a lost response is a transport retry, never a new open");
  await localdb.operations.update(`mig:shift:${next}`, { last_attempt_at: null }); // the backoff window elapsed
  await drainOffline(CTX, "reconnect", srv.deps);
  assert.equal(srv.calls.filter((c) => c.name === "open_shift").length, 2, "retried once after the lost response");
  assert.equal(srv.floats.length, 1, "the server created ONE shift");
  assert.equal((await localdb.entityMap.get(next))?.canonical_id, "SRV-NEW-1");
  assert.equal(srv.calls.filter((c) => c.name === "submit" && c.arg.shift_id === "SRV-NEW-1").length, 1);
});

// ================================================================ F — foreign shift → conflict

test("F a shift opened ELSEWHERE meanwhile → CONFLICT (SHIFT_ALREADY_OPEN), never attached; recoverable once resolved", async () => {
  const { next } = await closeNThenOpenNext();
  const srv = fakeServer({ open: "SRV-N" });
  const deps = { ...srv.deps, endShiftOp: async (a: { shiftId: string }) => { const r = await srv.deps.endShiftOp(a as never); srv.state.open = "FOREIGN"; return r; } } as PosTxnSyncDeps;
  await drainOffline(CTX, "reconnect", deps);
  const openOp = await getOperation(`mig:shift:${next}`);
  assert.equal(openOp?.status, "needs_attention");
  assert.equal(openOp?.last_error_code, "shift_already_open");
  assert.match(openOp?.last_error_message ?? "", /NOT attached/);
  assert.equal(await localdb.entityMap.get(next), undefined, "nothing resolved");
  assert.equal(srv.calls.filter((c) => c.name === "submit" && c.arg.shift_id === "FOREIGN").length, 0, "N+1's sale never lands in the foreign shift");
  assert.equal((await localdb.posOfflineTxns.toArray()).length, 2, "N+1's work is retained");
  // the other shift is ended; the operator retries the open → it creates N+1 exactly once and the sale follows
  srv.state.open = null;
  await requeueOperation(`mig:shift:${next}`);
  await drainOffline(CTX, "reconnect", deps);
  assert.equal((await getOperation(`mig:shift:${next}`))?.status, "synced");
  assert.equal(srv.calls.filter((c) => c.name === "submit" && c.arg.shift_id === "SRV-NEW-1").length, 1);
});

test("F2 an older server (no require_new) answering reused:true for a shift this op did not create → CONFLICT, nothing resolved", async () => {
  const { next } = await closeNThenOpenNext();
  const srv = fakeServer({ open: "SRV-N" });
  srv.state.honourRequireNew = false;
  const deps = { ...srv.deps, endShiftOp: async (a: { shiftId: string }) => { const r = await srv.deps.endShiftOp(a as never); srv.state.open = "FOREIGN"; return r; } } as PosTxnSyncDeps;
  await drainOffline(CTX, "reconnect", deps);
  const openOp = await getOperation(`mig:shift:${next}`);
  assert.equal(openOp?.status, "needs_attention");
  assert.equal(openOp?.last_error_code, "shift_adopted_existing");
  assert.equal(await localdb.entityMap.get(next), undefined);
  assert.equal(srv.calls.filter((c) => c.name === "submit" && c.arg.shift_id === "FOREIGN").length, 0);
});

test("F3 an UNCHAINED offline open (Case 2) keeps the 1.0.37 contract: no require_new, adoption allowed", async () => {
  await useShift.getState().open(OPEN);
  const n = useShift.getState().pendingLocalId as string;
  const srv = fakeServer({ open: "SRV-ALREADY" });
  await drainOffline(CTX, "reconnect", srv.deps);
  assert.equal(srv.calls[0].arg.requireNew, undefined);
  assert.equal((await localdb.entityMap.get(n))?.canonical_id, "SRV-ALREADY");
});

// ================================================================ R — close refused → open blocked

test("R close(N) refused at replay → open(N+1) blocked (dependency_failed), N+1's work retained, never adopted", async () => {
  const { endOpId, next } = await closeNThenOpenNext();
  const srv = fakeServer({ open: "SRV-N" });
  const deps = { ...srv.deps, endShiftOp: async () => { throw new Error("Cannot close this shift: 1 order(s) still open."); } } as unknown as PosTxnSyncDeps;
  await drainOffline(CTX, "reconnect", deps);
  assert.equal(localCloseStateOf(await getOperation(endOpId)), "CLOSE_REFUSED");
  const openOp = await getOperation(`mig:shift:${next}`);
  assert.equal(openOp?.status, "needs_attention");
  assert.equal(openOp?.last_error_code, "dependency_failed");
  assert.equal(srv.calls.filter((c) => c.name === "open_shift").length, 0, "never sent (the server would hand back N)");
  assert.equal(srv.calls.filter((c) => c.name === "submit").length, 1, "only N's own sale");
  // the server read: N is open again with the reason, and the operator is told N+1 could not start
  shiftNet.findOpenShift = async () => N;
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, "SRV-N");
  assert.match(useShift.getState().closeRefused?.message ?? "", /opened offline after it could not start/);
  assert.equal((await getOperation(`mig:shift:${next}`))?.status, "needs_attention", "still blocked (its predecessor is superseded, not satisfied)");
  assert.equal((await localdb.posOfflineTxns.toArray()).length, 2);
  // a refused close also refuses a further chained open at capture
  await localdb.operations.update(endOpId, { status: "needs_attention", last_error_code: "validation" });
  shiftNet.findOpenShift = offline;
  useShift.setState({ shift: null, pendingLocalId: null });
  await assert.rejects(useShift.getState().open(OPEN), /not accepted by the server/);
});

// ================================================================ A — approval gate at capture

test("A approval-required (or unknown) branch: the chained offline open is refused at capture with the reason", async () => {
  useShift.setState({ shift: N, pendingLocalId: null, loading: false });
  await useShift.getState().closeOffline({ scope: SCOPE, actualCashCounted: 40, notes: null });
  await assert.rejects(useShift.getState().open(OPEN), (e: Error) => e instanceof ShiftStillClosingError && /not yet confirmed/.test(e.message));
  await cacheEndShiftApprovalRequired("t1", "b1", true);
  await assert.rejects(useShift.getState().open(OPEN), (e: Error) => e instanceof ShiftStillClosingError && /requires manager approval/.test(e.message));
  assert.equal(await localdb.pendingShifts.count(), 0, "nothing captured — no sales can park behind a refused open");
  await cacheEndShiftApprovalRequired("t1", "OTHER-OU", false);
  await assert.rejects(useShift.getState().open(OPEN), ShiftStillClosingError, "another OU's rule never applies");
});

test("A2 an approval-REQUIRED server refusal of a chained open is a named CONFLICT (sales kept), not a validation dead end", async () => {
  const { next } = await closeNThenOpenNext();
  const srv = fakeServer({ open: "SRV-N" });
  const deps = { ...srv.deps, openShift: async () => { throw new Error("You still have a previous shift waiting for manager approval. Please ask a manager or owner to approve it before opening a new shift."); } } as unknown as PosTxnSyncDeps;
  await drainOffline(CTX, "reconnect", deps);
  const openOp = await getOperation(`mig:shift:${next}`);
  assert.equal(openOp?.last_error_code, "shift_awaiting_approval");
  assert.match(openOp?.last_error_message ?? "", /sales stay queued/);
});
