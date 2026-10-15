// Phase C — offline Dine-In: persistence (C1), floor/bill cache (C2), readiness (C3),
// open-table (C5), local bill (C6), multi-round chain + expected_order_id (C7), atomic
// capture (C8), kitchen print state (C9/C10), reconnect/canonical remap + conflicts
// (C13/C14), via the REAL Dexie stores (fake-indexeddb) + the ONE Phase-B orchestrator.

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
  cacheFloor, readCachedFloor, cacheBill, readCachedBill,
  getDineDraft, listDineDrafts,
} from "@/lib/offline/db";
import {
  openTableOffline, addDraftLine, setDraftLineQuantity, removeDraftLine,
  sendRoundOffline, setRoundPrintState, evaluateDineinOfflineReady, deterministicUuid,
} from "@/lib/offline/dineinOffline";
import { drainOffline, __resetDrainLockForTests } from "@/lib/offline/orchestrator";
import { getOperation } from "@/lib/offline/operationLog";
import type { PosTxnSyncDeps } from "@/lib/offline/posTxnSync";

const SCOPE = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", shiftId: "shift1" };
const CTX = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1", online: true };

type Spy = { opens: number; rounds: number; expected: (string | undefined)[]; lastRoundItems: unknown[] };
function deps(spy: Spy, over: Partial<PosTxnSyncDeps> = {}): PosTxnSyncDeps {
  return {
    submit: async () => ({ order_id: "x", order_number: "y" }),
    pay: async () => ({}),
    openShift: async () => ({ shiftId: "s", reused: false }),
    openTable: async () => { spy.opens++; return { table_id: "SRV-TABLE", pos_entity_version: 1 }; },
    submitRound: async (p) => {
      spy.rounds++;
      spy.expected.push((p as { expected_order_id?: string }).expected_order_id);
      spy.lastRoundItems = (p as { items: unknown[] }).items;
      return { order_id: "SRV-ORDER", order_number: "N" + spy.rounds, batch_no: spy.rounds, appended: spy.rounds > 1, idempotent: false };
    },
    isTransport: (e) => e instanceof TypeError,
    hasSession: async () => true,
    ...over,
  };
}
const newSpy = (): Spy => ({ opens: 0, rounds: 0, expected: [], lastRoundItems: [] });
const line = (name: string, over: Record<string, unknown> = {}) => ({ menu_item_id: "m-" + name, name, base_price: 10, quantity: 1, modifiers: [], kitchen_note: null, ...over });

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.syncHistory.clear(), localdb.dineDrafts.clear(), localdb.snapshots.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear()]);
  __resetDrainLockForTests();
});

// ---------------- C3 readiness ----------------
test("readiness: ready only when all inputs present; missing list is explicit", () => {
  const base = { tenantId: "t1", branchId: "b1", hasFloor: true, hasTableMap: true, hasMenu: true, hasOpenShift: true, hasPricingConfig: true, needsPrinter: false, hasPrinterRouting: false };
  assert.deepEqual(evaluateDineinOfflineReady(base), { ready: true, missing: [] });
  const r = evaluateDineinOfflineReady({ ...base, hasFloor: false, hasOpenShift: false });
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes("floor layout") && r.missing.includes("open shift"));
  const p = evaluateDineinOfflineReady({ ...base, needsPrinter: true, hasPrinterRouting: false });
  assert.ok(p.missing.includes("kitchen printer routing"));
});

// ---------------- C2 floor/bill cache ----------------
test("floor/bill cache: scope-checked read-back; authoritative empty replaces stale", async () => {
  await cacheFloor({ sections: [1] }, "t1", "b1");
  assert.deepEqual((await readCachedFloor("t1", "b1"))?.layout, { sections: [1] });
  assert.equal(await readCachedFloor("t1", "b2"), null, "other branch cannot read");
  assert.equal(await readCachedFloor("t2", "b1"), null, "other tenant cannot read");
  await cacheFloor({ sections: [] }, "t1", "b1"); // authoritative empty replaces
  assert.deepEqual((await readCachedFloor("t1", "b1"))?.layout, { sections: [] });
  await cacheBill("TBL", { order_id: "o1" }, "t1", "b1");
  assert.deepEqual((await readCachedBill("TBL", "t1", "b1"))?.bill, { order_id: "o1" });
  assert.equal(await readCachedBill("TBL", "t1", "b2"), null);
});

// ---------------- C5/C8 open table (atomic op + projection) ----------------
test("open table: op AND draft committed together; scope on the draft", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  const op = await getOperation(d.open_operation_id);
  assert.equal(op?.operation_type, "dinein_open_table");
  assert.equal(op?.status, "pending");
  assert.equal(op?.local_entity_id, "TBL12");
  const back = await getDineDraft(d.local_session_id);
  assert.equal(back?.table_name, "12");
  assert.equal(back?.terminal_id, "term1");
  assert.equal(back?.status, "open");
});

