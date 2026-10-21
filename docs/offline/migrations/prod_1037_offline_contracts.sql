-- ============================================================================
-- Desktop 1.0.37 Full Offline — PRODUCTION server contracts (additive).
-- Target: PRODUCTION cltlqfqormkhppmbvyrv. Applied ONCE via apply_migration
-- name = desktop_1037_offline_contracts (single transaction).
--
-- WHY: the accepted 1.0.37 offline client (rc.14 e4e4b13 + 1.0.36 c655651) relies on three
-- contracts that exist on staging (Track C/D, Konan-reviewed) but not in production:
--   C1  pos_save_order: OPTIONAL expected_order_id guard (EXPECTED_ORDER_MISMATCH) for offline
--       dine-in rounds >= 2. Absent => unchanged (every existing caller).
--   C2  pos_order_items.client_line_id (nullable) + _pos_insert_order_items persisting it +
--       NEW read-only pos_order_item_map(order, batch). Online callers omit the field => NULL.
--   C3  pos_void_order / pos_void_order_core: OPTIONAL trailing p_expected_refund_usd
--       (REFUND_BALANCE_CHANGED / REFUND_AMOUNT_MISMATCH before any write). The offline refund
--       replay always sends this named argument, so without it every offline refund replay
--       fails "function not found" in production. Existing callers pass it by omission.
--
-- METHOD (no transcription of production bodies): each changed function is rebuilt from its
-- LIVE production definition (pg_get_functiondef) + ONLY the offline delta, via exact anchored
-- replace() with exactly-once assertions. PRE guards abort on any drift from the captured
-- production pre-images (md5). ACLs restored to the exact pre-images. POST guards verify
-- signatures / SECURITY DEFINER / search_path / ACL / single overload. No business data is
-- read or written. No RLS / grant widening. Rollback: prod_1037_offline_contracts_ROLLBACK.sql.
-- ============================================================================

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------- PRE guards
do $pre$
declare
  m text;
begin
  m := md5(pg_get_functiondef('public.pos_save_order(jsonb)'::regprocedure));
  if m <> '2563d514483cb2f3d4a3f7dda6a19cff' then raise exception 'PRE: pos_save_order drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)'::regprocedure));
  if m <> 'dc862a87fdb2c9a9d523a78177c1bf7c' then raise exception 'PRE: _pos_insert_order_items drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_void_order(uuid,text,boolean,uuid,integer)'::regprocedure));
  if m <> 'c3576dc8362836174949be3976671325' then raise exception 'PRE: pos_void_order drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_void_order_core(uuid,text,boolean,integer)'::regprocedure));
  if m <> 'b73c49ac6046be1b84fc0405157e4e17' then raise exception 'PRE: pos_void_order_core drifted (md5 %)', m; end if;
  if to_regprocedure('public.pos_order_item_map(uuid,integer)') is not null then raise exception 'PRE: pos_order_item_map already exists'; end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='pos_order_items' and column_name='client_line_id') then
    raise exception 'PRE: pos_order_items.client_line_id already exists';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pos_void_order') <> 1
     or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='pos_void_order_core') <> 1 then
    raise exception 'PRE: unexpected pos_void_order overloads';
  end if;
end
$pre$;

