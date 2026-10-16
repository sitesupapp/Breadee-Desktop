// Phase F (F1) — resolved print-route cache: a kitchen/receipt destination resolved ONLINE is
// written through to a per-branch Dexie cache and read back OFFLINE, so a ticket still routes when
// the backend is unreachable. Branch-scoped (a route never crosses branches). Routing creates no
// business mutation — this only picks a destination.

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

import { localdb, cachePrintRoute, readCachedPrintRoute } from "@/lib/offline/db";

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

const ROUTE = { resolved: true, route_id: "R1", printer_id: "P1", printer_name: "Kitchen", system_printer_name: "WIN-KITCHEN", paper_width: "80mm", copies: 2, used_default: false };

beforeEach(async () => {
  await localdb.printRoutes.clear();
});

test("write-through + read-back: a resolved route round-trips per (branch, purpose, source)", async () => {
  await cachePrintRoute("b1", "kitchen_ticket", "dine_in", ROUTE);
  const got = await readCachedPrintRoute("b1", "kitchen_ticket", "dine_in");
  assert.deepEqual(got, ROUTE);
  // Independent keys: a different purpose/source is a different cache entry (miss until written).
  assert.equal(await readCachedPrintRoute("b1", "receipt", "dine_in"), null);
  assert.equal(await readCachedPrintRoute("b1", "kitchen_ticket", "takeaway"), null);
});

test("branch-scoped: one branch's cached route never serves another branch", async () => {
  await cachePrintRoute("b1", "kitchen_ticket", "dine_in", ROUTE);
  assert.equal(await readCachedPrintRoute("b2", "kitchen_ticket", "dine_in"), null);
  assert.equal(await readCachedPrintRoute(null, "kitchen_ticket", "dine_in"), null);
});

test("persists in the durable store (survives a cold restart): reopening the DB still reads it", async () => {
  await cachePrintRoute("b1", "receipt", "takeaway", ROUTE);
  // Reopen the Dexie connection (models a process restart against the same IndexedDB).
  await localdb.close();
  await localdb.open();
  const got = await readCachedPrintRoute("b1", "receipt", "takeaway");
  assert.deepEqual(got, ROUTE);
});

test("source wiring: resolveFor + the manual preview write through on resolve and fall back offline", () => {
  const apr = srcOf("src/lib/pos/autoPrintRun.ts");
  assert.match(apr, /if \(r\.resolved\) void cachePrintRoute\(branchId, input\.purpose, input\.orderSource, r\)/, "resolveFor writes through");
  assert.match(apr, /readCachedPrintRoute\(branchId, input\.purpose, input\.orderSource\)/, "resolveFor falls back to cache offline");
  const ktp = srcOf("src/screens/pos/KitchenTicketPreview.tsx");
  assert.match(ktp, /if \(r\.resolved\) void cachePrintRoute\(branchId, "kitchen_ticket", source, r\)/, "manual preview writes through");
  assert.match(ktp, /readCachedPrintRoute\(branchId, "kitchen_ticket", source\)/, "manual preview falls back to cache offline");
});
