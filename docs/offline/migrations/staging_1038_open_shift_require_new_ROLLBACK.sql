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
