-- =============================================================================
-- Final Foundation - ES256 entitlement signing key bootstrap (per environment).
--
-- The private scalar d (P-256) is GENERATED INSIDE THE DATABASE from
-- pgcrypto's CSPRNG and stored straight into Supabase Vault. It never exists in a
-- file, a terminal, a log, a commit, a CI secret or an AI transcript: nothing in
-- this script SELECTs or prints it. Only the Edge Function `desktop-entitlement`
-- reads it (through the service_role-only desktop_entitlement_signing_key()), and
-- only the derived PUBLIC key is published (GET on the function) and embedded in
-- the app (src/lib/security/entitlementKeys.ts).
--
-- Idempotent: a second run is a no-op (it never rotates). Rotation = a NEW vault
-- name + a new kid shipped in the app first; never overwrite in place.
--
-- d must satisfy 1 <= d < n (n = P-256 group order); rejection-sample until so.
-- Comparison is on fixed-width lowercase hex under COLLATE "C" (byte order).
-- =============================================================================
do $bootstrap$
declare
  c_n constant text := 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';
  v_d text;
begin
  if exists (select 1 from vault.secrets where name = 'desktop_entitlement_es256_d') then
    raise notice 'desktop_entitlement_es256_d already present - unchanged';
    return;
  end if;
  loop
    v_d := encode(extensions.gen_random_bytes(32), 'hex');
    exit when v_d collate "C" < c_n collate "C" and v_d <> repeat('0', 64);
  end loop;
  perform vault.create_secret(
    v_d,
    'desktop_entitlement_es256_d',
    'Breadee Desktop entitlement signer: ES256 (P-256) private scalar, hex. Generated in-database; never export, print or copy.'
  );
  v_d := null;
  raise notice 'desktop_entitlement_es256_d created';
end
$bootstrap$;
