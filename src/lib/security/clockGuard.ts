// Final Foundation - clock-rollback guard. PURE (state in, state out); persistence is
// the caller's job (sealed "time-guard" secret, see deviceAuthority.ts).
//
// The rule:  effective now = max(local now, last local time this device has seen)
//            + max(0, server offset learned at the last trusted server contact).
// So winding the Windows clock back can never make an entitlement younger, and a till
// whose clock runs BEHIND the server cannot stretch its 7 days either. A local reading
// more than ROLLBACK_TOLERANCE_MS earlier than the last one seen is a ROLLBACK: new
// financial captures lock until an online re-authorization resets the baseline from
// server time. Nothing is ever deleted because of it.

export const ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;

export type TimeGuardState = {
  v: 1;
  /** Highest local wall-clock reading observed (ms). */
  lastSeenLocalMs: number;
  /** server_time - local_time at the last trusted server contact (ms); 0 if never. */
  serverOffsetMs: number;
  /** Server time of the last trusted contact (ms), null if never. */
  lastTrustedServerMs: number | null;
  /** Monotonic counter, bumped on every device-signed entitlement request. */
  counter: number;
  /** First local reading at which a rollback was detected; null when clear. */
  rollbackAtMs: number | null;
  /** Local time the current entitlement was received (ms), null if none. */
  entitlementReceivedAtMs: number | null;
};

export function freshTimeGuard(nowMs: number): TimeGuardState {
  return { v: 1, lastSeenLocalMs: nowMs, serverOffsetMs: 0, lastTrustedServerMs: null, counter: 0, rollbackAtMs: null, entitlementReceivedAtMs: null };
}

const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);

/** Parse a persisted state; anything unreadable becomes a fresh state AT `nowMs`. */
export function parseTimeGuard(raw: string | null, nowMs: number): TimeGuardState {
  if (!raw) return freshTimeGuard(nowMs);
  try {
    const o = JSON.parse(raw) as Partial<TimeGuardState>;
    if (o.v !== 1) return freshTimeGuard(nowMs);
    return {
      v: 1,
      lastSeenLocalMs: num(o.lastSeenLocalMs, nowMs),
      serverOffsetMs: num(o.serverOffsetMs, 0),
      lastTrustedServerMs: o.lastTrustedServerMs == null ? null : num(o.lastTrustedServerMs, 0),
      counter: Math.max(0, Math.floor(num(o.counter, 0))),
      rollbackAtMs: o.rollbackAtMs == null ? null : num(o.rollbackAtMs, nowMs),
      entitlementReceivedAtMs: o.entitlementReceivedAtMs == null ? null : num(o.entitlementReceivedAtMs, 0),
    };
  } catch {
    return freshTimeGuard(nowMs);
  }
}

export type ClockObservation = { state: TimeGuardState; effectiveNowMs: number; rollback: boolean };

/** Observe the local clock. A detected rollback is sticky until `trustServerTime`. */
export function observeClock(prev: TimeGuardState, nowMs: number): ClockObservation {
  const wentBack = nowMs < prev.lastSeenLocalMs - ROLLBACK_TOLERANCE_MS;
  const state: TimeGuardState = {
    ...prev,
    lastSeenLocalMs: Math.max(prev.lastSeenLocalMs, nowMs),
    rollbackAtMs: prev.rollbackAtMs ?? (wentBack ? nowMs : null),
  };
  return {
    state,
    effectiveNowMs: Math.max(nowMs, prev.lastSeenLocalMs) + Math.max(0, state.serverOffsetMs),
    rollback: state.rollbackAtMs !== null,
  };
}

/** An authenticated server contact (entitlement issuance): reset the baseline. */
export function trustServerTime(prev: TimeGuardState, serverMs: number, nowMs: number): TimeGuardState {
  return {
    ...prev,
    lastSeenLocalMs: nowMs,
    serverOffsetMs: serverMs - nowMs,
    lastTrustedServerMs: serverMs,
    rollbackAtMs: null,
  };
}
