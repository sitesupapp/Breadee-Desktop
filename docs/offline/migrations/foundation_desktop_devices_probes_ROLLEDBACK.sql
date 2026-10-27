-- =============================================================================
-- Final Foundation - adversarial RPC probes for foundation_desktop_devices.sql.
--
-- HOW TO RUN (staging only): send foundation_desktop_devices.sql FOLLOWED BY this
-- file as ONE simple-query batch. Postgres runs a multi-statement simple query as
-- one implicit transaction, and this block always ends in RAISE EXCEPTION, so the
-- whole batch - migration included - rolls back. After the migration is applied
-- for real, run this file ALONE: it still rolls back everything it did.
--
-- Fixtures: QA tenant #2101 Classic Pizza Joint (d735104d-...). Cashier pinned to
-- one OU; owner for revocation. The SPKI is a synthetic, well-formed P-256 point
-- encoding (signature verification is the Edge Function's job - see header of the
-- migration); these probes pin the SERVER contracts only.
-- =============================================================================
do $probe$
declare
  c_tenant  constant uuid := 'd735104d-ed3c-4d58-9148-f1a82e94d418';
  c_cashier constant uuid := 'f1ac0885-26d5-498b-9175-b3734344ed07';
  c_owner   constant uuid := '2ddf135f-1a69-42c9-af5f-5f47777692a7';
  c_other   constant uuid := '7d7ceb53-5df8-44b5-ad1b-6b1c6dae5715'; -- same-tenant manager
  v_spki text := replace(encode(decode('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')
                    || decode('04', 'hex') || extensions.gen_random_bytes(64), 'base64'), E'\n', '');
  v_fp text;
  v_ch jsonb; v_ch2 jsonb; v_pre jsonb; v_reg jsonb; v_att jsonb; v_st jsonb; v_rv jsonb;
  v_err text;
  v_out text := '';
