// 1.0.41 — Server Off, F-HEALTH: "reachable" means the DATABASE answers, and a database that fails while
// the network is up (the 2026-11-07 Production stall: 5xx, PGRST003 pool exhaustion, statement timeouts)
// routes tills to local capture instead of failing online. Fault injection only — no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  __resetReachabilityForTests,
  getBackendHealth,
  isBackendReachable,
  lastKnownReachable,
  markBackendDegraded,
  markBackendReachable,
  markBackendUnreachable,
  RECOVERY_SUCCESSES,
  SERVER_OFF_FAILURES,
  DEGRADED_WINDOW_MS,
  statusProvesHealthy,
} from "@/lib/offline/reachability";
import { createTimeoutFetch } from "@/lib/net/timeoutFetch";

const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
const probe = (status: number) => isBackendReachable({ onLine: () => true, url: "http://probe.invalid/db", fetchFn: answer(status) });

test("probe: a gateway 5xx is NOT healthy (database stalled behind a live gateway)", async () => {
  for (const s of [500, 502, 503, 504]) assert.equal(await probe(s), false, `status ${s}`);
});

test("probe: any answer below 500 proves the database answered (200, 401, 404)", async () => {
  for (const s of [200, 401, 404]) assert.equal(await probe(s), true, `status ${s}`);
  assert.equal(statusProvesHealthy(0), false, "an opaque/zero status proves nothing");
});

test("store: one 5xx on real traffic → DEGRADED at once, routes offline (reachable = false)", async () => {
  __resetReachabilityForTests(async () => true);
  assert.equal(await isBackendReachable(), true);
  assert.equal(getBackendHealth(), "online");
  markBackendDegraded();
  assert.equal(lastKnownReachable(), false);
  assert.equal(await isBackendReachable(), false, "the negative wins within the TTL");
  assert.equal(getBackendHealth(), "degraded");
});

test("store: hysteresis — leaving DEGRADED needs RECOVERY_SUCCESSES healthy answers", () => {
  __resetReachabilityForTests(async () => true);
  markBackendDegraded();
  assert.ok(RECOVERY_SUCCESSES >= 2);
  for (let i = 1; i < RECOVERY_SUCCESSES; i++) {
    markBackendReachable();
    assert.equal(lastKnownReachable(), false, `still held after ${i} healthy answer(s)`);
  }
  markBackendReachable();
  assert.equal(lastKnownReachable(), true, "recovered after enough healthy answers");
  assert.equal(getBackendHealth(), "online");
});

test("store: a 5xx during recovery resets the streak (a stall answering 1 request in 3 never flips back)", () => {
  __resetReachabilityForTests(async () => true);
  markBackendDegraded();
  markBackendReachable();
  markBackendDegraded();
  markBackendReachable();
  assert.equal(lastKnownReachable(), false);
  markBackendReachable();
  assert.equal(lastKnownReachable(), true);
});

test("store: SERVER_OFF_FAILURES 5xx inside the window read as server_off", () => {
  __resetReachabilityForTests(async () => true);
  for (let i = 0; i < SERVER_OFF_FAILURES; i++) markBackendDegraded();
  assert.equal(getBackendHealth(), "server_off");
});

test("store: a 5xx older than the window no longer holds the store", () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    __resetReachabilityForTests(async () => true);
    markBackendDegraded();
    now += DEGRADED_WINDOW_MS + 1;
    markBackendReachable();
    assert.equal(lastKnownReachable(), true, "expired failure evidence does not demand extra recoveries");
  } finally {
    Date.now = realNow;
  }
});

test("store: a transport drop is server_off; its return is immediate (1.0.38 semantics kept)", () => {
  __resetReachabilityForTests(async () => true);
  markBackendUnreachable();
  assert.equal(getBackendHealth(), "server_off");
  markBackendReachable();
  assert.equal(lastKnownReachable(), true);
  assert.equal(getBackendHealth(), "online");
});

test("store: a failing default probe (database down) is server_off", async () => {
  __resetReachabilityForTests(async () => false);
  assert.equal(await isBackendReachable(), false);
  assert.equal(getBackendHealth(), "server_off");
});

test("store: while DEGRADED a healthy probe counts toward recovery instead of flipping at once", async () => {
  __resetReachabilityForTests(async () => true);
  markBackendDegraded();
  // Expire the TTL so the next caller re-probes.
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    now += 10_000;
    assert.equal(await isBackendReachable(), false, "first healthy probe: still held");
    now += 10_000;
    assert.equal(await isBackendReachable(), true, "second healthy probe: recovered");
  } finally {
    Date.now = realNow;
  }
});

test("timeoutFetch: a 503/504 answer on a WRITE marks the store DEGRADED; a 2xx marks it reachable", async () => {
  __resetReachabilityForTests(async () => true);
  await isBackendReachable();
  const f503 = createTimeoutFetch(() => answer(503));
  await f503("https://x.supabase.co/rest/v1/rpc/pos_pay_order", { method: "POST", body: "{}" });
  assert.equal(getBackendHealth(), "degraded");
  const f504 = createTimeoutFetch(() => answer(504));
  await f504("https://x.supabase.co/rest/v1/rpc/pos_submit_order", { method: "POST", body: "{}" });
  const ok = createTimeoutFetch(() => answer(200));
  await ok("https://x.supabase.co/rest/v1/orders", { method: "GET" });
  await ok("https://x.supabase.co/rest/v1/orders", { method: "GET" });
  assert.equal(getBackendHealth(), "online");
});

test("timeoutFetch: a 4xx business refusal is NOT a degraded signal (the database answered)", async () => {
  __resetReachabilityForTests(async () => true);
  await isBackendReachable();
  const f = createTimeoutFetch(() => answer(400));
  await f("https://x.supabase.co/rest/v1/rpc/pos_pay_table", { method: "POST", body: "{}" });
  assert.equal(getBackendHealth(), "online");
});
