-- PRICE (foundation_price_integrity): READ-ONLY anchor proof. Pure SELECT over the catalog: no DDL, no DML.
-- Run on the target (production: cltlqfqormkhppmbvyrv) BEFORE any GO. Expect: every anchor count = expected,
-- pre_md5 = the PRE constants of the prepared file, post_md5 = its POST constants, exposure rows = true,
-- invoker_callers = 0, policy_refs = 0, data_violations all 0.
with src as (
  select f, d, position(chr(13) in d) > 0 as crlf from (values
    ('ins',   pg_get_functiondef('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)'::regprocedure)),
    ('save',  pg_get_functiondef('public.pos_save_order(jsonb)'::regprocedure)),
    ('edit',  pg_get_functiondef('public.pos_edit_order_line_core(jsonb)'::regprocedure)),
    ('cc',    pg_get_functiondef('public.cc_intake_save(jsonb)'::regprocedure)),
    ('amreq', pg_get_functiondef('public.cc_amendment_request(jsonb)'::regprocedure)),
    ('cat',   pg_get_functiondef('public.permission_catalog()'::regprocedure))) v(f, d)
), edits(f, ord, anchor, repl, expect) as (values
  ('ins', 1, E'begin\n  for it in select * from jsonb_array_elements(coalesce(p_items,''[]''::jsonb)) loop\n',
             E'begin\n  -- PRICE P0: refuse quantity <= 0 and negative prices / modifier deltas before anything is written.\n  perform public._pos_assert_line_signs(p_items);\n  for it in select * from jsonb_array_elements(coalesce(p_items,''[]''::jsonb)) loop\n', 1),
  ('save', 1, E'  v_expected_order uuid := nullif(p_payload->>''expected_order_id'','''')::uuid;\nbegin\n',
              E'  v_expected_order uuid := nullif(p_payload->>''expected_order_id'','''')::uuid;\n  v_price_gf jsonb;  -- PRICE P0: prices already recorded on this order (a full re-save keeps them)\nbegin\n', 1),
  ('save', 2, E'    delete from public.pos_order_items where order_id=v_id;\n  end if;\n',
              E'    v_price_gf := public._pos_order_price_snapshot(v_id);\n    delete from public.pos_order_items where order_id=v_id;\n  end if;\n', 1),
  ('save', 3, E'\n  v_sub := public._pos_insert_order_items(v_tenant, v_branch, v_id, coalesce(p_payload->''items'',''[]''::jsonb), v_batch, v_super, auth.uid());',
              E'\n  -- PRICE P0: menu lines must carry the current menu price (else PRICE_CHANGED, nothing written); custom lines need pos.price_override.\n  perform public._pos_assert_line_prices(v_tenant, v_branch, v_id, coalesce(p_payload->''items'',''[]''::jsonb), v_price_gf, auth.uid());\n  v_sub := public._pos_insert_order_items(v_tenant, v_branch, v_id, coalesce(p_payload->''items'',''[]''::jsonb), v_batch, v_super, auth.uid());', 1),
  ('edit', 1, 'perform public._pos_insert_order_items(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, v_batch, true, auth.uid());',
              'perform public._pos_assert_line_prices(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, jsonb_build_array(v_snap), auth.uid());  /* PRICE P0 */ perform public._pos_insert_order_items(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, v_batch, true, auth.uid());', 2),
  ('cc', 1, E'  if p_payload ? ''items'' then\n    delete from public.call_center_order_intake_items where intake_id=v_id;',
            E'  if p_payload ? ''items'' then\n    perform public._pos_assert_line_signs(coalesce(p_payload->''items'',''[]''::jsonb));  -- PRICE P0\n    delete from public.call_center_order_intake_items where intake_id=v_id;', 1),
  ('amreq', 1, E'  if v_type = ''add_item'' and nullif(p_payload->>''menu_item_id'','''') is null then',
               E'  -- PRICE P0: an added / re-optioned line may not carry quantity <= 0 or a negative price.\n  if v_type in (''add_item'',''modifier_change'') then\n    perform public._pos_assert_line_signs(jsonb_build_array(jsonb_build_object(\n      ''name'', coalesce(p_payload->>''name'',''Item''),\n      ''quantity'', case when v_type = ''add_item'' then p_payload->''quantity'' end,\n      ''base_price'', case when v_type = ''add_item'' then p_payload->''base_price'' end,\n      ''modifiers'', coalesce(p_payload->''modifiers'',''[]''::jsonb))));\n  end if;\n  if v_type = ''add_item'' and nullif(p_payload->>''menu_item_id'','''') is null then', 1)
), e2 as (
  select e.f, e.ord, e.expect,
         case when s.crlf then replace(e.anchor, chr(10), chr(13)||chr(10)) else e.anchor end as a,
         case when s.crlf then replace(e.repl, chr(10), chr(13)||chr(10)) else e.repl end as r, s.d
    from edits e join src s using (f)
), counts as (
  select f, ord, expect, (length(d) - length(replace(d, a, ''))) / length(a) as n from e2
), built as (
  select 'ins' f, replace(s.d, (select a from e2 where f='ins'), (select r from e2 where f='ins')) b from src s where s.f='ins'
  union all
  select 'save', replace(replace(replace(s.d, (select a from e2 where f='save' and ord=1), (select r from e2 where f='save' and ord=1)),
                                 (select a from e2 where f='save' and ord=2), (select r from e2 where f='save' and ord=2)),
                         (select a from e2 where f='save' and ord=3), (select r from e2 where f='save' and ord=3)) from src s where s.f='save'
  union all
  select 'edit', replace(s.d, (select a from e2 where f='edit'), (select r from e2 where f='edit')) from src s where s.f='edit'
  union all
  select 'cc', replace(s.d, (select a from e2 where f='cc'), (select r from e2 where f='cc')) from src s where s.f='cc'
  union all
  select 'amreq', replace(s.d, (select a from e2 where f='amreq'), (select r from e2 where f='amreq')) from src s where s.f='amreq'
  union all
  select 'cat', case when position(',pos.print_receipts,' in s.d) > 0
                     then replace(s.d, ',pos.print_receipts,', ',pos.price_override,pos.print_receipts,')
                     else replace(s.d, '''pos.payouts.view'',''pos.payouts.create'',''pos.payouts.reverse'',',
                                       '''pos.payouts.view'',''pos.payouts.create'',''pos.payouts.reverse'',''pos.price_override'',') end
    from src s where s.f='cat'
)
select jsonb_build_object(
  'anchor_counts', (select jsonb_agg(jsonb_build_object('f', f, 'ord', ord, 'n', n, 'expect', expect, 'ok', n = expect) order by f, ord) from counts),
  'catalog_anchor', (select case when position(',pos.print_receipts,' in d) > 0 then 'literal'
                                 when position('''pos.payouts.view'',''pos.payouts.create'',''pos.payouts.reverse'',' in d) > 0 then 'quoted'
                                 else 'MISSING' end from src where f='cat'),
  'catalog_has_key_already', (select position('pos.price_override' in d) > 0 from src where f='cat'),
  'crlf', (select jsonb_object_agg(f, crlf) from src),
  'pre_md5', (select jsonb_object_agg(f, md5(d)) from src),
  'post_md5', (select jsonb_object_agg(f, md5(b)) from built),
  'new_helpers_present', (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public'
       and p.proname in ('_pos_assert_line_signs','_pos_order_price_snapshot','_pos_price_matches','_pos_assert_line_prices')),
  'exposure_authenticated', (select jsonb_object_agg(f, has_function_privilege('authenticated', f, 'EXECUTE')) from unnest(array[
       'public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', 'public._cc_intake_do_convert(uuid)',
       'public._cc_amend_recompute(uuid)', 'public._pos_recompute_order_payment(uuid)']) f),
  'exposure_acl', (select jsonb_object_agg(p.oid::regprocedure::text, p.proacl::text) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname in ('_pos_insert_order_items','_cc_intake_do_convert','_cc_amend_recompute','_pos_recompute_order_payment')),
  'invoker_callers', (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.prokind = 'f' and not p.prosecdef
         and pg_get_functiondef(p.oid) ~ '\m(_pos_insert_order_items|_cc_intake_do_convert|_cc_amend_recompute|_pos_recompute_order_payment)\s*\('),
  'policy_refs', (select count(*) from pg_policies pol
       where coalesce(pol.qual,'') || coalesce(pol.with_check,'') ~ '(_pos_insert_order_items|_cc_intake_do_convert|_cc_amend_recompute|_pos_recompute_order_payment)'),
  'dependency_md5', (select jsonb_object_agg(p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname in ('pos_op_error','resolve_price_amount','price_metadata_complete','can_user_permission','is_super_admin','pos_submit_order','pos_edit_order_line')),
  'data_violations', jsonb_build_object(
       'menu_neg_price', (select count(*) from public.menu_items where price < 0) + (select count(*) from public.menu_item_branch_availability where price_override < 0),
       'modifier_neg_price', (select count(*) from public.modifier_options where extra_price < 0) + (select count(*) from public.modifier_option_ou where extra_price < 0),
       'open_intakes_bad_lines', (select count(*) from public.call_center_order_intake_items it join public.call_center_order_intake i on i.id = it.intake_id
            where i.status not in ('converted','cancelled') and (it.quantity <= 0 or it.base_price < 0)),
       'custom_lines_30d', (select count(*) from public.pos_order_items where menu_item_id is null and created_at > now() - interval '30 days'))
) as proof;
