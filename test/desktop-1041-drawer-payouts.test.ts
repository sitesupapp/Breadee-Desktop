// 1.0.41 (D-1, S-DRAWER_01) — Staging 1.0.52 native QA B05-4: after a $3.00 cash payout the top-bar Drawer
// (pos_cash_box_shift.expected_cash) still showed 31.11 while the shift close expected 28.11. The server read now
// deducts active payouts with the shift close's own formula and returns `cash_payouts`; the client names the
// deduction only when the server reports it, and the offline drawer never deducts a payout twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { serverDrawerNote } from "@/lib/pos/shifts";
import { buildOfflineDrawerView } from "@/lib/pos/offlineDrawer";
import type { OfflineOperation } from "@/lib/offline/operationLog";

const usd = (n: number) => `$${n.toFixed(2)}`;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

test("D-1: the Drawer note names payouts only when the server deducted them", () => {
  // A server without S-DRAWER_01 returns no cash_payouts → described exactly as before (no false claim).
  const legacy = serverDrawerNote({ cash_payouts: null }, usd);
  assert.equal(legacy, "Expected cash: opening float plus cash taken this shift. Read from the server, in USD.");
  assert.doesNotMatch(legacy, /payout/i);
  assert.equal(serverDrawerNote({}, usd), legacy);
  // S-DRAWER_01 server: the deduction is stated, with the amount when there is one.
  assert.match(serverDrawerNote({ cash_payouts: 0 }, usd), /minus cash payouts \(none\)/);
  assert.match(serverDrawerNote({ cash_payouts: 3 }, usd), /minus \$3\.00 cash payouts/);
});

test("D-1: getCashBox carries cash_payouts (null when absent) and the status bar renders the note", () => {
  const shifts = src("src/lib/pos/shifts.ts");
  const getCashBox = shifts.slice(shifts.indexOf("export async function getCashBox"), shifts.indexOf("export function serverDrawerNote"));
  assert.match(getCashBox, /cash_payouts:\s*numOrNull\(row\.cash_payouts\)/);
  // expected_cash is still the server's figure, never adjusted client-side.
  assert.match(getCashBox, /expected_cash:\s*num\(row\.expected_cash\)/);
  const bar = src("src/components/pos/PosStatusBar.tsx");
  assert.match(bar, /serverDrawerNote\(props\.cashBox,/);
  assert.match(bar, /formatMoney\(props\.cashBox\.expected_cash, CASH_CONTRACT_CURRENCY\)/);
});

function payoutOp(createdAtMs: number, amountUsd: number): OfflineOperation {
  return {
    operation_id: "op-" + createdAtMs,
    operation_type: "payout",
    schema_version: 1,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" },
    created_at: new Date(createdAtMs).toISOString(),
    client_op_id: "c-" + createdAtMs,
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: { amount_usd: amountUsd, method: "cash" },
    status: "synced",
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    result_meta: null,
    synced_at: null,
  };
}

test("D-1: offline, a payout already inside the server figure is not deducted again", () => {
  const scope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };
  const readAt = 1_000_000;
  // Server figure 28.11 already deducts the $3.00 payout made before the read; a $2.00 payout after it is local.
  const view = buildOfflineDrawerView({
    ops: [payoutOp(readAt - 60_000, 3), payoutOp(readAt + 60_000, 2)],
    scope,
    server: { shiftId: "s1", expectedCashUsd: 28.11, fetchedAtMs: readAt },
    openingFloatUsd: null,
    shiftOpenedAtMs: readAt - 3_600_000,
    usdRate: 90_000,
  });
  assert.equal(view.baseSource, "server");
  assert.equal(view.cashOutUsd, 2);
  assert.equal(view.projectedUsd, 26.11);
});
