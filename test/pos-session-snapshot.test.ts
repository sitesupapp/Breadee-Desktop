// Restart-offline blocker (B1 real-world fix 3): a cashier who had a validated
// open shift before an outage must come back to the SAME branch + open shift
// after an offline restart, never "Branch unavailable / No open shift" — and the
// terminal must NEVER fabricate a shift, widen a branch, or restore another
// context's session. These tests exercise the durable POS-session snapshot
// directly (a pure localStorage module) and pin the wiring by reading source.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { stripComments, stripJsxComments } from "./source-helpers.ts";
import {
  savePosSessionSnapshot,
  readPosSessionSnapshot,
  clearPosSessionSnapshot,
  snapshotMatchesIdentity,
  restoreShiftFromSnapshot,
  restoreBranchNameFromSnapshot,
  isPersistableBranchName,
  type PosSessionSnapshot,
} from "@/lib/offline/posSession";

// Minimal in-memory localStorage — node has none; the module only ever touches it
// through its own try/catch, so a plain Map-backed shim is faithful.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (...p: string[]) => readFileSync(join(srcRoot, ...p), "utf8");

const DEV = "dev-1";
const TENANT = "tenant-1";
const CASHIER = "cashier-1";
const BRANCH = "branch-1";
const SHIFT = "shift-1";

function makeSnapshot(over: Partial<PosSessionSnapshot> = {}): PosSessionSnapshot {
  return {
    version: 1,
    source: "server",
    savedAt: Date.now(),
    device_id: DEV,
    tenant_id: TENANT,
    cashier_user_id: CASHIER,
    branch_id: BRANCH,
    branch_name: "Main",
    currency: "USD",
    shift: { id: SHIFT, status: "open", opened_at: "2026-09-19T09:00:00Z", opening_cash_amount: 100, branch_id: BRANCH },
    ...over,
  };
}

const IDENTITY = { deviceId: DEV, tenantId: TENANT, cashierUserId: CASHIER };

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage.clear();
});

// ---------------------------------------------------------------------------
// 1. An online, server-confirmed context is stored.
// ---------------------------------------------------------------------------
test("stores a snapshot from authoritative online state and reads it back", () => {
  savePosSessionSnapshot(makeSnapshot());
  const s = readPosSessionSnapshot();
  assert.ok(s, "snapshot persisted");
  assert.equal(s?.source, "server", "provenance is server-only");
  assert.equal(s?.shift.id, SHIFT);
  assert.equal(s?.branch_name, "Main");
});

// ---------------------------------------------------------------------------
// 2. After an offline restart the branch NAME is restored (id is separate).
// ---------------------------------------------------------------------------
test("restores the branch name offline for the same device+tenant+branch", () => {
  savePosSessionSnapshot(makeSnapshot());
  const name = restoreBranchNameFromSnapshot(readPosSessionSnapshot(), { branchId: BRANCH, tenantId: TENANT, deviceId: DEV });
  assert.equal(name, "Main");
});

// ---------------------------------------------------------------------------
// 3. After an offline restart the SAME open shift is restored.
// ---------------------------------------------------------------------------
test("restores the same open shift id offline", () => {
  savePosSessionSnapshot(makeSnapshot());
  const shift = restoreShiftFromSnapshot(readPosSessionSnapshot(), IDENTITY);
  assert.ok(shift, "shift restored");
  assert.equal(shift?.id, SHIFT, "same shift id, never a new one");
  assert.equal(shift?.status, "open");
});

// ---------------------------------------------------------------------------
// 4. Identity is preserved: tenant, user, branch, shift all round-trip.
// ---------------------------------------------------------------------------
test("preserves tenant, cashier, branch and shift exactly", () => {
  savePosSessionSnapshot(makeSnapshot());
  const s = readPosSessionSnapshot();
  assert.equal(s?.tenant_id, TENANT);
  assert.equal(s?.cashier_user_id, CASHIER);
  assert.equal(s?.branch_id, BRANCH);
  assert.equal(s?.shift.branch_id, BRANCH);
  assert.equal(s?.shift.opening_cash_amount, 100);
});

