// Integration tests that drive the REAL shift store (useShift) - its generation
// gate, branch/OU equality checks, Case-1 snapshot scoping and cash-box guard - with
// the network reads injected through shiftNet. Covers Konan cycle-4 findings #2
// (stale cash-box) and #3 (live-shift / Case-1 branch scoping), end to end against
// the store rather than a helper. Uses the real Dexie (fake-indexeddb) and a
// localStorage shim so device identity and the Case-1 snapshot behave normally.

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

import { useShift, shiftNet } from "@/state/shift";
import { localdb } from "@/lib/offline/db";
import { savePosSessionSnapshot, clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { getDeviceIdentity } from "@/lib/device";
import type { ActiveShift, CashBox } from "@/types/pos";

const DEVICE = getDeviceIdentity().device_id; // persisted once; must stay stable

const openShift = (id: string, branchId: string | null): ActiveShift => ({
  id, status: "open", opened_at: "2026-10-03T08:00:00Z", opening_cash_amount: 50, branch_id: branchId,
});
const cashBoxFor = (shiftId: string): CashBox => ({ shift_id: shiftId } as unknown as CashBox);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await localdb.pendingShifts.clear();
  await localdb.posOfflineTxns.clear();
  // Clear ONLY the Case-1 snapshot, never the whole store: wiping localStorage would
  // drop the device identity, and getDeviceIdentity() would then regenerate a new id
  // that no longer matches a seeded snapshot's device_id.
  clearPosSessionSnapshot();
  useShift.getState().clear();
  // Safe defaults; each test overrides as needed.
  shiftNet.findOpenShift = async () => null;
  shiftNet.getCashBox = async (id) => cashBoxFor(id as string);
});

test("a live server shift for ANOTHER branch/OU is NOT adopted as this context's shift", async () => {
  shiftNet.findOpenShift = async () => openShift("SRV-OTHER", "b2"); // cashier's open shift is in b2
  await useShift.getState().refresh("t1", "u1", "b1"); // operating in b1
  assert.equal(useShift.getState().shift, null, "a sibling-OU open shift must not surface in b1");
  assert.equal(useShift.getState().offlineRestored, false);
});

test("a live server shift for THIS branch/OU is adopted and its cash box is loaded", async () => {
  shiftNet.findOpenShift = async () => openShift("SRV-B1", "b1");
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, "SRV-B1");
  assert.equal(useShift.getState().pendingLocalId, null);
  assert.equal(useShift.getState().cashBox?.shift_id, "SRV-B1", "the drawer for the adopted shift loads");
});

test("a stale cash-box response from a superseded refresh is discarded (never overwrites the new shift's drawer)", async () => {
  let n = 0;
  shiftNet.findOpenShift = async () => (++n === 1 ? openShift("S1", "b1") : openShift("S2", "b1"));
  shiftNet.getCashBox = async (id) => {
    if (id === "S1") { await delay(50); return cashBoxFor("S1"); } // slow: in flight across the next refresh
    return cashBoxFor("S2"); // fast
  };
  const p1 = useShift.getState().refresh("t1", "u1", "b1"); // gen1 -> shift S1, getCashBox(S1) parked
  await delay(10);
  const p2 = useShift.getState().refresh("t1", "u1", "b1"); // gen2 supersedes gen1 -> shift S2, cashBox S2
  await Promise.all([p1, p2]);
  assert.equal(useShift.getState().shift?.id, "S2");
  assert.equal(useShift.getState().cashBox?.shift_id, "S2", "the slow S1 drawer response was dropped, not committed");
});

test("a Case-1 snapshot from ANOTHER branch/OU is rejected on an offline refresh", async () => {
  savePosSessionSnapshot({
    version: 1, source: "server", savedAt: Date.now(), device_id: DEVICE,
    tenant_id: "t1", cashier_user_id: "u1", branch_id: "b2", branch_name: "Sibling", currency: "USD",
    shift: openShift("SNAP-B2", "b2"),
  });
  shiftNet.findOpenShift = async () => { throw new TypeError("Failed to fetch"); }; // offline
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift, null, "a sibling-OU snapshot must not restore in b1");
  assert.equal(useShift.getState().error, null, "an expected outage with no in-scope shift is not an error");
});

test("a Case-1 snapshot for THIS branch/OU is restored on an offline refresh", async () => {
  savePosSessionSnapshot({
    version: 1, source: "server", savedAt: Date.now(), device_id: DEVICE,
    tenant_id: "t1", cashier_user_id: "u1", branch_id: "b1", branch_name: "Main", currency: "USD",
    shift: openShift("SNAP-B1", "b1"),
  });
  shiftNet.findOpenShift = async () => { throw new TypeError("Failed to fetch"); };
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift?.id, "SNAP-B1");
  assert.equal(useShift.getState().offlineRestored, true);
});
