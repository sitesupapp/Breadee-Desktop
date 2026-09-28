// READY POS Phase F — Auto-Seat / Direct Table Open (desktop).
// The setting is server-authoritative (pos_receipt_settings.auto_seat_direct_open).
// These tests lock the offline-safe cache read and the open-flow decision: skip the
// seat prompt ONLY when the setting is ON and the table has a published seat count;
// otherwise the existing seat modal appears. Never invents a seat count, never blocks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, "..", "src", p), "utf8").replace(/\r\n/g, "\n");

// ---- unit: the offline-safe cache read (defaults OFF) ----------------------
// A tiny in-memory localStorage so the pure cache reader can be exercised.
const store: Record<string, string> = {};
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = String(v); },
  removeItem: (k: string) => { delete store[k]; },
};

const { readCachedAutoSeat } = await import("@/lib/pos/autoSeat");

test("A. cache read defaults to OFF when the branch has no synchronized value", () => {
  assert.equal(readCachedAutoSeat("branch-x"), false);
  assert.equal(readCachedAutoSeat(null), false);
  assert.equal(readCachedAutoSeat(undefined), false);
});

test("H/I. cache read reflects the last synchronized value ('1' => on, anything else => off)", () => {
  store["breadee-desktop-autoseat:b1"] = "1";
  assert.equal(readCachedAutoSeat("b1"), true);
  store["breadee-desktop-autoseat:b1"] = "0";
  assert.equal(readCachedAutoSeat("b1"), false);
});

// ---- source contract: autoSeat.ts reads the canonical row, fail-safe -------
test("autoSeat.ts reads pos_receipt_settings, tenant+branch scoped, and never a draft source", () => {
  const s = src("lib/pos/autoSeat.ts");
  assert.match(s, /from\("pos_receipt_settings"\)/);
  assert.match(s, /\.select\("auto_seat_direct_open"\)/);
  assert.match(s, /\.eq\("tenant_id", tenantId\)/);
  assert.match(s, /\.eq\("branch_id", branchId\)/);
  // canonical published settings only — never reads a floor DRAFT source RPC/table
  assert.doesNotMatch(s, /floor_draft|floor_autosave_draft|floor_layout|_draft"/i);
  // fail-safe: on error return the cached value; default OFF
  assert.match(s, /return readCachedAutoSeat\(branchId\)/);
});

// ---- source contract: the open-flow decision ------------------------------
test("C/E. ON + published seats => open directly with the EXACT published seat count", () => {
  const s = src("screens/pos/DineInWorkspace.tsx");
  assert.match(s, /if \(autoSeat && selected && \(selected\.seats \?\? 0\) > 0\) \{\s*\n\s*void confirmOpen\(selected\.seats\);/);
});

test("B/D. OFF, or ON without a published seat count, falls back to the seat modal", () => {
  const s = src("screens/pos/DineInWorkspace.tsx");
  // requestOpenSelected ends by opening the existing modal when the fast path is not taken
  assert.match(s, /setManualOpen\(false\);\s*\n\s*setSeatOpen\(true\);/);
});

test("the setting starts from the synchronized cache and refreshes online (offline-safe)", () => {
  const s = src("screens/pos/DineInWorkspace.tsx");
  assert.match(s, /useState<boolean>\(\(\) => readCachedAutoSeat\(pos\.branch\.id\)\)/);
  assert.match(s, /loadAutoSeatDirectOpen\(pos\.tenantId, pos\.branch\.id\)/);
  assert.match(s, /if \(!input\.online\) return;/);
});

test("both free-table open triggers (keyboard + panel) route through requestOpenSelected", () => {
  const s = src("screens/pos/DineInWorkspace.tsx");
  assert.match(s, /tableOpen: \(\) => \{[\s\S]{0,140}requestOpenSelected\(\);/);
  assert.match(s, /onOpenTable=\{requestOpenSelected\}/);
});

test("G/K/L. no new cashier permission; occupied/manual/split/floor paths untouched", () => {
  const s = src("screens/pos/DineInWorkspace.tsx");
  // MANUAL open still forces the modal (a brand-new table has no published seats)
  assert.match(s, /setManualOpen\(true\);\s*\n\s*setSeatOpen\(true\);/);
  // auto-seat gates on the tenant setting only — no per-user permission check added
  assert.doesNotMatch(src("lib/pos/autoSeat.ts"), /can_user_permission|permission/i);
});