-- ---------------------------------------------------------------- helper: exactly-once replace
create or replace function pg_temp._d1037_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int;
begin
  n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / nullif(length(p_anchor), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  return replace(p_src, p_anchor, p_repl);
end $f$;

-- ---------------------------------------------------------------- C2a column (nullable, metadata-only)
alter table public.pos_order_items add column client_line_id uuid;
comment on column public.pos_order_items.client_line_id is
  'Desktop offline (1.0.37): the client-side line id of an offline-captured round line; correlates a local line to this canonical row (pos_order_item_map). NULL for every online line.';

-- ---------------------------------------------------------------- C1 + C2b + C3 (from LIVE bodies)
do $apply$
declare
  d text;
  core_new text;
  wrap_new text;
begin
  -- C1 pos_save_order: expected_order_id guard (two deltas only)
  d := pg_get_functiondef('public.pos_save_order(jsonb)'::regprocedure);
  d := pg_temp._d1037_once(d,
    E'  v_delivery_fee numeric := nullif(p_payload->>''delivery_fee'','''')::numeric;\nbegin',
    E'  v_delivery_fee numeric := nullif(p_payload->>''delivery_fee'','''')::numeric;\n  v_expected_order uuid := nullif(p_payload->>''expected_order_id'','''')::uuid;\nbegin',
    'save_order.declare');
  d := pg_temp._d1037_once(d,
    E'    if v_id is not null then\n      v_append := true;\n      select coalesce(max(i.batch_no), 0) + 1 into v_batch from public.pos_order_items i where i.order_id = v_id;\n    end if;\n  end if;',
    E'    if v_id is not null then\n      v_append := true;\n      select coalesce(max(i.batch_no), 0) + 1 into v_batch from public.pos_order_items i where i.order_id = v_id;\n    end if;\n'
    || E'    -- Desktop 1.0.37 offline multi-round guard (atomic, under this advisory lock): a caller that\n'
    || E'    -- pins expected_order_id (a later round of an offline session) MUST append to exactly\n'
    || E'    -- that order. A mismatch (bill closed/paid/replaced remotely, or none open) is refused.\n'
    || E'    if v_expected_order is not null and v_id is distinct from v_expected_order then\n'
    || E'      raise exception ''This table''''s bill changed since it was opened offline and cannot take this round''\n'
    || E'        using errcode = ''22023'', detail = json_build_object(''pos_error_code'',''EXPECTED_ORDER_MISMATCH'')::text;\n'
    || E'    end if;\n  end if;',
    'save_order.guard');
  execute d;

  -- C2b _pos_insert_order_items: persist client_line_id (column list + value only)
  d := pg_get_functiondef('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)'::regprocedure);
  d := pg_temp._d1037_once(d,
    'kitchen_note,customization_json,batch_no,added_by)',
    'kitchen_note,customization_json,batch_no,added_by,client_line_id)',
    'insert_items.columns');
  d := pg_temp._d1037_once(d,
    E'coalesce(it->''customization_json'',''{}''::jsonb),p_batch,p_actor)',
    E'coalesce(it->''customization_json'',''{}''::jsonb),p_batch,p_actor,nullif(it->>''client_line_id'','''')::uuid)',
    'insert_items.values');
  execute d;

  -- C3 pos_void_order_core: optional p_expected_refund_usd + guard before any write
  core_new := pg_get_functiondef('public.pos_void_order_core(uuid,text,boolean,integer)'::regprocedure);
  core_new := pg_temp._d1037_once(core_new,
    'p_expected_version integer DEFAULT NULL::integer)',
    'p_expected_version integer DEFAULT NULL::integer, p_expected_refund_usd numeric DEFAULT NULL::numeric)',
    'void_core.header');
  core_new := pg_temp._d1037_once(core_new,
    E'  v_outcome := case when v_paid then ''voided_no_refund'' else ''voided_no_refund'' end;',
    E'  -- Desktop 1.0.37 offline refundable-balance guard (ADDITIVE; NULL for every online caller).\n'
    || E'  if p_expected_refund_usd is not null then\n'
    || E'    if not v_paid then\n'
    || E'      perform public.pos_op_error(''REFUND_BALANCE_CHANGED'',\n'
    || E'        ''This order is no longer in a refundable paid state. Reconnect and review before refunding.'');\n'
    || E'    end if;\n'
    || E'    if abs(coalesce(v_net_usd, 0) - p_expected_refund_usd) >= 0.005 then\n'
    || E'      perform public.pos_op_error(''REFUND_AMOUNT_MISMATCH'',\n'
    || E'        ''The refundable amount changed since this refund was captured offline. Reconnect and review.'');\n'
    || E'    end if;\n'
    || E'  end if;\n'
    || E'  v_outcome := case when v_paid then ''voided_no_refund'' else ''voided_no_refund'' end;',
    'void_core.guard');

  -- C3 pos_void_order wrapper: thread the optional parameter
  wrap_new := pg_get_functiondef('public.pos_void_order(uuid,text,boolean,uuid,integer)'::regprocedure);
  wrap_new := pg_temp._d1037_once(wrap_new,
    'p_expected_version integer DEFAULT NULL::integer)',
    'p_expected_version integer DEFAULT NULL::integer, p_expected_refund_usd numeric DEFAULT NULL::numeric)',
    'void_wrap.header');
  wrap_new := pg_temp._d1037_once(wrap_new,
    'public.pos_void_order_core(p_order, p_reason, p_refund, p_expected_version)',
    'public.pos_void_order_core(p_order, p_reason, p_refund, p_expected_version, p_expected_refund_usd)',
    'void_wrap.calls', 2);

  -- signature change => replace the overloads (no DB callers / no view dependencies — verified)
  drop function public.pos_void_order(uuid, text, boolean, uuid, integer);
  drop function public.pos_void_order_core(uuid, text, boolean, integer);
  execute core_new;
  execute wrap_new;
end
$apply$;

-- exact pre-image ACLs (Supabase default privileges grant anon/authenticated/PUBLIC on new functions)
alter function public.pos_void_order_core(uuid, text, boolean, integer, numeric) owner to postgres;
alter function public.pos_void_order(uuid, text, boolean, uuid, integer, numeric) owner to postgres;
revoke all on function public.pos_void_order_core(uuid, text, boolean, integer, numeric) from public, anon, authenticated;
grant execute on function public.pos_void_order_core(uuid, text, boolean, integer, numeric) to service_role;
revoke all on function public.pos_void_order(uuid, text, boolean, uuid, integer, numeric) from public, anon;
grant execute on function public.pos_void_order(uuid, text, boolean, uuid, integer, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------- C2c pos_order_item_map (new, read-only)
create function public.pos_order_item_map(p_order uuid, p_batch integer default null::integer)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_order public.pos_orders; v_super boolean := public.is_super_admin();
begin
  select * into v_order from public.pos_orders where id = p_order;
  if v_order.id is null then raise exception 'Order not found'; end if;
  perform public.pos_assert_operator(v_order.tenant_id);
  if not v_super then perform public.assert_branch_access(v_order.branch_id); end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('client_line_id', i.client_line_id, 'order_item_id', i.id)), '[]'::jsonb)
    from public.pos_order_items i
    where i.order_id = p_order
      and i.client_line_id is not null
      and (p_batch is null or i.batch_no = p_batch)
  );
end; $function$;
alter function public.pos_order_item_map(uuid, integer) owner to postgres;
revoke all on function public.pos_order_item_map(uuid, integer) from public, anon;
grant execute on function public.pos_order_item_map(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------- POST guards
do $post$
declare r record; v text;
begin
  for r in
    select * from (values
      ('public.pos_save_order(jsonb)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.pos_void_order(uuid,text,boolean,uuid,integer,numeric)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.pos_void_order_core(uuid,text,boolean,integer,numeric)', '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.pos_order_item_map(uuid,integer)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
    ) t(sig, acl)
  loop
    if to_regprocedure(r.sig) is null then raise exception 'POST: missing %', r.sig; end if;
    select p.proacl::text into v from pg_proc p where p.oid = to_regprocedure(r.sig);
    if v is distinct from r.acl then raise exception 'POST: ACL of % is % (expected %)', r.sig, v, r.acl; end if;
    if not (select prosecdef from pg_proc where oid = to_regprocedure(r.sig)) then raise exception 'POST: % lost SECURITY DEFINER', r.sig; end if;
    if (select proconfig from pg_proc where oid = to_regprocedure(r.sig)) is distinct from array['search_path=public'] then raise exception 'POST: % search_path changed', r.sig; end if;
    if (select pg_get_userbyid(proowner) from pg_proc where oid = to_regprocedure(r.sig)) <> 'postgres' then raise exception 'POST: % owner changed', r.sig; end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('pos_void_order','pos_void_order_core')) <> 2 then
    raise exception 'POST: pos_void_order overload count is not exactly one each';
  end if;
  if position('EXPECTED_ORDER_MISMATCH' in pg_get_functiondef('public.pos_save_order(jsonb)'::regprocedure)) = 0 then raise exception 'POST: save_order guard missing'; end if;
  if position('client_line_id' in pg_get_functiondef('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)'::regprocedure)) = 0 then raise exception 'POST: insert_items delta missing'; end if;
  if position('REFUND_AMOUNT_MISMATCH' in pg_get_functiondef('public.pos_void_order_core(uuid,text,boolean,integer,numeric)'::regprocedure)) = 0 then raise exception 'POST: void guard missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='pos_order_items' and column_name='client_line_id' and is_nullable='YES' and column_default is null) then
    raise exception 'POST: client_line_id column not as expected';
  end if;
end
$post$;

notify pgrst, 'reload schema';
