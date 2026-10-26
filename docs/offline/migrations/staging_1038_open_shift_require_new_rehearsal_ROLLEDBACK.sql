-- Desktop 1.0.38 S6 (pos_open_shift_core require_new): STAGING rolled-back rehearsal of the STAGING
-- forward + rollback files, verbatim. ONE DO block that always ends in RAISE EXCEPTION carrying the JSON
-- results, so nothing persists on staging. Fixture: CPJ #2101 owner with its existing open shift.
do $rh$
declare
  v_t constant uuid := 'd735104d-ed3c-4d58-9148-f1a82e94d418';
  v_b constant uuid := 'a5469a61-2504-40e5-bc45-187b1bd4a2fa';
  v_sh constant uuid := 'a978d42d-cc00-439d-b0e4-a8e71c12878d';
  v_u constant uuid := '2ddf135f-1a69-42c9-af5f-5f47777692a7';
  res jsonb := '{}'::jsonb; j jsonb; v_fwd text; v_rbk text; v_new uuid; v_n int;
  op1 uuid := gen_random_uuid(); op2 uuid := gen_random_uuid(); op3 uuid := gen_random_uuid(); op4 uuid := gen_random_uuid(); op5 uuid := gen_random_uuid();
  base_reused jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_u::text, true);
  execute $h$
create function pg_temp._try(q text) returns jsonb language plpgsql as $f$
declare r jsonb; st text; m text; dt text;
begin
  execute q into r;
  return jsonb_build_object('ok', true, 'r', r);
exception when others then
  get stacked diagnostics st = returned_sqlstate, m = message_text, dt = pg_exception_detail;
  return jsonb_build_object('ok', false, 'state', st, 'code', case when dt like '{%' then (dt::jsonb)->>'pos_error_code' end, 'msg', left(m, 160));
end $f$ $h$;

  res := res || jsonb_build_object('pre_md5_ok', md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure)) = '70af91741e8df606c9b1912278aaed72',
    'fixture_open', (select status from public.pos_shifts where id = v_sh));
  -- BASELINE on the UNCHANGED body: an open shift is adopted (reused:true), even with require_new.
  base_reused := public.pos_open_shift(jsonb_build_object('branch_id', v_b, 'client_op_id', op1, 'require_new', true));
  res := res || jsonb_build_object('A_baseline_require_new_ignored', base_reused->>'reused' = 'true' and base_reused->>'shift_id' = v_sh::text);

  -- ================= APPLY: the STAGING forward migration file, verbatim
  v_fwd := $fwd$
