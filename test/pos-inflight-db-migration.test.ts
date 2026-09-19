// Gate 12 — the Dexie v1 -> v2 upgrade MUST be additive: an existing v1.0.21 local
// database (outbox / snapshots / audit, possibly holding unsynced work) upgrades in
// place with EVERY existing store and row preserved, and only GAINS the
// inflightSubmits store. Nothing is cleared, recreated or destructively migrated.
//
// Runs in its own file so it owns a fresh process: it builds a real v1 database
// FIRST, then opens the app's v2 `localdb` (dynamic import) to exercise the actual
// upgrade path rather than a fresh v2 create.

import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import Dexie from "dexie";

test("Dexie v1 -> v3 upgrade preserves outbox / snapshots / audit and adds inflightSubmits + posOfflineTxns", async () => {
  await Dexie.delete("breadee-desktop"); // start from nothing

  // 1) Exactly the v1.0.21 schema, populated with real data.
  const v1 = new Dexie("breadee-desktop");
  v1.version(1).stores({
    outbox: "++id, kind, status, tenant_id, branch_id, created_at",
    snapshots: "key, tenant_id, branch_id",
    audit: "++id, action, tenant_id, at, sync_status",
  });
  await v1.open();
  assert.equal(v1.verno, 1);
  await v1.table("outbox").add({
    kind: "pos.pay_order",
    payload: { order_id: "o1" },
    user_id: "u1",
    user_name: "Cashier",
    tenant_id: "t1",
    branch_id: "b1",
    device_id: "dev1",
    terminal_id: "term1",
    created_at: "2026-09-16T10:00:00Z",
    status: "queued",
    attempts: 0,
  });
  await v1.table("snapshots").put({ key: "menu", tenant_id: "t1", branch_id: "b1", data: { items: [1, 2] }, cached_at: "2026-09-16T10:00:00Z" });
  await v1.table("audit").add({ action: "sync.run", user_id: "u1", tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", at: "2026-09-16T10:00:00Z", sync_status: "local" });
  v1.close();

  // 2) Open the app's database, which now declares version(3). This triggers the
  //    real in-place upgrade of the existing v1 data STRAIGHT THROUGH v2 to v3, so
  //    the whole additive chain is exercised on genuinely old data.
  const { localdb } = await import("@/lib/offline/db");
  const outbox = await localdb.outbox.toArray();
  const snapshots = await localdb.snapshots.toArray();
  const audit = await localdb.audit.toArray();
  const inflight = await localdb.inflightSubmits.toArray();
  const posTxns = await localdb.posOfflineTxns.toArray();

  assert.equal(localdb.verno, 3, "database upgraded to version 3 (v1 -> v3, additive through v2)");
  assert.equal(outbox.length, 1, "outbox rows preserved across the upgrade");
  assert.equal(outbox[0]!.kind, "pos.pay_order", "outbox row content intact");
  assert.equal(snapshots.length, 1, "snapshots preserved");
  assert.deepEqual(snapshots[0]!.data, { items: [1, 2] }, "snapshot content intact");
  assert.equal(audit.length, 1, "audit preserved");
  assert.equal(inflight.length, 0, "inflightSubmits store present and empty (added in v2)");
  assert.equal(posTxns.length, 0, "posOfflineTxns store present and empty (added in v3)");
  localdb.close();
});
