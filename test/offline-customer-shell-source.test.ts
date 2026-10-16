// Phase E (E1/E2) — the customer-picker offline wiring, asserted against source (DOM execution is
// unavailable here). Locks: the ONLINE find/create/conflict path is unchanged, the OFFLINE branch
// captures via the proof-free engine with a deterministic client_op_id, the write gate upgrades to
// allowed offline ONLY with readiness + permission, and both workspaces thread offlineReady.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripComments } from "./source-helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const ts = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"));

const PICKER = "src/state/customerPicker.ts";
const PW = "src/screens/pos/PosWorkspace.tsx";
const DW = "src/screens/pos/DineInWorkspace.tsx";

test("picker: the ONLINE create path (performCustomerCreate) is preserved", () => {
  const src = ts(PICKER);
  assert.match(src, /const outcome = await performCustomerCreate\(\{/, "online create path intact");
  assert.match(src, /resolveCustomerConflict\(conflict\.payload, conflict\.error\.conflictToken\)/, "conflict verify-and-link intact");
});

test("picker: the OFFLINE branch captures via upsertCustomerOfflineAware with a deterministic id", () => {
  const src = ts(PICKER);
  assert.match(src, /if \(!online && offlineReady\)/, "offline create branch gated on offline + ready");
  assert.match(src, /deterministicUuid\(\[branchId \?\? "", decision\.phone \?\? "", decision\.name \?\? "", "customer_create"\]\)/, "deterministic client_op_id");
  assert.match(src, /await upsertCustomerOfflineAware\(/, "captures via the offline-aware authority");
});

test("picker: the write gate upgrades to allowed offline ONLY with readiness + permission", () => {
  const src = ts(PICKER);
  assert.match(src, /!gate\.allowed && !online && offlineReady && !saving && \(canManageCustomers\(access\) \|\| canCreateOrders\(access\)\.allowed\)/);
});

test("workspaces thread offlineReady into the picker", () => {
  assert.match(ts(PW), /offlineReady: Boolean\(tenantId && userId\)/, "PosWorkspace threads readiness");
  assert.match(ts(DW), /offlineReady: input\.offlineReady === true && input\.offlineScope != null/, "DineInWorkspace threads readiness");
});
