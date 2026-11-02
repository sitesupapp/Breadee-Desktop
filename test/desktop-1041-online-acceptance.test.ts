// Desktop 1.0.41 - regressions found in the Desktop 1.0.40 native ONLINE acceptance (2026-11-02).
//   DESK-1  The live shift read was not branch-scoped. With open shifts in two OUs, the POS of the
//           older one showed "No open shift", and Open Shift could not activate the reused shift.
//   DESK-2  Modal footer errors were clipped with an ellipsis, hiding the server's reason.
//   DESK-3  The end-of-shift report always said "Pending manager review", even when the server had
//           closed the shift directly (R7 switch ON -> shift_status 'approved').
//   DESK-4  Item-drawer modifier links need menu.manage_modifiers (Production immg_write, ISO-1).
// The shift tests drive the REAL store with the network reads injected through shiftNet, exactly
// as offline-shift-store.test.ts does.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { useShift, shiftNet } from "@/state/shift";
import { localdb } from "@/lib/offline/db";
import { clearPosSessionSnapshot } from "@/lib/offline/posSession";
import { shiftCloseOutcome, shiftReportFromRow } from "@/lib/pos/shifts";
import { canAssignItemModifiers, type MenuAccessContext } from "@/lib/menu/access";
import type { ActiveShift, CashBox } from "@/types/pos";

const openShift = (id: string, branchId: string | null): ActiveShift => ({
  id, status: "open", opened_at: "2026-11-02T08:00:00Z", opening_cash_amount: 0, branch_id: branchId,
});
const cashBoxFor = (shiftId: string): CashBox => ({ shift_id: shiftId } as unknown as CashBox);

// Server truth for every DESK-1 test: the cashier has open shifts in BOTH OUs, and b2's is the newest.
// An unscoped read (branchId undefined) returns only that newest one - the 1.0.40 behaviour.
const serverOpenShift = async (_t: string, _u: string, branchId?: string | null) => {
  if (branchId === undefined) return openShift("S-B2-NEWEST", "b2");
  if (branchId === "b1") return openShift("S-B1", "b1");
  if (branchId === "b2") return openShift("S-B2-NEWEST", "b2");
  return null;
};

beforeEach(async () => {
  await localdb.pendingShifts.clear();
  await localdb.posOfflineTxns.clear();
  clearPosSessionSnapshot();
  useShift.getState().clear();
  shiftNet.findOpenShift = async () => null;
  shiftNet.getCashBox = async (id) => cashBoxFor(id as string);
});

test("DESK-1: refresh reads THIS branch's open shift, not the cashier's newest one in another OU", async () => {
  const seen: Array<string | null | undefined> = [];
  shiftNet.findOpenShift = async (t: string, u: string, branchId?: string | null) => {
    seen.push(branchId);
    return serverOpenShift(t, u, branchId);
  };
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.deepEqual(seen, ["b1"], "the live read is scoped to the POS branch/OU");
  assert.equal(useShift.getState().shift?.id, "S-B1", "the b1 shift is adopted although b2's is newer");
  assert.equal(useShift.getState().cashBox?.shift_id, "S-B1");
});

test("DESK-1: a sibling OU's shift is still never adopted (defence in depth)", async () => {
  // Even if a read ignored the scope and returned b2's shift, the b1 POS must not adopt it.
  shiftNet.findOpenShift = async () => openShift("S-B2-NEWEST", "b2");
  await useShift.getState().refresh("t1", "u1", "b1");
  assert.equal(useShift.getState().shift, null);
});

test("DESK-1: Open Shift where the server REUSES this OU's open shift activates it (no false failure)", async () => {
  shiftNet.reachable = async () => true;
  shiftNet.openShift = async () => ({ shiftId: "S-B1" }); // pos_open_shift_core: reused = true
  shiftNet.findOpenShift = serverOpenShift;
  await useShift.getState().open({ tenantId: "t1", userId: "u1", branchId: "b1", openingCash: 0, currency: "USD" });
  assert.equal(useShift.getState().shift?.id, "S-B1");
  assert.equal(useShift.getState().shift?.status, "open");
});

test("DESK-3: a shift the server closed directly is reported as closed, not pending review", () => {
  const report = shiftReportFromRow(
    { shift_id: "s1", shift_status: "approved", approval_required: false },
    "pos_end_shift",
  );
  assert.equal(report.shift_status, "approved");
  assert.equal(report.approval_required, false);
  const outcome = shiftCloseOutcome(report);
  assert.equal(outcome.tone, "green");
  assert.match(outcome.label, /Closed/);
  assert.doesNotMatch(outcome.subtitle, /manager review - it is not approved/);
});

test("DESK-3: a review-required close, and a report with no outcome, keep the pending-review wording", () => {
  assert.equal(
    shiftCloseOutcome({ shift_status: "pending_manager_review", approval_required: true }).label,
    "Pending manager review",
  );
  const legacy = shiftReportFromRow({ shift_id: "s2" }, "pos_end_shift");
  assert.equal(legacy.shift_status, null);
  assert.equal(legacy.approval_required, null);
  assert.equal(shiftCloseOutcome(legacy).tone, "amber");
  assert.equal(shiftCloseOutcome({}).label, "Pending manager review");
});

const menuCtx = (permissions: Record<string, boolean>): MenuAccessContext =>
  ({ status: "active", permissions, features: {} }) as unknown as MenuAccessContext;

test("DESK-4: changing an item's modifier links needs menu.manage_modifiers, not just menu.edit", () => {
  assert.equal(canAssignItemModifiers(menuCtx({ "menu.edit": true, "menu.create": true })), false);
  assert.equal(canAssignItemModifiers(menuCtx({ "menu.edit": true, "menu.manage_modifiers": true })), true);
  assert.equal(canAssignItemModifiers(menuCtx({ "cost_control.modifiers.manage": true })), true);
});

test("DESK-2: shift dialog errors wrap and are announced instead of being clipped", () => {
  const src = readFileSync("src/components/pos/ShiftDialog.tsx", "utf8");
  assert.equal(/className="truncate[^"]*text-red-700"/.test(src), false, "no clipped error paragraph remains");
  assert.ok((src.match(/role="alert"/g) ?? []).length >= 2, "both footer errors are announced");
});