// ---------------------------------------------------------------------------
// 5. No valid branch snapshot -> the honest "Branch unavailable" fallback (null).
// ---------------------------------------------------------------------------
test("no snapshot -> branch name falls back (null, so caller shows 'Branch unavailable')", () => {
  assert.equal(restoreBranchNameFromSnapshot(null, { branchId: BRANCH, tenantId: TENANT, deviceId: DEV }), null);
  // A resolved id with no snapshot still yields null.
  assert.equal(readPosSessionSnapshot(), null);
});

// ---------------------------------------------------------------------------
// 6. No valid shift snapshot -> cannot fabricate a shift.
// ---------------------------------------------------------------------------
test("no snapshot -> shift restore is null (never fabricated)", () => {
  assert.equal(restoreShiftFromSnapshot(null, IDENTITY), null);
  assert.equal(restoreShiftFromSnapshot(readPosSessionSnapshot(), IDENTITY), null);
});

test("a non-open shift is never persisted and never restored", () => {
  // A closed/ended shift must not round-trip as if it were operable.
  savePosSessionSnapshot(makeSnapshot({ shift: { id: SHIFT, status: "open", opened_at: null, opening_cash_amount: 0, branch_id: BRANCH } }));
  // Tamper the stored value to a closed status and confirm the reader rejects it.
  (globalThis as unknown as { localStorage: MemStorage }).localStorage.setItem(
    "breadee-desktop-pos-session",
    JSON.stringify({ ...makeSnapshot(), shift: { id: SHIFT, status: "ended_by_cashier", opened_at: null, opening_cash_amount: 0, branch_id: BRANCH } }),
  );
  assert.equal(readPosSessionSnapshot(), null, "a non-open shift is not a valid snapshot");
});

// ---------------------------------------------------------------------------
// 7. A different tenant / user / device is rejected — never cross-context.
// ---------------------------------------------------------------------------
test("rejects a snapshot from a different tenant, cashier, or device", () => {
  savePosSessionSnapshot(makeSnapshot());
  const snap = readPosSessionSnapshot();
  assert.equal(restoreShiftFromSnapshot(snap, { deviceId: DEV, tenantId: "other-tenant", cashierUserId: CASHIER }), null);
  assert.equal(restoreShiftFromSnapshot(snap, { deviceId: DEV, tenantId: TENANT, cashierUserId: "other-cashier" }), null);
  assert.equal(restoreShiftFromSnapshot(snap, { deviceId: "other-device", tenantId: TENANT, cashierUserId: CASHIER }), null);
  assert.equal(snapshotMatchesIdentity(snap as PosSessionSnapshot, { deviceId: DEV, tenantId: null, cashierUserId: CASHIER }), false, "no identity, no restore");
  // The branch name is equally scoped.
  assert.equal(restoreBranchNameFromSnapshot(snap, { branchId: BRANCH, tenantId: "other-tenant", deviceId: DEV }), null);
  assert.equal(restoreBranchNameFromSnapshot(snap, { branchId: "other-branch", tenantId: TENANT, deviceId: DEV }), null);
});

// ---------------------------------------------------------------------------
// 8. UNKNOWN_BRANCH is never persisted and never restored.
// ---------------------------------------------------------------------------
test("UNKNOWN_BRANCH / unresolved branch is never persisted or restored", () => {
  assert.equal(isPersistableBranchName("Branch unavailable"), false);
  assert.equal(isPersistableBranchName("No branch"), false);
  assert.equal(isPersistableBranchName("Unnamed branch"), false);
  assert.equal(isPersistableBranchName(""), false);
  assert.equal(isPersistableBranchName("Main"), true);

  // A null branch id is refused by the writer.
  savePosSessionSnapshot(makeSnapshot({ branch_id: null }));
  assert.equal(readPosSessionSnapshot(), null, "null branch id is not persisted");

  // A placeholder branch name is refused by the writer.
  savePosSessionSnapshot(makeSnapshot({ branch_name: "Branch unavailable" }));
  assert.equal(readPosSessionSnapshot(), null, "placeholder branch name is not persisted");

  // And a resolved id of null never restores a name.
  savePosSessionSnapshot(makeSnapshot());
  assert.equal(restoreBranchNameFromSnapshot(readPosSessionSnapshot(), { branchId: null, tenantId: TENANT, deviceId: DEV }), null);
});

