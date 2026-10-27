# Final Foundation: device binding and signed offline entitlement

## Staging status (azjxprewycygsocusxjn), applied 2026-10-27

| Step | Result |
|---|---|
| Rehearsal: the migration plus `foundation_desktop_devices_probes_ROLLEDBACK.sql`, run as one batch | 20/20 probes passed. Everything rolled back, and a check afterwards found 0 tables and 0 functions. |
| Apply (`apply_migration` `foundation_desktop_devices`) | Applied. Pre-check: no `desktop_*` objects existed. Post-check: 2 tables, both with RLS on, 0 policies, and table access for postgres and service_role only. 7 functions, all SECURITY DEFINER, owner postgres, `search_path=public`. |
| Probes after apply (rolled back) | 20/20 passed. 0 rows were left behind. |
| Function body md5 (`md5(prosrc)`) | attest d17764b6…, challenge 9334a361…, precheck f4b90357…, register 5106fac4…, revoke cc0914c1…, status 17072e71…, signing_key b5190c3d… |
| Signing key (`foundation_desktop_entitlement_key_bootstrap.sql`) | Vault secret `desktop_entitlement_es256_d` was generated in the database. It is well-formed and was never printed. |
| Edge Function `desktop-entitlement` v1 (verify_jwt=true) | ACTIVE. GET returns kid `staging-b9e35d0a78f72566`. The selftest JWS verifies against the published JWK, which is embedded in `src/lib/security/entitlementKeys.ts`. Requests that fail are refused with these status codes: anon POST 401, request with no JWT 401, bad JSON 400. CORS allows Tauri origins only. |
| Replay and shift guards that already exist (read-only) | `uq_pos_order_submissions_tenant_op` and `uq_pos_op_submissions_tenant_op` are both UNIQUE(tenant_id, client_op_id). `pos_save_order` has the shift-ownership check (`cashier_user_id` = caller). |

## Production (cltlqfqormkhppmbvyrv): PREPARED ONLY. Each step needs its own exact human GO.

A read-only parity check on production (2026-10-27) found:

- all helpers present with the same signatures: `current_tenant_id`, `pos_assert_operator`, `current_user_permissions`, `get_tenant_effective_features`, `can_access_branch` and `is_super_admin`;
- pgcrypto 1.3 and supabase_vault 0.3.1;
- `branches` has the columns `archived_at`, `is_main` and `created_at`;
- no `desktop_*` objects and no key.

1. **Database GO.** Take a fresh baseline, then apply `foundation_desktop_devices.sql` unchanged. It is additive only and replaces nothing. Before applying, check that no `desktop_*` objects exist. After applying, run the same ACL, RLS, SECURITY DEFINER and md5 checks as on staging. Production has no QA fixture, so skip the probe file there or adapt it to a GO-approved test tenant.
2. **Key GO.** Run `foundation_desktop_entitlement_key_bootstrap.sql` on production. The key is generated inside the production database and never leaves it. A human must decide custody and rotation; the recommendation is no rotation unless compromised, and rotation adds a new kid before switching. Production and staging keys are different by construction.
3. **Edge Function GO.** Deploy `docs/offline/edge-functions/desktop-entitlement` (index.ts + jws.ts; kept out of a `supabase/` folder on purpose - this repo owns no Supabase project tree) to production with verify_jwt=true. The function maps the project ref to the env label itself.
4. **Key embed.** Run `GET /functions/v1/desktop-entitlement` with the production anon key. Copy `kid`, `jwk.x` and `jwk.y` into `ENTITLEMENT_PUBLIC_KEYS.production`. Verify `GET ?selftest=1` against them.
5. **Then ship the production desktop build.** If a production build has no production kid, it falls back to the legacy 7-day authority plus the clock guard. It does not fail open and it does not lock the till.

Rollback is `foundation_desktop_devices_ROLLBACK.sql`, plus deleting the Edge Function if needed. The Vault key is kept unless a human decides otherwise.

## Behavioural notes for acceptance

- Online sign-in obtains the entitlement in the background: the device registers, a fresh challenge is signed, and the result is verified and stored sealed.
- An offline relaunch restores the session only if the stored entitlement passes all of these:
  - its signature verifies against an embedded key;
  - it matches this env;
  - its device fingerprint matches this PC's key;
  - its user and tenant match the cache;
  - it has not expired at the guarded effective time.
- Role, OU pin, OU list, permissions and features all come from the signed claims.
- A staging tester who upgrades from 1.0.37 must sign in online once before any offline relaunch.
- Revocation: run `desktop_device_revoke(device_id)` as the tenant owner or admin. On its next reconnect or focus, the device stops new captures, and its queued work keeps draining under server authority.
