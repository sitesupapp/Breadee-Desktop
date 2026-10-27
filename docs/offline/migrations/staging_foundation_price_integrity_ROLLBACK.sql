-- ============================================================================
-- ROLLBACK of foundation_price_integrity, STAGING (STAGING azjxprewycygsocusxjn).
-- GENERATED from scratchpad price/template_rollback.sql (gen.ps1). Single transaction; fix-forward is preferred.
-- Reverses the six anchored edits from the LIVE bodies (each result must hash to the recorded pre-image),
-- drops the four new helpers, and restores the four helpers' pre-image EXECUTE grants (the direct-RPC
-- exposure comes back — only roll back if the new guard itself is faulty). Rows granting pos.price_override in
-- tenant_role_permissions / tenant_user_permissions are left untouched (inert once the key leaves the catalog).
-- Order: roll this back BEFORE any 1.0.37 contracts rollback.
-- ============================================================================
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $pre$
declare f text; m text;
begin
  for f, m in select * from (values
      ('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', '8b14eaf02661bce904d832b0d25e9788'),
      ('public.pos_save_order(jsonb)', '66f2c447f93ae50809bc896a563e9ce9'),
      ('public.pos_edit_order_line_core(jsonb)', '75d327c251b0e512723c7834b74321db'),
      ('public.cc_intake_save(jsonb)', 'c512773e9fe85b0526b29b89594e470a'),
      ('public.cc_amendment_request(jsonb)', 'e45c3c2a8f4a6908041ea3e0c4b13a42'),
      ('public.permission_catalog()', 'cdd507779665af1975903ddfef1a2a0c')) v(a, b) loop
    if md5(pg_get_functiondef(f::regprocedure)) <> m then
      raise exception 'RB PRE: % is not the foundation_price_integrity post-image (md5 %)', f, md5(pg_get_functiondef(f::regprocedure));
    end if;
  end loop;
end
$pre$;

create or replace function pg_temp._prc_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int; a text := p_anchor; r text := p_repl;
begin
  if position(chr(13) in p_src) > 0 then
    a := replace(p_anchor, chr(10), chr(13) || chr(10));
    r := replace(p_repl, chr(10), chr(13) || chr(10));
  end if;
  n := (length(p_src) - length(replace(p_src, a, ''))) / nullif(length(a), 0);
  if n is distinct from p_expect then raise exception 'RB ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  return replace(p_src, a, r);
end $f$;

create or replace function pg_temp._prc_exec(p_fn text, p_def text, p_expected text)
returns void language plpgsql as $f$
begin
  if md5(p_def) <> p_expected then raise exception 'RB BUILD: % md5 % (expected pre-image %)', p_fn, md5(p_def), p_expected; end if;
  execute p_def;
end $f$;

