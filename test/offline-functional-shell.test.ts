// SECOND-LAYER offline blockers (1.0.37 rc.4): the ACCESS layer passed natively, but page/modal DATA
// LOADERS threw raw "TypeError: Failed to fetch" offline. This locks the fixes:
//   1. Dine-In Floor Map — pre-hydrated during normal online POS use; a controlled offline readiness
//      message instead of a raw fetch error when no cache exists.
//   2. Delivery customer — the live UI routes to the Phase-E offline capture (search/create/edit/
//      address) instead of the online-only "Saving a customer needs a connection" gate.
//   3. Transfer Center / 4. Force End Shift — the modal OPENS offline with a controlled coordination
//      message and runs NO loader (server-authoritative; never a raw fetch error).
//
// Behavioural coverage uses fake-indexeddb for the offline customer/address capture; the loader
// wiring (React components / stores) is asserted at the source level, the repo's established style.

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

import { localdb, getCachedCustomer } from "@/lib/offline/db";
import { getOperation } from "@/lib/offline/operationLog";
import {
  captureCustomerUpsertOffline,
  evaluateCustomerWriteOfflineReady,
  type CustomerOpScope,
} from "@/lib/offline/customerOffline";

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

const SCOPE: CustomerOpScope = { tenantId: "t1", branchId: "b1", cashierUserId: "u1", deviceId: "dev1", terminalId: "term1" };

beforeEach(async () => {
  await Promise.all([localdb.operations.clear(), localdb.entityMap.clear(), localdb.posCustomers.clear()]);
});

// --- Delivery offline customer (Phase-E capture) ----------------------------

test("offline CREATE with an address mints a local address and caches the pending-local customer with it", async () => {
  const r = await captureCustomerUpsertOffline({
    scope: SCOPE,
    upsert: { branch_id: "b1", phone: "03111222", name: "Zed", address: { street: "Main St" } },
    clientOpId: "op-create-1",
    display: { name: "Zed", phone: "03111222", phone_e164: null },
  });
  assert.ok(r.localCustomerId, "a new customer gets a local id");
  assert.ok(r.localAddressId, "a NEW address on a create gets a local id (so a dependent order can chain to it)");
  const cached = await getCachedCustomer(r.localCustomerId as string, "t1", "b1");
  assert.equal(cached?.pending_local, true, "selectable offline immediately");
  const addresses = (cached?.addresses as { id: string }[] | null) ?? [];
  assert.equal(addresses.length, 1);
  assert.equal(addresses[0].id, r.localAddressId);
});

test("offline ADD-ADDRESS to a pending-local customer appends a local address to its cached profile", async () => {
  const c = await captureCustomerUpsertOffline({ scope: SCOPE, upsert: { branch_id: "b1", phone: "03999", name: "Ada" }, clientOpId: "op-create-2" });
  const a = await captureCustomerUpsertOffline({
    scope: SCOPE,
    upsert: { id: c.localCustomerId, branch_id: "b1", address: { street: "2nd St" } },
    clientOpId: "op-addr-2",
  });
  assert.equal(a.localCustomerId, null, "an edit mints no new customer");
  assert.ok(a.localAddressId, "a NEW address on an edit still gets a local id");
  const cached = await getCachedCustomer(c.localCustomerId as string, "t1", "b1");
  const addresses = (cached?.addresses as { id: string }[] | null) ?? [];
  assert.equal(addresses.length, 1, "the local address is appended so it is selectable offline");
  assert.equal(addresses[0].id, a.localAddressId);
  // The op carries local_address_id so the replay handler remaps it to the canonical address id.
  const op = await getOperation("customer:op-addr-2");
  assert.equal((op?.payload as { local_address_id?: string }).local_address_id, a.localAddressId);
});

test("offline ADD-ADDRESS to a CANONICAL (uncached) customer never re-marks it pending-local", async () => {
  const a = await captureCustomerUpsertOffline({
    scope: SCOPE,
    upsert: { id: "SRV-CUST-X", branch_id: "b1", address: { street: "3rd" } },
    clientOpId: "op-addr-3",
  });
  assert.ok(a.localAddressId, "the address id is minted + carried for replay remap");
  assert.equal(await getCachedCustomer("SRV-CUST-X", "t1", "b1"), undefined, "a canonical customer is not turned pending-local");
});

test("evaluateCustomerWriteOfflineReady: offline-ready + permission allows; not-ready blocks; no permission blocks", () => {
  const base = { online: false, canManageCustomers: false, canCreateOrders: true };
  assert.equal(evaluateCustomerWriteOfflineReady({ ...base, offlineReady: true, hasScope: true }).allowed, true);
  assert.equal(evaluateCustomerWriteOfflineReady({ ...base, offlineReady: false, hasScope: true }).allowed, false);
  assert.equal(evaluateCustomerWriteOfflineReady({ ...base, offlineReady: true, hasScope: false }).allowed, false);
  assert.equal(
    evaluateCustomerWriteOfflineReady({ online: false, offlineReady: true, hasScope: true, canManageCustomers: false, canCreateOrders: false }).allowed,
    false,
    "no create/manage permission is never upgraded",
  );
});

// --- loader wiring (source-asserted) ----------------------------------------

test("Dine-In Floor Map: pre-hydrated on POS entry, and no raw fetch error offline", () => {
  const pw = srcOf("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /canViewFloor\(pos\.access\)\.allowed\) void useFloor\.getState\(\)\.load\(ctx\)/, "floor pre-hydrated during online POS use");
  assert.match(pw, /canViewTables\(pos\.access\)\.allowed\) void useTables\.getState\(\)\.refresh\(ctx\)/, "table map pre-hydrated too");
  const floor = srcOf("src/state/floor.ts");
  assert.match(floor, /isBackendReachable/, "the no-cache branch classifies offline vs a real fault");
  assert.match(floor, /isn't saved for offline use yet/, "a controlled readiness message replaces a raw 'Failed to fetch'");
});

test("Delivery customer: the live UI routes to the offline-aware Phase-E path", () => {
  const dw = srcOf("src/screens/pos/DeliveryWorkspace.tsx");
  assert.match(dw, /searchCustomersOfflineAware/, "lookup is offline-aware (no raw fetch)");
  assert.match(dw, /upsertCustomerOfflineAware/, "create/edit/address capture offline");
  assert.match(dw, /customerOfflineReady = Boolean\(pos\.tenantId && pos\.userId\)/, "offline-ready signal");
  assert.match(dw, /!gate\.allowed &&\s*!online &&\s*customerOfflineReady/, "writeGate is upgraded offline when ready");
});

test("Transfer Center + Force End: modal opens offline with a controlled message and runs no loader", () => {
  const tc = srcOf("src/components/pos/TransferCenterModal.tsx");
  assert.match(tc, /online: boolean;/, "takes an online prop");
  assert.match(tc, /\{!online \?/, "short-circuits to the offline branch before any tab loader mounts");
  assert.match(tc, /Transfer Center needs a connection\./);
  const fem = srcOf("src/components/pos/ForceEndShiftModal.tsx");
  assert.match(fem, /\{!online \?/);
  assert.match(fem, /Force End Shift needs a connection\./);
  const feb = srcOf("src/components/pos/ForceEndShiftBrowser.tsx");
  assert.match(feb, /if \(!open \|\| !online\)/, "the browser does not fetch offline");
  assert.match(feb, /Force-End needs a connection\./);
});
