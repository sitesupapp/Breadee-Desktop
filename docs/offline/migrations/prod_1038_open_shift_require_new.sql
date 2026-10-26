-- ============================================================================
-- Desktop 1.0.38 (Bug 3) — S6 pos_open_shift_core optional `require_new` (additive).
-- Target: PRODUCTION cltlqfqormkhppmbvyrv. Apply ONCE via apply_migration name = desktop_1038_open_shift_require_new
-- (single transaction). NOT APPLIED — needs an exact production GO.
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
  if m <> '70c310a6dbc9194358e3b1b624fc9540' then raise exception 'PRE: public.pos_open_shift_core(jsonb) drifted (md5 %)', m; end if;
  if md5(pg_get_functiondef('public.pos_open_shift(jsonb)'::regprocedure)) <> '0d222c6bf756a643723c9163a4360946'
     or md5(pg_get_functiondef('public.pos_op_replay(uuid,uuid,text,uuid)'::regprocedure)) <> '78e42ee7e2d5dc3d6687e297f7a058d4'
     or md5(pg_get_functiondef('public.pos_op_record(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure)) <> '8a2df61e34abbb302698c06b377be017'
     or md5(pg_get_functiondef('public.pos_op_error(text,text)'::regprocedure)) <> 'ed70a93fa4e5321e636ba82efe1c15bd'
     or md5(pg_get_functiondef('public.pos_resolve_operational_branch(uuid,uuid)'::regprocedure)) <> '8cdf7d6becc452e71ba27783ae931214' then
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
    E'  if v_id is not null then\r\n    -- Desktop 1.0.38 (Bug 3): a chained offline open (require_new) must CREATE a shift, never adopt one.\r\n    if lower(coalesce(p_payload->>''require_new'', '''')) = ''true'' then\r\n      perform public.pos_op_error(''SHIFT_ALREADY_OPEN'', ''Another shift is already open for this cashier on this branch. The shift opened offline was not attached to it.'');\r\n    end if;',
    'open_core.require_new');
  if md5(d) <> '5dee6e73adb270f536fcf883e00c30d5' then raise exception 'BUILD: public.pos_open_shift_core(jsonb) post-image md5 % (expected 5dee6e73adb270f536fcf883e00c30d5)', md5(d); end if;
  execute d;
end
$apply$;

-- ---------------------------------------------------------------- POST guards
do $post$
begin
  if md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure)) <> '5dee6e73adb270f536fcf883e00c30d5' then
    raise exception 'POST: public.pos_open_shift_core(jsonb) md5 % (expected 5dee6e73adb270f536fcf883e00c30d5)', md5(pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure));
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
     or md5(pg_get_functiondef('public.pos_op_replay(uuid,uuid,text,uuid)'::regprocedure)) <> '78e42ee7e2d5dc3d6687e297f7a058d4'
     or md5(pg_get_functiondef('public.pos_op_record(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure)) <> '8a2df61e34abbb302698c06b377be017'
     or md5(pg_get_functiondef('public.pos_op_error(text,text)'::regprocedure)) <> 'ed70a93fa4e5321e636ba82efe1c15bd'
     or md5(pg_get_functiondef('public.pos_resolve_operational_branch(uuid,uuid)'::regprocedure)) <> '8cdf7d6becc452e71ba27783ae931214' then
    raise exception 'POST: an unchanged dependency changed';
  end if;
end
$post$;

notify pgrst, 'reload schema';
