// 1.0.41 (BUG 03 RC-A, Server Off F-WORKER) — the ONE application-level sync coordinator.
//
// WHY: through 1.0.40 the only drain listener lived inside the POS workspace and was registered only while
// that screen thought it was online. Settings → Sync Center therefore could not sync anything ("Nothing was
// synced: this terminal is offline, or the POS screen is not open"), and Retry merely re-labelled an op as
// Pending. The drain now belongs to the app: started once after sign-in, independent of which screen is open.
//
// It runs EXACTLY the drain the POS ran — the integration-tested runReconnectDrain sequence under the
// server-authoritative context (rehydrate from offline mode first, security pre-check, fresh tenant / cashier /
// pinned operational branch, re-validated before any post-sync commit), then the work of users PARKED on this
// device under their own sessions. Nothing about WHAT is replayed, under WHICH identity, or the orchestrator's
// single-flight lock changes. Overlapping requests coalesce: callers await the pass in flight, and at most one
// follow-up pass is queued so an operator's "Sync now" always gets a pass that STARTED after the click.
//
// A drain is attempted only when the backend health store says the database answers (reachability.ts): during
// a backend outage nothing is hammered, captured work stays on the device, and the pass runs on recovery.

import { getBackendHealth, isBackendReachable, subscribeReachability } from "@/lib/offline/reachability";
import { onDrainRequested } from "@/lib/offline/operationLog";

export type DrainTrigger = "reconnect" | "backend-returned" | "periodic" | "operator-retry" | "startup";

/** The periodic pass interval (unchanged from the 1.0.38 POS timer). */
export const SYNC_WORKER_PERIOD_MS = 45_000;
/** 1.0.41 (Staging 1.0.52 native QA, D-2) — while the backend is NOT answering, the worker re-asks on this cadence
 *  (the POS badge poll's 20 s), from ANY screen. Through 1.0.52 only the POS screen probed, so after an outage with
 *  the network up, Dashboard / Settings stayed "Breadee server off" and never synced until POS was opened. */
export const SYNC_WORKER_RECOVERY_PROBE_MS = 20_000;

/** The stores and transport, imported LAZILY (they load the Supabase client / Vite env), so this module stays
 *  importable in tests and the worker's own startup never blocks on them. */
async function liveModules() {
  const [{ runReconnectDrain }, { syncPosTxns }, { drainParkedUsers }, { resolveBranchId }, { getDeviceIdentity }, { securityReconnect, useSession }, { useShift }, { useOperationalBranch }, { summarizeOperations }] =
    await Promise.all([
      import("@/lib/offline/reconnectDrain"),
      import("@/lib/offline/posTxnSync"),
      import("@/lib/offline/parkedDrain"),
      import("@/lib/branch"),
      import("@/lib/device"),
      import("@/state/session"),
      import("@/state/shift"),
      import("@/state/operationalBranch"),
      import("@/lib/offline/operationLog"),
    ]);
  return { runReconnectDrain, syncPosTxns, drainParkedUsers, resolveBranchId, getDeviceIdentity, securityReconnect, useSession, useShift, useOperationalBranch, summarizeOperations };
}

/** One full pass: the live user's queue under fresh context, then parked users' queues. */
async function pass(trigger: DrainTrigger): Promise<void> {
  if (!(await isBackendReachable().catch(() => false))) return;
  const { runReconnectDrain, syncPosTxns, drainParkedUsers, resolveBranchId, getDeviceIdentity, securityReconnect, useSession, useShift, useOperationalBranch } =
    await liveModules();
  await runReconnectDrain({
    isOfflineMode: () => useSession.getState().offlineMode,
    // Leave offline mode through the canonical revalidation (adopts the user's own session).
    loadContextOnline: () => useSession.getState().goOnline(),
    readContext: () => {
      const s = useSession.getState();
      const t = s.tenant?.id ?? null;
      const u = s.userId ?? null;
      if (!t || !u) return null;
      // Replay in the SAME operational branch the capture used (1.0.38 C4).
      return { tenantId: t, userId: u, branchId: resolveBranchId(s.tenant, s.membership, useOperationalBranch.getState().getBranch(t, u)) };
    },
    sync: (c) =>
      syncPosTxns(
        { tenantId: c.tenantId, branchId: c.branchId, cashierUserId: c.userId, deviceId: getDeviceIdentity().device_id, terminalId: getDeviceIdentity().terminal_id, online: true },
        trigger === "startup" ? "reconnect" : trigger,
      ).then(() => undefined),
    // Queue displays refresh themselves on OFFLINE_DRAINED_EVENT (dispatched by runReconnectDrain).
    refreshQueue: async () => undefined,
    refreshShift: (c, isCurrent) => useShift.getState().refresh(c.tenantId, c.userId, c.branchId, isCurrent),
    // Device / user standing before replay (bounded; a revocation locks NEW captures only).
    securityCheck: () => securityReconnect(),
  });
  // Then the work captured by users PARKED on this device, each under their own sealed session.
  if (!useSession.getState().offlineMode && (await isBackendReachable().catch(() => false))) {
    await drainParkedUsers(useSession.getState().userId, trigger === "startup" ? "reconnect" : trigger).catch(() => []);
  }
}

