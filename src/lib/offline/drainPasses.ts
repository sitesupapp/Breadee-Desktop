// The fresh-context re-pass orchestrator for the offline reconnect drain.
//
// A drain (sync the offline queue, then re-read the active shift) must always run
// under the SERVER-AUTHORITATIVE context. But the context can change WHILE a drain is
// in flight - an OU switch, a sign-out - and because the underlying sync is
// single-flight (a concurrent trigger no-ops rather than queuing), that second
// context would otherwise never be drained. This runs the drain, then re-reads the
// context; if it changed, it drains ONCE MORE under the new context, converging when
// the context is stable. Bounded, so a context that flaps can never loop forever.
//
// It is a chained re-pass (one pass at a time), NOT a second parallel queue.

export async function runFreshContextPasses<C>(
  // Reads the current server-authoritative context, or null to stop (no tenant/user).
  readContext: () => C | null,
  // A stable key for a context; two contexts with the same key need no re-pass.
  keyOf: (ctx: C) => string,
  // Runs one drain under the given context.
  onPass: (ctx: C) => Promise<void>,
  maxPasses = 3,
): Promise<void> {
  let lastKey: string | null = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    const ctx = readContext();
    if (ctx == null) return; // tenant/user gone - nothing to replay
    const key = keyOf(ctx);
    if (key === lastKey) return; // context stable since the last pass - done
    lastKey = key;
    await onPass(ctx);
  }
}