test("open table: a different cashier/device/terminal cannot see the session", async () => {
  await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  assert.equal((await listDineDrafts(CTX)).length, 1);
  assert.equal((await listDineDrafts({ ...CTX, cashierUserId: "u2" })).length, 0);
  assert.equal((await listDineDrafts({ ...CTX, deviceId: "dev2" })).length, 0);
  assert.equal((await listDineDrafts({ ...CTX, terminalId: "term2" })).length, 0);
});

// ---------------- C6 local bill editing (unsent only) ----------------
test("local bill: add / qty / remove / notes affect only UNSENT lines", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  await addDraftLine(d.local_session_id, line("Fries", { line_id: "L1" }));
  await addDraftLine(d.local_session_id, line("Cola", { line_id: "L2" }));
  await setDraftLineQuantity(d.local_session_id, "L1", 3);
  let back = await getDineDraft(d.local_session_id);
  assert.equal(back?.lines.find((l) => l.line_id === "L1")?.quantity, 3);
  assert.equal(back?.lines.length, 2);
  await removeDraftLine(d.local_session_id, "L2");
  back = await getDineDraft(d.local_session_id);
  assert.equal(back?.lines.length, 1);
  assert.ok((back?.draft_revision ?? 0) >= 4);
});

// ---------------- C1 restart persistence ----------------
test("restart: draft + unsent lines + sent rounds survive (re-query, no network)", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  await addDraftLine(d.local_session_id, line("Fries"));
  await sendRoundOffline(d.local_session_id);
  await addDraftLine(d.local_session_id, line("Cola")); // unsent after a round
  // "restart" = fresh read of the durable stores
  const back = await getDineDraft(d.local_session_id);
  assert.equal(back?.rounds.length, 1);
  assert.equal(back?.lines.length, 2);
  assert.equal(back?.lines.filter((l) => l.sent_round === null).length, 1, "the unsent line is preserved");
  assert.equal(back?.lines.filter((l) => l.sent_round === 1).length, 1, "the sent line is marked");
});

// ---------------- C7 multi-round chain + expected_order_id + canonical remap ----------------
test("multi-round: open->R1->R2->R3 replay in order, same canonical order, expected_order_id on R2+", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  await addDraftLine(d.local_session_id, line("Fries")); await sendRoundOffline(d.local_session_id);
  await addDraftLine(d.local_session_id, line("Cola")); await sendRoundOffline(d.local_session_id);
  await addDraftLine(d.local_session_id, line("Cake")); await sendRoundOffline(d.local_session_id);
  const draftBefore = await getDineDraft(d.local_session_id);
  assert.equal(draftBefore?.rounds.length, 3);

  const spy = newSpy();
  const r = await drainOffline(CTX, "test", deps(spy));
  assert.equal(spy.opens, 1, "table occupied once");
  assert.equal(spy.rounds, 3, "three rounds submitted");
  assert.equal(spy.expected[0], undefined, "round 1 does NOT pin expected_order_id");
  assert.equal(spy.expected[1], "SRV-ORDER", "round 2 pins the session order");
  assert.equal(spy.expected[2], "SRV-ORDER", "round 3 pins the session order");
  assert.ok(r.drained.length >= 4, "open + 3 rounds synced");
  // canonical remap durably mirrored into the projection
  const after = await getDineDraft(d.local_session_id);
  assert.equal(after?.canonical_order_id, "SRV-ORDER");
});

test("multi-round: a later round that MISMATCHES the session order -> needs_attention, local data kept", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  await addDraftLine(d.local_session_id, line("Fries")); await sendRoundOffline(d.local_session_id);
  await addDraftLine(d.local_session_id, line("Cola")); await sendRoundOffline(d.local_session_id);
  const draft = await getDineDraft(d.local_session_id);
  const r2op = draft!.rounds[1].operation_id;
  const spy = newSpy();
  // R1 ok; R2 submit raises the server guard (bill changed remotely).
  let n = 0;
  const d2 = deps(spy, { submitRound: async (p) => {
    n++;
    if (n === 1) { spy.rounds++; return { order_id: "SRV-ORDER", order_number: "N1", batch_no: 1, appended: false, idempotent: false }; }
    throw new Error("This table's bill changed since it was opened offline and cannot take this round");
  } });
  await drainOffline(CTX, "test", d2);
  assert.equal((await getOperation(r2op))?.status, "needs_attention");
  // local round + lines preserved for the operator to resolve
  const after = await getDineDraft(d.local_session_id);
  assert.equal(after?.rounds.length, 2, "the local round is retained, not dropped");
});

