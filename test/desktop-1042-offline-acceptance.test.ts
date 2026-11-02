// Desktop 1.0.42 - regressions found in the Desktop 1.0.41 native OFFLINE acceptance (2026-11-02).
//   DESK-O1  Pay Full Bill of a bill split offline offered the gross bill and was then refused.
//   DESK-O2  A line merged in offline could not be collected offline (Split left it out and called the bill
//            "Fully paid"; the full Pay was refused), so the table and the shift could not be closed.
//   DESK-O3  Switching branch offline showed "No open shift" for a branch with an open shift: the restore
//            snapshot was kept per cashier, holding only the last branch saved.
//   DESK-O4  A branch's sync status read "All changes synced" while other branches' work waited on the device.
//   Receipt  An offline cash sale paid in USD printed the LBP total under a "$" sign.
// The end-to-end merge + split / full-pay replays live in offline-1038-movemerge.test.ts (its fake server).

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

import { useShift, shiftNet } from "@/state/shift";
import { localdb } from "@/lib/offline/db";
import {
  clearPosSessionSnapshot,
  clearPosSessionSnapshotsForShift,
  readAllPosSessionSnapshots,
  readPosSessionSnapshot,
  savePosSessionSnapshot,
  type PosSessionSnapshot,
} from "@/lib/offline/posSession";
import { getDeviceIdentity } from "@/lib/device";
import { chipOf, summarize, withOtherBranches } from "@/components/sync/syncCenterModel";
import { offlineSettleAmount, splitItemOf, PART_PAID_OFFLINE_SETTLE_MESSAGE, type LineMeta, type OperationalTableBill } from "@/lib/offline/operationalProjection";
import type { ActiveShift } from "@/types/pos";

const DEVICE = getDeviceIdentity().device_id;
const openShift = (id: string, branchId: string): ActiveShift => ({ id, status: "open", opened_at: "2026-11-02T08:00:00Z", opening_cash_amount: 0, branch_id: branchId });
const snap = (cashier: string, branchId: string, shiftId: string): PosSessionSnapshot => ({
  version: 1, source: "server", savedAt: Date.now(), device_id: DEVICE, tenant_id: "t1", cashier_user_id: cashier,
  branch_id: branchId, branch_name: branchId === "b1" ? "Main" : "QA", currency: "LBP", shift: openShift(shiftId, branchId) as PosSessionSnapshot["shift"],
});

beforeEach(async () => {
  await localdb.pendingShifts.clear();
  await localdb.posOfflineTxns.clear();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  shiftNet.getCashBox = async () => { throw new TypeError("Failed to fetch"); };
});

// ------------------------------------------------------------------------------------------------ DESK-O3

test("DESK-O3: offline, EACH branch restores its own open shift (the cashier slot holds only the last branch saved)", async () => {
  savePosSessionSnapshot(snap("u1", "b2", "S-QA")); // QA visited online first …
  savePosSessionSnapshot(snap("u1", "b1", "S-MAIN")); // … then Main (the cashier slot now holds Main)
  shiftNet.findOpenShift = async () => { throw new TypeError("Failed to fetch"); }; // offline
  await useShift.getState().refresh("t1", "u1", "b2");
  assert.equal(useShift.getState().shift?.id, "S-QA", "QA's shift is restored, not 'No open shift'");
  assert.equal(useShift.getState().offlineRestored, true);
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, "S-MAIN");
  // a sibling branch's snapshot still never restores in a branch without one
  await useShift.getState().refresh("t1", "u1", "b3");
  assert.equal(useShift.getState().shift, null);
});

test("DESK-O3: a live 'no shift' in one branch clears only that branch; a closed shift is cleared everywhere it is held", async () => {
  savePosSessionSnapshot(snap("u1", "b2", "S-QA"));
  savePosSessionSnapshot(snap("u1", "b1", "S-MAIN"));
  shiftNet.findOpenShift = async () => null; // online: QA has no open shift any more
  await useShift.getState().refresh("t1", "u1", "b2");
  assert.equal(readPosSessionSnapshot("u1", "b2"), null, "QA's snapshot is gone");
  assert.equal(readPosSessionSnapshot("u1", "b1")?.shift.id, "S-MAIN", "Main's open shift stays restorable");
  clearPosSessionSnapshotsForShift("S-MAIN");
  assert.equal(readPosSessionSnapshot("u1", "b1"), null);
  assert.equal(readPosSessionSnapshot("u1"), null, "the cashier slot holding it is cleared too");
});

