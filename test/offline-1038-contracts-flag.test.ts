// 1.0.38 — one switch for "the 1.0.38 server contracts are live on this backend". OFF unless the build sets
// VITE_SERVER_1038_CONTRACTS=1 (or the server reports the capability): an accidental early release must behave
// like 1.0.37 for part-paid settlement and offline Move/Merge, never rely on contracts the server lacks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  SERVER_DEDUCTS_PRIOR_PAYMENTS_AT_RELEASE,
  server1038ContractsLive,
  serverDeductsPriorPayments,
  setServerDeductsPriorPayments,
} from "@/lib/pos/tablePayment";

test("default build: the 1.0.38 contracts switch is OFF", () => {
  assert.equal(SERVER_DEDUCTS_PRIOR_PAYMENTS_AT_RELEASE, false);
  assert.equal(server1038ContractsLive(), false);
  assert.equal(serverDeductsPriorPayments(), false);
});

test("a server capability widens it, and null returns to the build default", () => {
  setServerDeductsPriorPayments(true);
  assert.equal(server1038ContractsLive(), true);
  setServerDeductsPriorPayments(null);
  assert.equal(server1038ContractsLive(), false);
});

test("the flag is read from the build env, and offline Move/Merge capture is gated by the same switch", () => {
  const tp = readFileSync(new URL("../src/lib/pos/tablePayment.ts", import.meta.url), "utf8");
  assert.match(tp, /VITE_SERVER_1038_CONTRACTS \?\? ""\)\.trim\(\) === "1"/);
  const dw = readFileSync(new URL("../src/screens/pos/DineInWorkspace.tsx", import.meta.url), "utf8");
  assert.match(dw, /offlineCapable: offlineProjOn && server1038ContractsLive\(\)/);
});
