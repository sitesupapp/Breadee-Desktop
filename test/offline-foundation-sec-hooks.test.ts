// Final Foundation (INT) — the two SEC hooks wired into the POS shell:
//   (a) a bounded device / user standing check (session.securityReconnect) BEFORE each
//       reconnect / periodic drain, which never blocks or aborts the drain;
//   (b) the capture-lock banner (CAPTURE_LOCK_MESSAGE[captureLock]) in the POS shell.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runReconnectDrain, runSecurityPrecheck, SECURITY_PRECHECK_TIMEOUT_MS, type DrainContext } from "@/lib/offline/reconnectDrain";
import { applyCaptureLock, CAPTURE_LOCK_MESSAGE, type CaptureLockReason } from "@/lib/security/captureLock";

const CTX: DrainContext = { tenantId: "t1", userId: "u1", branchId: "b1" };
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function deps(log: string[], securityCheck?: () => Promise<void>, offline = false) {
  return {
    isOfflineMode: () => offline,
    loadContextOnline: async () => {
      log.push("rehydrate");
    },
    readContext: () => CTX,
    sync: async () => {
      log.push("sync");
    },
    refreshQueue: async () => {
      log.push("queue");
    },
    refreshShift: async () => {
      log.push("shift");
    },
    securityCheck,
  };
}

test("security check runs before replay (and after offline rehydration)", async () => {
  const log: string[] = [];
  await runReconnectDrain(deps(log, async () => void log.push("security"), true));
  assert.deepEqual(log, ["rehydrate", "security", "sync", "queue", "shift"]);
});

test("a FAILING security check never blocks the drain", async () => {
  const log: string[] = [];
  await runReconnectDrain(deps(log, async () => {
    log.push("security");
    throw new Error("network down");
  }));
  assert.deepEqual(log, ["security", "sync", "queue", "shift"]);
});

test("revocation reported by the check locks NEW captures but already-captured work still drains", async () => {
  const log: string[] = [];
  let lock: CaptureLockReason | null = null;
  await runReconnectDrain(deps(log, async () => {
    lock = "device_revoked";
  }));
  assert.equal(lock, "device_revoked");
  assert.ok(log.includes("sync"), "replay of captured work is server-authoritative, not skipped locally");
  const perms = applyCaptureLock({ "pos.access": true, "pos.create_order": true, "pos.view_orders": true }, lock);
  assert.equal(perms["pos.create_order"], false);
  assert.equal(perms["pos.view_orders"], true);
});

test("a HANGING security check is bounded by the timeout", async () => {
  const t0 = Date.now();
  await runSecurityPrecheck(() => new Promise<void>(() => undefined), 30);
  assert.ok(Date.now() - t0 < 2_000);
  assert.ok(SECURITY_PRECHECK_TIMEOUT_MS > 0 && SECURITY_PRECHECK_TIMEOUT_MS <= 15_000);
  await runSecurityPrecheck(undefined); // absent hook = no-op
});

test("every capture-lock reason has a user-facing message", () => {
  const reasons: CaptureLockReason[] = ["clock_rollback", "entitlement_expired", "entitlement_invalid", "device_revoked", "access_revoked"];
  for (const r of reasons) assert.ok(CAPTURE_LOCK_MESSAGE[r] && CAPTURE_LOCK_MESSAGE[r].length > 20, r);
});

test("PosWorkspace wires securityReconnect into the shared drain and renders the capture-lock banner", () => {
  const pos = src("src/screens/pos/PosWorkspace.tsx");
  assert.match(pos, /import \{ securityReconnect, useSession \} from "@\/state\/session"/);
  assert.match(pos, /securityCheck: \(\) => securityReconnect\(\)/);
  assert.match(pos, /session\.captureLock && \(/);
  assert.match(pos, /CAPTURE_LOCK_MESSAGE\[session\.captureLock\]/);
  // Exactly one drain path carries the hook (no second drain / queue).
  assert.equal((pos.match(/runReconnectDrain\(/g) ?? []).length, 1);
});
