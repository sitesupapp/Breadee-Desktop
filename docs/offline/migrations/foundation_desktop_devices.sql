-- =============================================================================
-- Breadee Desktop - Final Foundation, Tracks 4/5/6: device registration +
-- signed offline entitlement (server objects).
--
-- ENVIRONMENT: written for STAGING (azjxprewycygsocusxjn) first. The SAME file is
-- the PREPARED production migration - it is purely ADDITIVE (2 new tables, 7 new
-- functions, no ALTER/REPLACE of any existing object), so it carries no
-- live-body anchor. Production apply = separate exact GO (see
-- foundation_desktop_devices_PROD_README.md).
--
-- WHAT IT ADDS
--   public.desktop_devices            one row per (tenant, device key fingerprint)
--   public.desktop_device_challenges  single-use, 2-minute nonces bound to a user
--   desktop_device_challenge(p_purpose)                   authenticated
--   desktop_device_precheck(p_challenge_id, p_fingerprint) authenticated, read-only
--   desktop_device_status(p_fingerprint)                  authenticated, read-only
--   desktop_device_revoke(p_device_id)                    authenticated owner/admin
--   desktop_device_register(...)                          service_role ONLY
--   desktop_device_attest(...)                            service_role ONLY
--   desktop_entitlement_signing_key()                     service_role ONLY
--
-- WHY THE WRITES ARE service_role ONLY. Postgres cannot verify an ECDSA P-256
-- signature (pgcrypto has no asymmetric verify; no pgsodium/pgjwt here), so the
-- proof of possession is checked in the `desktop-entitlement` Edge Function with
-- WebCrypto. The function reads (as the USER, so every existing permission helper
-- keeps working unchanged) via desktop_device_precheck, verifies the device
-- signature, and only then commits via register/attest with the service role.
-- A user calling the write RPCs directly is refused (no EXECUTE grant).
--
-- RLS: both tables ENABLE ROW LEVEL SECURITY with NO policy and no table grant to
-- anon/authenticated = deny-all. Every access goes through the SECURITY DEFINER
-- functions below (owner postgres, search_path pinned).
--
-- BACKWARD COMPATIBILITY: nothing existing is touched; 1.0.37 clients never call
-- these objects. ROLLBACK: foundation_desktop_devices_ROLLBACK.sql.
-- =============================================================================

