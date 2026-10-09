// Desktop 1.0.35 (B3) — Transfer Settings/Permissions integration (desktop). Pins the client surface for
// the OU-scoped Force-Transfer setting toggle: the write RPC is allow-listed, the manage permission key +
// gate exist, the data layer shapes the payload (optional expected_config_version), and Settings → POS
// Settings renders the gated branch-wide toggle. Server authority is the B1 RPC pos_transfer_settings_set
// (default-deny pos.transfers.manage_force_setting, PK tenant+branch, no inheritance), proven on staging.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildForceSettingPayload } from "@/lib/pos/transfers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

test("the Force-setting WRITE RPC is allow-listed (B3)", () => {
  const rpc = read("src/lib/pos/rpc.ts");
  assert.match(rpc, /\|\s*"pos_transfer_settings_set"/);
});

test("the manage-force-setting permission key + gate exist (B3)", () => {
  const access = read("src/lib/pos/access.ts");
  assert.match(access, /TRANSFERS_MANAGE_FORCE_SETTING:\s*"pos\.transfers\.manage_force_setting"/);
  assert.match(access, /export function canManageForceSetting/);
});

test("the data layer maps the setter and reader", () => {
  const t = read("src/lib/pos/transfers.ts");
  assert.match(t, /export async function setForceTransferEnabled/);
  assert.match(t, /callPosRpc\("pos_transfer_settings_set"/);
  assert.match(t, /export async function isForceTransferEnabled/);
  assert.match(t, /callPosRpc\("pos_transfer_force_enabled", \{ p_branch: branchId \}\)/);
});

test("Settings → POS Settings renders the gated branch-wide Force-Transfer toggle", () => {
  const s = read("src/screens/settings/PosSettings.tsx");
  assert.match(s, /import \{ ForceTransferSettings \}/);
  assert.match(s, /canManageForceSetting/);
  assert.match(s, /<ForceTransferSettings/);
  const c = read("src/components/pos/ForceTransferSettings.tsx");
  // reads the current value, writes through the RPC wrapper, optimistic-with-rollback, gated + disabled.
  assert.match(c, /isForceTransferEnabled\(branchId\)/);
  assert.match(c, /setForceTransferEnabled\(\{ branchId, enabled: next \}\)/);
  assert.match(c, /setEnabled\(previous \?\? null\)/); // rollback on failure (to null => disabled if unknown)
  assert.match(c, /disabled=\{!canManage \|\| saving \|\| loading \|\| enabled === null\}/);
  assert.match(c, /Branch-wide/); // scope is labelled (no inheritance)
  // OU ISOLATION by REMOUNT: PosSettings keys the component by branch, so a branch change mounts a fresh
  // instance (initial enabled=null/loading=true) — branch A's value can never render for branch B, and NO
  // unsafe render-time ref mutation is used. seqRef only orders requests WITHIN a single branch mount.
  assert.match(s, /key=\{branchId \?\? "no-branch"\}/); // keyed remount at integration
  assert.match(c, /const seqRef = useRef\(0\)/);
  assert.doesNotMatch(c, /branchRef/); // no render-time ref mutation (unsafe under concurrent/abandoned renders)
  assert.doesNotMatch(c, /ctx === branchId/); // the tautological guard is gone
  assert.equal((c.match(/if \(seq === seqRef\.current\)/g) || []).length >= 5, true); // seq-only completion guards
  assert.match(c, /const seq = \(seqRef\.current \+= 1\); \/\/ a write supersedes any in-flight read/);
});

test("buildForceSettingPayload includes expected_config_version ONLY when a real integer is supplied", () => {
  const base = buildForceSettingPayload({ branchId: "b1", enabled: true });
  assert.equal(base.branch_id, "b1");
  assert.equal(base.force_transfer_enabled, true);
  assert.ok(!("expected_config_version" in base)); // omitted => simple set (server still audits)
  const cas = buildForceSettingPayload({ branchId: "b1", enabled: false, expectedConfigVersion: 3 });
  assert.equal(cas.expected_config_version, 3);
  assert.equal(cas.force_transfer_enabled, false);
  // a non-integer version is NEVER sent as null/NaN
  const bad = buildForceSettingPayload({ branchId: "b1", enabled: true, expectedConfigVersion: Number.NaN });
  assert.ok(!("expected_config_version" in bad));
});
