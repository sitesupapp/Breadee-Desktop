// The reconnect-drain re-pass orchestrator (Konan cycle-4 finding #1): when the
// server-authoritative context changes WHILE a drain is in flight (an OU switch, a
// sign-out), the drain must run once more under the NEW context - so work is never
// replayed only under the stale pre-switch context - and must converge and stay
// bounded. Deterministic; no store or network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runFreshContextPasses } from "@/lib/offline/drainPasses";

type Ctx = { tenantId: string; userId: string; branchId: string | null };
const keyOf = (c: Ctx) => `${c.tenantId}|${c.userId}|${c.branchId}`;

test("a stable context drains exactly once", async () => {
  const ran: string[] = [];
  const ctx: Ctx = { tenantId: "t1", userId: "u1", branchId: "b1" };
  await runFreshContextPasses(() => ctx, keyOf, async (c) => { ran.push(c.branchId!); });
  assert.deepEqual(ran, ["b1"]);
});

test("an OU switch DURING a pass triggers one more pass under the NEW context", async () => {
  const ran: string[] = [];
  let ctx: Ctx = { tenantId: "t1", userId: "u1", branchId: "b1" };
  await runFreshContextPasses(
    () => ctx,
    keyOf,
    async (c) => {
      ran.push(c.branchId!);
      // The context switches to a sibling OU while THIS drain is in flight.
      if (c.branchId === "b1") ctx = { ...ctx, branchId: "b2" };
    },
  );
  assert.deepEqual(ran, ["b1", "b2"], "ran under the old OU, then re-ran under the new OU, then stopped");
});

test("no tenant/user context (signed out mid-reconnect) drains nothing", async () => {
  const ran: string[] = [];
  await runFreshContextPasses(() => null, keyOf, async () => { ran.push("x"); });
  assert.deepEqual(ran, []);
});

test("a context that flaps every pass is BOUNDED (never loops forever)", async () => {
  const ran: string[] = [];
  let toggle = false;
  await runFreshContextPasses(
    () => {
      toggle = !toggle;
      return { tenantId: "t1", userId: "u1", branchId: toggle ? "b1" : "b2" };
    },
    keyOf,
    async (c) => { ran.push(c.branchId!); },
    3,
  );
  assert.equal(ran.length, 3, "capped at maxPasses despite the context never stabilising");
});

test("a context that goes away between passes stops cleanly", async () => {
  const ran: string[] = [];
  let ctx: Ctx | null = { tenantId: "t1", userId: "u1", branchId: "b1" };
  await runFreshContextPasses(
    () => ctx,
    keyOf,
    async (c) => { ran.push(c.branchId!); ctx = null; }, // revoked during the first pass
  );
  assert.deepEqual(ran, ["b1"], "the first pass ran; the revoked context ends the loop");
});
