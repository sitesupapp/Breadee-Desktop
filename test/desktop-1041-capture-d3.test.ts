// 1.0.41 (S-CAPTURE, D-3 — Staging 1.0.52 native QA 2026-11-11). An offline Takeaway / Delivery sale is written to
// posOfflineTxns and becomes a `takeaway_sale` op only when the next drain STAGES it (migration.ts). Through 1.0.52 the
// op's capture evidence was stamped at that staging moment, so the till rate recorded was the rate held at SYNC time:
// a rate changed during the outage (native: 90 000 at the sale, 91 000 before replay) was lost. The evidence is now
// stamped on the ROW at capture and carried onto the op. Real Dexie (fake-indexeddb), real hooks, real migration.

import "fake-indexeddb/auto";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb, addPosOfflineTxn, type PosOfflineTxn } from "@/lib/offline/db";
import { getOperation, setCaptureCurrencyProvider, applyCaptureStamp } from "@/lib/offline/operationLog";
import { migrateLegacyToOperations } from "@/lib/offline/migration";
import { captureEvidenceFor, menuSyncedAt, noteMenuSynced, __resetMenuSyncedForTests } from "@/lib/offline/captureEvidence";
import { cacheMenu, readCachedMenu } from "@/lib/pos/menu";
import type { MenuData } from "@/types/pos";

const SALE_AT = "2026-11-11T08:31:57.615Z"; // native: 23:31 Anchorage, Nov 10 (QA branch), rate 90 000

function txn(id: string, extra: Partial<PosOfflineTxn> = {}): PosOfflineTxn {
  return {
    local_txn_id: id,
    client_op_id: `cop-${id}`,
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "d1",
    terminal_id: "term1",
    cashier_user_id: "u1",
    cashier_user_name: "QA",
    shift_id: "s1",
    created_at: SALE_AT,
    order_payload: { branch_id: "b1", order_type: "takeaway", shift_id: "s1", client_op_id: `cop-${id}`, items: [{ menu_item_id: "m1", base_price: 100000, quantity: 1, modifiers: [] }] },
    payment_intent: { method: "cash", currency: "LBP", pay_op_v: 1 },
    sent_to_kitchen: true,
    currency: "LBP",
    total: 100000,
    status: "queued",
    attempts: 0,
    ...extra,
  };
}

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.posOfflineTxns.clear(), localdb.pendingShifts.clear(), localdb.entityMap.clear(), localdb.snapshots.clear()]);
  __resetMenuSyncedForTests();
});
afterEach(() => setCaptureCurrencyProvider(null));

test("D-3: the sale row is stamped at capture; the op staged later carries the CAPTURE-time rate, not the sync-time rate", async () => {
  setCaptureCurrencyProvider(() => ({ primary: "LBP", rate: 90000 }));
  await addPosOfflineTxn(txn("a"));
  const row = await localdb.posOfflineTxns.get("a");
  assert.deepEqual(row?.capture, { v: 1, captured_at: SALE_AT, usd_to_lbp_rate: 90000, primary_currency: "LBP" });

  // The rate changes on the server during the outage; reconnect refreshes the till's currency BEFORE the drain stages.
  setCaptureCurrencyProvider(() => ({ primary: "LBP", rate: 91000 }));
  await migrateLegacyToOperations();
  const op = await getOperation("mig:txn:a");
  assert.ok(op, "the sale was staged");
  assert.equal(op.capture?.usd_to_lbp_rate, 90000, "the till rate at the sale");
  assert.equal(op.capture?.captured_at, SALE_AT, "the time of the sale");
});

test("D-3: a row written with an explicit stamp keeps it (never overwritten); re-staging is idempotent", async () => {
  setCaptureCurrencyProvider(() => ({ primary: "LBP", rate: 95000 }));
  const given = { v: 1 as const, captured_at: SALE_AT, usd_to_lbp_rate: 89500, primary_currency: "LBP" };
  await addPosOfflineTxn(txn("b", { capture: given }));
  assert.deepEqual((await localdb.posOfflineTxns.get("b"))?.capture, given);
  await migrateLegacyToOperations();
  await migrateLegacyToOperations();
  assert.deepEqual((await getOperation("mig:txn:b"))?.capture, given);
  assert.equal(await localdb.operations.count(), 1, "staged exactly once");
});