do $rb$
declare d text;
begin
  d := pg_get_functiondef('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)'::regprocedure);
  d := pg_temp._prc_once(d,
    E'begin\n  -- PRICE P0: refuse quantity <= 0 and negative prices / modifier deltas before anything is written.\n  perform public._pos_assert_line_signs(p_items);\n  for it in select * from jsonb_array_elements(coalesce(p_items,''[]''::jsonb)) loop\n',
    E'begin\n  for it in select * from jsonb_array_elements(coalesce(p_items,''[]''::jsonb)) loop\n', 'rb.insert_items');
  perform pg_temp._prc_exec('_pos_insert_order_items', d, '1b64ea09b550d4e72dd3a22702b915a1');

  d := pg_get_functiondef('public.pos_save_order(jsonb)'::regprocedure);
  d := pg_temp._prc_once(d,
    E'\n  v_price_gf jsonb;  -- PRICE P0: prices already recorded on this order (a full re-save keeps them)\nbegin\n', E'\nbegin\n', 'rb.save.decl');
  d := pg_temp._prc_once(d, E'    v_price_gf := public._pos_order_price_snapshot(v_id);\n', '', 'rb.save.snapshot');
  d := pg_temp._prc_once(d,
    E'\n  -- PRICE P0: menu lines must carry the current menu price (else PRICE_CHANGED, nothing written); custom lines need pos.price_override.\n  perform public._pos_assert_line_prices(v_tenant, v_branch, v_id, coalesce(p_payload->''items'',''[]''::jsonb), v_price_gf, auth.uid());',
    '', 'rb.save.guard');
  perform pg_temp._prc_exec('pos_save_order', d, '1c08e24d8680e62b3908d341f80945dd');

  d := pg_get_functiondef('public.pos_edit_order_line_core(jsonb)'::regprocedure);
  d := pg_temp._prc_once(d,
    'perform public._pos_assert_line_prices(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, jsonb_build_array(v_snap), auth.uid());  /* PRICE P0 */ ',
    '', 'rb.edit', 2);
  perform pg_temp._prc_exec('pos_edit_order_line_core', d, '853eb21bff2111250f708cabd6309371');

  d := pg_get_functiondef('public.cc_intake_save(jsonb)'::regprocedure);
  d := pg_temp._prc_once(d,
    E'    perform public._pos_assert_line_signs(coalesce(p_payload->''items'',''[]''::jsonb));  -- PRICE P0\n', '', 'rb.ccsave');
  perform pg_temp._prc_exec('cc_intake_save', d, 'd0d8b81713eaf9e287e416786a915d60');

  d := pg_get_functiondef('public.cc_amendment_request(jsonb)'::regprocedure);
  d := pg_temp._prc_once(d,
    E'  -- PRICE P0: an added / re-optioned line may not carry quantity <= 0 or a negative price.\n  if v_type in (''add_item'',''modifier_change'') then\n    perform public._pos_assert_line_signs(jsonb_build_array(jsonb_build_object(\n      ''name'', coalesce(p_payload->>''name'',''Item''),\n      ''quantity'', case when v_type = ''add_item'' then p_payload->''quantity'' end,\n      ''base_price'', case when v_type = ''add_item'' then p_payload->''base_price'' end,\n      ''modifiers'', coalesce(p_payload->''modifiers'',''[]''::jsonb))));\n  end if;\n',
    '', 'rb.amreq');
  perform pg_temp._prc_exec('cc_amendment_request', d, 'e0949aac79917b3b58be8fd335d3bbab');

  d := pg_get_functiondef('public.permission_catalog()'::regprocedure);
  if position(',pos.price_override,pos.print_receipts,' in d) > 0 then
    d := pg_temp._prc_once(d, ',pos.price_override,pos.print_receipts,', ',pos.print_receipts,', 'rb.catalog.literal');
  else
    d := pg_temp._prc_once(d, '''pos.payouts.reverse'',''pos.price_override'',', '''pos.payouts.reverse'',', 'rb.catalog.quoted');
  end if;
  perform pg_temp._prc_exec('permission_catalog', d, 'a4f316c3fa7a32ab4f059c7718579f08');
end
$rb$;

drop function public._pos_assert_line_prices(uuid,uuid,uuid,jsonb,jsonb,uuid);
drop function public._pos_price_matches(numeric,numeric,text,numeric,numeric,text,numeric,numeric);
drop function public._pos_order_price_snapshot(uuid);
drop function public._pos_assert_line_signs(jsonb);

-- restore the recorded pre-image grants
grant execute on function public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid) to public, anon, authenticated;
grant execute on function public._cc_intake_do_convert(uuid) to public, anon, authenticated;
grant execute on function public._cc_amend_recompute(uuid) to public, anon, authenticated;
grant execute on function public._pos_recompute_order_payment(uuid) to anon, authenticated;

do $post$
declare f text; a text; n int;
begin
  for f, a in select * from (values ('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public._cc_intake_do_convert(uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public._cc_amend_recompute(uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public._pos_recompute_order_payment(uuid)', '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}')) v(x, y) loop
    if (select array_agg(e order by e) from unnest((select proacl from pg_proc where oid = f::regprocedure)::text[]) e)
       is distinct from (select array_agg(e order by e) from unnest(a::text[]) e) then
      raise exception 'RB POST: ACL of % is % (expected pre-image %)', f, (select proacl::text from pg_proc where oid = f::regprocedure), a;
    end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('_pos_assert_line_signs','_pos_order_price_snapshot','_pos_price_matches','_pos_assert_line_prices');
  if n <> 0 then raise exception 'RB POST: % helper(s) still present', n; end if;
  if 'pos.price_override' = any(public.permission_catalog()) then raise exception 'RB POST: key still in catalog'; end if;
end
$post$;

notify pgrst, 'reload schema';
