// A monotonic "latest wins" gate for overlapping async operations.
//
// Some async flows can be re-invoked (a new branch/OU, a reconnect) before an
// in-flight run resolves. Without a guard, an OLDER run that finishes LATE can
// overwrite the state a NEWER run already committed - e.g. an old-OU shift refresh
// restoring its (now stale) pending shift over the current OU's authoritative result.
//
// Each run calls claim() to take the next generation; isStale() for that run becomes
// true the instant a newer claim() is made, so a late older run can detect it was
// superseded and skip its commit. Single-threaded JS guarantees claim() is atomic.
export type LatestClaim = { isStale: () => boolean };

export function createLatestGate(): { claim: () => LatestClaim; invalidate: () => void } {
  let seq = 0;
  return {
    claim() {
      const gen = ++seq;
      return { isStale: () => seq !== gen };
    },
    // Mark every outstanding claim stale WITHOUT handing out a new live one. Used on a
    // hard reset (sign-out): an in-flight operation that claimed before this must not
    // repopulate state after the reset, and nothing new is "latest" until the next claim.
    invalidate() {
      seq++;
    },
  };
}
