// The "latest wins" gate that guards shift.refresh() against an older-OU refresh
// completing after a newer one and restoring stale state (Konan cycle-3 finding #3).
// Tests the exact mechanism shift.ts uses, deterministically and without the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLatestGate } from "@/lib/offline/latestGate";

test("a sole claim is never stale", () => {
  const gate = createLatestGate();
  const a = gate.claim();
  assert.equal(a.isStale(), false);
});

test("an earlier claim becomes stale once a later claim is made; the latest is live", () => {
  const gate = createLatestGate();
  const first = gate.claim();
  assert.equal(first.isStale(), false, "latest so far");
  const second = gate.claim();
  assert.equal(first.isStale(), true, "superseded by the later claim");
  assert.equal(second.isStale(), false, "the newest claim is the live one");
  const third = gate.claim();
  assert.equal(second.isStale(), true);
  assert.equal(third.isStale(), false);
});

test("overlapping-refresh simulation: the OLDER run's commit is skipped, the NEWER wins", async () => {
  const gate = createLatestGate();
  const committed: string[] = [];
  // Model two refreshes of different OUs that overlap: the OLD one is slow, the NEW
  // one (started afterwards) resolves first. Only the latest generation may commit.
  async function refresh(label: string, delayMs: number) {
    const { isStale } = gate.claim();
    await new Promise((r) => setTimeout(r, delayMs));
    if (isStale()) return; // superseded - must NOT write
    committed.push(label);
  }
  const slowOld = refresh("OLD-OU", 30); // claims generation 1
  // microtask gap so the OLD claim is taken first, then the NEW claim supersedes it
  await new Promise((r) => setTimeout(r, 5));
  const fastNew = refresh("NEW-OU", 5); // claims generation 2
  await Promise.all([slowOld, fastNew]);
  assert.deepEqual(committed, ["NEW-OU"], "only the newest refresh commits; the stale old-OU result is dropped");
});

test("a non-overlapping sequence lets each claim commit in turn", async () => {
  const gate = createLatestGate();
  const committed: string[] = [];
  async function refresh(label: string) {
    const { isStale } = gate.claim();
    await Promise.resolve();
    if (isStale()) return;
    committed.push(label);
  }
  await refresh("first");
  await refresh("second");
  assert.deepEqual(committed, ["first", "second"]);
});
