// Phase D (D2) — dynamic/manual payment methods offline: catalog classification (pure) + the
// tenant-scoped offline catalog cache. The settle/on-account ops already carry the selected method
// key; this proves the catalog is available offline (local-recording subset) without substituting
// Cash, and that the hook reads the cache offline / mirrors online (source-contract).

import "fake-indexeddb/auto";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

import { classifyPaymentMethod, isOfflineCapableMethod, offlineCapableMethods, type CatalogMethod } from "@/lib/offline/paymentMethodClass";
import { localdb, cachePaymentMethods, readCachedPaymentMethods } from "@/lib/offline/db";

beforeEach(async () => {
  await localdb.snapshots.clear();
});

test("classify: every current catalog method is BREADEE_LOCAL_RECORDING (no external-auth field)", () => {
  const cash: CatalogMethod = { key: "cash", label: "Cash", is_cash: true };
  const card: CatalogMethod = { key: "card", label: "Card (manual)", is_cash: false };
  const owner: CatalogMethod = { key: "wish", label: "WishMoney", is_cash: false };
  for (const m of [cash, card, owner]) {
    assert.equal(classifyPaymentMethod(m), "BREADEE_LOCAL_RECORDING");
    assert.equal(isOfflineCapableMethod(m), true);
  }
});

test("classify: a forward-compat external-auth method is EXTERNAL_AUTHORIZATION_REQUIRED (offline-excluded)", () => {
  const ext: CatalogMethod = { key: "stripe", label: "Stripe", is_cash: false, requires_external_auth: true };
  assert.equal(classifyPaymentMethod(ext), "EXTERNAL_AUTHORIZATION_REQUIRED");
  assert.equal(isOfflineCapableMethod(ext), false);
});

test("offlineCapableMethods: keeps local tenders with EXACT keys/labels, excludes external, never substitutes Cash", () => {
  const catalog: CatalogMethod[] = [
    { key: "cash", label: "Cash", is_cash: true },
    { key: "card", label: "Card (manual)", is_cash: false },
    { key: "stripe", label: "Stripe", is_cash: false, requires_external_auth: true },
  ];
  const usable = offlineCapableMethods(catalog);
  assert.deepEqual(usable.map((m) => m.key), ["cash", "card"]); // stripe excluded, not turned into cash
  assert.equal(usable.find((m) => m.key === "card")?.label, "Card (manual)"); // label preserved exactly
});

test("offlineCapableMethods: Cash is always present even if the catalog omits it", () => {
  const usable = offlineCapableMethods([{ key: "card", label: "Card", is_cash: false }]);
  assert.ok(usable.some((m) => m.key === "cash" && m.is_cash));
  assert.ok(usable.some((m) => m.key === "card"));
});

test("catalog cache: tenant-scoped round-trip; a different tenant never reads it", async () => {
  await cachePaymentMethods("t1", [{ key: "cash", label: "Cash", is_cash: true }, { key: "card", label: "Card", is_cash: false }]);
  const c = await readCachedPaymentMethods("t1");
  assert.equal(c?.methods.length, 2);
  assert.equal(await readCachedPaymentMethods("t2"), null); // fail-closed across tenant
});

test("source-contract: useActivePaymentMethods reads the cache OFFLINE and mirrors ONLINE, no Cash substitution", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = stripComments(readFileSync(join(here, "..", "src/lib/pos/useActivePaymentMethods.ts"), "utf8"));
  // Offline-first recovery — offline AND a failed live read both answer from the cached catalog.
  assert.match(src, /const fromCache = \(\) =>\s*readCachedPaymentMethods\(tenantId\)/, "the cached catalog read");
  assert.match(src, /if \(!online\) \{\s*void fromCache\(\);/, "offline reads the cached catalog");
  assert.match(src, /\.catch\(\(\) => \{\s*if \(!cancelled\) void fromCache\(\);/, "a failed live read falls back to the cache, never Cash-only over it");
  assert.match(src, /offlineCapableMethods\(/, "offline offers the local-recording subset");
  assert.match(src, /void cachePaymentMethods\(tenantId, m\)/, "online mirrors the live catalog to cache");
});
