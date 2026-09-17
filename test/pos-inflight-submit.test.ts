// The durable in-flight submit journal (crash/restart protection for the existing
// client_op_id idempotency). Exercises the real Dexie store via fake-indexeddb.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { localdb } from "@/lib/offline/db";
import {
  beginInflightSubmit,
  clearInflightSubmit,
  getUnresolvedSubmit,
  UnresolvedSubmitExistsError,
} from "@/lib/pos/inflightSubmit";

const ctxA = { tenant_id: "t1", branch_id: "b1", terminal_id: "term1", device_id: "dev1" };
const ctxA_b2 = { tenant_id: "t1", branch_id: "b2", terminal_id: "term1", device_id: "dev1" };
const ctxB = { tenant_id: "t2", branch_id: "b1", terminal_id: "term1", device_id: "dev1" };

beforeEach(async () => {
  await localdb.inflightSubmits.clear();
});

test("gate2: begin writes an UNRESOLVED row with the EXACT payload and context", async () => {
  const payload = { client_op_id: "op1", items: [{ menu_item_id: "m1", quantity: 2 }] };
  await beginInflightSubmit({ client_op_id: "op1", payload, ctx: ctxA });
  const e = await getUnresolvedSubmit("t1", "b1");
  assert.ok(e, "entry exists");
  assert.equal(e!.client_op_id, "op1");
  assert.equal(e!.status, "submitting");
  assert.deepEqual(e!.payload, payload, "the exact payload is persisted for reconciliation");
  assert.equal(e!.tenant_id, "t1");
  assert.equal(e!.branch_id, "b1");
  assert.equal(e!.terminal_id, "term1");
  assert.equal(e!.device_id, "dev1");
});

test("gate3: clear retires the journal row", async () => {
  await beginInflightSubmit({ client_op_id: "op1", payload: {}, ctx: ctxA });
  await clearInflightSubmit("op1");
  assert.equal(await getUnresolvedSubmit("t1", "b1"), null);
});

test("gate5: an unresolved entry survives a simulated restart (close + reopen)", async () => {
  const payload = { client_op_id: "op1", n: 7 };
  await beginInflightSubmit({ client_op_id: "op1", payload, ctx: ctxA });
  localdb.close();
  await localdb.open();
  const e = await getUnresolvedSubmit("t1", "b1");
  assert.ok(e, "journal survived restart");
  assert.deepEqual(e!.payload, payload, "exact payload survived restart");
});

test("gate7/L: same client_op_id keeps the ORIGINAL immutable payload (never rebuilt)", async () => {
  await beginInflightSubmit({ client_op_id: "op1", payload: { v: 1 }, ctx: ctxA });
  await beginInflightSubmit({ client_op_id: "op1", payload: { v: 2 }, ctx: ctxA }); // a same-session retry
  const e = await getUnresolvedSubmit("t1", "b1");
  assert.deepEqual(e!.payload, { v: 1 }, "the first persisted payload is authoritative");
});

test("gate10/M: a DIFFERENT new submit cannot overwrite an unresolved one in the same context", async () => {
  await beginInflightSubmit({ client_op_id: "op1", payload: {}, ctx: ctxA });
  await assert.rejects(
    () => beginInflightSubmit({ client_op_id: "op2", payload: {}, ctx: ctxA }),
    (e: unknown) => e instanceof UnresolvedSubmitExistsError && e.pendingClientOpId === "op1",
  );
  const e = await getUnresolvedSubmit("t1", "b1");
  assert.equal(e!.client_op_id, "op1", "the unresolved entry is untouched");
});

test("gate11/N: an entry is scoped to its tenant+branch (no cross-context surfacing/replay)", async () => {
  await beginInflightSubmit({ client_op_id: "op1", payload: {}, ctx: ctxA });
  assert.equal(await getUnresolvedSubmit("t2", "b1"), null, "a different tenant never sees it");
  assert.equal(await getUnresolvedSubmit("t1", "b2"), null, "a different branch never sees it");
  assert.ok(await getUnresolvedSubmit("t1", "b1"), "the owning context sees it");
});

test("different tenants/branches journal independently (no false conflict across contexts)", async () => {
  await beginInflightSubmit({ client_op_id: "op1", payload: {}, ctx: ctxA });
  await beginInflightSubmit({ client_op_id: "op2", payload: {}, ctx: ctxB }); // different tenant, allowed
  await beginInflightSubmit({ client_op_id: "op3", payload: {}, ctx: ctxA_b2 }); // same tenant, other branch, allowed
  assert.equal((await getUnresolvedSubmit("t1", "b1"))!.client_op_id, "op1");
  assert.equal((await getUnresolvedSubmit("t2", "b1"))!.client_op_id, "op2");
  assert.equal((await getUnresolvedSubmit("t1", "b2"))!.client_op_id, "op3");
});
