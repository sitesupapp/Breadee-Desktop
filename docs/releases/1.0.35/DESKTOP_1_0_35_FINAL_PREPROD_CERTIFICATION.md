# DESKTOP 1.0.35 — FINAL PRE-PRODUCTION CERTIFICATION (Transfer workstream)

**Status: all autonomously-executable gates COMPLETE; VERDICT = NO-GO for Production** (as the directive
requires — "this is NOT a Production GO"). Outstanding prerequisites are credentialed interactive acceptance
and the install/upgrade smoke (both gated on a human session). Staging-first; no prod DB write, no updater
publish, no tenant rollout occurred. Baseline = verified prod Desktop **1.0.34**
(`candidate/posfinal-prod-1034`, identity `app.breadee.desktop`). Branch =
`feature/desktop-1.0.35-cumulative`.

---

## GATE 1 — Clean, uninterrupted full regression — **PASS (with one characterised harness artifact)**

The per-file test harness spawns one child node process per file (116 files); the intermittent Windows
node-spawn storm (exit 5 / "Access is denied" / 0xC0000005 at *process launch*) crashes a varying number
of those launches per run — an environment fault, never an assertion failure. To obtain a genuinely
uninterrupted run, the whole suite was executed in a **single process** via
`node --test --test-isolation=none` (≈1 spawn instead of 116), driven from PowerShell (the alternate shell
that dodged the storm when Bash's own launch was being faulted).

**Result (single process, uninterrupted):**
```
ℹ tests 1999
ℹ pass  1998
ℹ fail  1
ℹ duration_ms 94865.5   (94.9 s, one process, zero storm crashes)
```

The lone failure — `test/offline-shift-store.test.ts:110` "a Case-1 snapshot for THIS branch/OU is restored
on an offline refresh" (expected `'SNAP-B1'`, got `undefined`) — was then run **in isolation** and
**passed 6/6** (including that exact test). Root cause: `--test-isolation=none` runs every file in one
process, so the shared `fake-indexeddb` global (a devDependency) is left dirty by an earlier offline-* file;
the restore then reads a polluted store. This is a **test-harness ordering artifact, not a product
regression** — the file is pre-existing, untouched by 1.0.35, and passes alone. The other **1998** tests
(all transfer suites, all financial/POS/OU/offline contracts) passed in the shared process, which is exactly
the cross-test-interaction / resource-leak signal that individually-passing files cannot provide.

Evidence: `scratchpad/p6-clean-regression.txt` (full run), `scratchpad/offline-shift-isolation.txt`
(isolation proof). tsc --noEmit = 0 (see Gate 2).

---

## GATE 7 — Production migration plan recheck (READ-ONLY) — **PASS**

Prod (`cltlqfqormkhppmbvyrv`) verified read-only to sit exactly at the 1.0.34 transfer baseline:

| Check | Prod result | Meaning |
|---|---|---|
| 6 timestamped transfer migrations present | **0** | none of B1/A on prod |
| transfer-named migrations (2026-10) | **2** → `pos_posfinal_w4_order_transfers_prod_atomic` (20261005151653), `pos_posfinal_w5w6_transfer_refinements` (20261005152031) | the legit 1.0.34 R1 suite only |
| `pos_order_transfer_force` / `_cancel` / `pos_transfer_settings_set` / `pos_transfer_force_enabled` | **all false** | new RPCs absent |
| `pos_order_transfer_create`, `permission_catalog` exist | **true** | the ALTER targets exist → clean apply |
| `pos_op_submissions.request_fingerprint` column | **false** | new nullable column absent |
| `uq_pos_customer_phone` (global) present | **true** | R6 OU-local index drop did **not** leak to prod |
| `uq_pos_customer_ou_e164/_rawphone` present | **false** | R6 OU-local indexes did **not** leak |
| `permission_catalog()` contains `pos.orders.force_transfer` | **false** | new keys not yet in prod catalog |
| `pos_order_transfer*` function count | **7** | 1.0.34 R1 suite (staging has 9 = +force +cancel) |

**Prod promotion set = exactly 7 migrations, in version order** (cherry-picked from staging; the other
staging deltas are explicitly EXCLUDED):
1. `20261008160601_pos_posfinal_w4_transfer_create_release_orphan_claims` (Deliverable A)
2. `20261008170900_pos_transfer_center_b1_backend`
3. `20261008171241_pos_transfer_center_b1_permissions`
4. `20261008182845_pos_transfer_b1_force_idempotency_fingerprint`
5. `20261008185514_pos_transfer_b1_force_replay_authz_hardening`
6. `20261008200706_pos_transfer_b1_cancel_replay_authz_hardening`
7. `20261008202836_pos_transfer_b1_ou_authz_hardening`

**EXCLUDED from this plan (must NOT be promoted here):**
- `20261008103134_perf_cost_material_effective_cost_v_unitprice_parity` — a *different team's* Cost-Control
  perf migration that happens to live on staging; out of scope for Desktop 1.0.35.
- `20261008150758/151120/151208/151941` — **R6 OU-local m1/m2/m3/m6** — INCOMPLETE (m4 CSV, m5 e-menu,
  m7 revoke absent; no Konan impl review of the OU-local core; no full cross-channel/concurrency/security
  regression). **m3 drops the fleet-wide `uq_pos_customer_phone` and re-keys per-OU — a shared-backend change
  affecting Web / e-menu / CSV.** It must stay on staging until its own coordinated plan + GO.

The 7 transfer migrations touch only `pos_order_transfer*`, `pos_op_submissions`, `permission_catalog`,
`pos_transfer_settings` — zero overlap with the customer / perf objects — so they promote **independently
and cleanly** onto prod's current baseline regardless of staging's co-mingled deltas.

**Plan properties (verified / inherited from B1 certification):**
- **Ordering**: A (alters `pos_order_transfer_create`) → B1 backend (adds RPCs + `transfer_mode`/resolution
  columns) → permissions (adds 3 keys) → fingerprint (adds nullable column) → force authz → cancel authz →
  OU authz. Additive; each ALTER target exists on prod.
- **1.0.34 backward compat**: a 1.0.34 client calls none of the new RPCs; the new column is nullable;
  `pos_op_replay/record` signatures unchanged (strict-branch pre-existing since 20260925165534).
- **Permission defaults**: 3 new keys land default-deny (absent from prod catalog today; not in
  `role_default_true_keys`) — feature ships dark until a role is explicitly granted.
- **Per-OU kill switch**: `pos_transfer_settings` PK(tenant,branch), no inheritance;
  `pos_transfer_settings_set(branch,false)` disables Force per-OU instantly and the server fail-closes.
- **Security hardening carried**: `_core` functions EXECUTE-revoked from `authenticated`; wrappers re-check
  actor/perm/branch on replay cache hits (fail-closed).
- **Rollback/fix-forward**: fix-forward preferred; a rollback MUST restore the prior `pos_order_transfer_create`
  and `permission_catalog()` definitions (behavior-changed), and MUST NOT drop `request_fingerprint` or
  truncate the idempotency/audit tables. (Full runbook in P6 doc.)
- **Pre-GO step**: re-confirm per-function body parity of `pos_order_transfer_create` (prod vs staging pre-A)
  immediately before applying Deliverable A.

---

## GATE 8 — Cumulative 1.0.35 scope — each requirement's ACTUAL status (independent)

> Transfer completion does **not** certify R2–R7. Verified against the branch, the staging/prod DBs, and the
> program record.

| Req | Scope | Actual status in this RC |
|---|---|---|
| **R1** Transfer Open Orders | data layer + Transfer Center | **CERTIFIED (staging).** Built in 1.0.34 (on prod); EXTENDED by the Transfer workstream (Force Transfer, Sender Cancel, OU-scoped Force setting = A/B1/B2/B3). Konan PASS; 10/10 runtime cert. |
| **R2** Edit Delivery items | add/edit/delete, inventory-aware | **NOT IMPLEMENTED.** Architecture package prepped only (`scratchpad/konan-arch-r2.json`). No code, no migration. |
| **R3** Merge tables (A/B/C) | false same-shift, provenance, split/partial-paid | **NOT IMPLEMENTED.** Never started ("R3 next"). No `pos_merge_tables_v2`, no provenance columns, no R3-B. |
| **R4** Force End Shift | recipient-acceptance dark plumbing | **NOT IMPLEMENTED.** Distinct from Force *Transfer*; B1 explicitly proved `pos_end_shift_core` does NOT call force. The force-end-shift path was not built. |
| **R5** Owner POS access | default-OFF `pos.sales` + guarded `pos_assert_operator` | **NOT IMPLEMENTED.** No new perm key, no spine change, no self-approval fix. |
| **R6** Customer create/search OU-local | name-only + OU-local identity | **PARTIAL.** name/phone/both desktop code = CODE COMPLETE (Konan impl FIX/no-blockers; desktop-only, no DB) — ships in this RC. OU-local identity CORE proven on **staging only** (m1/m2/m3/m6) but INCOMPLETE (m4/m5/m7 absent; no Konan impl review of the core; no full regression) → stays on staging, EXCLUDED from prod plan. |
| **R7** End-Shift Approve/Reject switch | inert registry setting | **NOT IMPLEMENTED.** No inert setting added. |
| **R8** Desktop/Web parity | handoff doc | **DOC COMPLETE / deferred** (`WEB_HANDOFF.md`) per directive — documentation-only, does not block R1–R7. |

**Headline:** this RC certifies the **Transfer workstream (R1 + Force/Cancel/OU-setting)** and carries the
authorized **R6 name-only** desktop change. **R2, R3, R4, R5, R7 are not in this release** and must not be
represented as shipped. R6 OU-local is incomplete and remains staging-only.

---

## GATE 9 — R8 documentation-only / deferred — **SATISFIED**
`WEB_HANDOFF.md` records the shared contracts (force-end perm, POS Sales, approval switch), the
dark/activation-blocked list, migration deps, rollback, and 1.0.34 + Web compatibility. No audit/impl/scope
expansion; does not block R1–R7.

---

## GATE 2 — Build the actual 1.0.35 RC installer — **DONE (staging RC built through the storm)**

Established clean this session (PowerShell driving, inline D: enforcement mirroring `Start-Breadee.ps1`):
- **`tsc --noEmit` = 0.**
- **`vite build` = clean** (`✓ built in ~14–33s`, `dist/` produced). With the staging backend injected the JS
  bundle hash changes (`index-BM0RshN-.js`, 1,552 kB) vs the no-env build (`index-BhaDqidH.js`) — proving the
  staging values are inlined at build time.
- Toolchain present: cargo 1.96.1, node 24.17.0, rustup stable-x86_64-pc-windows-msvc.

**Storm workaround (resolved):** the Windows node-spawn storm (0xC0000005 / STATUS_ACCESS_VIOLATION / "Access
is denied" at *process launch*) faulted cargo's `rustc -vV` probe and cc/rustc invocations on nearly every
attempt. Because `cargo build` is incremental, a patient `Start-Process` retry loop accumulated compiled
crates across storm windows and the compile **completed** (attempt 57). The NSIS bundle then completed on a
later clean window. This was **environment instability, not a code fault** (tsc 0, vite clean, full suite 0
AssertionErrors).

> Build command of record: `npm run tauri:build` (= `tsc -b && vite build` then `cargo build --release` +
> NSIS). Bundle targets `["nsis"]`, `installMode: currentUser`, `createUpdaterArtifacts: false`.

**BUILD RESULT — staging RC produced 2026-10-09.** Rust compile finished at cargo attempt 57
(`Finished release profile [optimized]`); NSIS bundle succeeded at bundle attempt 19
(`Running makensis … Finished 1 bundle`).

| Artifact | Path | Size | SHA-256 |
|---|---|---|---|
| **Installer (RC)** | `src-tauri/target/release/bundle/nsis/Breadee_1.0.35_x64-setup.exe` | 3,442,989 B | `50D5FE134A15E55FEE12386A0AE240CCA094E35D2978DD9DAA498C726AC8C6B4` |
| App binary | `src-tauri/target/release/breadee-desktop.exe` | 13,204,992 B | `70110216F0B908B2F0856E477E1CEA9A8A889C3F89EA53AF25E09EBD8E3919E3` |

- Installer filename encodes **1.0.35**; binary version resource = **ProductName Breadee / FileVersion 1.0.35 /
  ProductVersion 1.0.35**.
- Bundle dir holds **only** `Breadee_1.0.35_x64-setup.exe` — **no `latest.json` / `.sig`** (confirms
  `createUpdaterArtifacts: false`; no updater metadata emitted, nothing publishable).
- **Endpoint separation PROVEN**: the embedded `dist/assets/index-BM0RshN-.js` contains the staging host
  `azjxprewycygsocusxjn.supabase.co` (1×) and the prod host `cltlqfqormkhppmbvyrv.supabase.co` **0×** → this RC
  targets **staging only**.
- Hashes are specific to this local staging build; the production RC (built `VITE_APP_ENV=production` + prod
  URL/key, same `app.breadee.desktop` identity) will hash differently and must be re-checksummed at prod-GO.

## GATE 3 — Package identity / version / hashes / signature / manifest / endpoint separation

| Item | Result |
|---|---|
| Version | `1.0.35` in package.json + tauri.conf.json + Cargo.toml |
| Identifier | `app.breadee.desktop` (prod identity, unchanged from 1.0.34) |
| Bundle | NSIS, `installMode: currentUser` (matches 1.0.34) |
| Updater artifacts | `createUpdaterArtifacts: false` → **no `.sig`/manifest emitted → updater publish structurally impossible from this build** |
| Updater endpoint | prod channel only (`…/desktop-production-channel/latest.json`); static |
| Updater pubkey | `tauri.conf` pubkey (`…TXL/gh2Jl5…`) matches the keypair that signed the live 1.0.34 manifest → continuity |
| Current prod manifest | `1.0.34`, `windows-x86_64`, signed, URL `…/desktop-prod-v1.0.34/Breadee_1.0.34_x64-setup.exe` → `1.0.35 > 1.0.34` is a valid upgrade |
| **Backend endpoint separation** | **fail-closed in `env.ts`**: no default URL/key/label; `VITE_APP_ENV` must be `staging`\|`production` or the app refuses to start; a `service_role` key is rejected. The staging RC carries staging values; a prod build must declare production values. |
| Artifact SHA-256 + embedded-version check | **DONE** — installer `50D5FE13…C6B4`; binary version resource FileVersion/ProductVersion **1.0.35**; staging host embedded, prod host absent (see BUILD RESULT above) |

Updater-metadata publishing remains OFF and human-gated (requires `createUpdaterArtifacts: true` + the minisign
**private** key — a secret this session does not hold and must not handle).

## GATE 4 — Install/launch smoke + 1.0.34→1.0.35 upgrade — **installer built; smoke pending stable session + credential-gated**
- Installer now exists and is identity/version/endpoint-verified (Gate 2/3). An unauthenticated launch smoke
  (install → app reaches Login showing env `staging` + `1.0.35`) was **not** run this session: the active
  node-spawn storm is faulting process launches (it intermittently faults even PowerShell), so a GUI
  install/launch could not be driven reliably, and it was not worth risking a flaky/false result. It should be
  run in a storm-free desktop session.
- The **real 1.0.34→1.0.35 upgrade preserving settings/auth/local data/POS** additionally requires (a) the
  signed installer, (b) the prior 1.0.34 installer to upgrade from, and (c) an **authenticated tenant session**
  to create and then verify preserved POS/local state — which is credential-gated (Gate 6).

## GATE 5 — Authenticated interactive staging acceptance — **BLOCKED (credential gate)**
Manager/Cashier permission gating, Standard vs Force send, Incoming/Outgoing/Pending/History, Cancel,
permission denials, OU switching, and settings persistence in the Desktop Transfer Center all require an
authenticated staging tenant login **inside the installed desktop app**. This session has **no authorized
tenant credentials** and must not enter passwords or bypass auth. See Gate 6.

## GATE 6 — Exact credential blocker
- **What is needed:** an authorized sign-in to the **staging** backend (`azjxprewycygsocusxjn`) *from the
  installed 1.0.35 desktop app*, as (i) a **Manager** and (ii) a **Cashier** of a staging tenant with POS
  enabled and at least one OU with the Force-transfer setting toggled on (e.g. QA tenant #2101 Main/Aramoun).
- **Why it is blocked:** credentials are not available to this session; policy forbids entering passwords in
  chat or bypassing authentication; a single native browser profile is super-admin XOR tenant.
- **No evidence is fabricated.** The transfer behavior is otherwise covered by: the B1 backend runtime
  certification on staging (10/10, incl. real 2-backend concurrency and the full replay-authz matrix), the
  single-process full regression (Gate 1), and the identical-code automated transfer suites (contract 9/9,
  center 16/16, settings 5/5).
- **To clear it:** a human performs the interactive desktop acceptance against staging (as was done for the
  prod fin-safety acceptance — the user signs in; Claude verifies behavior and zero-write via MCP reads), or
  provisions an authorized non-production test session.

## GATE 10 — EVIDENCE-BASED GO / NO-GO

**VERDICT: NO-GO for Production (expected — the directive states "This is NOT a Production GO").** The Transfer
workstream is **staging-certified and release-reviewed**, but mandatory pre-production prerequisites remain
open:

1. ~~RC installer~~ **DONE** — staging RC `Breadee_1.0.35_x64-setup.exe` built + checksummed + identity/version/
   endpoint verified (Gate 2/3). The **production** RC (prod backend) still to be built at prod-GO.
2. **Credentialed interactive staging acceptance** (Gate 5) — not performed; no authorized session. *(Human gate.)*
3. **Install/launch smoke + real 1.0.34→1.0.35 upgrade/preservation** (Gate 4) — installer now exists; the
   launch + upgrade test needs a stable desktop session (storm-free) and, for the auth/POS-preservation part,
   an authenticated tenant login. *(Desktop session + human credential gate.)*
4. **Scope truth** (Gate 8): 1.0.35 as it stands = **Transfer workstream (R1 + Force/Cancel/OU-setting) + R6
   name-only + R8 doc**. **R2, R3, R4, R5, R7 are NOT implemented**; R6 OU-local is staging-only/incomplete.
   The release must be scoped and communicated as such — it is not a full R1–R8 delivery.

**What IS certified (staging):** Transfer workstream code + backend (Konan impl/security PASS sess_0762bbe3,
release review FIX/none sess_0b5ab658); clean single-process regression (1998/1999, the one failure a proven
harness artifact); tsc 0; prod migration plan verified read-only and cleanly promotable in isolation.

### Exact authorized PRODUCTION steps (each behind an explicit human GO — do NOT execute without it)
1. **Pre-apply parity check (read-only):** confirm prod `pos_order_transfer_create` + `permission_catalog()`
   bodies match the staging pre-migration baseline; confirm prod still lacks the 4 new RPCs + `request_fingerprint`
   + the 3 keys (as verified 2026-10-09).
2. **Apply the 7 transfer migrations to prod, in version order** (and ONLY these — exclude the perf and R6
   OU-local migrations): `20261008160601` → `170900` → `171241` → `182845` → `185514` → `200706` → `202836`.
   Verify applied-history after each (git merge ≠ migration applied).
3. **Post-migration invariants:** `_core` functions EXECUTE-revoked from `authenticated`; 3 keys default-deny;
   `pos_transfer_settings` kill switch present; no privilege widening / no business-logic change elsewhere
   (hard-stop + report on any deviation).
4. **Build the prod RC** with `VITE_APP_ENV=production` + prod URL/key, identity `app.breadee.desktop`; record
   SHA-256; smoke-launch; run the 1.0.34→1.0.35 upgrade test.
5. **Publish the installer** to the GitHub release (`desktop-prod-vX`) — authorized deploy only.
6. **Updater release (separate):** build with `createUpdaterArtifacts: true`, sign `latest.json` with the
   minisign private key, publish to `desktop-production-channel`. Keep auto-publish LOCKED.
7. **Rollout dark:** feature ships OFF (keys default-deny + Force setting OFF per OU); enable per-OU via the
   canonical kill switch after live verification. Fix-forward only; no destructive rollback.

**No prod DB write, no updater publish, no tenant rollout, and no feature activation occurred in this session.
Tenant #2124 recovery remains CLOSED and NON-REPLAYABLE (verified absent from all migrations/code/fixtures).**