create table if not exists public.desktop_devices (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  fingerprint           text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  public_key_spki       text not null check (length(public_key_spki) between 100 and 200),
  key_provider          text not null check (key_provider in ('tpm', 'software')),
  terminal_id           text not null check (terminal_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  registered_by         uuid not null,
  created_at            timestamptz not null default now(),
  revoked_at            timestamptz,
  revoked_by            uuid,
  last_seen_at          timestamptz,
  last_counter          bigint not null default 0 check (last_counter >= 0),
  counter_regressed_at  timestamptz,
  entitlement_seq       bigint not null default 0 check (entitlement_seq >= 0),
  constraint desktop_devices_tenant_fingerprint_key unique (tenant_id, fingerprint)
);

create table if not exists public.desktop_device_challenges (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  user_id     uuid not null,
  purpose     text not null check (purpose in ('register', 'entitlement')),
  nonce       text not null check (nonce ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists desktop_device_challenges_user_open_idx
  on public.desktop_device_challenges (user_id, expires_at) where used_at is null;
create index if not exists desktop_device_challenges_expiry_idx
  on public.desktop_device_challenges (expires_at);

alter table public.desktop_devices enable row level security;
alter table public.desktop_device_challenges enable row level security;
revoke all on table public.desktop_devices from public, anon, authenticated;
revoke all on table public.desktop_device_challenges from public, anon, authenticated;

comment on table public.desktop_devices is
  'Final Foundation: registered Breadee Desktop device keys (non-exportable ECDSA P-256). RLS deny-all; access only via desktop_device_* SECURITY DEFINER functions.';
comment on table public.desktop_device_challenges is
  'Final Foundation: single-use 2-minute device challenges. RLS deny-all.';

-- -----------------------------------------------------------------------------
-- desktop_device_challenge: issue a single-use nonce to an authenticated POS operator.
-- -----------------------------------------------------------------------------
create or replace function public.desktop_device_challenge(p_purpose text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_row public.desktop_device_challenges;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_purpose is null or p_purpose not in ('register', 'entitlement') then
    raise exception 'invalid_purpose' using errcode = '22023';
  end if;
  v_tenant := public.current_tenant_id();
  if v_tenant is null then
    raise exception 'no_active_membership' using errcode = '42501';
  end if;
  -- POS operator gate (membership active + pos feature + pos.access) - the same
  -- gate every POS RPC uses.
  perform public.pos_assert_operator(v_tenant);

  delete from public.desktop_device_challenges where expires_at < now() - interval '1 day';
  if (select count(*) from public.desktop_device_challenges
       where user_id = v_uid and used_at is null and expires_at > now()) >= 20 then
    raise exception 'too_many_open_challenges' using errcode = '54000';
  end if;

  insert into public.desktop_device_challenges (tenant_id, user_id, purpose, nonce, expires_at)
  values (v_tenant, v_uid, p_purpose, encode(extensions.gen_random_bytes(32), 'hex'), now() + interval '2 minutes')
  returning * into v_row;

  return jsonb_build_object(
    'challenge_id', v_row.id,
    'nonce', v_row.nonce,
    'purpose', v_row.purpose,
    'tenant_id', v_row.tenant_id,
    'user_id', v_row.user_id,
    'expires_at', v_row.expires_at,
    'server_time', now()
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- desktop_device_precheck: READ-ONLY snapshot the Edge Function needs, computed
-- AS THE USER (so current_user_permissions / get_tenant_effective_features /
-- can_access_branch apply their existing rules unchanged). Consumes nothing.
-- -----------------------------------------------------------------------------
create or replace function public.desktop_device_precheck(p_challenge_id uuid, p_fingerprint text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_ch public.desktop_device_challenges;
  v_mem record;
  v_dev public.desktop_devices;
  v_branch_ids jsonb;
  v_main uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_fingerprint' using errcode = '22023';
  end if;
  select * into v_ch from public.desktop_device_challenges where id = p_challenge_id and user_id = v_uid;
  if not found or v_ch.used_at is not null or v_ch.expires_at <= now() then
    raise exception 'challenge_invalid' using errcode = '42501';
  end if;
  v_tenant := public.current_tenant_id();
  if v_tenant is distinct from v_ch.tenant_id then
    raise exception 'tenant_changed' using errcode = '42501';
  end if;
  perform public.pos_assert_operator(v_tenant);

  select id, role::text as role, branch_id, all_branches into v_mem
    from public.tenant_users
   where user_id = v_uid and tenant_id = v_tenant and status = 'active'
   order by created_at limit 1;
  if not found then
    raise exception 'no_active_membership' using errcode = '42501';
  end if;

  select main_branch_id into v_main from public.tenants where id = v_tenant;
  -- The OUs this user may operate in, by the SAME rule the server enforces on
  -- every branch-scoped write (can_access_branch).
  select coalesce(jsonb_agg(b.id order by b.is_main desc, b.created_at), '[]'::jsonb)
    into v_branch_ids
    from public.branches b
   where b.tenant_id = v_tenant and b.archived_at is null and public.can_access_branch(b.id);

  select * into v_dev from public.desktop_devices where tenant_id = v_tenant and fingerprint = p_fingerprint;

  return jsonb_build_object(
    'challenge', jsonb_build_object('id', v_ch.id, 'nonce', v_ch.nonce, 'purpose', v_ch.purpose,
                                    'tenant_id', v_ch.tenant_id, 'user_id', v_ch.user_id, 'expires_at', v_ch.expires_at),
    'membership', jsonb_build_object('tenant_user_id', v_mem.id, 'role', v_mem.role,
                                     'branch_id', v_mem.branch_id, 'all_branches', coalesce(v_mem.all_branches, false)),
    'main_branch_id', v_main,
    'branch_ids', v_branch_ids,
    'permissions', public.current_user_permissions(v_tenant),
    'features', public.get_tenant_effective_features(v_tenant),
    'device', case when v_dev.id is null then null else jsonb_build_object(
                'id', v_dev.id, 'public_key_spki', v_dev.public_key_spki, 'key_provider', v_dev.key_provider,
                'terminal_id', v_dev.terminal_id, 'revoked', v_dev.revoked_at is not null,
                'last_counter', v_dev.last_counter, 'entitlement_seq', v_dev.entitlement_seq) end,
    'server_time', now()
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- desktop_device_register: service_role only (called by the Edge Function AFTER it
-- verified the device signature). Idempotent per (tenant, fingerprint).
-- -----------------------------------------------------------------------------
create or replace function public.desktop_device_register(
  p_challenge_id uuid, p_user_id uuid, p_fingerprint text, p_spki text,
  p_provider text, p_terminal_id text, p_counter bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ch public.desktop_device_challenges;
  v_dev public.desktop_devices;
  v_created boolean := false;
  v_regressed boolean;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_fingerprint' using errcode = '22023';
  end if;
  if p_provider is null or p_provider not in ('tpm', 'software') then
    raise exception 'invalid_provider' using errcode = '22023';
  end if;
  if p_terminal_id is null or p_terminal_id !~ '^[A-Za-z0-9._-]{1,64}$' then
    raise exception 'invalid_terminal_id' using errcode = '22023';
  end if;
  if p_counter is null or p_counter < 0 then
    raise exception 'invalid_counter' using errcode = '22023';
  end if;
  if encode(extensions.digest(decode(p_spki, 'base64'), 'sha256'), 'hex') <> p_fingerprint then
    raise exception 'fingerprint_mismatch' using errcode = '22023';
  end if;

  select * into v_ch from public.desktop_device_challenges where id = p_challenge_id for update;
  if not found or v_ch.user_id <> p_user_id or v_ch.purpose <> 'register'
     or v_ch.used_at is not null or v_ch.expires_at <= now() then
    raise exception 'challenge_invalid' using errcode = '42501';
  end if;
  if not exists (select 1 from public.tenant_users
                  where user_id = p_user_id and tenant_id = v_ch.tenant_id and status = 'active') then
    raise exception 'no_active_membership' using errcode = '42501';
  end if;
  update public.desktop_device_challenges set used_at = now() where id = v_ch.id;

  insert into public.desktop_devices (tenant_id, fingerprint, public_key_spki, key_provider, terminal_id, registered_by)
  values (v_ch.tenant_id, p_fingerprint, p_spki, p_provider, p_terminal_id, p_user_id)
  on conflict (tenant_id, fingerprint) do nothing
  returning true into v_created;

  select * into v_dev from public.desktop_devices
   where tenant_id = v_ch.tenant_id and fingerprint = p_fingerprint for update;
  if v_dev.revoked_at is not null then
    raise exception 'device_revoked' using errcode = '42501';
  end if;
  if v_dev.public_key_spki <> p_spki then
    raise exception 'device_key_mismatch' using errcode = '42501';
  end if;

  v_regressed := p_counter < v_dev.last_counter;
  update public.desktop_devices
     set terminal_id = p_terminal_id,
         last_seen_at = now(),
         last_counter = greatest(last_counter, p_counter),
         counter_regressed_at = case when v_regressed then now() else counter_regressed_at end,
         entitlement_seq = entitlement_seq + 1
   where id = v_dev.id
   returning * into v_dev;

  return jsonb_build_object('device_id', v_dev.id, 'tenant_id', v_dev.tenant_id, 'created', coalesce(v_created, false),
                            'entitlement_seq', v_dev.entitlement_seq, 'last_counter', v_dev.last_counter,
                            'counter_regressed', v_regressed, 'server_time', now());
end;
$function$;

-- -----------------------------------------------------------------------------
-- desktop_device_attest: service_role only. Consumes an 'entitlement' challenge for
-- an ACTIVE (non-revoked) registered device and advances its counters.
-- -----------------------------------------------------------------------------
create or replace function public.desktop_device_attest(
  p_challenge_id uuid, p_user_id uuid, p_fingerprint text, p_terminal_id text, p_counter bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ch public.desktop_device_challenges;
  v_dev public.desktop_devices;
  v_regressed boolean;
begin
  if p_terminal_id is null or p_terminal_id !~ '^[A-Za-z0-9._-]{1,64}$' then
    raise exception 'invalid_terminal_id' using errcode = '22023';
  end if;
  if p_counter is null or p_counter < 0 then
    raise exception 'invalid_counter' using errcode = '22023';
  end if;
  select * into v_ch from public.desktop_device_challenges where id = p_challenge_id for update;
  if not found or v_ch.user_id <> p_user_id or v_ch.purpose <> 'entitlement'
     or v_ch.used_at is not null or v_ch.expires_at <= now() then
    raise exception 'challenge_invalid' using errcode = '42501';
  end if;
  if not exists (select 1 from public.tenant_users
                  where user_id = p_user_id and tenant_id = v_ch.tenant_id and status = 'active') then
    raise exception 'no_active_membership' using errcode = '42501';
  end if;
  select * into v_dev from public.desktop_devices
   where tenant_id = v_ch.tenant_id and fingerprint = p_fingerprint for update;
  if not found then
    raise exception 'device_not_registered' using errcode = '42501';
  end if;
  if v_dev.revoked_at is not null then
    raise exception 'device_revoked' using errcode = '42501';
  end if;
  update public.desktop_device_challenges set used_at = now() where id = v_ch.id;

  v_regressed := p_counter < v_dev.last_counter;
  update public.desktop_devices
     set terminal_id = p_terminal_id,
         last_seen_at = now(),
         last_counter = greatest(last_counter, p_counter),
         counter_regressed_at = case when v_regressed then now() else counter_regressed_at end,
         entitlement_seq = entitlement_seq + 1
   where id = v_dev.id
   returning * into v_dev;

  return jsonb_build_object('device_id', v_dev.id, 'tenant_id', v_dev.tenant_id,
                            'entitlement_seq', v_dev.entitlement_seq, 'last_counter', v_dev.last_counter,
                            'counter_regressed', v_regressed, 'server_time', now());
end;
$function$;

-- -----------------------------------------------------------------------------
-- desktop_device_status: cheap reconnect check (before draining). Read-only.
-- -----------------------------------------------------------------------------
create or replace function public.desktop_device_status(p_fingerprint text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid;
  v_dev public.desktop_devices;
  v_pos boolean := false;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_fingerprint' using errcode = '22023';
  end if;
  v_tenant := public.current_tenant_id();
  if v_tenant is not null then
    v_pos := coalesce((public.current_user_permissions(v_tenant) ->> 'pos.access')::boolean, false);
    select * into v_dev from public.desktop_devices where tenant_id = v_tenant and fingerprint = p_fingerprint;
  end if;
  return jsonb_build_object(
    'tenant_id', v_tenant,
    'membership_active', v_tenant is not null,
    'pos_access', v_pos,
    'registered', v_dev.id is not null,
    'revoked', v_dev.revoked_at is not null,
    'device_id', v_dev.id,
    'last_counter', v_dev.last_counter,
    'server_time', now()
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- desktop_device_revoke: tenant owner/admin (or platform super admin).
-- Revocation never deletes anything; it only stops new entitlements.
-- -----------------------------------------------------------------------------
create or replace function public.desktop_device_revoke(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_dev public.desktop_devices;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_dev from public.desktop_devices where id = p_device_id for update;
  if not found then
    raise exception 'device_not_found' using errcode = '42501';
  end if;
  if not (public.is_super_admin()
          or exists (select 1 from public.tenant_users
                      where user_id = v_uid and tenant_id = v_dev.tenant_id and status = 'active'
                        and role::text in ('owner', 'admin'))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  update public.desktop_devices
     set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, v_uid)
   where id = v_dev.id
   returning * into v_dev;
  return jsonb_build_object('device_id', v_dev.id, 'revoked_at', v_dev.revoked_at);
end;
$function$;

-- -----------------------------------------------------------------------------
-- desktop_entitlement_signing_key: service_role only. Returns the ES256 private
-- scalar (hex) from Supabase Vault. The scalar is GENERATED INSIDE THE DATABASE by
-- foundation_desktop_entitlement_key_bootstrap.sql and is never printed, logged,
-- committed or passed through any client.
-- -----------------------------------------------------------------------------
create or replace function public.desktop_entitlement_signing_key()
returns text
language sql
stable
security definer
set search_path to 'public'
as $function$
  select decrypted_secret from vault.decrypted_secrets
   where name = 'desktop_entitlement_es256_d' limit 1;
$function$;

-- Grants: explicit, least privilege.
revoke all on function public.desktop_device_challenge(text) from public, anon;
revoke all on function public.desktop_device_precheck(uuid, text) from public, anon;
revoke all on function public.desktop_device_status(text) from public, anon;
revoke all on function public.desktop_device_revoke(uuid) from public, anon;
revoke all on function public.desktop_device_register(uuid, uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.desktop_device_attest(uuid, uuid, text, text, bigint) from public, anon, authenticated;
revoke all on function public.desktop_entitlement_signing_key() from public, anon, authenticated;
grant execute on function public.desktop_device_challenge(text) to authenticated;
grant execute on function public.desktop_device_precheck(uuid, text) to authenticated;
grant execute on function public.desktop_device_status(text) to authenticated;
grant execute on function public.desktop_device_revoke(uuid) to authenticated;
grant execute on function public.desktop_device_register(uuid, uuid, text, text, text, text, bigint) to service_role;
grant execute on function public.desktop_device_attest(uuid, uuid, text, text, bigint) to service_role;
grant execute on function public.desktop_entitlement_signing_key() to service_role;