begin
  v_fp := encode(extensions.digest(decode(v_spki, 'base64'), 'sha256'), 'hex');

  -- ---- as the cashier --------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('sub', c_cashier, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', c_cashier::text, true);
  execute 'set local role authenticated';

  v_ch := public.desktop_device_challenge('register');
  if v_ch->>'tenant_id' <> c_tenant::text or length(v_ch->>'nonce') <> 64 then raise exception 'P1 challenge shape %', v_ch; end if;
  v_out := v_out || 'P1 challenge ok; ';

  begin perform public.desktop_device_challenge('anything'); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'invalid_purpose' then raise exception 'P2 purpose: %', v_err; end if;
  v_out := v_out || 'P2 bad purpose refused; ';

  v_pre := public.desktop_device_precheck((v_ch->>'challenge_id')::uuid, v_fp);
  if (v_pre->'permissions'->>'pos.access')::boolean is not true then raise exception 'P3 perms %', v_pre->'permissions'; end if;
  if v_pre->'device' <> 'null'::jsonb then raise exception 'P3 device should be null'; end if;
  if (v_pre->'membership'->>'all_branches')::boolean then raise exception 'P3 cashier all_branches'; end if;
  if not (v_pre->'branch_ids') ? (v_pre->'membership'->>'branch_id') then raise exception 'P3 own OU missing %', v_pre->'branch_ids'; end if;
  v_out := v_out || format('P3 precheck ok (OUs=%s); ', jsonb_array_length(v_pre->'branch_ids'));

  -- cashier cannot write device rows directly, read the tables, or read the key
  begin perform public.desktop_device_register((v_ch->>'challenge_id')::uuid, c_cashier, v_fp, v_spki, 'software', 'till-1', 1); v_err := 'NO ERROR';
  exception when others then v_err := sqlstate; end;
  if v_err <> '42501' then raise exception 'P4 direct register: %', v_err; end if;
  begin perform public.desktop_entitlement_signing_key(); v_err := 'NO ERROR';
  exception when others then v_err := sqlstate; end;
  if v_err <> '42501' then raise exception 'P5 key read: %', v_err; end if;
  begin perform count(*) from public.desktop_devices; v_err := 'NO ERROR';
  exception when others then v_err := sqlstate; end;
  if v_err <> '42501' then raise exception 'P6 table read: %', v_err; end if;
  begin perform count(*) from public.desktop_device_challenges; v_err := 'NO ERROR';
  exception when others then v_err := sqlstate; end;
  if v_err <> '42501' then raise exception 'P6b table read: %', v_err; end if;
  v_out := v_out || 'P4-P6 direct write/key/table access refused; ';

  -- ---- the Edge Function (service_role) commits the registration ---------------
  execute 'reset role';
  execute 'set local role service_role';
  begin perform public.desktop_device_register((v_ch->>'challenge_id')::uuid, c_cashier, repeat('0', 64), v_spki, 'software', 'till-1', 1); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'fingerprint_mismatch' then raise exception 'P7 fp mismatch: %', v_err; end if;
  begin perform public.desktop_device_register((v_ch->>'challenge_id')::uuid, c_other, v_fp, v_spki, 'software', 'till-1', 1); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'challenge_invalid' then raise exception 'P8 foreign user: %', v_err; end if;
  v_out := v_out || 'P7 fingerprint/key mismatch refused; P8 challenge bound to user; ';

  v_reg := public.desktop_device_register((v_ch->>'challenge_id')::uuid, c_cashier, v_fp, v_spki, 'software', 'till-1', 5);
  if (v_reg->>'created')::boolean is not true or (v_reg->>'entitlement_seq')::int <> 1 then raise exception 'P9 register %', v_reg; end if;
  begin perform public.desktop_device_register((v_ch->>'challenge_id')::uuid, c_cashier, v_fp, v_spki, 'software', 'till-1', 6); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'challenge_invalid' then raise exception 'P10 replay: %', v_err; end if;
  v_out := v_out || 'P9 registered; P10 challenge replay refused; ';

  -- ---- idempotent re-register + attest (counter regression flagged) -----------
  execute 'reset role';
  execute 'set local role authenticated';
  v_ch2 := public.desktop_device_challenge('register');
  execute 'reset role';
  execute 'set local role service_role';
  v_reg := public.desktop_device_register((v_ch2->>'challenge_id')::uuid, c_cashier, v_fp, v_spki, 'software', 'till-2', 7);
  if (v_reg->>'created')::boolean or (v_reg->>'entitlement_seq')::int <> 2 then raise exception 'P11 idempotent %', v_reg; end if;
  v_out := v_out || 'P11 re-register idempotent; ';

  execute 'reset role';
  execute 'set local role authenticated';
  v_ch2 := public.desktop_device_challenge('entitlement');
  execute 'reset role';
  execute 'set local role service_role';
  begin perform public.desktop_device_register((v_ch2->>'challenge_id')::uuid, c_cashier, v_fp, v_spki, 'software', 'till-2', 8); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'challenge_invalid' then raise exception 'P12 purpose cross-use: %', v_err; end if;
  v_att := public.desktop_device_attest((v_ch2->>'challenge_id')::uuid, c_cashier, v_fp, 'till-2', 3);
  if (v_att->>'counter_regressed')::boolean is not true or (v_att->>'last_counter')::int <> 7 then raise exception 'P13 attest %', v_att; end if;
  v_out := v_out || 'P12 purpose bound; P13 attest ok, counter regression flagged; ';

  -- ---- expired challenge -------------------------------------------------------
  execute 'reset role';
  execute 'set local role authenticated';
  v_ch2 := public.desktop_device_challenge('entitlement');
  execute 'reset role';
  update public.desktop_device_challenges set expires_at = now() - interval '1 second' where id = (v_ch2->>'challenge_id')::uuid;
  execute 'set local role authenticated';
  begin perform public.desktop_device_precheck((v_ch2->>'challenge_id')::uuid, v_fp); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'challenge_invalid' then raise exception 'P14 expired: %', v_err; end if;
  v_out := v_out || 'P14 expired challenge refused; ';

  -- ---- status + revocation ------------------------------------------------------
  v_st := public.desktop_device_status(v_fp);
  if (v_st->>'registered')::boolean is not true or (v_st->>'revoked')::boolean then raise exception 'P15 status %', v_st; end if;
  begin perform public.desktop_device_revoke((v_reg->>'device_id')::uuid); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'not_authorized' then raise exception 'P16 cashier revoke: %', v_err; end if;
  v_out := v_out || 'P15 status ok; P16 cashier cannot revoke; ';

  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', c_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', c_owner::text, true);
  execute 'set local role authenticated';
  v_rv := public.desktop_device_revoke((v_reg->>'device_id')::uuid);
  if v_rv->>'revoked_at' is null then raise exception 'P17 revoke %', v_rv; end if;
  v_out := v_out || 'P17 owner revoked; ';

  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', c_cashier, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', c_cashier::text, true);
  execute 'set local role authenticated';
  v_st := public.desktop_device_status(v_fp);
  if (v_st->>'revoked')::boolean is not true then raise exception 'P18 status after revoke %', v_st; end if;
  v_ch2 := public.desktop_device_challenge('entitlement');
  execute 'reset role';
  execute 'set local role service_role';
  begin perform public.desktop_device_attest((v_ch2->>'challenge_id')::uuid, c_cashier, v_fp, 'till-2', 9); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'device_revoked' then raise exception 'P19 attest revoked: %', v_err; end if;
  execute 'reset role';
  execute 'set local role authenticated';
  v_ch2 := public.desktop_device_challenge('register');
  execute 'reset role';
  execute 'set local role service_role';
  begin perform public.desktop_device_register((v_ch2->>'challenge_id')::uuid, c_cashier, v_fp, v_spki, 'software', 'till-2', 9); v_err := 'NO ERROR';
  exception when others then v_err := sqlerrm; end;
  if v_err <> 'device_revoked' then raise exception 'P20 re-register revoked: %', v_err; end if;
  v_out := v_out || 'P18 status shows revoked; P19 revoked device gets no entitlement; P20 revoked device cannot re-register; ';

  execute 'reset role';
  raise exception 'REHEARSAL_OK (rolled back): %', v_out;
end
$probe$;
