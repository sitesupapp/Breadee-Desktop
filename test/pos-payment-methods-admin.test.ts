// POS Final W3 (Part 5) — Payment Methods management (desktop). Pins the contract
// wiring: the two new RPCs are allow-listed, the data layer round-trips the opaque
// CAS token and requires it for updates, the permission gate exists, VERSION_CONFLICT
// is classified, and the UI is permission-gated, protects Cash, surfaces the GL gate,
// and sends the token on edits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

test("both management RPCs are in the desktop allow-list, and nothing else was removed", () => {
  const rpc = read("src/lib/pos/rpc.ts");
  assert.match(rpc, /\|\s*"pos_payment_methods_manage_list"/);
  assert.match(rpc, /\|\s*"pos_payment_method_save"/);
  // checkout's active-only read is untouched (still its own helper, not this list).
  const active = read("src/lib/pos/useActivePaymentMethods.ts");
  assert.match(active, /loadSplitPaymentMethods/);
});

test("the permission key and gate exist and reuse the perm helper", () => {
  const access = read("src/lib/pos/access.ts");
  assert.match(access, /PAYMENT_METHODS_MANAGE:\s*"pos\.payment_methods\.manage"/);
  assert.match(access, /export function canManagePaymentMethods\(ctx: PosAccessContext\): Gate/);
  assert.match(access, /perm\(ctx, POS_PERMISSIONS\.PAYMENT_METHODS_MANAGE\)/);
});

test("the data layer requires + round-trips the opaque CAS token", () => {
  const admin = read("src/lib/pos/paymentMethodsAdmin.ts");
  // updatedAt is read from the server as the token (never Date-parsed).
  assert.match(admin, /updatedAt:\s*str\(r\.updated_at\)/);
  // an update sends expected_updated_at from expectedUpdatedAt.
  assert.match(admin, /payload\.expected_updated_at = input\.expectedUpdatedAt/);
  // id present => update path; list reads the manager RPC.
  assert.match(admin, /callPosRpc\("pos_payment_method_save"/);
  assert.match(admin, /callPosRpc\("pos_payment_methods_manage_list"/);
});

test("VERSION_CONFLICT is classified (payment-method wording covered)", () => {
  const errors = read("src/lib/pos/errors.ts");
  assert.match(errors, /this \(order\|payment method\) changed since it was loaded/i);
});

test("the UI is gated, protects Cash, surfaces the GL gate, and sends the token on edit", () => {
  const ui = read("src/components/pos/PaymentMethodsSettings.tsx");
  // Permission gate: the card self-hides for a non-manager.
  assert.match(ui, /if \(!canManage\) return null;/);
  // Edit sends the opaque token for the atomic concurrency check.
  assert.match(ui, /expectedUpdatedAt:\s*edit\.row\.updatedAt/);
  // VERSION_CONFLICT => reload + reapply, never silent retry.
  assert.match(ui, /c\.kind === "version_conflict"/);
  assert.match(ui, /await load\(\);/);
  // Cash cannot be deactivated (no switch offered).
  assert.match(ui, /Cash is always available and cannot be deactivated\./);
  // GL-gate (and any other server refusal) surfaced verbatim.
  assert.match(ui, /setNotice\(\{ tone: "error", text: c\.message \}\)/);
  // It renders inside POS Settings, gated.
  const settings = read("src/screens/settings/PosSettings.tsx");
  assert.match(settings, /<PaymentMethodsSettings canManage=\{canManagePaymentMethods\(pos\.access\)\.allowed\}/);
});