// ---------------- F kitchen print state ----------------
test("kitchen: print state is tracked separately and a print failure never reverses the round", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  await addDraftLine(d.local_session_id, line("Fries"));
  const sent = await sendRoundOffline(d.local_session_id);
  const roundId = sent.rounds[0].round_local_id;
  assert.equal(sent.rounds[0].print_state, "not_printed");
  await setRoundPrintState(d.local_session_id, roundId, "print_failed");
  const after = await getDineDraft(d.local_session_id);
  assert.equal(after?.rounds[0].print_state, "print_failed");
  assert.equal(after?.rounds.length, 1, "the business round survives a print failure");
});

test("double-send with no new lines is a no-op (one round); deterministic op-id is stable", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  await addDraftLine(d.local_session_id, line("Fries"));
  await sendRoundOffline(d.local_session_id);
  await sendRoundOffline(d.local_session_id); // nothing unsent
  assert.equal((await getDineDraft(d.local_session_id))?.rounds.length, 1);
  assert.equal(deterministicUuid(["a", "1", "x"]), deterministicUuid(["a", "1", "x"]));
  assert.notEqual(deterministicUuid(["a", "1", "x"]), deterministicUuid(["a", "2", "x"]));
});

// ---------------- G orchestrator isolation ----------------
test("orchestrator: a dine-in session from another OU is DEFERRED, never replayed here", async () => {
  await openTableOffline({ scope: { ...SCOPE, branchId: "b2" }, tableId: "TBLX", tableName: "9", seats: 2 });
  await addDraftLine((await listDineDrafts({ ...CTX, branchId: "b2" }))[0].local_session_id, line("Fries"));
  await sendRoundOffline((await listDineDrafts({ ...CTX, branchId: "b2" }))[0].local_session_id);
  const spy = newSpy();
  const r = await drainOffline(CTX, "test", deps(spy)); // live OU = b1
  assert.equal(spy.opens, 0, "no foreign-OU open replayed");
  assert.equal(spy.rounds, 0, "no foreign-OU round replayed");
  assert.ok(r.deferred.length >= 2, "foreign-OU ops deferred");
});

test("lost response: server commits a round but the reply is lost; retry with the SAME client_op_id → exactly one mutation", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  await addDraftLine(d.local_session_id, line("Fries"));
  const sent = await sendRoundOffline(d.local_session_id);
  const r1op = sent.rounds[0].operation_id;

  // Server-side dedup model keyed by client_op_id: first call COMMITS then the response is
  // "lost" (transport error); a repeat of the SAME op id returns the cached result.
  const committed = new Map<string, { order_id: string; order_number: string; batch_no: number; appended: boolean; idempotent: boolean }>();
  let serverCommits = 0;
  const spy = newSpy();
  const d2 = deps(spy, {
    submitRound: async (p) => {
      const opId = (p as { client_op_id: string }).client_op_id;
      const prior = committed.get(opId);
      if (prior) return { ...prior, idempotent: true };
      serverCommits++;
      committed.set(opId, { order_id: "SRV-ORDER", order_number: "N1", batch_no: 1, appended: false, idempotent: false });
      throw new TypeError("Failed to fetch"); // committed, but the client never sees the reply
    },
  });

  await drainOffline(CTX, "lost-1", d2);
  assert.equal((await getOperation(r1op))?.status, "retryable", "transport failure → retryable, not needs_attention");
  assert.equal(serverCommits, 1, "the server committed once");

  // Bypass the backoff cooldown for the test, then drain again.
  await localdb.operations.update(r1op, { last_attempt_at: null });
  await drainOffline(CTX, "lost-2", d2);
  assert.equal((await getOperation(r1op))?.status, "synced", "retry resolves via server dedup");
  assert.equal(serverCommits, 1, "EXACTLY ONCE — the retry did not create a second round/order");
  assert.equal((await getDineDraft(d.local_session_id))?.canonical_order_id, "SRV-ORDER");
});

test("orchestrator: items captured at the offline price travel into the submit payload", async () => {
  const d = await openTableOffline({ scope: SCOPE, tableId: "TBL12", tableName: "12", seats: 4 });
  await addDraftLine(d.local_session_id, line("Fries", { base_price: 7.5, quantity: 2 }));
  await sendRoundOffline(d.local_session_id);
  const spy = newSpy();
  await drainOffline(CTX, "test", deps(spy));
  const items = spy.lastRoundItems as { base_price: number; quantity: number }[];
  assert.equal(items[0].base_price, 7.5, "captured price honoured (not repriced client-side)");
  assert.equal(items[0].quantity, 2);
});
