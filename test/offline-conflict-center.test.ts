// Phase F — Conflict Center + op-log GC: requeue a parked (needs_attention) operation for retry,
// never disturbing in-flight/terminal work; GC only old SYNCED ops, never unsettled durable work.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? (this.m.get(k) as string) : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();

import { localdb } from "@/lib/offline/db";
import { OPERATION_SCHEMA_VERSION, requeueOperation, gcSyncedOperations, getOperation, type OfflineOperation, type OperationStatus } from "@/lib/offline/operationLog";

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

function op(id: string, status: OperationStatus, over: Partial<OfflineOperation> = {}): OfflineOperation {
  return {
    operation_id: id,
    operation_type: "payout",
    schema_version: OPERATION_SCHEMA_VERSION,
    scope: { tenant_id: "t1", branch_id: "b1", device_id: "dev1", terminal_id: "term1", cashier_user_id: "u1" },
    created_at: new Date().toISOString(),
    client_op_id: id,
    local_entity_id: null,
    canonical_entity_id: null,
    dependency_ids: [],
    depends_on_local_entities: [],
    payload: {},
    status,
    retry_count: 0,
    last_attempt_at: null,
    last_error_code: "x",
    last_error_message: "y",
    result_meta: null,
    synced_at: null,
    ...over,
  };
}

beforeEach(async () => {
  await localdb.operations.clear();
});

test("requeue: ONLY a needs_attention op is reset to pending (errors cleared); others untouched", async () => {
  await localdb.operations.bulkAdd([
    op("na", "needs_attention"),
    op("sy", "synced"),
    op("pe", "pending"),
    op("ca", "cancelled"),
    op("sg", "syncing"),
  ]);
  assert.equal(await requeueOperation("na"), true);
  const na = await getOperation("na");
  assert.equal(na?.status, "pending");
  assert.equal(na?.last_error_code, null);
  assert.equal(na?.last_error_message, null);

  // Terminal / in-flight / already-queued ops are NOT requeued.
  for (const id of ["sy", "pe", "ca", "sg"]) assert.equal(await requeueOperation(id), false);
  assert.equal((await getOperation("sy"))?.status, "synced");
  assert.equal((await getOperation("ca"))?.status, "cancelled");
  assert.equal((await getOperation("sg"))?.status, "syncing");
  assert.equal(await requeueOperation("missing"), false);
});

test("GC: drops only OLD synced ops; never unsettled work or recent synced", async () => {
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const recent = new Date().toISOString();
  await localdb.operations.bulkAdd([
    op("old-synced", "synced", { synced_at: old }),
    op("recent-synced", "synced", { synced_at: recent }),
    op("old-needs", "needs_attention", { synced_at: null, created_at: old }),
    op("old-pending", "pending", { created_at: old }),
  ]);
  const removed = await gcSyncedOperations(); // default 7-day window
  assert.equal(removed, 1); // only old-synced
  assert.equal(await getOperation("old-synced"), undefined);
  assert.ok(await getOperation("recent-synced")); // within window
  assert.ok(await getOperation("old-needs")); // unsettled — never dropped
  assert.ok(await getOperation("old-pending")); // unsettled — never dropped
});

test("Sync Center source: a needs_attention event offers a requeue action; it calls requeueOperation", () => {
  const src = srcOf("src/components/pos/SyncCenter.tsx");
  assert.match(src, /import \{[^}]*\brequeueOperation\b[^}]*\} from "@\/lib\/offline\/operationLog";/);
  assert.match(src, /await requeueOperation\(operationId\)/);
  assert.match(src, /e\.status === "needs_attention" && e\.operation_id && \(/, "retry button gated on needs_attention");
});
