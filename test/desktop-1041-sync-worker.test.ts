// 1.0.41 (BUG 03 RC-A) — the app-level sync worker: Sync now / Retry reach a drain with the POS closed,
// one worker, coalesced passes, and health-truthful wording.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __setSyncPassForTests, __syncWorkerRunningForTests, appDrain, recoveryProbe, startSyncWorker, SYNC_WORKER_RECOVERY_PROBE_MS } from "@/lib/offline/syncWorker";
import { __drainListenerCountForTests, requestDrainAndWait } from "@/lib/offline/operationLog";
import { runSyncNow, SYNC_NOW_NO_POS, SYNC_NOW_SERVER_OFF, SYNC_NOW_NOT_RUN, retryOutcomeText } from "@/lib/offline/syncActions";
import { __reachabilityProbeCountForTests, __resetReachabilityForTests, getBackendHealth, markBackendDegraded, markBackendUnreachable } from "@/lib/offline/reachability";

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

// --- D-2 (Staging 1.0.52 native QA): recovery from ANY screen -------------------------------------------------------
// Native evidence 2026-11-11: after a backend outage with the network up, Dashboard / Settings made no request for
// 3.5 min and stayed "Breadee server off" (the header) beside "Online" (the Dashboard card) until POS was opened.

test("D-2: while the server is off, the worker's recovery step re-probes and a healthy answer starts the drain", async () => {
  let up = false;
  __resetReachabilityForTests(async () => up);
  const passes: string[] = [];
  __setSyncPassForTests(async (t) => { passes.push(t); });
  const stop = startSyncWorker();
  try {
    await tick();
    passes.length = 0;
    markBackendUnreachable(); // transport drop (the app's own proxy offline / server gone)
    assert.equal(getBackendHealth(), "server_off");
    await new Promise((r) => setTimeout(r, 3_100)); // past the shared store's 3 s TTL (the 20 s cadence always is)
    const n0 = __reachabilityProbeCountForTests();
    assert.equal(await recoveryProbe(), false, "still down: the step probes and reports down");
    assert.equal(__reachabilityProbeCountForTests(), n0 + 1, "exactly one probe per step");
    assert.deepEqual(passes, [], "no drain while down (nothing hammered)");
    up = true;
    await new Promise((r) => setTimeout(r, 3_100)); // past the shared store's 3 s TTL
    assert.equal(await recoveryProbe(), true);
    await tick();
    assert.equal(getBackendHealth(), "online");
    assert.ok(passes.includes("backend-returned"), "the healthy answer started the drain with no screen involved");
    const n1 = __reachabilityProbeCountForTests();
    assert.equal(recoveryProbe(), null, "online: no probe at all (no background load while healthy)");
    assert.equal(__reachabilityProbeCountForTests(), n1);
  } finally {
    stop();
  }
});

test("D-2: the worker schedules the recovery step on the POS badge cadence and clears it on stop", () => {
  assert.equal(SYNC_WORKER_RECOVERY_PROBE_MS, 20_000);
  const src = readFileSync(join(process.cwd(), "src", "lib", "offline", "syncWorker.ts"), "utf8");
  assert.match(src, /window\.setInterval\(\(\) => void recoveryProbe\(\), SYNC_WORKER_RECOVERY_PROBE_MS\)/);
  assert.match(src, /if \(recovery !== null\) window\.clearInterval\(recovery\);/);
  const dash = readFileSync(join(process.cwd(), "src", "screens", "Dashboard.tsx"), "utf8");
  assert.match(dash, /const health = healthBadge\(backendHealth, s\.offlineMode, s\.online\);/, "the Dashboard badge reads the same health truth as the header");
  assert.doesNotMatch(dash, /s\.online \? "Online" : "No internet"/);
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