// ---------------------------------------------------------------------------
// Provenance + expiry + sign-out hygiene.
// ---------------------------------------------------------------------------
test("only server-provenance snapshots are accepted", () => {
  savePosSessionSnapshot({ ...makeSnapshot(), source: "server" });
  assert.ok(readPosSessionSnapshot(), "server snapshot kept");
  // A hand-forged non-server snapshot is rejected on both write and read.
  (globalThis as unknown as { localStorage: MemStorage }).localStorage.setItem(
    "breadee-desktop-pos-session",
    JSON.stringify({ ...makeSnapshot(), source: "client" }),
  );
  assert.equal(readPosSessionSnapshot(), null, "non-server provenance is not trusted");
});

test("an expired snapshot (older than the 7-day TTL) is not restored", () => {
  const eightDays = 8 * 24 * 60 * 60 * 1000;
  savePosSessionSnapshot(makeSnapshot({ savedAt: Date.now() - eightDays }));
  assert.equal(readPosSessionSnapshot(), null, "stale snapshot forces a fresh online read");
});

test("clear removes the snapshot", () => {
  savePosSessionSnapshot(makeSnapshot());
  assert.ok(readPosSessionSnapshot());
  clearPosSessionSnapshot();
  assert.equal(readPosSessionSnapshot(), null);
});

// ---------------------------------------------------------------------------
// Source contracts — the wiring the behavioural tests cannot see.
// ---------------------------------------------------------------------------
test("shift store: offline refresh restores the snapshot; a live 'no shift' clears it", () => {
  const src = stripComments(read("state", "shift.ts"));
  // The catch (offline) path restores from the durable snapshot for THIS identity.
  assert.match(src, /catch[\s\S]*restoreShiftFromSnapshot\(readPosSessionSnapshot\(\)/, "offline refresh restores from snapshot");
  assert.match(src, /deviceId: getDeviceIdentity\(\)\.device_id/, "restore is device-scoped");
  assert.match(src, /offlineRestored: true/, "an offline-restored shift is flagged, not passed off as live");
  // A live read that finds NO open shift drops any stale snapshot (never restore a closed shift).
  assert.match(src, /clearPosSessionSnapshot\(\)/, "server 'no shift' / close clears the snapshot");
  assert.match(src, /offlineRestored: false/, "a successful live read clears the offline flag");
});

test("branch resolver: offline name falls back to the snapshot, never widening access", () => {
  const src = stripComments(read("lib", "branch.ts"));
  assert.match(src, /restoreBranchNameFromSnapshot\(readPosSessionSnapshot\(\)/, "offline branch name from snapshot");
  assert.match(src, /name: cached \?\? "Branch unavailable"/, "honest fallback when no snapshot applies");
  // The id is still the pure resolver's — the snapshot only supplies a label.
  assert.match(src, /export function resolveBranchId/, "branch id remains resolved from tenant/membership, not the snapshot");
});

test("PosWorkspace: the ONLY snapshot writer runs online with a server-confirmed open shift + named branch", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /savePosSessionSnapshot\(\{/, "writer present");
  const w = src.slice(src.indexOf("savePosSessionSnapshot({") - 400, src.indexOf("savePosSessionSnapshot({"));
  assert.match(w, /if \(!online\) return;/, "never writes while offline");
  assert.match(w, /shift\.status !== "open"/, "only a server-confirmed OPEN shift is persisted");
  assert.match(w, /isPersistableBranchName\(pos\.branch\.name\)/, "never persists an unresolved branch");
  assert.match(src, /source: "server"/, "snapshot is stamped server-provenance");
});

test("PosWorkspace: the Online badge is qualified by backend reachability, not navigator.onLine alone", () => {
  const src = stripJsxComments(read("screens", "pos", "PosWorkspace.tsx"));
  assert.match(src, /const online = session\.online && !session\.offlineMode && backendReachable/, "online AND-s a real reachability probe");
  assert.match(src, /isBackendReachable\(\)\.then\(\(r\) => \{[\s\S]*setBackendReachable\(r\)/, "a non-mutating probe drives it");
  assert.match(src, /offlineMode=\{session\.offlineMode \|\| shiftStore\.offlineRestored\}/, "a restored (offline) shift shows as Offline mode");
});

test("sign-out drops the durable POS-session snapshot (no cross-user restore)", () => {
  const src = stripComments(read("state", "session.ts"));
  assert.match(src, /signOut:[\s\S]*clearPosSessionSnapshot\(\)/, "signOut clears the snapshot");
});
