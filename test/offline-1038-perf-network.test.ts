// 1.0.38 PERF (Track 8) — the shared reachability store, the Supabase read timeout and the cache-backed
// print-route lookup. Pure / injected: no network, no build-time env.
//  - store: TTL reuse, in-flight de-duplication, navigator-offline fast negative, invalidation, transport
//    marks, change-only subscriptions; injected deps still probe exactly as 1.0.37 (uncached).
//  - timeoutFetch: reads abort at READ_TIMEOUT_MS, mutations get NO added timeout, the caller's signal
//    composes, and transport evidence feeds the store.
//  - resolvePrintRouteCached: write-through online, cache fallback on failure, cache-first when the store
//    already knows the backend is unreachable (C1–C3).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  isBackendReachable,
  lastKnownReachable,
  markBackendReachable,
  markBackendUnreachable,
  invalidateReachability,
  subscribeReachability,
  REACHABILITY_TTL_MS,
  __resetReachabilityForTests,
  __reachabilityProbeCountForTests,
} from "@/lib/offline/reachability";
import { createTimeoutFetch, requestTimeoutMs, READ_TIMEOUT_MS, AUTH_TOKEN_TIMEOUT_MS } from "@/lib/net/timeoutFetch";
import { resolvePrintRouteCached, UNRESOLVED, type ResolvedRoute } from "@/lib/pos/printRouteResolver";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => __resetReachabilityForTests(async () => true));

// ---------------------------------------------------------------- store

test("store: concurrent callers share ONE in-flight probe; the verdict is reused within the TTL", async () => {
  let probes = 0;
  __resetReachabilityForTests(async () => {
    probes++;
    await delay(20);
    return false;
  });
  const all = await Promise.all([isBackendReachable(), isBackendReachable(), isBackendReachable()]);
  assert.deepEqual(all, [false, false, false]);
  assert.equal(probes, 1, "three concurrent callers → one probe");
  assert.equal(await isBackendReachable(), false);
  assert.equal(probes, 1, "a TTL-fresh verdict is reused, no second probe");
  assert.equal(__reachabilityProbeCountForTests(), 1);
  assert.equal(lastKnownReachable(), false);
  assert.ok(REACHABILITY_TTL_MS >= 1000 && REACHABILITY_TTL_MS <= 5000);
});

test("store: invalidation forces a re-probe; marks publish at once without a probe", async () => {
  let answer = true;
  __resetReachabilityForTests(async () => answer);
  assert.equal(await isBackendReachable(), true);
  markBackendUnreachable(); // first transport error seen by the client
  assert.equal(await isBackendReachable(), false, "the negative mark wins within the TTL");
  assert.equal(__reachabilityProbeCountForTests(), 1);
  invalidateReachability();
  answer = true;
  assert.equal(await isBackendReachable(), true, "invalidated → re-probed");
  assert.equal(__reachabilityProbeCountForTests(), 2);
  markBackendUnreachable();
  markBackendReachable(); // any answer from the backend
  assert.equal(await isBackendReachable(), true);
  assert.equal(__reachabilityProbeCountForTests(), 2);
});

test("store: a mark during an in-flight probe is never overwritten by that older probe", async () => {
  __resetReachabilityForTests(async () => {
    await delay(20);
    return true;
  });
  const p = isBackendReachable();
  markBackendUnreachable();
  await p;
  assert.equal(lastKnownReachable(), false, "the newer transport evidence wins");
});

test("store: subscribers hear CHANGES only", async () => {
  const heard: boolean[] = [];
  let answer = false;
  __resetReachabilityForTests(async () => answer);
  const off = subscribeReachability((r) => heard.push(r));
  await isBackendReachable();
  markBackendUnreachable(); // same value: silent
  markBackendReachable();
  markBackendReachable(); // same value: silent
  answer = true;
  off();
  markBackendUnreachable(); // unsubscribed
  assert.deepEqual(heard, [false, true]);
});

