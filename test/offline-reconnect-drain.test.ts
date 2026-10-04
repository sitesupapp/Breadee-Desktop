// Integration test: the REAL shift store driven THROUGH the reconnect drain
// sequence (runReconnectDrain). Reproduces Konan cycle-5's race - an OU-A drain
// parked in sync, the user switches to OU-B and OU-B commits, OU-A then releases -
// and proves OU-A never commits its (now stale) state, because the drain re-checks
// the live context before committing and re-passes under the new OU.

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
import { runReconnectDrain, type DrainContext } from "@/lib/offline/reconnectDrain";
import type { ActiveShift, CashBox } from "@/types/pos";

const A: DrainContext = { tenantId: "t1", userId: "u1", branchId: "bA" };
const B: DrainContext = { tenantId: "t1", userId: "u1", branchId: "bB" };
const openShift = (id: string, branchId: string | null): ActiveShift => ({
  id, status: "open", opened_at: "2026-10-03T08:00:00Z", opening_cash_amount: 0, branch_id: branchId,
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  useShift.getState().clear();
  // The open shift the server returns always matches the branch being refreshed, so
  // a refresh under OU-X yields OU-X's shift (and refresh's own branch check passes).
  shiftNet.getCashBox = async (id) => ({ shift_id: id } as unknown as CashBox);
});

test("OU-A drain parked in sync, switch to OU-B which commits, release OU-A: OU-A NEVER commits", async () => {
  let liveCtx: DrainContext = A;
  shiftNet.findOpenShift = async () => openShift(`S-${liveCtx.branchId}`, liveCtx.branchId);
  const committed: (string | null)[] = [];

  await runReconnectDrain({
    isOfflineMode: () => false,
    loadContextOnline: async () => {},
    readContext: () => liveCtx,
    sync: async (c) => {
      // While OU-A's sync is "in flight", the user switches to OU-B and OU-B's own
      // drain completes a refresh that commits OU-B as the active shift.
      if (c.branchId === "bA") {
        await delay(10);
        liveCtx = B;
        await useShift.getState().refresh(B.tenantId, B.userId, B.branchId);
      }
    },
    refreshQueue: async () => {},
    refreshShift: async (c) => {
      committed.push(c.branchId);
      await useShift.getState().refresh(c.tenantId, c.userId, c.branchId);
    },
  });

  assert.deepEqual(committed, ["bB"], "OU-A's post-sync commit was skipped; only OU-B committed");
  assert.equal(useShift.getState().shift?.id, "S-bB", "the active shift is OU-B's, never OU-A's");
  assert.equal(useShift.getState().shift?.branch_id, "bB");
});

test("a stable context drains and commits exactly once through the drain", async () => {
  shiftNet.findOpenShift = async () => openShift("S-bA", "bA");
  const committed: (string | null)[] = [];
  await runReconnectDrain({
    isOfflineMode: () => false,
    loadContextOnline: async () => {},
    readContext: () => A,
    sync: async () => {},
    refreshQueue: async () => {},
    refreshShift: async (c) => { committed.push(c.branchId); await useShift.getState().refresh(c.tenantId, c.userId, c.branchId); },
  });
  assert.deepEqual(committed, ["bA"]);
  assert.equal(useShift.getState().shift?.id, "S-bA");
});

test("a failed rehydration stops the drain entirely (no replay under stale context)", async () => {
  shiftNet.findOpenShift = async () => openShift("S-bA", "bA");
  let synced = false;
  await runReconnectDrain({
    isOfflineMode: () => true,
    loadContextOnline: async () => { throw new Error("offline"); },
    readContext: () => A,
    sync: async () => { synced = true; },
    refreshQueue: async () => {},
    refreshShift: async () => {},
  });
  assert.equal(synced, false, "a failed authoritative refresh must not replay");
  assert.equal(useShift.getState().shift, null);
});