test("DESK-O3: the per-cashier contract is unchanged (one snapshot per cashier listed; clearing a cashier clears all of theirs; sign-out clears all)", () => {
  savePosSessionSnapshot(snap("A", "b1", "SA1"));
  savePosSessionSnapshot(snap("A", "b2", "SA2"));
  savePosSessionSnapshot(snap("B", "b1", "SB1"));
  assert.equal(readAllPosSessionSnapshots().length, 2, "one per cashier");
  assert.equal(readAllPosSessionSnapshots({ perBranch: true }).filter((s) => s.cashier_user_id === "A").length, 3, "A: cashier slot + two branch slots");
  assert.equal(readPosSessionSnapshot("A")?.shift.id, "SA2", "the cashier read is the latest save, as before");
  assert.equal(readPosSessionSnapshot("A", "b1")?.shift.id, "SA1");
  clearPosSessionSnapshot("A");
  assert.equal(readPosSessionSnapshot("A", "b1"), null);
  assert.equal(readPosSessionSnapshot("A", "b2"), null);
  assert.equal(readPosSessionSnapshot("B", "b1")?.shift.id, "SB1", "B untouched");
  clearPosSessionSnapshot();
  assert.equal(readAllPosSessionSnapshots({ perBranch: true }).length, 0);
});

// ------------------------------------------------------------------------------------------------ DESK-O4

const ops = (n: number, status: string) =>
  Array.from({ length: n }, () => ({ status, last_error_code: null, operation_type: "pay_table" })) as unknown as Parameters<typeof summarize>[0];

test("DESK-O4: a clean branch chip says other branches still have work on this device", () => {
  const branch = summarize([]);
  const device = summarize(ops(21, "pending"));
  assert.deepEqual(withOtherBranches(chipOf(branch), branch, device), { text: "This branch is synced · 21 pending on other branches", kind: "pending" });
  const parked = summarize(ops(2, "needs_attention"));
  assert.equal(withOtherBranches(chipOf(branch), branch, parked).kind, "attention");
  assert.deepEqual(withOtherBranches(chipOf(branch), branch, branch), { text: "All changes synced", kind: "clear" }, "all-synced only when the device is clean");
  const own = summarize(ops(3, "pending"));
  assert.deepEqual(withOtherBranches(chipOf(own), own, device), { text: "3 pending", kind: "pending" }, "a branch's own work keeps its own wording");
  assert.deepEqual(withOtherBranches(chipOf(branch), branch, null), { text: "All changes synced", kind: "clear" });
});

test("DESK-O4: the POS chip and footer are wired to the device-wide queue", () => {
  const chip = readFileSync("src/components/pos/SyncCenter.tsx", "utf8");
  assert.match(chip, /useSyncSummary\(tenantId, null\)/);
  assert.match(chip, /withOtherBranches\(chipOf\(summary\), summary, branchId \? device : null\)/);
  const footer = readFileSync("src/components/pos/PosFooterBar.tsx", "utf8");
  assert.match(footer, /waiting to sync on other branches/);
  const pw = readFileSync("src/screens/pos/PosWorkspace.tsx", "utf8");
  assert.match(pw, /summarizeOperations\(\{ tenantId \}, \{ includeSynced: false \}\)/);
  assert.match(pw, /pendingElsewhere=\{pendingElsewhere\}/);
  assert.match(readFileSync("src/layouts/PosShell.tsx", "utf8"), /pendingElsewhere=\{props\.pendingElsewhere\}/);
});

// ------------------------------------------------------------------------------------------------ DESK-O1 / O2

const bill = (over: Partial<OperationalTableBill>): OperationalTableBill =>
  ({ gross: 1_400_000, collected: 0, paidPending: 180_000, bill: { mixedCurrency: false }, ...over }) as unknown as OperationalTableBill;

