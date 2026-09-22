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

async function healthUrl(): Promise<string> {
  // Lazy import so this module stays loadable without build-time env (tests).
  const { env } = await import("@/env");
  return `${env.SUPABASE_URL}/auth/v1/health`;
}

export async function isBackendReachable(deps: ReachabilityDeps = {}): Promise<boolean> {
  const timeoutMs = deps.timeoutMs ?? 2500;
  const onLine = deps.onLine ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine));
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
