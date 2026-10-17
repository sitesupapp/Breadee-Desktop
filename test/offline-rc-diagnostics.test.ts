// Phase F — SECOND-PASS runtime-first native blocker. The first fix (session.init
// cache-restore) did NOT change the native symptom, so this pass does NOT make a
// third speculative fix: it ships a DIAGNOSTIC RC that proves which build runs and
// surfaces the offline access decision on-screen, so ONE reproduction localizes the
// blocker. These tests lock three things:
//   1. the reported symptom is a PARTIAL access context (not a fully-empty one) —
//      which is exactly what the on-screen readout is built to expose;
//   2. the diagnostics are INERT by default (gated on env.RC_DIAGNOSTICS), so a
//      normal / production build is byte-for-byte unaffected;
//   3. the RC is a DISTINCT, identifiable build (version bump + injected SHA/run).
//
// The env-dependent modules (env.ts / rcDiagnostics.ts) cannot be imported under the
// dependency-free node runner, so their wiring is asserted at the source level, the
// same way session.ts / PosWorkspace.tsx are checked elsewhere.

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
const rawOf = (rel: string) => readFileSync(join(here, "..", rel), "utf8");

// The EXACT shape the native result reports: the workspace is usable (canOperatePOS
// true → Takeaway renders and works) but the four gated sections refuse — because
// access carries ONLY base POS (the `pos` feature + `pos.access`) and none of the
// section-specific features/permissions. A FULLY-empty context would instead fail
// canOperatePOS and show the denial screen (no rail at all), which is NOT what the
// tester saw. This is the fingerprint the RC readout must reveal.
const BASE_ONLY: PosAccessContext = {
  membership: { role: "cashier", status: "active" } as never,
  features: { [FEATURES.POS]: true },
  permissions: { [POS_PERMISSIONS.ACCESS]: true, [POS_PERMISSIONS.CREATE_ORDERS]: true },
};

test("symptom is reproducible as a PARTIAL access context (Takeaway works, the four gated sections refuse)", () => {
  assert.equal(canOperatePOS(BASE_ONLY), true, "workspace usable → explains 'Takeaway works'");
  assert.equal(canViewTables(BASE_ONLY).allowed, false, "Dine-in refused (needs pos.dine_in + pos.tables.view)");
  assert.equal(canViewDelivery(BASE_ONLY).allowed, false, "Delivery refused (needs pos.delivery)");
  assert.equal(canViewTransfers(BASE_ONLY).allowed, false, "Transfer refused (needs a transfer perm)");
  assert.equal(canCreateTransfer(BASE_ONLY).allowed, false);
  assert.equal(canRequestForceEndShift(BASE_ONLY, false).allowed, false, "Force-End refused (needs close_other_shifts)");
});

test("env.ts exposes the RC build fingerprint (SHA / run / diagnostics flag)", () => {
  const src = srcOf("src/env.ts");
  assert.match(src, /BUILD_SHA:/, "BUILD_SHA exposed on env");
  assert.match(src, /BUILD_RUN:/, "BUILD_RUN exposed on env");
  assert.match(src, /RC_DIAGNOSTICS:/, "RC_DIAGNOSTICS exposed on env");
  assert.match(src, /VITE_RC_DIAGNOSTICS/, "reads the VITE_RC_DIAGNOSTICS build var");
});

test("diagnostics are INERT by default — a normal build renders nothing and logs nothing", () => {
  const diag = srcOf("src/lib/rcDiagnostics.ts");
  // The single switch is strictly VITE_RC_DIAGNOSTICS === "1" (absent everywhere else).
  assert.match(diag, /rcDiagnosticsOn = env\.RC_DIAGNOSTICS === true/);
  // Every emitter fail-closes on the flag.
  for (const fn of ["rcLogStartup", "rcLogSnapshot", "rcLogNav"]) {
    const body = diag.slice(diag.indexOf(`export function ${fn}`));
    assert.match(body.slice(0, 220), /if \(!rcDiagnosticsOn\) return;/, `${fn} is gated`);
  }
  // The on-screen strip renders null unless the flag is on.
  const strip = srcOf("src/components/pos/RcDiagnosticStrip.tsx");
  assert.match(strip, /if \(!rcDiagnosticsOn\) return null;/);
  // The About/Help build block is gated too.
  const help = srcOf("src/screens/settings/Help.tsx");
  assert.match(help, /if \(!rcDiagnosticsOn\) return null;/);
});

test("rcAccessInputs maps the DECISIVE feature/permission keys the four gates consume", () => {
  const diag = srcOf("src/lib/rcDiagnostics.ts");
  assert.match(diag, /featPos: hasFeature\(ctx\.features, FEATURES\.POS\)/);
  assert.match(diag, /featDineIn: hasFeature\(ctx\.features, FEATURES\.POS_DINE_IN\)/);
  assert.match(diag, /featDelivery: hasFeature\(ctx\.features, FEATURES\.POS_DELIVERY\)/);
  assert.match(diag, /POS_PERMISSIONS\.TABLES_VIEW/);
  assert.match(diag, /POS_PERMISSIONS\.CLOSE_OTHER_SHIFTS/);
});

test("PosWorkspace mounts the readout and traces the four nav clicks; main logs the build at startup", () => {
  const pw = srcOf("src/screens/pos/PosWorkspace.tsx");
  assert.match(pw, /<RcDiagnosticStrip snapshot=\{rcSnapshot\} \/>/, "readout mounted");
  assert.match(pw, /rcLogNav\("dine_in"/);
  assert.match(pw, /rcLogNav\("delivery"/);
  assert.match(pw, /rcLogNav\("transfer"/);
  assert.match(pw, /rcLogNav\("force_end"/);
  assert.match(pw, /inputs: rcAccessInputs\(pos\.access\)/, "snapshot carries the decisive inputs");
  const main = srcOf("src/main.tsx");
  assert.match(main, /rcLogStartup\(\);/, "startup trace wired");
});

test("the RC is a DISTINCT, identifiable build (version bumped; SHA/run/flag injected by CI)", () => {
  const conf = JSON.parse(rawOf("src-tauri/tauri.conf.json")) as { version: string; identifier: string };
  assert.equal(conf.version, "1.0.37-rc.4", "version bumped so Windows cannot reuse the prior package");
  assert.equal(conf.identifier, "app.breadee.desktop.offlinerc", "isolated bundle identity preserved");
  const wf = rawOf(".github/workflows/desktop-windows-installer.yml");
  assert.match(wf, /VITE_BUILD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(wf, /VITE_BUILD_RUN: \$\{\{ github\.run_id \}\}/);
  assert.match(wf, /VITE_RC_DIAGNOSTICS: "1"/);
});
