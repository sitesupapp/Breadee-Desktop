// Shift-INDEPENDENT branch-context cache: an already-hydrated device must be able
// to NAME its branch after an offline restart even with NO open shift (the gap that
// showed "Branch unavailable"), while never restoring another device/tenant/branch's
// name. Pure localStorage module, exercised directly.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  saveBranchContext,
  restoreBranchName,
  clearBranchContext,
} from "@/lib/offline/branchContext";

// Minimal in-memory localStorage - node has none; the module only ever touches it
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

const KEY = "breadee-desktop-branch-context";
const DEV = "dev-1";
const TENANT = "tenant-1";
const BRANCH = "branch-1";

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage.clear();
});

test("ONLINE hydration caches the branch name; an offline restart restores it", () => {
  saveBranchContext({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH, branchName: "Main Branch", currency: "LBP" });
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH }), "Main Branch");
});

test("a wrong-tenant / wrong-device / wrong-branch request restores nothing", () => {
  saveBranchContext({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH, branchName: "Main Branch", currency: "LBP" });
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: "other-tenant", branchId: BRANCH }), null);
  assert.equal(restoreBranchName({ deviceId: "other-device", tenantId: TENANT, branchId: BRANCH }), null);
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: "other-branch" }), null);
});

test("a placeholder name is never persisted (so it can never come back as a fake label)", () => {
  saveBranchContext({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH, branchName: "Branch unavailable", currency: "LBP" });
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH }), null);
  saveBranchContext({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH, branchName: "", currency: "LBP" });
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH }), null);
});

test("multiple branches (OU switching) are each restorable; a new tenant replaces the cache", () => {
  saveBranchContext({ deviceId: DEV, tenantId: TENANT, branchId: "b-main", branchName: "Main Branch", currency: "LBP" });
  saveBranchContext({ deviceId: DEV, tenantId: TENANT, branchId: "b-flour", branchName: "Flour", currency: "LBP" });
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: "b-main" }), "Main Branch");
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: "b-flour" }), "Flour");
  // A different tenant on the same device replaces the cache wholesale.
  saveBranchContext({ deviceId: DEV, tenantId: "tenant-2", branchId: "b-x", branchName: "Shop X", currency: "USD" });
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: "b-main" }), null, "old tenant's entries gone");
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: "tenant-2", branchId: "b-x" }), "Shop X");
});

test("an entry older than the 7-day TTL is not restored", () => {
  const eightDays = 8 * 24 * 60 * 60 * 1000;
  (globalThis as unknown as { localStorage: MemStorage }).localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      source: "server",
      device_id: DEV,
      tenant_id: TENANT,
      entries: [{ branch_id: BRANCH, branch_name: "Main Branch", currency: "LBP", savedAt: Date.now() - eightDays }],
    }),
  );
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH }), null);
});

test("a non-server-provenance cache is not trusted", () => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage.setItem(
    KEY,
    JSON.stringify({
      version: 1,
      source: "client",
      device_id: DEV,
      tenant_id: TENANT,
      entries: [{ branch_id: BRANCH, branch_name: "Main Branch", currency: "LBP", savedAt: Date.now() }],
    }),
  );
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH }), null);
});

test("clear removes the whole cache (sign-out)", () => {
  saveBranchContext({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH, branchName: "Main Branch", currency: "LBP" });
  assert.ok(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH }));
  clearBranchContext();
  assert.equal(restoreBranchName({ deviceId: DEV, tenantId: TENANT, branchId: BRANCH }), null);
});
