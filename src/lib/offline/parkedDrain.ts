// Offline-first recovery — replay a PARKED user's captured work under THAT user's own identity.
//
// A cashier who switches user while offline leaves operations scoped to them (tenant / OU / cashier /
// device / terminal). The drain only ever replays under the identity that captured the work — the
// server checks auth.uid() against the cashier — so through 1.0.38 those operations waited until the
// same cashier signed in again on this device. Now, on reconnect, every parked user with unsynced work
// and a parked session gets their own pass: a SEPARATE Supabase client carrying ONLY their sealed
// session (never the active user's), the same single orchestrator, the same exactly-once contracts
// (client_op_id, entity map, dependencies). A rotated token is written back to their vault record.
//
// It never touches the active user's session, never changes what is on screen, and never runs while
// the backend is unreachable. A parked user whose sign-in the server no longer accepts simply keeps
// their work queued (and their vault session is dropped), exactly like an expired active session.

import { createReplayClient } from "@/lib/supabase";
import { getDeviceIdentity } from "@/lib/device";
import { localdb } from "@/lib/offline/db";
import { drainOperations } from "@/lib/offline/orchestrator";
import { makePosTxnSyncDeps, type ReplayClient } from "@/lib/offline/posTxnSync";
import { getVaultUser, parkedUsersWithSession, updateParkedSession, type VaultUser } from "@/lib/security/offlineVault";

const SETTLED = new Set(["synced", "cancelled", "needs_attention"]);

export type ParkedDrainResult = { userId: string; passes: number; drained: number };

function clientFor(u: VaultUser): ReplayClient {
  let session: string | null = u.parkedSession;
  const storage = {
    getItem: async () => session,
    setItem: async (_k: string, v: string) => {
      session = v;
      await updateParkedSession(u.userId, v);
    },
    removeItem: async () => {
      session = null;
      await updateParkedSession(u.userId, null);
    },
  };
  return createReplayClient(`breadee-desktop-replay-${u.userId}`, storage) as unknown as ReplayClient;
}

/** Replay every parked user's unsynced work on this device, one user / OU at a time. */
export async function drainParkedUsers(activeUserId: string | null, trigger: string): Promise<ParkedDrainResult[]> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return [];
  const users = await parkedUsersWithSession(activeUserId).catch(() => [] as VaultUser[]);
  if (users.length === 0) return [];
  const dev = getDeviceIdentity();
  const ops = await localdb.operations.toArray();
  const out: ParkedDrainResult[] = [];
  for (const u of users) {
    const mine = ops.filter((o) => o.scope.cashier_user_id === u.userId && o.scope.device_id === dev.device_id && !SETTLED.has(o.status));
    if (mine.length === 0) continue;
    const client = clientFor(u);
    const scopes = new Map<string, { tenantId: string; branchId: string | null }>();
    for (const o of mine) scopes.set(`${o.scope.tenant_id}|${o.scope.branch_id ?? ""}`, { tenantId: o.scope.tenant_id, branchId: o.scope.branch_id ?? null });
    const result: ParkedDrainResult = { userId: u.userId, passes: 0, drained: 0 };
    for (const s of scopes.values()) {
      // The user may have signed in meanwhile (unparked): their own live drain owns their work now.
      const still = await getVaultUser(u.userId).catch(() => null);
      if (!still?.parkedSession) break;
      const report = await drainOperations(
        { tenantId: s.tenantId, branchId: s.branchId, cashierUserId: u.userId, deviceId: dev.device_id, terminalId: dev.terminal_id, online: true },
        `parked-user:${trigger}`,
        makePosTxnSyncDeps(client),
      ).catch(() => null);
      result.passes += 1;
      result.drained += report?.drained.length ?? 0;
    }
    out.push(result);
  }
  return out;
}
