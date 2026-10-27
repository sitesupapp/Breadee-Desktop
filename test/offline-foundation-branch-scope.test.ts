// Foundation — while the session runs on a VERIFIED offline entitlement, the operational-branch pin and the
// branch picker are restricted to the signed branch scope; a cached/stored pin outside it counts as no pin.

import { test } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

const { useOperationalBranch, setEntitledBranchScope, withinEntitledScope, filterToEntitledScope } = await import("@/state/operationalBranch");

test("no entitlement scope: pins and options are unchanged", () => {
  setEntitledBranchScope(null);
  useOperationalBranch.getState().setBranch("t1", "u1", "b-other");
  assert.equal(useOperationalBranch.getState().getBranch("t1", "u1"), "b-other");
  assert.equal(withinEntitledScope("anything"), true);
  assert.deepEqual(filterToEntitledScope([{ id: "a" }, { id: "b" }]).map((o) => o.id), ["a", "b"]);
});

test("entitlement scope: a stored pin outside it is treated as no pin; options are filtered", () => {
  useOperationalBranch.getState().setBranch("t1", "u1", "b-tampered");
  setEntitledBranchScope(["b-main", "b-2"]);
  assert.equal(useOperationalBranch.getState().getBranch("t1", "u1"), null, "pin outside the signed scope is ignored");
  useOperationalBranch.getState().setBranch("t1", "u1", "b-2");
  assert.equal(useOperationalBranch.getState().getBranch("t1", "u1"), "b-2");
  assert.equal(withinEntitledScope("b-tampered"), false);
  assert.equal(withinEntitledScope(null), false);
  assert.deepEqual(filterToEntitledScope([{ id: "b-main" }, { id: "b-tampered" }, { id: "b-2" }]).map((o) => o.id), ["b-main", "b-2"]);
  setEntitledBranchScope(null);
});
