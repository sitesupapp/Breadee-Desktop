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
    refreshShift: async (c, isCurrent) => {
      committed.push(c.branchId);
      await useShift.getState().refresh(c.tenantId, c.userId, c.branchId, isCurrent);
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
    refreshShift: async (c, isCurrent) => { committed.push(c.branchId); await useShift.getState().refresh(c.tenantId, c.userId, c.branchId, isCurrent); },
  });
  assert.deepEqual(committed, ["bA"]);
  assert.equal(useShift.getState().shift?.id, "S-bA");
});

test("context switch DURING refreshQueue (the TOCTOU window after the pre-refresh check) commits NO OU-A state", async () => {
  let liveCtx: DrainContext = A;
  shiftNet.findOpenShift = async () => openShift(`S-${liveCtx.branchId}`, liveCtx.branchId);
  const queueCommits: (string | null)[] = [];
  const shiftCommits: (string | null)[] = [];
  await runReconnectDrain({
    isOfflineMode: () => false,
    loadContextOnline: async () => {},
    readContext: () => liveCtx,
    sync: async () => {}, // instant: context is still OU-A at the pre-refreshQueue check
    refreshQueue: async (c, isCurrent) => {
      // The OU switches to B WHILE this queue refresh is awaiting its reads - exactly
      // the window Konan flagged. After the awaits, the live-context guard must bail.
      if (c.branchId === "bA") { await delay(10); liveCtx = B; }
      if (!isCurrent()) return;
      queueCommits.push(c.branchId);
    },
    refreshShift: async (c, isCurrent) => {
      shiftCommits.push(c.branchId);
      await useShift.getState().refresh(c.tenantId, c.userId, c.branchId, isCurrent);
    },
  });
  assert.ok(!queueCommits.includes("bA"), "OU-A queue never painted into OU-B's UI after the switch");
  assert.ok(!shiftCommits.includes("bA"), "OU-A shift refresh never even ran after the switch");
  assert.deepEqual(queueCommits, ["bB"], "only OU-B's queue committed");
  assert.deepEqual(shiftCommits, ["bB"], "only OU-B's shift committed");
  assert.equal(useShift.getState().shift?.branch_id, "bB");
});

test("context switch DURING the shift refresh itself: OU-A shift is not committed", async () => {
  let liveCtx: DrainContext = A;
  // findOpenShift is slow for OU-A; the OU switches to B while refresh(A) awaits it.
  shiftNet.findOpenShift = async (_t, _u) => {
    if (liveCtx.branchId === "bA") { await delay(10); liveCtx = B; return openShift("S-bA", "bA"); }
    return openShift("S-bB", "bB");
  };
  const shiftCommits: (string | null)[] = [];
  await runReconnectDrain({
    isOfflineMode: () => false,
    loadContextOnline: async () => {},
    readContext: () => liveCtx,
    sync: async () => {},
    refreshQueue: async () => {},
    refreshShift: async (c, isCurrent) => {
      shiftCommits.push(c.branchId);
      await useShift.getState().refresh(c.tenantId, c.userId, c.branchId, isCurrent);
    },
  });
  // refreshShift(A) runs, but inside refresh(A) the context flips to B during
  // findOpenShift, so refresh's live guard blocks the OU-A commit.
  assert.equal(useShift.getState().shift?.branch_id, "bB", "the active shift is OU-B's, never OU-A's");
  assert.equal(useShift.getState().shift?.id, "S-bB");
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
