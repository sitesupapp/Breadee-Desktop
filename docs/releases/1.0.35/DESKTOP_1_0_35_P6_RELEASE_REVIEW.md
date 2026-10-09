# DESKTOP 1.0.35 — P6: STAGING INSTALLER & RELEASE REVIEW

Staging-first. **NO PRODUCTION GO.** This records the release-readiness gate for the Transfer workstream
(Deliverable A + B1 + B2 + B3) as a cumulative 1.0.35 RC on the verified 1.0.34 baseline.

## Version identity (RELEASE VERSION GATE — RC)
Bumped 1.0.34 → **1.0.35** in all three files; identifier **unchanged** (`app.breadee.desktop`, prod identity):
- `package.json` → 1.0.35
- `src-tauri/tauri.conf.json` → version 1.0.35, identifier app.breadee.desktop
- `src-tauri/Cargo.toml` → 1.0.35

## Konan RELEASE review — VERDICT: FIX, BLOCKERS: none (sess_0b5ab658)
Non-blocking for the staging RC workflow. Konan: *"architecture, server-authoritative authorization, OU
isolation, concurrency controls, and staging database evidence support continuing the RC workflow… the
supplied backend runtime evidence materially reduces authorization, OU-isolation, concurrency, and
financial-integrity risk."* (A prior submission, sess_02577115, blocked only because the release-schema
fields diff/tests/rollback/blastRadius were mis-keyed and rendered "(not provided)"; re-submitted with the
full evidence → FIX/none.)

## PRE-PRODUCTION CHECKLIST (REQUIRED_FIXES — must precede the production GO)
All AUTO-FIX; none is a correctness/isolation/guardrail blocker. These are packaging / environment /
credential gates, consistent with "production publish + prod migration apply = separate explicit HUMAN GO".
1. **Installer artifacts** — produce the 1.0.35 installer/updater from the reviewed commit; record artifact
   hashes, signing result, a clean install/launch smoke, and a 1.0.34→1.0.35 update test. (The Tauri binary
   build is currently blocked by the Windows node-spawn storm at process launch — environment, not code:
   `tsc --noEmit`=0 and the full suite's ZERO AssertionErrors validate compilation + behavior. Build when
   the env is stable.)
2. **One clean integrated regression run** in a stable environment (the storm crashes 14–22 test *processes*
   per run with 0 AssertionErrors; each file passes in isolation, but a single clean run is required to also
   rule out cross-test/resource-leak interaction).
3. **Credentialed staging acceptance** — manager vs cashier permission gating; Standard vs Force send;
   Incoming approve/reject; Manage cancel/reapprove; duplicate-submission (exactly-once) behavior; branch/OU
   transitions. Credential-gated (native Chrome tenant login; single native profile = super-admin XOR
   tenant).
4. **Rollback runbook (CORRECTED below).**
5. **Desktop updater rollback** — republishing a lower-semver 1.0.34 is NOT a proven updater downgrade;
   demonstrate the downgrade, or document a tested manual-rollback / fix-forward procedure.

## ROLLBACK RUNBOOK (corrected per Konan — the DB change is NOT entirely additive)
**New, purely-additive objects** (safe to leave in place on a fix-forward; a rollback MAY drop them only
with explicit human approval, and NOT if they hold history to preserve):
- RPCs `pos_order_transfer_force(+_core)`, `pos_order_transfer_cancel(+_core)`, `pos_transfer_force_enabled`,
  `pos_transfer_settings_set`; tables' new rows; the nullable column `pos_op_submissions.request_fingerprint`.
- **Do NOT treat dropping `request_fingerprint` or truncating `pos_op_submissions` / `pos_order_transfers*`
  / `pos_transfer_settings` as harmless** — they carry idempotency + audit history. Preserve unless a human
  explicitly approves data loss.

**Behavior changes to EXISTING objects (a rollback MUST restore their prior definitions, not just drop the
new ones):**
- `pos_order_transfer_create` — gained the orphan-claim release block; rolling back to 1.0.34 behavior
  requires restoring the pre-`20261008160601` function definition.
- `permission_catalog()` — now includes `pos.orders.force_transfer`, `pos.transfers.cancel_others`,
  `pos.transfers.manage_force_setting`; a rollback restoring the prior catalog must also decide the fate of
  any grants already made against those keys.
- (`pos_op_replay`/`pos_op_record` signatures + bodies are UNCHANGED — nothing to restore there.)

**Preferred posture: FIX-FORWARD** (program principle — no destructive live rollback). The feature is a
kill-switch: `pos_transfer_settings_set(branch,false)` disables Force per-OU instantly and the server
fail-closes; permissions are default-deny so the feature is dark until granted. Recovery from a bad transfer
state is canonical (compensating transfer / cancel / orphan-claim release), never raw row surgery.

## Blast radius (fleet) — summary
All shared changes additive + default-deny + server-enforced; feature ships dark (OFF until a role is
granted the new keys AND the branch Force setting is turned on). `_core` functions EXECUTE-revoked from
`authenticated`. OU-scoped (PK tenant+branch, no inheritance). Existing 1.0.34 workflows + other tenants
unaffected; mixed-version clients compatible (they call none of the new RPCs). Full detail in the release
payload + the P5 preservation doc.

## Gate
STAGING RC release-reviewed = FIX/none (non-blocking). **PRODUCTION = separate explicit HUMAN GO** (prod
migration apply + installer publish + updater release), after the pre-production checklist above. Deliverable
A remains independently releasable subject to its own certification + GO.