let current: Promise<void> | null = null;
let next: Promise<void> | null = null;
let passImpl: (trigger: DrainTrigger) => Promise<void> = pass;

/** Test hook: replace the pass (no network / stores); null restores the real pass. */
export function __setSyncPassForTests(f: ((trigger: DrainTrigger) => Promise<void>) | null): void {
  passImpl = f ?? pass;
}

/**
 * Run (or join) the app drain. Never throws. A request while a pass runs returns ONE queued follow-up pass,
 * shared by every request that arrives meanwhile.
 */
export function appDrain(trigger: DrainTrigger): Promise<void> {
  if (!current) {
    current = passImpl(trigger)
      .catch(() => undefined)
      .finally(() => {
        current = null;
      });
    return current;
  }
  if (!next) {
    next = current.then(() => {
      next = null;
      return appDrain(trigger);
    });
  }
  return next;
}

/**
 * 1.0.41 (D-2) — one recovery step: while the health store is NOT online, ask the shared store again (its
 * DB-touching probe; deduplicated with the POS badge poll; creates nothing). Returns null when online (no probe).
 */
export function recoveryProbe(): Promise<boolean> | null {
  if (getBackendHealth() === "online") return null;
  return isBackendReachable().catch(() => false);
}

let stopFn: (() => void) | null = null;
let periodicBusy = false;

/** Start the worker once (idempotent). Returns the stop function. */
export function startSyncWorker(): () => void {
  if (stopFn) return stopFn;
  // Operator Retry / Sync now (Sync Center, Needs Attention, Settings) — the listener RETURNS the pass, so the
  // caller can await the pass's real outcome. Registered for the whole signed-in session, POS open or not.
  const offRequest = onDrainRequested(() => appDrain("operator-retry"));
  const run = () => {
    void appDrain("reconnect");
  };
  if (typeof window !== "undefined") window.addEventListener("online", run);
  // A backend that comes back while the network never dropped (the 2026-11-07 shape) is seen by the health
  // store, not by the browser's `online` event.
  const offHealth = subscribeReachability((reachable) => {
    if (reachable) void appDrain("backend-returned");
  });
  // Bounded periodic pass, ONLY while healthy and THIS context still holds replayable work. Parked ops alone
  // never trigger it (they wait for a human).
  const tick = async () => {
    if (periodicBusy) return;
    if (getBackendHealth() !== "online") return;
    const { resolveBranchId, getDeviceIdentity, useSession, useOperationalBranch, summarizeOperations } = await liveModules();
    const s = useSession.getState();
    const t = s.tenant?.id ?? null;
    const u = s.userId ?? null;
    if (!t || !u) return;
    periodicBusy = true;
    try {
      const dev = getDeviceIdentity();
      const sum = await summarizeOperations(
        { tenantId: t, branchId: resolveBranchId(s.tenant, s.membership, useOperationalBranch.getState().getBranch(t, u)), cashierUserId: u, deviceId: dev.device_id, terminalId: dev.terminal_id },
        { includeSynced: false },
      );
      if (sum.pending + sum.syncing + sum.retryable + sum.waiting_dependency + sum.legacy_pending > 0) {
        await appDrain("periodic");
      }
    } catch {
      /* best-effort; the next tick retries */
    } finally {
      periodicBusy = false;
    }
  };
  const id = typeof window !== "undefined" ? window.setInterval(() => void tick(), 45_000) : null;
  // D-2 — recovery probe while NOT online (see recoveryProbe). A healthy answer publishes through the store, and
  // offHealth above starts the drain.
  const recovery = typeof window !== "undefined" ? window.setInterval(() => void recoveryProbe(), SYNC_WORKER_RECOVERY_PROBE_MS) : null;
  // Startup: replay whatever a previous session left, as soon as the database answers.
  void appDrain("startup");
  stopFn = () => {
    offRequest();
    offHealth();
    if (typeof window !== "undefined") window.removeEventListener("online", run);
    if (id !== null) window.clearInterval(id);
    if (recovery !== null) window.clearInterval(recovery);
    stopFn = null;
  };
  return stopFn;
}

/** Test hook: is a worker running? */
export function __syncWorkerRunningForTests(): boolean {
  return stopFn !== null;
}
