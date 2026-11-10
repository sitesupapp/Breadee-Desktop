// 1.0.41 (BUG 03 RC-A) — the app-level sync worker: Sync now / Retry reach a drain with the POS closed,
// one worker, coalesced passes, and health-truthful wording.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setSyncPassForTests, __syncWorkerRunningForTests, appDrain, startSyncWorker } from "@/lib/offline/syncWorker";
import { __drainListenerCountForTests, requestDrainAndWait } from "@/lib/offline/operationLog";
import { runSyncNow, SYNC_NOW_NO_POS, SYNC_NOW_SERVER_OFF, SYNC_NOW_NOT_RUN, retryOutcomeText } from "@/lib/offline/syncActions";
import { __resetReachabilityForTests, markBackendDegraded } from "@/lib/offline/reachability";

const tick = () => new Promise((r) => setTimeout(r, 5));
afterEach(() => __setSyncPassForTests(null));

test("Sync now with NO POS mounted reaches the app worker's drain (1.0.40 said 'POS screen is not open')", async () => {
  __resetReachabilityForTests(async () => true);
  const passes: string[] = [];
  __setSyncPassForTests(async (t) => { passes.push(t); });
  const before = __drainListenerCountForTests();
  const stop = startSyncWorker();
  try {
    assert.equal(__syncWorkerRunningForTests(), true);
    assert.equal(__drainListenerCountForTests(), before + 1, "exactly one worker listener");
    await tick();
    const listeners = await requestDrainAndWait("operator-sync-now");
    assert.equal(listeners, before + 1);
    assert.ok(passes.includes("operator-retry"), "the operator request ran a pass");
  } finally {
    stop();
  }
  assert.equal(__syncWorkerRunningForTests(), false);
  assert.equal(__drainListenerCountForTests(), before, "stop removes the listener");
});

test("startSyncWorker is idempotent: a second start returns the same stop, no duplicate listener", () => {
  __setSyncPassForTests(async () => undefined);
  const before = __drainListenerCountForTests();
  const a = startSyncWorker();
  const b = startSyncWorker();
  try {
    assert.equal(a, b);
    assert.equal(__drainListenerCountForTests(), before + 1);
  } finally {
    a();
  }
});

test("passes coalesce: requests during a pass share ONE follow-up pass that starts after it", async () => {
  let release: () => void = () => {};
  const order: string[] = [];
  let n = 0;
  __setSyncPassForTests(async (t) => {
    n += 1;
    const id = `${t}#${n}`;
    order.push(`start ${id}`);
    if (n === 1) await new Promise<void>((r) => { release = r; });
    order.push(`end ${id}`);
  });
  const first = appDrain("reconnect");
  const a = appDrain("operator-retry");
  const b = appDrain("periodic");
  assert.equal(a, b, "requests during a pass join the same follow-up");
  release();
  await Promise.all([first, a, b]);
  assert.equal(n, 2, "one pass in flight + exactly one follow-up");
  assert.deepEqual(order, ["start reconnect#1", "end reconnect#1", "start operator-retry#2", "end operator-retry#2"]);
});

test("a failing pass never throws to the caller and frees the worker", async () => {
  __setSyncPassForTests(async () => { throw new Error("boom"); });
  await appDrain("operator-retry");
  let ran = false;
  __setSyncPassForTests(async () => { ran = true; });
  await appDrain("operator-retry");
  assert.equal(ran, true);
});

test("Sync now wording follows the ONE health truth (no 'online' header next to 'offline' text)", async () => {
  __resetReachabilityForTests(async () => true);
  assert.deepEqual(await runSyncNow(async () => 0, () => null), { ran: false, text: SYNC_NOW_NO_POS });
  assert.deepEqual(await runSyncNow(async () => 1, () => null), { ran: false, text: SYNC_NOW_NOT_RUN });
  markBackendDegraded();
  assert.deepEqual(await runSyncNow(async () => 1, () => null), { ran: false, text: SYNC_NOW_SERVER_OFF });
  assert.match(retryOutcomeText({ status: "pending" } as never), /server is not answering/);
  __resetReachabilityForTests(async () => true);
  assert.match(retryOutcomeText({ status: "pending" } as never), /next pass/);
});