test("store: navigator.onLine === false is a fast negative with no probe", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  try {
    __resetReachabilityForTests(async () => true);
    assert.equal(await isBackendReachable(), false);
    assert.equal(__reachabilityProbeCountForTests(), 0);
    assert.equal(lastKnownReachable(), false);
  } finally {
    if (desc) Object.defineProperty(globalThis, "navigator", desc);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test("store: INJECTED deps bypass the store (1.0.37 semantics, uncached, one request each)", async () => {
  let calls = 0;
  const deps = { onLine: () => true, url: "http://probe.invalid/health", fetchFn: (async () => { calls++; return new Response(); }) as unknown as typeof fetch };
  assert.equal(await isBackendReachable(deps), true);
  assert.equal(await isBackendReachable(deps), true);
  assert.equal(calls, 2);
  assert.equal(__reachabilityProbeCountForTests(), 0, "the store was not touched");
});

// ---------------------------------------------------------------- timeoutFetch

test("timeout policy: GET/HEAD and allow-listed read RPCs are bounded; writes and other RPCs are not", () => {
  const base = "https://x.supabase.co";
  assert.equal(requestTimeoutMs("GET", `${base}/rest/v1/orders?select=*`), READ_TIMEOUT_MS);
  assert.equal(requestTimeoutMs("HEAD", `${base}/rest/v1/orders`), READ_TIMEOUT_MS);
  assert.equal(requestTimeoutMs("POST", `${base}/rest/v1/rpc/resolve_print_route`), READ_TIMEOUT_MS);
  assert.equal(requestTimeoutMs("POST", `${base}/rest/v1/rpc/pos_submit_order`), null, "a mutating RPC is never shortened");
  assert.equal(requestTimeoutMs("POST", `${base}/rest/v1/rpc/pos_pay_table`), null);
  assert.equal(requestTimeoutMs("POST", `${base}/rest/v1/orders`), null);
  assert.equal(requestTimeoutMs("PATCH", `${base}/rest/v1/orders?id=eq.1`), null);
  assert.equal(requestTimeoutMs("DELETE", `${base}/rest/v1/orders?id=eq.1`), null);
  // Offline-first recovery — the auth token endpoint is bounded (a hung refresh held the auth lock
  // every PostgREST call awaits); it is never shortened below the read ceiling.
  assert.equal(requestTimeoutMs("POST", `${base}/auth/v1/token?grant_type=refresh_token`), AUTH_TOKEN_TIMEOUT_MS);
  assert.ok(AUTH_TOKEN_TIMEOUT_MS >= READ_TIMEOUT_MS);
  assert.ok(READ_TIMEOUT_MS >= 10_000 && READ_TIMEOUT_MS <= 20_000);
});

test("timeoutFetch: a hung READ aborts (bounded) and only invalidates the store", async () => {
  let seenSignal: AbortSignal | undefined;
  const hung = (async (_u: unknown, init?: RequestInit) => {
    seenSignal = init?.signal ?? undefined;
    return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
  }) as unknown as typeof fetch;
  __resetReachabilityForTests(async () => true);
  await isBackendReachable();
  // The production policy, with the read ceiling shrunk to 10 ms for the test.
  const f = createTimeoutFetch(() => hung, (m, u) => (requestTimeoutMs(m, u) == null ? null : 10));
  const started = Date.now();
  await assert.rejects(() => f("https://x.supabase.co/rest/v1/orders", { method: "GET" }), (e: unknown) => (e as DOMException).name === "TimeoutError");
  assert.ok(Date.now() - started < 1000, "bounded, not a hang");
  assert.ok(seenSignal?.aborted);
  assert.equal(lastKnownReachable(), true, "a timeout only invalidates (re-probe next), it does not claim offline");
  assert.equal(__reachabilityProbeCountForTests(), 1);
  await isBackendReachable();
  assert.equal(__reachabilityProbeCountForTests(), 2, "invalidated → the next caller re-probes");
});

test("timeoutFetch: a WRITE gets no signal of ours (no added timeout); transport errors mark the store", async () => {
  let seen: RequestInit | undefined;
  const ok = (async (_u: unknown, init?: RequestInit) => { seen = init; return new Response("{}"); }) as unknown as typeof fetch;
  const f = createTimeoutFetch(() => ok);
  const init = { method: "POST", body: "{}" };
  await f("https://x.supabase.co/rest/v1/rpc/pos_submit_order", init);
  assert.equal(seen, init, "the write is passed through untouched");
  assert.equal(lastKnownReachable(), true, "any answer marks the backend reachable");

  const down = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
  const g = createTimeoutFetch(() => down);
  await assert.rejects(() => g("https://x.supabase.co/rest/v1/rpc/pos_submit_order", { method: "POST" }), TypeError);
  assert.equal(lastKnownReachable(), false, "a transport rejection marks the backend unreachable");
});

test("timeoutFetch: the caller's signal composes (caller abort propagates; not counted as offline)", async () => {
  const hung = (async (_u: unknown, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
  __resetReachabilityForTests(async () => true);
  await isBackendReachable();
  const f = createTimeoutFetch(() => hung);
  const c = new AbortController();
  const p = f("https://x.supabase.co/rest/v1/orders", { method: "GET", signal: c.signal });
  c.abort();
  await assert.rejects(p, (e: unknown) => (e as DOMException).name === "AbortError");
  assert.equal(lastKnownReachable(), true);
});

// ---------------------------------------------------------------- resolvePrintRouteCached

const ROUTE: ResolvedRoute = { ...UNRESOLVED, resolved: true, route_id: "R1", printer_id: "P1", printer_name: "Front", system_printer_name: "WIN-FRONT", paper_width: "80mm", copies: 1 };

function routeDeps(opts: { reachable: boolean | null; resolve: () => Promise<ResolvedRoute> }) {
  const cache = new Map<string, unknown>();
  let resolveCalls = 0;
  return {
    cache,
    get resolveCalls() { return resolveCalls; },
    deps: {
      resolve: async () => { resolveCalls++; return opts.resolve(); },
      cache: async (b: string, p: string, s: string, r: unknown) => { cache.set(`${b}|${p}|${s}`, r); },
      readCache: async (b: string, p: string, s: string) => cache.get(`${b}|${p}|${s}`) ?? null,
      lastKnownReachable: () => opts.reachable,
    },
  };
}

test("print route: online → server answer, written through to the cache", async () => {
  const d = routeDeps({ reachable: true, resolve: async () => ROUTE });
  const r = await resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "takeaway" }, d.deps);
  assert.deepEqual(r, ROUTE);
  await delay(0);
  assert.deepEqual(d.cache.get("b1|receipt|takeaway"), ROUTE);
});

test("print route: the resolve FAILS (offline) → the cached route (C1/C2/C3 no longer blocked)", async () => {
  const d = routeDeps({ reachable: null, resolve: async () => { throw new TypeError("Failed to fetch"); } });
  d.cache.set("b1|receipt|takeaway", ROUTE);
  assert.deepEqual(await resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "takeaway" }, d.deps), ROUTE);
  assert.equal(await resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "dine_in" }, d.deps), null, "a miss stays 'no route'");
});

test("print route: the store KNOWS it is offline → cache first, NO request", async () => {
  const d = routeDeps({ reachable: false, resolve: async () => ROUTE });
  d.cache.set("b1|receipt|takeaway", ROUTE);
  assert.deepEqual(await resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "takeaway" }, d.deps), ROUTE);
  assert.equal(await resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "delivery" }, d.deps), null, "a miss is 'no route', still no request");
  assert.equal(d.resolveCalls, 0);
});

test("print route: no branch → null with no request; an unresolved online answer is returned as-is (not cached)", async () => {
  const d = routeDeps({ reachable: true, resolve: async () => UNRESOLVED });
  assert.equal(await resolvePrintRouteCached({ branchId: null, purpose: "receipt", orderSource: "takeaway" }, d.deps), null);
  assert.equal(d.resolveCalls, 0);
  assert.deepEqual(await resolvePrintRouteCached({ branchId: "b1", purpose: "receipt", orderSource: "takeaway" }, d.deps), UNRESOLVED);
  await delay(0);
  assert.equal(d.cache.size, 0);
});
