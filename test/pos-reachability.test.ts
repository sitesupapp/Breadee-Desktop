// Pre-submit backend reachability probe - the fix for the physical Wi-Fi defect
// where navigator.onLine stayed true after a real adapter drop. Injectable fetch/
// onLine so the routing decision is proven without a network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isBackendReachable } from "@/lib/offline/reachability";

test("navigator offline => unreachable WITHOUT any network request", async () => {
  let called = 0;
  const r = await isBackendReachable({
    onLine: () => false,
    url: "http://probe.invalid/health",
    fetchFn: (async () => { called++; return new Response(); }) as unknown as typeof fetch,
  });
  assert.equal(r, false);
  assert.equal(called, 0, "no probe when the OS is certain there is no network");
});

test("online + backend answers (any status, e.g. 401) => reachable", async () => {
  const r = await isBackendReachable({
    onLine: () => true,
    url: "http://probe.invalid/health",
    fetchFn: (async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
  });
  assert.equal(r, true);
});

test("PHYSICAL DROP: navigator.onLine=true but fetch REJECTS => unreachable => route offline", async () => {
  const r = await isBackendReachable({
    onLine: () => true,
    url: "http://probe.invalid/health",
    fetchFn: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch,
  });
  assert.equal(r, false);
});

test("probe times out => unreachable, bounded (never hangs the till)", async () => {
  const started = Date.now();
  const r = await isBackendReachable({
    onLine: () => true,
    url: "http://probe.invalid/health",
    timeoutMs: 40,
    fetchFn: ((_u: unknown, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch,
  });
  assert.equal(r, false);
  assert.ok(Date.now() - started < 1000, "resolved via the abort timeout, not a hang");
});

test("no fetch attempted when navigator is offline (fail-closed before any RPC)", async () => {
  let networkTouched = false;
  const r = await isBackendReachable({
    onLine: () => false,
    url: "http://probe.invalid/health",
    fetchFn: (async () => { networkTouched = true; return new Response(); }) as unknown as typeof fetch,
  });
  assert.equal(r, false);
  assert.equal(networkTouched, false);
});
