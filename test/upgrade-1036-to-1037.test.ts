// 1.0.37 PRODUCTION — local data preservation on the in-app update 1.0.36 → 1.0.37.
//
// The installed 1.0.36 fleet holds an IndexedDB "breadee-desktop" at Dexie schema v4 (outbox, snapshots,
// audit, posOfflineTxns, posCustomers, pendingShifts) plus localStorage (device/terminal identity, offline
// authority, POS session, operational branch). The update keeps the SAME bundle identity
// (app.breadee.desktop), so the WebView2 data folder is the same one; 1.0.37 opens the existing database
// and Dexie upgrades it to v11 ADDITIVELY (new stores only, no upgrade() callbacks).
//
// This test seeds a database with the EXACT 1.0.36 schema (v1..v4 store definitions, verbatim from the
// production tag c655651), closes it, opens it with the 1.0.37 `localdb`, and proves every row survives,
// the new stores exist empty, the device identity is unchanged, and a second open is idempotent.

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import Dexie from "dexie";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
const storage = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = storage;

/** The production 1.0.36 database, schema v1..v4 VERBATIM (src/lib/offline/db.ts @ c655651). */
function open1036(): Dexie {
  const db = new Dexie("breadee-desktop");
  db.version(1).stores({
    outbox: "++id, kind, status, tenant_id, branch_id, created_at",
    snapshots: "key, tenant_id, branch_id",
    audit: "++id, action, tenant_id, at, sync_status",
  });
  db.version(2).stores({
    posOfflineTxns: "local_txn_id, client_op_id, tenant_id, branch_id, status, created_at, cashier_user_id",
  });
  db.version(3).stores({
    posCustomers: "id, tenant_id, branch_id, phone_e164, name",
  });
  db.version(4).stores({
    pendingShifts: "local_shift_id, client_op_id, tenant_id, branch_id, status, cashier_user_id, opened_at",
  });
  return db;
}

const T = "tenant-prod-1";
const B = "branch-prod-1";
const now = new Date().toISOString();

test("1.0.36 → 1.0.37: the existing local database upgrades in place — every row preserved, identity unchanged, idempotent", async () => {
  // ---- a 1.0.36 terminal with real local state ----
  storage.setItem("breadee-device-identity", JSON.stringify({ device_id: "dev-1036", terminal_id: "TERM-7" }));
  storage.setItem("breadee-desktop-context", JSON.stringify({ userId: "u1", cachedAt: Date.now() }));
  storage.setItem("printer-config", JSON.stringify({ receipt: "EPSON-TM20", kitchen: "KITCHEN-1" }));
  const old = open1036();
  await old.open();
  assert.equal(old.verno, 4);
  await old.table("snapshots").bulkPut([
    { key: "menu", tenant_id: T, branch_id: B, data: { items: [{ id: "m1", name: "Pizza" }] }, cached_at: now },
    { key: `tables:${B}`, tenant_id: T, branch_id: B, data: { tables: [{ id: "t1" }] }, cached_at: now },
  ]);
  await old.table("posOfflineTxns").add({
    local_txn_id: "TX-QUEUED", client_op_id: "op-1", tenant_id: T, branch_id: B, device_id: "dev-1036", terminal_id: "TERM-7",
    cashier_user_id: "u1", cashier_user_name: "Cashier", shift_id: "SH-1", created_at: now,
    order_payload: { order_type: "takeaway", shift_id: "SH-1", items: [] }, payment_intent: { method: "cash", currency: "USD" },
    currency: "USD", total: 10, status: "queued", attempts: 0,
  });
  await old.table("posCustomers").add({ id: "C1", tenant_id: T, branch_id: B, name: "Rana", phone: "03123456", phone_e164: "+9613123456", addresses: null, notes: null, has_profile: false, cached_at: now });
  await old.table("pendingShifts").add({ local_shift_id: "LS-1", client_op_id: "op-s", tenant_id: T, branch_id: B, device_id: "dev-1036", terminal_id: "TERM-7", cashier_user_id: "u1", opening_cash_amount: 0, currency: "USD", opened_at: now, status: "pending_sync", attempts: 0 });
  await old.table("outbox").add({ kind: "pos.save_order", payload: {}, user_id: "u1", user_name: "Cashier", tenant_id: T, branch_id: B, device_id: "dev-1036", terminal_id: "TERM-7", created_at: now, status: "queued", attempts: 0 });
  await old.table("audit").add({ action: "sync.run", user_id: "u1", tenant_id: T, branch_id: B, device_id: "dev-1036", terminal_id: "TERM-7", at: now, sync_status: "local" });
  old.close();

  // ---- the updated 1.0.37 app opens the SAME database ----
  const { localdb } = await import("@/lib/offline/db");
  await localdb.open();
  assert.equal(localdb.verno, 11, "upgraded additively to the 1.0.37 schema");
  assert.equal(await localdb.snapshots.count(), 2, "menu + table cache retained");
  assert.deepEqual((await localdb.snapshots.get("menu"))?.data, { items: [{ id: "m1", name: "Pizza" }] });
  assert.equal((await localdb.posOfflineTxns.get("TX-QUEUED"))?.status, "queued", "unsynced local work retained");
  assert.equal((await localdb.posCustomers.get("C1"))?.phone_e164, "+9613123456", "customer cache retained");
  assert.equal((await localdb.pendingShifts.get("LS-1"))?.status, "pending_sync");
  assert.equal(await localdb.outbox.count(), 1, "legacy outbox retained (quarantined by migration, never deleted)");
  assert.equal(await localdb.audit.count(), 1);
  for (const store of ["operations", "entityMap", "syncHistory", "dineDrafts", "paidOrderProofs", "payoutSourceProofs", "printRoutes", "receivableProofs", "receipts"]) {
    assert.equal(await localdb.table(store).count(), 0, `${store} created empty`);
  }
  // localStorage is never touched by the schema upgrade.
  assert.deepEqual(JSON.parse(storage.getItem("breadee-device-identity") as string), { device_id: "dev-1036", terminal_id: "TERM-7" });
  assert.deepEqual(JSON.parse(storage.getItem("printer-config") as string), { receipt: "EPSON-TM20", kitchen: "KITCHEN-1" });
  assert.ok(storage.getItem("breadee-desktop-context"), "offline authority retained");

  // ---- idempotent: a restart re-opens without any change ----
  localdb.close();
  await localdb.open();
  assert.equal(localdb.verno, 11);
  assert.equal(await localdb.posOfflineTxns.count(), 1, "no duplicate on re-open");
  assert.equal(await localdb.snapshots.count(), 2);
});
