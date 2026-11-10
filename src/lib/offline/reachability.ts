// Is the authoritative Breadee backend reachable RIGHT NOW?
//
// WHY THIS EXISTS: navigator.onLine is NOT trustworthy for deciding whether a
// cash sale should go online. On Windows/WebView2 a physical Wi-Fi drop can leave
// navigator.onLine === true, so a routing gate built on it sends the order to
// pos_submit_order, which then fails with "Failed to fetch" AFTER the attempt -
// the exact ambiguous state offline capture must avoid before a submit. So before
// committing a cash sale we ASK the backend with a short, NON-MUTATING probe.
//
// SEMANTICS (1.0.41 — Server Off): "reachable" now means THE DATABASE ANSWERS, not
// "some gateway answered". The 2026-11-07 Production incident was a database stall:
// Auth and the API gateway kept answering while every POS write failed with 5xx /
// statement timeouts, so the 1.0.40 no-cors auth-health probe (any answer = reachable)
// kept every till on the online path. The probe is now a CORS read that Postgres
// itself must execute (anon `select id … limit 0` on a 4-row catalog table: RLS gives
// anon zero rows, so nothing is ever returned), and a status >= 500 is a FAILURE.
// A 4xx still proves the database answered (e.g. a permission refusal is raised by
// Postgres), so it stays "reachable". The probe creates no order, payment, inventory
// or accounting state and is used ONLY before a submit begins. Once a submit has
// started, an ambiguous result is left to the server's own idempotency
// (client_op_id) - this probe never reclassifies an already-started submit.
//
// DEGRADED (1.0.41): a 5xx seen on REAL traffic (timeoutFetch → markBackendDegraded)
// publishes "unreachable" at once and holds it until RECOVERY_SUCCESSES healthy answers
// have been seen (hysteresis: a stalled database answering one request in three must not
// flip tills back to the online path between failures). A plain transport drop/return
// keeps its immediate 1.0.38 semantics.
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

/** 1.0.41 — the database-touching probe target and its headers (anon key: public by design). */
async function healthRequest(): Promise<{ url: string; headers: Record<string, string> }> {
  // Lazy import so this module stays loadable without build-time env (tests).
  const { env } = await import("@/env");
  return {
    url: `${env.SUPABASE_URL}/rest/v1/subscription_plans?select=id&limit=0`,
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` },
  };
}

/** PURE — does this HTTP status prove the DATABASE answered? (5xx = gateway/pool/statement failure.) */
export function statusProvesHealthy(status: number): boolean {
  return status > 0 && status < 500;
}

/** The raw probe: one request, no caching. Healthy only when the database answered (< 500). */
async function probeBackend(deps: ReachabilityDeps): Promise<boolean> {
  const timeoutMs = deps.timeoutMs ?? REACHABILITY_PROBE_TIMEOUT_MS;
  const onLine = deps.onLine ?? navigatorOnLine;
  // Fast negative: the OS is certain there is no network. No request needed.
  if (onLine() === false) return false;
  const f = deps.fetchFn ?? fetch;
  const req = deps.url ? { url: deps.url, headers: {} as Record<string, string> } : await healthRequest();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(req.url, { method: "GET", cache: "no-store", headers: req.headers, signal: controller.signal });
    return statusProvesHealthy(res.status);
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

// 1.0.41 — DEGRADED hold (database failing while the network is up). See the header.
/** A 5xx older than this no longer holds the store degraded. */
export const DEGRADED_WINDOW_MS = 30_000;
/** Healthy answers needed to leave DEGRADED (hysteresis). */
export const RECOVERY_SUCCESSES = 2;
/** Failures inside the window that make DEGRADED read as SERVER_OFF. */
export const SERVER_OFF_FAILURES = 3;
let degradedFailures: number[] = [];
let healthyStreak = 0;
/** The last negative came from a transport drop / failed probe (not a 5xx). */
let transportDown = false;

function pruneDegraded(now: number): void {
  degradedFailures = degradedFailures.filter((t) => now - t < DEGRADED_WINDOW_MS);
}

/** True while recent 5xx evidence holds the store negative until enough healthy answers arrive. */
function degradedHold(now: number): boolean {
  pruneDegraded(now);
  return degradedFailures.length > 0 && healthyStreak < RECOVERY_SUCCESSES;
}

/** A healthy answer arrived (probe or real traffic). Returns the verdict to publish. */
function noteHealthy(now: number): boolean {
  transportDown = false;
  if (!degradedHold(now)) return true;
  healthyStreak += 1;
  if (healthyStreak >= RECOVERY_SUCCESSES) {
    degradedFailures = [];
    return true;
  }
  return false;
}

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
    .then((raw) => {
      // 1.0.41 — a healthy probe while DEGRADED counts toward recovery, not an instant flip.
      const r = raw ? noteHealthy(Date.now()) : false;
      if (!raw) transportDown = true;
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
  transportDown = true;
  publish(false);
}

/** The DATABASE answered a request (status < 500): the same proof the probe looks for. While DEGRADED,
 *  it counts toward recovery (RECOVERY_SUCCESSES) instead of flipping the store back at once. */
export function markBackendReachable(): void {
  if (navigatorOnLine() === false) return;
  generation += 1;
  inFlight = null;
  publish(noteHealthy(Date.now()));
}

/** 1.0.41 — the backend answered with a 5xx (gateway / pool exhaustion / statement timeout / Postgres
 *  down): the database is failing even though the network is up. Publish the negative at once and hold
 *  it (see DEGRADED_WINDOW_MS / RECOVERY_SUCCESSES). */
export function markBackendDegraded(): void {
  const now = Date.now();
  generation += 1;
  inFlight = null;
  pruneDegraded(now);
  degradedFailures.push(now);
  healthyStreak = 0;
  publish(false);
}

export type BackendHealth = "online" | "degraded" | "server_off";

/**
 * 1.0.41 — the ONE three-state connectivity truth for the header, POS gates, Sync Center and the sync
 * worker. Synchronous, no I/O. `online` only when the last verdict is positive; `server_off` when the OS
 * is offline, the last negative was a transport drop / failed probe, or SERVER_OFF_FAILURES 5xx landed
 * inside the window; otherwise `degraded`. Every non-`online` state routes new work to local capture
 * exactly like 1.0.40's "unreachable" did.
 */
export function getBackendHealth(): BackendHealth {
  if (navigatorOnLine() === false) return "server_off";
  if (!last || last.value) return "online";
  pruneDegraded(Date.now());
  if (transportDown || degradedFailures.length >= SERVER_OFF_FAILURES) return "server_off";
  return "degraded";
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
  degradedFailures = [];
  healthyStreak = 0;
  transportDown = false;
}

/** Test hook: how many default-path probes the store has actually started since the last reset. */
export function __reachabilityProbeCountForTests(): number {
  return probeCount;
}
