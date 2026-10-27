-- Rollback for foundation_desktop_devices.sql (staging or production).
-- Safe at any time: no existing object depends on these, and 1.0.37 clients never call them.
-- A 1.0.38 client whose server objects are gone simply cannot obtain/renew an
-- entitlement (online keeps working; offline unlock requires re-authorization).
-- The Vault key is NOT dropped here (separate, deliberate step - see README).
drop function if exists public.desktop_entitlement_signing_key();
drop function if exists public.desktop_device_revoke(uuid);
drop function if exists public.desktop_device_status(text);
drop function if exists public.desktop_device_attest(uuid, uuid, text, text, bigint);
drop function if exists public.desktop_device_register(uuid, uuid, text, text, text, text, bigint);
drop function if exists public.desktop_device_precheck(uuid, text);
drop function if exists public.desktop_device_challenge(text);
drop table if exists public.desktop_device_challenges;
drop table if exists public.desktop_devices;
