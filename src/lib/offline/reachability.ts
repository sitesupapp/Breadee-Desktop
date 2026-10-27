// Is the authoritative Breadee backend reachable RIGHT NOW?
//
// WHY THIS EXISTS: navigator.onLine is NOT trustworthy for deciding whether a
// cash sale should go online. On Windows/WebView2 a physical Wi-Fi drop can leave
// navigator.onLine === true, so a routing gate built on it sends the order to
// pos_submit_order, which then fails with "Failed to fetch" AFTER the attempt -
// the exact ambiguous state offline capture must avoid before a submit. So before
// committing a cash sale we ASK the backend with a short, NON-MUTATING probe.
//
// SEMANTICS: the probe is no-cors, so it resolves (opaque) for ANY answer the
// gateway gives - 200, 401, 404, 5xx - because any answer proves the backend was
// reached. It rejects ONLY on a network-level failure (no route, DNS/connect fail)
// or the abort timeout, which is exactly "unreachable". It creates no order,
// payment, inventory or accounting state, and it is used ONLY before a submit
// begins. Once a submit has started, an ambiguous result is left to the server's
// own idempotency (client_op_id) on retry - this probe never reclassifies an
// already-started submit into a new offline transaction.
//
// 1.0.38 (PERF C10 / R1) — ONE SHARED STORE. Every default caller (no deps) goes
// through a module store: a result is reused for REACHABILITY_TTL_MS, concurrent
// callers share ONE in-flight probe, navigator.onLine === false is a fast negative,
// the browser's online/offline events invalidate it, and the Supabase transport
// (lib/net/timeoutFetch) marks it on the first transport error / any answer. So an
// offline tap that refreshes the map, selects a table and loads its bill costs at
// most ONE probe instead of three, and the 20 s badge poll, the per-action re-checks
// and the subscribers (PosWorkspace's `backendReachable`) all see the same answer.
// Callers that INJECT deps (tests) bypass the store and probe exactly as before.

export type ReachabilityDeps = {
  /** Injectable for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests. Defaults to navigator.onLine (true when unavailable). */
  onLine?: () => boolean;
  /** Injectable for tests to avoid importing build-time env. */
  url?: string;
  /** Abort ceiling; a real disconnect usually fails much faster. */
  timeoutMs?: number;
};

/** How long a probe / transport verdict is reused before the next caller re-probes. */
export const REACHABILITY_TTL_MS = 3_000;
/** The probe's own abort ceiling (unchanged from 1.0.37). */
export const REACHABILITY_PROBE_TIMEOUT_MS = 2_500;

async function healthUrl(): Promise<string> {
  // Lazy import so this module stays loadable without build-time env (tests).
  const { env } = await import("@/env");
  return `${env.SUPABASE_URL}/auth/v1/health`;
}

/** The raw probe (1.0.37 behaviour): one request, no caching. */
async function probeBackend(deps: ReachabilityDeps): Promise<boolean> {
  const timeoutMs = deps.timeoutMs ?? REACHABILITY_PROBE_TIMEOUT_MS;
  const onLine = deps.onLine ?? navigatorOnLine;
  // Fast negative: the OS is certain there is no network. No request needed.
  if (onLine() === false) return false;
  const f = deps.fetchFn ?? fetch;
  const target = deps.url ?? (await healthUrl());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-cors: resolves for any gateway answer, rejects only on a network failure.
    await f(target, { method: "GET", mode: "no-cors", cache: "no-store", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function navigatorOnLine(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

// --- shared store -----------------------------------------------------------
let last: { value: boolean; at: number } | null = null;
let inFlight: Promise<boolean> | null = null;
// Bumped by every invalidation/mark: an older in-flight probe may not overwrite a newer verdict.
let generation = 0;
const listeners = new Set<(reachable: boolean) => void>();
let eventsInstalled = false;
let probeOverride: (() => Promise<boolean>) | null = null;
let probeCount = 0;

function publish(value: boolean): void {
  const changed = last?.value !== value;
  last = { value, at: Date.now() };
  if (!changed) return;
  for (const l of listeners) {
    try {
      l(value);
    } catch {
      /* a subscriber's failure never breaks the store */
    }
  }
}

function installBrowserEvents(): void {
  if (eventsInstalled || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  eventsInstalled = true;
  // `online` is only a HINT (the backend may still be unreachable): drop the cached verdict so the
  // next caller re-probes. `offline` is certain: publish the negative at once.
  window.addEventListener("online", () => invalidateReachability());
  window.addEventListener("offline", () => markBackendUnreachable());
}

async function sharedReachability(): Promise<boolean> {
  installBrowserEvents();
  if (navigatorOnLine() === false) {
    publish(false);
    return false;
  }
  if (last && Date.now() - last.at < REACHABILITY_TTL_MS) return last.value;
  if (inFlight) return inFlight;
  const gen = generation;
  probeCount += 1;
  const p = (probeOverride ? probeOverride() : probeBackend({}))
    .catch(() => false)
    .then((r) => {
      if (gen === generation) publish(r);
      return r;
    })
    .finally(() => {
      if (inFlight === p) inFlight = null;
    });
  inFlight = p;
  return p;
}

/**
 * Is the backend reachable? With `deps` (tests) this is the raw 1.0.37 probe, uncached. Without
 * deps it is the shared store: TTL-fresh, de-duplicated, fast-negative when the OS is offline.
 */
export async function isBackendReachable(deps?: ReachabilityDeps): Promise<boolean> {
  if (deps) return probeBackend(deps);
  return sharedReachability();
}

/** The last verdict the store holds (any age), or null when nothing is known yet. Synchronous, no I/O. */
export function lastKnownReachable(): boolean | null {
  if (navigatorOnLine() === false) return false;
  return last ? last.value : null;
}

/** A transport-level failure was observed (fetch rejected): publish the negative and drop any probe. */
export function markBackendUnreachable(): void {
  generation += 1;
  inFlight = null;
  publish(false);
}

/** The backend ANSWERED a request (any status): the same proof the probe looks for. */
export function markBackendReachable(): void {
  if (navigatorOnLine() === false) return;
  generation += 1;
  inFlight = null;
  publish(true);
}

/** Forget the cached verdict (keeps the last value for `lastKnownReachable`); the next caller re-probes. */
export function invalidateReachability(): void {
  generation += 1;
  inFlight = null;
  if (last) last = { value: last.value, at: 0 };
}

/** Subscribe to verdict CHANGES (true⇄false). Returns the unsubscribe function. */
export function subscribeReachability(listener: (reachable: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: reset the store; optionally replace the default probe (no network) and read the probe count. */
export function __resetReachabilityForTests(probe: (() => Promise<boolean>) | null = null): void {
  last = null;
  inFlight = null;
  generation += 1;
  listeners.clear();
  probeOverride = probe;
  probeCount = 0;
}

/** Test hook: how many default-path probes the store has actually started since the last reset. */
export function __reachabilityProbeCountForTests(): number {
  return probeCount;
}
