// The reconnect offline-drain sequence, extracted from the POS workspace so the
// exact ordering can be integration-tested against the real shift store.
//
// A drain must run entirely under the SERVER-AUTHORITATIVE context. Two things can
// move that context WHILE a drain is in flight:
//   * an OU switch / sign-out that lands between the sync and the post-sync refresh;
//   * a concurrent drain that no-ops on the single-flight lock, leaving this one to
//     finish under what is now a stale context.
// So after the (awaited) sync, and BEFORE committing any post-sync state, we re-read
// the live context and compare it to the pass's context. If it changed, we skip the
// stale refresh entirely and let runFreshContextPasses re-pass under the new context.
// Ordering by claim generation alone is not enough: a late drain's refresh would be
// the newest claim and would commit the stale OU until the re-pass corrects it.

import { runFreshContextPasses } from "@/lib/offline/drainPasses";

export type DrainContext = { tenantId: string; userId: string; branchId: string | null };

export const drainContextKey = (c: DrainContext): string => `${c.tenantId}|${c.userId}|${c.branchId}`;

export type ReconnectDrainDeps = {
  /** True while the session is in offline mode and must be rehydrated before replay. */
  isOfflineMode: () => boolean;
  /** Leave offline mode / re-read the server-authoritative session. May reject. */
  loadContextOnline: () => Promise<void>;
  /** The current server-authoritative context, or null (no tenant/user → stop). */
  readContext: () => DrainContext | null;
  /** Replay the offline queue under this exact context. */
  sync: (ctx: DrainContext) => Promise<void>;
  /**
   * Refresh the offline-queue display for this exact context. `isCurrent` is a live
   * guard the callback MUST re-check after its own async reads and before committing
   * any UI state, so a context that moved mid-read never paints this OU's queue.
   */
  refreshQueue: (ctx: DrainContext, isCurrent: () => boolean) => Promise<void>;
  /**
   * Re-read the active shift for this exact context. `isCurrent` is forwarded so the
   * shift commit is gated on the live context at the moment it would commit, not only
   * on invocation order.
   */
  refreshShift: (ctx: DrainContext, isCurrent: () => boolean) => Promise<void>;
};

export async function runReconnectDrain(d: ReconnectDrainDeps): Promise<void> {
  if (d.isOfflineMode()) {
    try {
      await d.loadContextOnline();
    } catch {
      return; // a failed authoritative refresh must NOT replay under stale context
    }
  }
  await runFreshContextPasses(
    () => d.readContext(),
    drainContextKey,
    async (c) => {
      await d.sync(c).catch(() => {});
      // A live-context predicate re-evaluated at EVERY commit boundary, not once: the
      // context can move during the sync OR during either post-sync refresh. Each
      // commit step re-checks isCurrent() after its own async work, so a pass whose
      // OU changed mid-step never commits this (now stale) OU's queue or shift; the
      // loop then re-passes under the new context.
      const isCurrent = () => {
        const live = d.readContext();
        return !!live && drainContextKey(live) === drainContextKey(c);
      };
      if (!isCurrent()) return;
      await d.refreshQueue(c, isCurrent);
      if (!isCurrent()) return;
      await d.refreshShift(c, isCurrent);
    },
  );
}