// --- owner decision 2026-11-11: honour the LAST-SYNCED menu price (server S-CAPTURE_03 validates + logs) ----------

const MENU_AT = "2026-11-11T08:28:39.000Z"; // native: "Cached menu from 10:28:39"; price changed 08:38:50; sale 08:39:07

test("last-synced: the evidence carries when this till last loaded THIS OU's menu (never a later one, never another OU)", () => {
  assert.equal(captureEvidenceFor(SALE_AT, { primary: "LBP", rate: 90000 }, MENU_AT)?.menu_synced_at, MENU_AT);
  assert.equal("menu_synced_at" in (captureEvidenceFor(SALE_AT, { primary: "LBP", rate: 90000 }) ?? {}), false, "absent = the 1.0.52 evidence shape");
  assert.equal("menu_synced_at" in (captureEvidenceFor(SALE_AT, null, "2026-11-11T09:00:00.000Z") ?? {}), false, "a sync AFTER the sale cannot be the menu the cashier saw");
  assert.equal("menu_synced_at" in (captureEvidenceFor(SALE_AT, null, "garbage") ?? {}), false);
  noteMenuSynced("t1", "b1", MENU_AT);
  noteMenuSynced("t1", "b1", "2026-11-11T07:00:00.000Z"); // an older read never moves it back
  assert.equal(menuSyncedAt("t1", "b1"), MENU_AT);
  assert.equal(menuSyncedAt("t1", "b2"), null, "another OU's menu is not this OU's");
  assert.equal(menuSyncedAt("t2", "b1"), null, "another tenant's menu is not this tenant's");
});

test("last-synced: the menu cache feeds it (online load and offline restart), and the sale row + op carry it", async () => {
  setCaptureCurrencyProvider(() => ({ primary: "LBP", rate: 90000 }));
  const menu = { items: [], categories: [] } as unknown as MenuData;
  await cacheMenu(menu, "t1", "b1");
  const loaded = menuSyncedAt("t1", "b1");
  assert.ok(loaded && Date.parse(loaded) > 0, "an online menu load records the moment");
  __resetMenuSyncedForTests(); // app restarted offline: memory empty, the cache is all there is
  const cached = await readCachedMenu("t1", "b1");
  assert.equal(menuSyncedAt("t1", "b1"), cached?.cachedAt, "reading the cached menu restores the moment");

  __resetMenuSyncedForTests();
  noteMenuSynced("t1", "b1", MENU_AT);
  await addPosOfflineTxn(txn("m", { created_at: "2026-11-11T08:39:07.461Z" }));
  assert.equal((await localdb.posOfflineTxns.get("m"))?.capture?.menu_synced_at, MENU_AT);
  await migrateLegacyToOperations();
  assert.equal((await getOperation("mig:txn:m"))?.capture?.menu_synced_at, MENU_AT, "sent to the server on replay");

  const op = { created_at: "2026-11-11T08:40:00.000Z", scope: { tenant_id: "t1", branch_id: "b2" } } as { created_at: string; scope: { tenant_id: string; branch_id: string }; capture?: unknown };
  applyCaptureStamp(op as never);
  assert.equal("menu_synced_at" in (op.capture as object), false, "an op of an OU whose menu was never synced here carries none");
});

test("D-3 compat: a row captured before the fix (no stamp) keeps the 1.0.52 behaviour (stamped when staged)", async () => {
  setCaptureCurrencyProvider(null); // a pre-fix build wrote the row with no stamp
  await addPosOfflineTxn(txn("c"));
  assert.equal((await localdb.posOfflineTxns.get("c"))?.capture, undefined);
  setCaptureCurrencyProvider(() => ({ primary: "LBP", rate: 91000 }));
  await migrateLegacyToOperations();
  const op = await getOperation("mig:txn:c");
  assert.equal(op?.capture?.usd_to_lbp_rate, 91000, "the staging-time rate, exactly as 1.0.52 (the server honours it only if it was in effect)");
  assert.equal(op?.capture?.captured_at, SALE_AT);
});
