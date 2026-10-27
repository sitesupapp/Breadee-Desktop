// 1.0.38 PERF (Track 8) — the "network-off sentinel".
//
// Records every attempt to reach the network from code under test:
//  - `globalThis.fetch` is replaced by a recorder that throws TypeError("Failed to fetch") (what the
//    WebView raises offline);
//  - "@/lib/supabase" resolves (through test/support/sentinel-hook.mjs) to a Proxy client whose every
//    .from/.rpc/.schema call and .auth/.storage/.functions/.realtime/.channel member records and
//    rejects with the same TypeError.
// The recorder is module state here; the stub imports this module, so both share one instance.

import { register } from "node:module";

export type NetCall = { api: string; name: string; stack: string };

const calls: NetCall[] = [];

export function recordNet(api: string, name: string): void {
  calls.push({ api, name, stack: new Error().stack ?? "" });
}

export function netCalls(): NetCall[] {
  return calls.slice();
}

export function resetNet(): void {
  calls.length = 0;
}

let hookRegistered = false;
/** Register the stub-redirecting loader hook. Must run BEFORE the modules under test are imported. */
export function registerSentinelHook(): void {
  if (hookRegistered) return;
  hookRegistered = true;
  register("./sentinel-hook.mjs", import.meta.url);
}

/** Replace globalThis.fetch with the recording, always-failing one. */
export function installFetchSentinel(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    recordNet("fetch", typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
}

/** Run `fn` and return what it produced plus every network attempt it made that is not allow-listed. */
export async function expectNoNetwork<T>(fn: () => Promise<T>, allow: string[] = []): Promise<{ result: T | undefined; error: unknown; calls: NetCall[] }> {
  resetNet();
  let result: T | undefined;
  let error: unknown = null;
  try {
    result = await fn();
  } catch (e) {
    error = e;
  }
  // Let fire-and-forget work scheduled by the action (write-throughs, prewarms) run and be recorded too.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const offending = netCalls().filter((c) => !allow.some((a) => `${c.api}:${c.name}`.includes(a)));
  return { result, error, calls: offending };
}

function failing(): Promise<never> {
  return Promise.reject(new TypeError("Failed to fetch"));
}

/** A chainable, awaitable stand-in for a PostgREST builder: every member chains, awaiting rejects. */
export function rejectingChain(): unknown {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return (res?: (v: never) => unknown, rej?: (e: unknown) => unknown) => failing().then(res, rej);
      if (prop === "catch") return (rej?: (e: unknown) => unknown) => failing().catch(rej);
      if (prop === "finally") return (f?: () => void) => failing().finally(f);
      return rejectingChain();
    },
    apply() {
      return rejectingChain();
    },
  });
}

/** A namespace (auth / storage / functions / realtime): every member access is a recorded network attempt. */
export function recordingNamespace(api: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        const name = String(prop);
        if (name === "then") return undefined;
        return (...args: unknown[]) => {
          recordNet(api, name);
          // Listener registration returns the shape callers destructure (no request is implied).
          if (name === "onAuthStateChange") return { data: { subscription: { unsubscribe() {} } } };
          void args;
          return rejectingChain();
        };
      },
    },
  );
}