test("DESK-O1/O2: a bill split offline settles for exactly what is still open once the server deducts prior payments", () => {
  assert.deepEqual(offlineSettleAmount(bill({}), true), { ok: true, exactAmount: 1_220_000 }, "R = T − P_local (the 1.0.41 native case)");
  assert.deepEqual(offlineSettleAmount(bill({ collected: 100_000 }), true), { ok: true, exactAmount: 1_120_000 }, "R = T − P_server − P_local");
  assert.deepEqual(offlineSettleAmount(bill({}), false), { ok: false, reason: PART_PAID_OFFLINE_SETTLE_MESSAGE }, "still refused while the server charges T");
  assert.deepEqual(offlineSettleAmount(bill({ bill: { mixedCurrency: true } as OperationalTableBill["bill"] }), true), { ok: false, reason: PART_PAID_OFFLINE_SETTLE_MESSAGE }, "no single figure to pin → refused");
  assert.deepEqual(offlineSettleAmount(bill({ paidPending: 0 }), true), { ok: true, exactAmount: 1_400_000 }, "an unsplit bill is unchanged");
});

test("DESK-O2: a merged-in line is splittable by its SOURCE item; an older block without one stays locked", () => {
  const meta = (ref: LineMeta["ref"]): LineMeta => ({ ref, orderKey: "k", creatorOpId: null, paidQty: 0 });
  assert.deepEqual(splitItemOf(meta({ kind: "merged", op_id: "m1", item: { line_local: "L3" } })), { line_local: "L3" });
  assert.deepEqual(splitItemOf(meta({ kind: "merged", op_id: "m1", item: { order_item_id: "OI-9" } })), { order_item_id: "OI-9" });
  assert.equal(splitItemOf(meta({ kind: "merged", op_id: "m1" })), null, "pre-1.0.42 block");
  assert.deepEqual(splitItemOf(meta({ kind: "canonical", order_item_id: "OI-1" })), { order_item_id: "OI-1" });
  assert.deepEqual(splitItemOf(meta({ kind: "local", line_local: "L1", batch_no: null })), { line_local: "L1" });
  assert.equal(splitItemOf(meta({ kind: "summary" })), null);
  assert.equal(splitItemOf(undefined), null);
});

test("DESK-O1/O2: the Split panel and the Pay dialog read the remaining bill (source wiring)", () => {
  const src = readFileSync("src/screens/pos/DineInWorkspace.tsx", "utf8");
  assert.match(src, /order\.lines\.filter\(\(l\) => splitItemOf\(p\.meta\.get\(l\.id\)\) != null\)/, "the panel offers merged-in lines");
  assert.match(src, /allocs\.push\(\{ \.\.\.item, quantity: a\.quantity \}\)/, "a leg allocates a merged line by its source item");
  assert.match(src, /settlements: legs\.map\(/, "legs taken offline are listed");
  assert.doesNotMatch(src, /-offline`, amount: 0,/, "the leg banner shows its amount");
  assert.match(src, /\(offlineProj\?\.collected \?\? 0\) \+ \(offlineProj\?\.paidPending \?\? 0\)/, "Pay Full Bill offers what is still open");
  assert.match(src, /collected: p\.collected \+ p\.paidPending \}, discount\)/, "no discount on top of a captured leg");
  const merge = readFileSync("src/lib/offline/tableOpOffline.ts", "utf8");
  assert.match(merge, /items: itemsOf\(l\)/, "a merge records each folded line's source item");
});

// ------------------------------------------------------------------------------------------------ receipt

test("Receipt: an offline cash sale prints amounts in the order currency and the tender separately", () => {
  const src = readFileSync("src/screens/pos/PosWorkspace.tsx", "utf8").replace(/\r\n/g, "\n"); // CRLF checkouts (Windows CI)
  const at = src.indexOf("const saveOfflineCashPayment");
  const body = src.slice(at, src.indexOf("const resumeOfflineOrder", at));
  assert.match(body, /\n\s*currency,\n\s*tenderCurrency: input\.currency,/);
  assert.match(body, /tenderTotal: tenderTotalFor\(total, currency, input\.currency, rate \?\? null\)/);
  assert.doesNotMatch(body, /\n\s*currency: input\.currency,\n\s*lines: receiptLines/, "the 1.0.41 '$320000.00' wiring is gone");
});
