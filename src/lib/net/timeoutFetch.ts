// The Supabase client's transport: `fetch` with a read timeout.
//
// WHY: supabase-js has no request timeout. On a half-open link (Wi-Fi dropped but
// the socket not yet torn down) any awaited `.from(...)` / read `.rpc(...)` can hang
// indefinitely - POS boot, a reprint, a delivery queue refresh all waited on it.
// The orchestrator only bounds its own REPLAY wait (45 s watchdog).
//
// POLICY (1.0.38 PERF):
//  - READS (GET/HEAD, and POST /rest/v1/rpc/<name> for the allow-listed read-only
//    RPCs below) abort after READ_TIMEOUT_MS. A read is side-effect free, so an
//    abort is always safe; PostgREST surfaces it as `{ error }` and every caller
//    already treats that as "unreadable" (cache / last-good fallback).
//  - EVERYTHING ELSE (mutating POST/PATCH/PUT/DELETE, every other RPC, auth token
//    refresh, storage upload) gets NO added timeout. Aborting a write client-side
//    does not stop it server-side; it would only turn a slow success into an
//    ambiguous failure. Replay ambiguity is already owned by the orchestrator's 45 s
//    watchdog + client_op_id exactly-once contracts, and the online paths keep
//    their 1.0.37 behaviour. A shorter ceiling than the replay watchdog on POST
//    /rpc is never applied.
//  - A caller-provided `signal` is always honoured (composed with the timeout).
//  - Evidence feeds the shared reachability store: any answer marks the backend
//    reachable; a transport rejection (TypeError "Failed to fetch") marks it
//    unreachable; our own read timeout only invalidates it (re-probe next time).

import { invalidateReachability, markBackendReachable, markBackendUnreachable } from "@/lib/offline/reachability";

/** Ceiling for a single read request (headers received). */
export const READ_TIMEOUT_MS = 15_000;

/** RPCs that are pure reads (POST only because PostgREST requires it for RPC). Keep this list small and verified. */
export const READ_ONLY_RPCS: ReadonlySet<string> = new Set([
  "resolve_print_route",
  "get_tenant_effective_features",
  "current_user_permissions",
  // Offline-first recovery — every remaining POS READ the desktop calls. Verified on staging
  // (2026-10-27): each is declared STABLE (PostgreSQL forbids writes in a STABLE function), so an abort
  // can never leave a half-applied effect. Without a ceiling these hung indefinitely on a half-open
  // link (menu / floor / table-map skeletons, the End Shift dialog, payout list).
  "pos_menu",
  "pos_table_map",
  "floor_service_layout",
  "floor_history",
  "floor_unplaced_tables",
  "pos_shift_expected",
  "pos_cash_box_shift",
  "pos_payout_list",
  "pos_split_state",
  "pos_shift_unresolved_orders",
  "pos_end_shift_approval_required",
  "pos_transfer_force_enabled",
  "delivery_providers_operational",
  "pos_order_item_map",
  "pos_delivery_report",
  "pos_analytics_summary",
  "pos_deletion_reason_report",
  "pos_order_transfers_for_recipient",
  "pos_order_transfers_list",
  "pos_order_transfer_detail",
  "pos_order_transfer_eligible_recipients",
  "pos_force_end_eligible_recipients",
  "pos_shifts_list",
  "pos_payment_methods_manage_list",
  "desktop_device_status",
]);

/** Offline-first recovery — ceiling for the auth TOKEN endpoint (sign-in / refresh). supabase-js holds its
 *  auth lock across a refresh and every PostgREST call awaits that lock, so an unbounded refresh on a
 *  half-open link stalled every read behind it. A refresh is safe to bound: supabase-js retries a
 *  transport failure, and the server's refresh-token reuse window covers a lost response. */
export const AUTH_TOKEN_TIMEOUT_MS = 20_000;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const m = init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : undefined);
  return (m ?? "GET").toUpperCase();
}

/** The read timeout this request gets, or null for none (mutations). Pure; exported for tests. */
export function requestTimeoutMs(method: string, url: string): number | null {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return READ_TIMEOUT_MS;
  if (m === "POST") {
    const match = /\/rest\/v1\/rpc\/([A-Za-z0-9_]+)(?:[/?#]|$)/.exec(url);
    if (match && READ_ONLY_RPCS.has(match[1])) return READ_TIMEOUT_MS;
    if (/\/auth\/v1\/token(?:[?#]|$)/.test(url)) return AUTH_TOKEN_TIMEOUT_MS;
  }
  return null;
}

/** Same as `timeoutFetch` but over an injectable base fetch and timeout policy (tests). */
export function createTimeoutFetch(base: () => typeof fetch, policy: typeof requestTimeoutMs = requestTimeoutMs): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const f = base();
    const timeoutMs = policy(requestMethod(input, init), requestUrl(input));
    const callerSignal = init?.signal ?? (typeof input === "object" && !(input instanceof URL) ? input.signal : undefined) ?? undefined;
    if (timeoutMs == null) {
      try {
        const res = await f(input, init);
        markBackendReachable();
        return res;
      } catch (e) {
        if (!callerSignal?.aborted && e instanceof TypeError) markBackendUnreachable();
        throw e;
      }
    }
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(`Request timed out after ${timeoutMs} ms`, "TimeoutError"));
    }, timeoutMs);
    try {
      const res = await f(input, { ...init, signal: controller.signal });
      markBackendReachable();
      return res;
    } catch (e) {
      if (timedOut) invalidateReachability();
      else if (!callerSignal?.aborted && e instanceof TypeError) markBackendUnreachable();
      throw e;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };
}

/** The Supabase client's `global.fetch`. Resolves `globalThis.fetch` per call (never captured at import). */
export const timeoutFetch: typeof fetch = createTimeoutFetch(() => globalThis.fetch.bind(globalThis));