-- ============================================================================
-- Desktop 1.0.38 (Bug 3) — S6 pos_open_shift_core optional `require_new` (additive).
-- Target: STAGING azjxprewycygsocusxjn. Apply ONCE via apply_migration name = desktop_1038_open_shift_require_new_staging
-- (single transaction). STAGING ONLY (PRE guards pin staging pre-images and refuse anywhere else).
-- GENERATED (scratchpad gen1038/gen_openshift.py over deltas.py OPEN_SHIFT_*); do not hand-edit anchors.
--
-- WHY: the desktop's chained offline open (OPEN(N+1) captured after an offline CLOSE(N), replayed strictly
-- after that close) must CREATE a shift. Today pos_open_shift_core hands back ANY open shift of the cashier +
-- branch with reused:true; a shift opened elsewhere meanwhile would be silently adopted (two drawers mixed),
-- and because the wrapper records that adoption under the op's client_op_id, the op could never be retried.
-- WHAT: when p_payload.require_new = 'true' and an open shift exists, raise pos_op_error('SHIFT_ALREADY_OPEN')
-- (P0001, detail pos_error_code) instead of returning it. The raise aborts before pos_op_record, so the
-- client_op_id is NOT burnt: after the operator ends the other shift, a retry opens exactly once. A lost-
-- response replay of an op that DID create its shift is answered by pos_op_replay (its own result,
-- reused:false) before the core runs — unaffected.
-- Callers that omit require_new (every existing caller): byte-identical behaviour and result JSON.
-- The 1.0.38 client ALSO refuses a reused:true result for a chained open (fail-closed without this
-- migration; this migration makes the conflict recoverable).
--
-- METHOD: rebuilt from the LIVE definition + exact anchored replace() asserted exactly-once; the rebuilt
-- text must hash to the post-image computed read-only from the same live body before it is executed.
-- Signature unchanged (CREATE OR REPLACE keeps owner/ACL); POST guards verify md5, ACL, SECURITY DEFINER,
-- search_path, owner, single overload, unchanged dependencies. No business data read or written.
-- ============================================================================

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------- PRE guards
do $pre$
declare m text;
begin
  m := md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure));
  if m <> '70af91741e8df606c9b1912278aaed72' then raise exception 'PRE: public.pos_open_shift_core(jsonb) drifted (md5 %)', m; end if;
  if md5(pg_get_functiondef('public.pos_open_shift(jsonb)'::regprocedure)) <> '0d222c6bf756a643723c9163a4360946'
     or md5(pg_get_functiondef('public.pos_op_replay(uuid,uuid,text,uuid)'::regprocedure)) <> 'd196ad1ce7025419fc5a32f4e87461e3'
     or md5(pg_get_functiondef('public.pos_op_record(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure)) <> '8a2df61e34abbb302698c06b377be017'
     or md5(pg_get_functiondef('public.pos_op_error(text,text)'::regprocedure)) <> 'ed70a93fa4e5321e636ba82efe1c15bd'
     or md5(pg_get_functiondef('public.pos_resolve_operational_branch(uuid,uuid)'::regprocedure)) <> '370fd24815d42091c9c28910164e9eaa' then
    raise exception 'PRE: a dependency of pos_open_shift_core drifted';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('pos_open_shift', 'pos_open_shift_core')) <> 2 then
    raise exception 'PRE: unexpected pos_open_shift overloads';
  end if;
end
$pre$;

-- ---------------------------------------------------------------- helper: exactly-once replace
create or replace function pg_temp._d1038os_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int;
begin
  n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / nullif(length(p_anchor), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  return replace(p_src, p_anchor, p_repl);
end $f$;

-- ---------------------------------------------------------------- S6 (from the LIVE body)
do $apply$
declare d text;
begin
  d := pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure);
  d := pg_temp._d1038os_once(d,
    E'  if v_id is not null then',
    E'  if v_id is not null then\n    -- Desktop 1.0.38 (Bug 3): a chained offline open (require_new) must CREATE a shift, never adopt one.\n    if lower(coalesce(p_payload->>''require_new'', '''')) = ''true'' then\n      perform public.pos_op_error(''SHIFT_ALREADY_OPEN'', ''Another shift is already open for this cashier on this branch. The shift opened offline was not attached to it.'');\n    end if;',
    'open_core.require_new');
  if md5(d) <> 'eb54473fb280e3e4c96a18e5f111aeea' then raise exception 'BUILD: public.pos_open_shift_core(jsonb) post-image md5 % (expected eb54473fb280e3e4c96a18e5f111aeea)', md5(d); end if;
  execute d;
end
$apply$;

-- ---------------------------------------------------------------- POST guards
do $post$
begin
  if md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure)) <> 'eb54473fb280e3e4c96a18e5f111aeea' then
    raise exception 'POST: public.pos_open_shift_core(jsonb) md5 % (expected eb54473fb280e3e4c96a18e5f111aeea)', md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure));
  end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_open_shift_core(jsonb)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'POST: ACL of public.pos_open_shift_core(jsonb) changed'; end if;
  if not (select prosecdef from pg_proc where oid = 'public.pos_open_shift_core(jsonb)'::regprocedure) then raise exception 'POST: public.pos_open_shift_core(jsonb) lost SECURITY DEFINER'; end if;
  if (select proconfig from pg_proc where oid = 'public.pos_open_shift_core(jsonb)'::regprocedure) is distinct from array['search_path=public'] then raise exception 'POST: public.pos_open_shift_core(jsonb) search_path changed'; end if;
  if (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.pos_open_shift_core(jsonb)'::regprocedure) <> 'postgres' then raise exception 'POST: public.pos_open_shift_core(jsonb) owner changed'; end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('pos_open_shift', 'pos_open_shift_core')) <> 2 then
    raise exception 'POST: overload count changed';
  end if;
  if md5(pg_get_functiondef('public.pos_open_shift(jsonb)'::regprocedure)) <> '0d222c6bf756a643723c9163a4360946'
     or md5(pg_get_functiondef('public.pos_op_replay(uuid,uuid,text,uuid)'::regprocedure)) <> 'd196ad1ce7025419fc5a32f4e87461e3'
     or md5(pg_get_functiondef('public.pos_op_record(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure)) <> '8a2df61e34abbb302698c06b377be017'
     or md5(pg_get_functiondef('public.pos_op_error(text,text)'::regprocedure)) <> 'ed70a93fa4e5321e636ba82efe1c15bd'
     or md5(pg_get_functiondef('public.pos_resolve_operational_branch(uuid,uuid)'::regprocedure)) <> '370fd24815d42091c9c28910164e9eaa' then
    raise exception 'POST: an unchanged dependency changed';
  end if;
end
$post$;

notify pgrst, 'reload schema';

$fwd$;
  res := res || jsonb_build_object('fwd_text_md5_ok', md5(v_fwd) = '5d6ace2eeef73865f080f716e5cd554f');
  execute v_fwd;
  res := res || jsonb_build_object('post_md5_ok', md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure)) = 'eb54473fb280e3e4c96a18e5f111aeea',
    'acl', (select proacl::text from pg_proc where oid = 'public.pos_open_shift_core(jsonb)'::regprocedure));

  -- B: no require_new → unchanged (adopts the open shift, same JSON shape as the baseline)
  j := public.pos_open_shift(jsonb_build_object('branch_id', v_b, 'client_op_id', op2));
  res := res || jsonb_build_object('B_unchanged_adopt', j->>'reused' = 'true' and j->>'shift_id' = v_sh::text
    and (j - 'idempotent' - 'result_code') = (base_reused - 'idempotent' - 'result_code'));
  -- C: require_new while a shift is open → SHIFT_ALREADY_OPEN, and the op id is NOT recorded (not burnt)
  j := pg_temp._try(format('select public.pos_open_shift(%L::jsonb)', jsonb_build_object('branch_id', v_b, 'client_op_id', op3, 'require_new', true)));
  res := res || jsonb_build_object('C_conflict', j, 'C_not_recorded', not exists (select 1 from public.pos_op_submissions where tenant_id = v_t and client_op_id = op3));
  -- D: 'false' / garbage values never trigger the refusal
  j := public.pos_open_shift(jsonb_build_object('branch_id', v_b, 'client_op_id', op4, 'require_new', 'yes'));
  res := res || jsonb_build_object('D_non_true_ignored', j->>'reused' = 'true');
  -- E: the other shift is closed → the SAME op3 now creates exactly one new shift
  update public.pos_shifts set status = 'approved', closed_at = now() where id = v_sh;
  j := public.pos_open_shift(jsonb_build_object('branch_id', v_b, 'client_op_id', op3, 'require_new', true));
  v_new := (j->>'shift_id')::uuid;
  res := res || jsonb_build_object('E_created', j->>'reused' = 'false' and v_new is distinct from v_sh,
    'E_recorded_once', (select count(*) from public.pos_op_submissions where tenant_id = v_t and client_op_id = op3) = 1);
  -- F: lost-response replay of op3 → its OWN result (reused:false, idempotent), no second shift
  j := public.pos_open_shift(jsonb_build_object('branch_id', v_b, 'client_op_id', op3, 'require_new', true));
  select count(*) into v_n from public.pos_shifts where tenant_id = v_t and cashier_user_id = v_u and status = 'open';
  res := res || jsonb_build_object('F_replay_own', j->>'shift_id' = v_new::text and j->>'reused' = 'false' and j->>'idempotent' = 'true', 'F_open_count', v_n);
  -- G: a further require_new open while N+1 is open → SHIFT_ALREADY_OPEN (never adopts N+1 either)
  j := pg_temp._try(format('select public.pos_open_shift(%L::jsonb)', jsonb_build_object('branch_id', v_b, 'client_op_id', op5, 'require_new', true)));
  res := res || jsonb_build_object('G_conflict_code', j->>'code');

  -- ================= ROLLBACK: the STAGING rollback file, verbatim
  v_rbk := $rbk$
-- ============================================================================
-- ROLLBACK of the Desktop 1.0.38 S6 pos_open_shift_core `require_new` change (STAGING azjxprewycygsocusxjn).
-- Restores the exact pre-image (inverse anchored replace on the LIVE body; the rebuilt text must hash to the
-- captured pre-image before it is executed). GENERATED from the same delta definition as the forward file.
-- Refuses unless the live body is exactly the S6 post-image (no drift / no fix-forward on top).
-- Safety after rollback: a 1.0.38 desktop still sends require_new (silently ignored by the restored body)
-- and still refuses a reused:true result for a chained open (CONFLICT, nothing adopted) — fail-closed, only
-- the retry-after-resolution property is lost (the adoption is then recorded under that op id).
-- ============================================================================

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $guard$
begin
  if md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure)) <> 'eb54473fb280e3e4c96a18e5f111aeea' then
    raise exception 'ROLLBACK REFUSED: public.pos_open_shift_core(jsonb) is not the S6 post-image (md5 %)', md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure));
  end if;
end
$guard$;

create or replace function pg_temp._r1038os_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int;
begin
  n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / nullif(length(p_anchor), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  return replace(p_src, p_anchor, p_repl);
end $f$;

do $rb$
declare d text;
begin
  d := pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure);
  d := pg_temp._r1038os_once(d,
    E'  if v_id is not null then\n    -- Desktop 1.0.38 (Bug 3): a chained offline open (require_new) must CREATE a shift, never adopt one.\n    if lower(coalesce(p_payload->>''require_new'', '''')) = ''true'' then\n      perform public.pos_op_error(''SHIFT_ALREADY_OPEN'', ''Another shift is already open for this cashier on this branch. The shift opened offline was not attached to it.'');\n    end if;',
    E'  if v_id is not null then',
    'rb.open_core.require_new');
  if md5(d) <> '70af91741e8df606c9b1912278aaed72' then raise exception 'RB BUILD: public.pos_open_shift_core(jsonb) restored md5 % (expected 70af91741e8df606c9b1912278aaed72)', md5(d); end if;
  execute d;
end
$rb$;

do $post$
begin
  if md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure)) <> '70af91741e8df606c9b1912278aaed72' then raise exception 'RB POST: public.pos_open_shift_core(jsonb) md5 %', md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure)); end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_open_shift_core(jsonb)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'RB POST: ACL of public.pos_open_shift_core(jsonb) changed'; end if;
  if md5(pg_get_functiondef('public.pos_open_shift(jsonb)'::regprocedure)) <> '0d222c6bf756a643723c9163a4360946'
     or md5(pg_get_functiondef('public.pos_op_replay(uuid,uuid,text,uuid)'::regprocedure)) <> 'd196ad1ce7025419fc5a32f4e87461e3'
     or md5(pg_get_functiondef('public.pos_op_record(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure)) <> '8a2df61e34abbb302698c06b377be017'
     or md5(pg_get_functiondef('public.pos_op_error(text,text)'::regprocedure)) <> 'ed70a93fa4e5321e636ba82efe1c15bd'
     or md5(pg_get_functiondef('public.pos_resolve_operational_branch(uuid,uuid)'::regprocedure)) <> '370fd24815d42091c9c28910164e9eaa' then
    raise exception 'RB POST: an unchanged dependency changed';
  end if;
end
$post$;

notify pgrst, 'reload schema';

$rbk$;
  res := res || jsonb_build_object('rb_text_md5_ok', md5(v_rbk) = '84b190cf79ff1e683f53bedae779f912');
  execute v_rbk;
  res := res || jsonb_build_object('rb_md5_ok', md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure)) = '70af91741e8df606c9b1912278aaed72',
    'rb_acl_ok', (select proacl::text from pg_proc where oid = 'public.pos_open_shift_core(jsonb)'::regprocedure) = '{postgres=X/postgres,service_role=X/postgres}');
  raise exception 'R1038_OPENSHIFT_REHEARSAL RESULT=%', res::text;
end $rh$;
