// Phase F (NATIVE ACCESS BLOCKER) — SECTION ACCESS ≠ BACKEND AVAILABILITY.
//
// The native RC showed only Takeaway accessible offline while Dine-In / Delivery / Transfer /
// Force-End became inaccessible. Root cause: session.init restored the durable offline context ONLY
// when supabase.auth.getSession() returned a session, but offline (expired access token, refresh
// unreachable) it returns null — so pos.access emptied and every permission/feature-gated section
// collapsed, leaving unconditional Takeaway. The fix restores the valid, TTL-bounded cache offline
// regardless of getSession(). These tests lock BOTH: the gates are reachable from CACHED authority
// (no online), and the restore no longer requires a live session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

import { FEATURES } from "@/lib/features";
import {
  POS_PERMISSIONS,
  canOperatePOS,
  canViewTables,
  canViewDelivery,
  canViewTransfers,
  canCreateTransfer,
  canRequestForceEndShift,
  type PosAccessContext,
} from "@/lib/pos/access";

const here = dirname(fileURLToPath(import.meta.url));
const srcOf = (rel: string) => stripComments(readFileSync(join(here, "..", rel), "utf8"));

// A CACHED-OFFLINE access context: exactly what session.init restores from the durable cache for an
// active cashier — POS + the order-type features, and the section permissions.
const CACHED_OFFLINE: PosAccessContext = {
  membership: { role: "cashier", status: "active", branch_id: "b1" } as never,
  features: {
    [FEATURES.POS]: true,
    [FEATURES.POS_TAKEAWAY]: true,
    [FEATURES.POS_DINE_IN]: true,
    [FEATURES.POS_DELIVERY]: true,
  },
  permissions: {
    [POS_PERMISSIONS.ACCESS]: true,
    [POS_PERMISSIONS.CREATE_ORDERS]: true,
    [POS_PERMISSIONS.TABLES_VIEW]: true,
    [POS_PERMISSIONS.TRANSFERS_VIEW]: true,
    [POS_PERMISSIONS.TRANSFERS_CREATE]: true,
    [POS_PERMISSIONS.TRANSFERS_SELECT_RECIPIENT]: true,
    [POS_PERMISSIONS.END_OWN_SHIFT]: true,
  },
};

test("ACCESS MATRIX: with cached offline authority, every POS section is reachable (no online needed)", () => {
  assert.equal(canOperatePOS(CACHED_OFFLINE), true, "POS operable offline from cached auth");
  assert.equal(canViewTables(CACHED_OFFLINE).allowed, true, "Dine-In reachable offline");
  assert.equal(canViewDelivery(CACHED_OFFLINE).allowed, true, "Delivery reachable offline");
  assert.equal(canViewTransfers(CACHED_OFFLINE).allowed, true, "Transfer Center reachable offline");
  assert.equal(canCreateTransfer(CACHED_OFFLINE).allowed, true, "Transfer send reachable offline");
  assert.equal(canRequestForceEndShift(CACHED_OFFLINE, true).allowed, true, "Force-End (own) reachable offline");
});

test("the gates are pure authority (no connectivity term): identical result regardless of network", () => {
  // The gate functions take only (access); there is no online/reachability parameter, so losing the
  // backend cannot change whether a section opens — only cached authority does.
  assert.equal(canViewTables.length, 1);
  assert.equal(canViewDelivery.length, 1);
  assert.equal(canViewTransfers.length, 1);
});

test("EMPTY access (the pre-fix collapse) blocks the gated sections — which is why the cache MUST restore offline", () => {
  const empty: PosAccessContext = { membership: null, features: {}, permissions: {} };
  assert.equal(canOperatePOS(empty), false);
  assert.equal(canViewTables(empty).allowed, false);
  assert.equal(canViewDelivery(empty).allowed, false);
  assert.equal(canViewTransfers(empty).allowed, false);
  // Takeaway's rail entry is unconditional (enabled:true) — it survives an empty context, which is
  // exactly why only Takeaway remained accessible before the fix.
});

test("session.init restores the durable offline cache WITHOUT requiring a live getSession() session", () => {
  const src = srcOf("src/state/session.ts");
  // The offline-restore guard must NOT depend on data.session (that was the native blocker).
  assert.ok(
    !/if \(cache && Date\.now\(\) - cache\.cachedAt < OFFLINE_TTL_MS && data\.session\)/.test(src),
    "offline restore must not require data.session",
  );
  assert.match(src, /if \(cache && Date\.now\(\) - cache\.cachedAt < OFFLINE_TTL_MS\) \{/, "restores on a valid, non-expired cache alone");
  assert.match(src, /permissions: cache\.permissions,/, "restores cached permissions (so section gates pass offline)");
  assert.match(src, /features: cache\.features,/, "restores cached features");
});

test("PosShell gates rail items on permission (enabled), never on online; Takeaway stays unconditional", () => {
  const pw = srcOf("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /key: "takeaway",[\s\S]{0,80}enabled: true,/, "Takeaway rail is unconditional");
  assert.match(pw, /key: "dine_in",[\s\S]{0,120}enabled: tablesGate\.allowed,/, "Dine-In rail gated on permission, not online");
  assert.match(pw, /key: "delivery",[\s\S]{0,120}enabled: deliveryGate\.allowed,/, "Delivery rail gated on permission, not online");
});
