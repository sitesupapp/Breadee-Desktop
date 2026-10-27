-- ============================================================================
-- Breadee Final Foundation — PRICE (P0 server price integrity), STAGING.
-- Target: STAGING azjxprewycygsocusxjn. Apply ONCE via apply_migration name = foundation_price_integrity (single transaction).
-- Staging: rehearse (rolled back) first, then apply (zero downtime; additive + refusals only).
-- GENERATED from scratchpad price/template.sql (gen.ps1); do not hand-edit anchors or md5 constants.
--
-- WHY: _pos_insert_order_items stored the client's base_price / modifier price_delta / quantity as sent:
-- no reprice, no sign checks (web, desktop online and desktop offline replay alike). It and three other
-- order-total helpers were also EXECUTE-granted to PUBLIC/anon/authenticated (direct-RPC bypass of every
-- permission, OU and price check).
-- WHAT (PO decision 2026-10-27; conservative defaults, PO-adjustable):
--  P1 _pos_insert_order_items (every line writer) + cc_intake_save + cc_amendment_request: refuse quantity<=0,
--     negative base_price, modifier quantity<=0, negative modifier price_delta
--     (pos_op_error INVALID_LINE_QUANTITY / INVALID_LINE_PRICE, P0001 + detail.pos_error_code; nothing written).
--  P2 pos_save_order (=> pos_submit_order AFTER its client_op_id replay lookup) and pos_edit_order_line_core
--     (=> pos_edit_order_line AFTER pos_op_replay): every menu line must carry the CURRENT menu price of the
--     order's OU — coalesce(menu_item_branch_availability.price_override, menu_items.price), or the same price
--     resolved by resolve_price_amount() at the order's rate snapshot or the tenant's current rate (exactly
--     what pos_menu + the clients' resolveMenuPrice show) — within 0.005 in the order currency; modifier
--     deltas likewise from coalesce(modifier_option_ou.extra_price, modifier_options.extra_price).
--     A mismatch is REFUSED with PRICE_CHANGED — the price is never silently rewritten.
--     Prices already recorded on the SAME order (full re-save of an existing order; edit of an existing line)
--     stay valid (historical lines are never repriced). Lines without menu_item_id (custom / open price) and
--     non-zero modifiers without option_id need the NEW permission pos.price_override (default OFF for every
--     role, super-admin exempt) else PRICE_OVERRIDE_NOT_PERMITTED.
--  P3 permission_catalog(): + 'pos.price_override' (additive; grantable via role templates / user overrides).
--  P4 REVOKE EXECUTE FROM PUBLIC, anon, authenticated on _pos_insert_order_items, _cc_intake_do_convert,
--     _cc_amend_recompute, _pos_recompute_order_payment (callers are all SECURITY DEFINER owned by postgres;
--     no web/desktop client calls them; service_role keeps EXECUTE).
-- Unchanged on purpose: pos_add_order_items_core (already prices from the menu), pos_order_add_combo (server-
-- priced), merge/move (UPDATE re-parent only), _cc_intake_do_convert / cc_amendment_accept bodies (sign checks
-- via P1 only — call-center pricing-OU semantics unchanged this tranche).
-- Honest clients: identical rows and result JSON (nothing is rewritten; refusals only).
--
-- METHOD: modified bodies rebuilt from the LIVE definition + exact anchored replace() asserted exactly-once
-- (CRLF-tolerant); each rebuilt text must hash to its expected post-image before execute. Signatures unchanged
-- (CREATE OR REPLACE keeps owner/ACL/SECURITY DEFINER/search_path); POST guards verify md5, ACL (unchanged except
-- the four revoked helpers), SECURITY DEFINER, search_path, owner, overload counts, unchanged dependencies.
-- No business data read or written.
-- ROLLBACK: staging_foundation_price_integrity_ROLLBACK.sql (roll this back BEFORE any 1.0.37 contracts rollback — that one re-anchors
-- _pos_insert_order_items from the live body and asserts its 1.0.37 pre-image md5).
-- ============================================================================

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create temp table _prc_build(fn text, m text) on commit drop;
create temp table _prc_pre(fn text primary key, m text, acl text, secdef boolean, cfg text, own text) on commit drop;

-- ---------------------------------------------------------------- PRE guards
do $pre$
declare m text; f text; n int;
begin
  for f, m in select * from (values
      ('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', '1b64ea09b550d4e72dd3a22702b915a1'),
      ('public.pos_save_order(jsonb)', '1c08e24d8680e62b3908d341f80945dd'),
      ('public.pos_edit_order_line_core(jsonb)', '853eb21bff2111250f708cabd6309371'),
      ('public.cc_intake_save(jsonb)', 'd0d8b81713eaf9e287e416786a915d60'),
      ('public.cc_amendment_request(jsonb)', 'e0949aac79917b3b58be8fd335d3bbab'),
      ('public.permission_catalog()', 'a4f316c3fa7a32ab4f059c7718579f08')) v(a, b) loop
    if md5(pg_get_functiondef(f::regprocedure)) <> m then
      raise exception 'PRE: % drifted (md5 %, expected %)', f, md5(pg_get_functiondef(f::regprocedure)), m;
    end if;
  end loop;
  -- capture identity of every touched / depended-on function (env-agnostic POST comparison)
  insert into _prc_pre
  select p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), p.proacl::text, p.prosecdef, p.proconfig::text, pg_get_userbyid(p.proowner)
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in (
     '_pos_insert_order_items','pos_save_order','pos_edit_order_line_core','cc_intake_save','cc_amendment_request','permission_catalog',
     '_cc_intake_do_convert','_cc_amend_recompute','_pos_recompute_order_payment',
     'pos_submit_order','pos_edit_order_line','pos_add_order_items','pos_add_order_items_core','pos_order_add_combo',
     'cc_amendment_accept','cc_branch_accept','pos_op_error','pos_op_replay','pos_op_record','resolve_price_amount',
     'price_metadata_complete','can_user_permission','get_user_effective_permissions','role_default_true_keys',
     'is_super_admin','pos_merge_tables_v3','pos_merge_tables_core','pos_menu');
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('_pos_assert_line_signs','_pos_order_price_snapshot','_pos_price_matches','_pos_assert_line_prices');
  if n <> 0 then raise exception 'PRE: price-integrity helpers already exist (%)', n; end if;
  if position('pos.price_override' in pg_get_functiondef('public.permission_catalog()'::regprocedure)) > 0 then
    raise exception 'PRE: pos.price_override already in permission_catalog()';
  end if;
  -- the exposure being closed must exist (else the environment is not the one this file was generated for)
  if not (has_function_privilege('authenticated', 'public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public._cc_intake_do_convert(uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public._cc_amend_recompute(uuid)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public._pos_recompute_order_payment(uuid)', 'EXECUTE')) then
    raise exception 'PRE: helper ACL pre-image differs from the generated environment';
  end if;
  -- every caller of the four helpers must be SECURITY DEFINER (they keep working after the revoke)
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.prokind = 'f' and not p.prosecdef
     and pg_get_functiondef(p.oid) ~ '\m(_pos_insert_order_items|_cc_intake_do_convert|_cc_amend_recompute|_pos_recompute_order_payment)\s*\(';
  if n <> 0 then raise exception 'PRE: % SECURITY INVOKER caller(s) of a helper being revoked', n; end if;
  select count(*) into n from pg_policies pol
   where coalesce(pol.qual,'') || coalesce(pol.with_check,'') ~ '(_pos_insert_order_items|_cc_intake_do_convert|_cc_amend_recompute|_pos_recompute_order_payment)';
  if n <> 0 then raise exception 'PRE: % RLS policy reference(s) to a helper being revoked', n; end if;
end
$pre$;

-- ---------------------------------------------------------------- helpers: exactly-once replace (CRLF tolerant), build+exec
create or replace function pg_temp._prc_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int; a text := p_anchor; r text := p_repl;
begin
  if position(chr(13) in p_src) > 0 then
    a := replace(p_anchor, chr(10), chr(13) || chr(10));
    r := replace(p_repl, chr(10), chr(13) || chr(10));
  end if;
  n := (length(p_src) - length(replace(p_src, a, ''))) / nullif(length(a), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  return replace(p_src, a, r);
end $f$;

create or replace function pg_temp._prc_exec(p_fn text, p_def text, p_expected text)
returns void language plpgsql as $f$
begin
  insert into _prc_build values (p_fn, md5(p_def));
  if p_expected <> 'SKIP' and md5(p_def) <> p_expected then
    raise exception 'BUILD: % post-image md5 % (expected %)', p_fn, md5(p_def), p_expected;
  end if;
  execute p_def;
end $f$;

-- ---------------------------------------------------------------- P1/P2 new internal helpers
create or replace function public._pos_assert_line_signs(p_items jsonb)
 returns void
 language plpgsql
 set search_path to 'public'
as $function$
-- PRICE P0: a line may never carry a non-positive quantity or a negative price (web, desktop, replay, call center).
declare it jsonb; md jsonb; v_n int := 0; v_q numeric; v_p numeric; v_name text;
begin
  for it in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    v_n := v_n + 1;
    v_name := coalesce(it->>'name','Item');
    v_q := coalesce((it->>'quantity')::numeric, 1);
    if v_q::text in ('NaN','Infinity','-Infinity') or v_q <= 0 then
      perform public.pos_op_error('INVALID_LINE_QUANTITY',
        format('Line %s (%s): the quantity must be greater than zero.', v_n, v_name));
    end if;
    v_p := coalesce((it->>'base_price')::numeric, 0);
    if v_p::text in ('NaN','Infinity','-Infinity') or v_p < 0 then
      perform public.pos_op_error('INVALID_LINE_PRICE',
        format('Line %s (%s): the price cannot be negative.', v_n, v_name));
    end if;
    for md in select * from jsonb_array_elements(coalesce(it->'modifiers','[]'::jsonb)) loop
      v_q := coalesce((md->>'quantity')::numeric, 1);
      if v_q::text in ('NaN','Infinity','-Infinity') or v_q <= 0 then
        perform public.pos_op_error('INVALID_LINE_QUANTITY',
          format('Line %s (%s): option "%s" must have a quantity greater than zero.', v_n, v_name, coalesce(md->>'name','Extra')));
      end if;
      v_p := coalesce((md->>'price_delta')::numeric, 0);
      if v_p::text in ('NaN','Infinity','-Infinity') or v_p < 0 then
        perform public.pos_op_error('INVALID_LINE_PRICE',
          format('Line %s (%s): option "%s" cannot have a negative price.', v_n, v_name, coalesce(md->>'name','Extra')));
      end if;
    end loop;
  end loop;
end; $function$;

create or replace function public._pos_order_price_snapshot(p_order uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  -- PRICE P0: the prices already recorded on an order (historical lines are never repriced).
  select coalesce(jsonb_agg(jsonb_build_object(
           'menu_item_id', i.menu_item_id, 'name', i.name_snapshot, 'base_price', i.base_price,
           'modifiers', (select coalesce(jsonb_agg(jsonb_build_object(
                            'option_id', m.modifier_option_id, 'name', m.name_snapshot, 'price_delta', m.price_delta)), '[]'::jsonb)
                           from public.pos_order_item_modifiers m where m.order_item_id = i.id))), '[]'::jsonb)
    from public.pos_order_items i where i.order_id = p_order;
$function$;

create or replace function public._pos_price_matches(p_client numeric, p_legacy numeric, p_ec text, p_usd numeric, p_row_rate numeric,
                                                     p_primary text, p_order_rate numeric, p_tenant_rate numeric)
 returns boolean
 language sql
 stable
 set search_path to 'public'
as $function$
  -- PRICE P0: the client price equals the canonical menu price (stored column, or the currency-aware price that
  -- pos_menu + resolveMenuPrice show, at the order's rate snapshot or the tenant's current rate) within 0.005.
  select abs(p_client - coalesce(p_legacy, 0)) <= 0.005
      or coalesce(abs(p_client - public.resolve_price_amount(p_legacy, p_ec, p_usd, p_row_rate, p_primary, p_order_rate)) <= 0.005, false)
      or coalesce(abs(p_client - public.resolve_price_amount(p_legacy, p_ec, p_usd, p_row_rate, p_primary, p_tenant_rate)) <= 0.005, false);
$function$;

create or replace function public._pos_assert_line_prices(p_tenant uuid, p_branch uuid, p_order uuid, p_items jsonb, p_recorded jsonb, p_actor uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
-- PRICE P0: menu lines must carry the current menu price of the order's OU (fail-closed PRICE_CHANGED, never
-- rewritten); prices already recorded on this order (p_recorded) stay valid; custom-priced lines need
-- pos.price_override. Sign checks first (INVALID_LINE_QUANTITY / INVALID_LINE_PRICE).
declare
  it jsonb; md jsonb; v_n int := 0;
  v_mi uuid; v_opt uuid; v_name text; v_oname text; v_price numeric; v_delta numeric;
  v_legacy numeric; v_ec text; v_usd numeric; v_rrate numeric; v_found boolean;
  v_pc text; v_orate numeric; v_tpc text; v_trate numeric;
  v_override boolean; v_mem uuid;
  v_rec jsonb := coalesce(p_recorded, '[]'::jsonb);
begin
  perform public._pos_assert_line_signs(p_items);

  select o.primary_currency_snapshot, o.usd_to_lbp_rate_snapshot into v_pc, v_orate from public.pos_orders o where o.id = p_order;
  select s.primary_currency, s.usd_to_lbp_rate into v_tpc, v_trate from public.tenant_currency_settings s where s.tenant_id = p_tenant;
  v_pc := coalesce(v_pc, v_tpc, 'USD');

  for it in select * from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
    v_n := v_n + 1;
    v_mi := nullif(it->>'menu_item_id','')::uuid;
    v_name := coalesce(it->>'name','Item');
    v_price := coalesce((it->>'base_price')::numeric, 0);

    if exists (select 1 from jsonb_array_elements(v_rec) g
                where nullif(g->>'menu_item_id','')::uuid is not distinct from v_mi
                  and (v_mi is not null or coalesce(g->>'name', g->>'name_snapshot') is not distinct from v_name)
                  and abs(coalesce((g->>'base_price')::numeric, 0) - v_price) <= 0.005) then
      null;  -- a price already recorded on this order
    elsif v_mi is null then
      if v_override is null then
        if public.is_super_admin() then v_override := true;
        else
          select tu.id into v_mem from public.tenant_users tu
           where tu.user_id = coalesce(p_actor, auth.uid()) and tu.tenant_id = p_tenant and tu.status = 'active' limit 1;
          v_override := coalesce(public.can_user_permission(p_tenant, v_mem, 'pos.price_override'), false);
        end if;
      end if;
      if not v_override then
        perform public.pos_op_error('PRICE_OVERRIDE_NOT_PERMITTED',
          format('"%s" is a custom-priced item and you do not have permission to set item prices.', v_name));
      end if;
    else
      select coalesce(a.price_override, i.price),
             case when a.price_override is not null then a.price_entered_currency else i.price_entered_currency end,
             case when a.price_override is not null then a.price_amount_usd else i.price_amount_usd end,
             case when a.price_override is not null then a.price_exchange_rate_usd_to_lbp else i.price_exchange_rate_usd_to_lbp end
        into v_legacy, v_ec, v_usd, v_rrate
        from public.menu_items i
        left join public.menu_item_branch_availability a
          on a.menu_item_id = i.id and a.branch_id = p_branch and a.tenant_id = p_tenant
       where i.id = v_mi and i.tenant_id = p_tenant
       order by a.archived_at nulls first
       limit 1;
      v_found := found;
      if not v_found or not public._pos_price_matches(v_price, v_legacy, v_ec, v_usd, v_rrate, v_pc, v_orate, v_trate) then
        perform public.pos_op_error('PRICE_CHANGED',
          format('The price of "%s" changed since this order was taken (sent %s). Review the order and send it again at the current menu price.',
                 v_name, v_price));
      end if;
    end if;

    for md in select * from jsonb_array_elements(coalesce(it->'modifiers','[]'::jsonb)) loop
      v_opt := nullif(md->>'option_id','')::uuid;
      v_oname := coalesce(md->>'name','Extra');
      v_delta := coalesce((md->>'price_delta')::numeric, 0);
      if exists (select 1 from jsonb_array_elements(v_rec) g, jsonb_array_elements(coalesce(g->'modifiers','[]'::jsonb)) gm
                  where nullif(gm->>'option_id','')::uuid is not distinct from v_opt
                    and (v_opt is not null or gm->>'name' is not distinct from v_oname)
                    and abs(coalesce((gm->>'price_delta')::numeric, 0) - v_delta) <= 0.005) then
        null;
      elsif v_opt is null then
        if v_delta <> 0 then
          if v_override is null then
            if public.is_super_admin() then v_override := true;
            else
              select tu.id into v_mem from public.tenant_users tu
               where tu.user_id = coalesce(p_actor, auth.uid()) and tu.tenant_id = p_tenant and tu.status = 'active' limit 1;
              v_override := coalesce(public.can_user_permission(p_tenant, v_mem, 'pos.price_override'), false);
            end if;
          end if;
          if not v_override then
            perform public.pos_op_error('PRICE_OVERRIDE_NOT_PERMITTED',
              format('Option "%s" on "%s" has a custom price and you do not have permission to set item prices.', v_oname, v_name));
          end if;
        end if;
      else
        select coalesce(oo.extra_price, o.extra_price),
               case when oo.extra_price is not null then oo.price_entered_currency else o.price_entered_currency end,
               case when oo.extra_price is not null then oo.price_amount_usd else o.price_amount_usd end,
               case when oo.extra_price is not null then oo.price_exchange_rate_usd_to_lbp else o.price_exchange_rate_usd_to_lbp end
          into v_legacy, v_ec, v_usd, v_rrate
          from public.modifier_options o
          left join public.modifier_option_ou oo
            on oo.modifier_option_id = o.id and oo.branch_id = p_branch and oo.tenant_id = p_tenant
         where o.id = v_opt and o.tenant_id = p_tenant
         order by (oo.is_active and oo.archived_at is null) desc nulls last
         limit 1;
        v_found := found;
        if not v_found or not public._pos_price_matches(v_delta, v_legacy, v_ec, v_usd, v_rrate, v_pc, v_orate, v_trate) then
          perform public.pos_op_error('PRICE_CHANGED',
            format('The price of option "%s" on "%s" changed since this order was taken (sent %s). Review the order and send it again at the current menu price.',
                   v_oname, v_name, v_delta));
        end if;
      end if;
    end loop;
  end loop;
end; $function$;

revoke all on function public._pos_assert_line_signs(jsonb) from public, anon, authenticated;
revoke all on function public._pos_order_price_snapshot(uuid) from public, anon, authenticated;
revoke all on function public._pos_price_matches(numeric,numeric,text,numeric,numeric,text,numeric,numeric) from public, anon, authenticated;
revoke all on function public._pos_assert_line_prices(uuid,uuid,uuid,jsonb,jsonb,uuid) from public, anon, authenticated;
grant execute on function public._pos_assert_line_signs(jsonb) to service_role;
grant execute on function public._pos_order_price_snapshot(uuid) to service_role;
grant execute on function public._pos_price_matches(numeric,numeric,text,numeric,numeric,text,numeric,numeric) to service_role;
grant execute on function public._pos_assert_line_prices(uuid,uuid,uuid,jsonb,jsonb,uuid) to service_role;

-- ---------------------------------------------------------------- P1/P2/P3 rebuilt from the LIVE bodies
do $apply$
declare d text;
begin
  -- P1 _pos_insert_order_items: sign checks before anything is written (covers save/submit, add, edit, cc convert/amend)
  d := pg_get_functiondef('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)'::regprocedure);
  d := pg_temp._prc_once(d,
    E'begin\n  for it in select * from jsonb_array_elements(coalesce(p_items,''[]''::jsonb)) loop\n',
    E'begin\n  -- PRICE P0: refuse quantity <= 0 and negative prices / modifier deltas before anything is written.\n  perform public._pos_assert_line_signs(p_items);\n  for it in select * from jsonb_array_elements(coalesce(p_items,''[]''::jsonb)) loop\n',
    'insert_items.signs');
  perform pg_temp._prc_exec('_pos_insert_order_items', d, '8b14eaf02661bce904d832b0d25e9788');

  -- P2 pos_save_order: reprice-verify before the insert; a full re-save keeps the prices already on the order
  d := pg_get_functiondef('public.pos_save_order(jsonb)'::regprocedure);
  d := pg_temp._prc_once(d,
    E'  v_expected_order uuid := nullif(p_payload->>''expected_order_id'','''')::uuid;\nbegin\n',
    E'  v_expected_order uuid := nullif(p_payload->>''expected_order_id'','''')::uuid;\n  v_price_gf jsonb;  -- PRICE P0: prices already recorded on this order (a full re-save keeps them)\nbegin\n',
    'save.decl');
  d := pg_temp._prc_once(d,
    E'    delete from public.pos_order_items where order_id=v_id;\n  end if;\n',
    E'    v_price_gf := public._pos_order_price_snapshot(v_id);\n    delete from public.pos_order_items where order_id=v_id;\n  end if;\n',
    'save.snapshot');
  d := pg_temp._prc_once(d,
    E'\n  v_sub := public._pos_insert_order_items(v_tenant, v_branch, v_id, coalesce(p_payload->''items'',''[]''::jsonb), v_batch, v_super, auth.uid());',
    E'\n  -- PRICE P0: menu lines must carry the current menu price (else PRICE_CHANGED, nothing written); custom lines need pos.price_override.\n  perform public._pos_assert_line_prices(v_tenant, v_branch, v_id, coalesce(p_payload->''items'',''[]''::jsonb), v_price_gf, auth.uid());\n  v_sub := public._pos_insert_order_items(v_tenant, v_branch, v_id, coalesce(p_payload->''items'',''[]''::jsonb), v_batch, v_super, auth.uid());',
    'save.guard');
  perform pg_temp._prc_exec('pos_save_order', d, '66f2c447f93ae50809bc896a563e9ce9');

  -- P2 pos_edit_order_line_core: the edited line keeps its recorded prices; a NEW option must carry the menu price
  d := pg_get_functiondef('public.pos_edit_order_line_core(jsonb)'::regprocedure);
  d := pg_temp._prc_once(d,
    'perform public._pos_insert_order_items(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, v_batch, true, auth.uid());',
    'perform public._pos_assert_line_prices(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, jsonb_build_array(v_snap), auth.uid());  /* PRICE P0 */ perform public._pos_insert_order_items(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, v_batch, true, auth.uid());',
    'edit.guard', 2);
  perform pg_temp._prc_exec('pos_edit_order_line_core', d, '75d327c251b0e512723c7834b74321db');

  -- P1 cc_intake_save: sign checks on the stored intake lines (pricing-OU semantics unchanged this tranche)
  d := pg_get_functiondef('public.cc_intake_save(jsonb)'::regprocedure);
  d := pg_temp._prc_once(d,
    E'  if p_payload ? ''items'' then\n    delete from public.call_center_order_intake_items where intake_id=v_id;',
    E'  if p_payload ? ''items'' then\n    perform public._pos_assert_line_signs(coalesce(p_payload->''items'',''[]''::jsonb));  -- PRICE P0\n    delete from public.call_center_order_intake_items where intake_id=v_id;',
    'ccsave.signs');
  perform pg_temp._prc_exec('cc_intake_save', d, 'c512773e9fe85b0526b29b89594e470a');

  -- P1 cc_amendment_request: an added / re-optioned line may not carry quantity <= 0 or a negative price
  d := pg_get_functiondef('public.cc_amendment_request(jsonb)'::regprocedure);
  d := pg_temp._prc_once(d,
    E'  if v_type = ''add_item'' and nullif(p_payload->>''menu_item_id'','''') is null then',
    E'  -- PRICE P0: an added / re-optioned line may not carry quantity <= 0 or a negative price.\n  if v_type in (''add_item'',''modifier_change'') then\n    perform public._pos_assert_line_signs(jsonb_build_array(jsonb_build_object(\n      ''name'', coalesce(p_payload->>''name'',''Item''),\n      ''quantity'', case when v_type = ''add_item'' then p_payload->''quantity'' end,\n      ''base_price'', case when v_type = ''add_item'' then p_payload->''base_price'' end,\n      ''modifiers'', coalesce(p_payload->''modifiers'',''[]''::jsonb))));\n  end if;\n  if v_type = ''add_item'' and nullif(p_payload->>''menu_item_id'','''') is null then',
    'amreq.signs');
  perform pg_temp._prc_exec('cc_amendment_request', d, 'e45c3c2a8f4a6908041ea3e0c4b13a42');

  -- P3 permission_catalog: + pos.price_override (staging = sorted literal; production = quoted list)
  d := pg_get_functiondef('public.permission_catalog()'::regprocedure);
  if position(',pos.print_receipts,' in d) > 0 then
    d := pg_temp._prc_once(d, ',pos.print_receipts,', ',pos.price_override,pos.print_receipts,', 'catalog.literal');
  else
    d := pg_temp._prc_once(d, '''pos.payouts.view'',''pos.payouts.create'',''pos.payouts.reverse'',',
      '''pos.payouts.view'',''pos.payouts.create'',''pos.payouts.reverse'',''pos.price_override'',', 'catalog.quoted');
  end if;
  perform pg_temp._prc_exec('permission_catalog', d, 'cdd507779665af1975903ddfef1a2a0c');
end
$apply$;

-- ---------------------------------------------------------------- P4 close the direct-RPC bypass
revoke execute on function public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid) from public, anon, authenticated;
revoke execute on function public._cc_intake_do_convert(uuid) from public, anon, authenticated;
revoke execute on function public._cc_amend_recompute(uuid) from public, anon, authenticated;
revoke execute on function public._pos_recompute_order_payment(uuid) from public, anon, authenticated;
grant execute on function public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid) to service_role;
grant execute on function public._cc_intake_do_convert(uuid) to service_role;
grant execute on function public._cc_amend_recompute(uuid) to service_role;
grant execute on function public._pos_recompute_order_payment(uuid) to service_role;

-- ---------------------------------------------------------------- POST guards
do $post$
declare r record; f text; m text; n int; v_new text[] := array[
  'public._pos_assert_line_signs(jsonb)', 'public._pos_order_price_snapshot(uuid)',
  'public._pos_price_matches(numeric,numeric,text,numeric,numeric,text,numeric,numeric)',
  'public._pos_assert_line_prices(uuid,uuid,uuid,jsonb,jsonb,uuid)'];
  v_revoked text[] := array[
  'public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', 'public._cc_intake_do_convert(uuid)',
  'public._cc_amend_recompute(uuid)', 'public._pos_recompute_order_payment(uuid)'];
begin
  for f, m in select * from (values
      ('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', '8b14eaf02661bce904d832b0d25e9788'),
      ('public.pos_save_order(jsonb)', '66f2c447f93ae50809bc896a563e9ce9'),
      ('public.pos_edit_order_line_core(jsonb)', '75d327c251b0e512723c7834b74321db'),
      ('public.cc_intake_save(jsonb)', 'c512773e9fe85b0526b29b89594e470a'),
      ('public.cc_amendment_request(jsonb)', 'e45c3c2a8f4a6908041ea3e0c4b13a42'),
      ('public.permission_catalog()', 'cdd507779665af1975903ddfef1a2a0c')) v(a, b) loop
    if m <> 'SKIP' and md5(pg_get_functiondef(f::regprocedure)) <> m then
      raise exception 'POST: % md5 % (expected %)', f, md5(pg_get_functiondef(f::regprocedure)), m;
    end if;
  end loop;
  -- new helpers: CR-normalised md5, internal-only ACL, owner postgres
  for f, m in select * from (values
      ('public._pos_assert_line_signs(jsonb)', '6597982f8b7cecd4fb62479c07c9fe7d'),
      ('public._pos_order_price_snapshot(uuid)', 'c6807bf9ca5d5b3f2ec5e5e506f04b9e'),
      ('public._pos_price_matches(numeric,numeric,text,numeric,numeric,text,numeric,numeric)', '20ef4d56a255429678d98502d6d50781'),
      ('public._pos_assert_line_prices(uuid,uuid,uuid,jsonb,jsonb,uuid)', 'e7aab7311c10d00708361d56a7c82457')) v(a, b) loop
    if m <> 'SKIP' and md5(replace(pg_get_functiondef(f::regprocedure), chr(13), '')) <> m then
      raise exception 'POST: new % md5 % (expected %)', f, md5(replace(pg_get_functiondef(f::regprocedure), chr(13), '')), m;
    end if;
  end loop;
  foreach f in array v_new || v_revoked loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE')
       or (select proacl::text from pg_proc where oid = f::regprocedure) ~ '(^\{|,)=' then
      raise exception 'POST: % is still executable by PUBLIC/anon/authenticated', f;
    end if;
    if not has_function_privilege('service_role', f, 'EXECUTE') then raise exception 'POST: % lost service_role EXECUTE', f; end if;
    if (select pg_get_userbyid(proowner) from pg_proc where oid = f::regprocedure) <> 'postgres' then raise exception 'POST: % owner', f; end if;
  end loop;
  -- every captured function: same SECURITY DEFINER / search_path / owner; ACL unchanged unless revoked;
  -- body unchanged unless it is one of the six rebuilt functions
  for r in select p.*, x.oid as xoid, x.prosecdef as now_secdef, x.proconfig::text as now_cfg, pg_get_userbyid(x.proowner) as now_own,
                  x.proacl::text as now_acl, md5(pg_get_functiondef(x.oid)) as now_m
             from _prc_pre p left join pg_proc x on x.oid = to_regprocedure(p.fn) loop
    if r.xoid is null then raise exception 'POST: % disappeared', r.fn; end if;
    if r.now_secdef is distinct from r.secdef or r.now_cfg is distinct from r.cfg or r.now_own is distinct from r.own then
      raise exception 'POST: % definer/search_path/owner changed', r.fn;
    end if;
    if r.xoid <> all (array(select unnest(v_revoked)::regprocedure::oid)) and r.now_acl is distinct from r.acl then
      raise exception 'POST: ACL of % changed (% -> %)', r.fn, r.acl, r.now_acl;
    end if;
    if r.fn not in ('_pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)', 'pos_save_order(jsonb)', 'pos_edit_order_line_core(jsonb)',
                    'cc_intake_save(jsonb)', 'cc_amendment_request(jsonb)', 'permission_catalog()')
       and r.now_m is distinct from r.m then
      raise exception 'POST: dependency % changed', r.fn;
    end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('_pos_insert_order_items','pos_save_order','pos_edit_order_line_core','cc_intake_save',
     'cc_amendment_request','permission_catalog','_pos_assert_line_signs','_pos_order_price_snapshot','_pos_price_matches','_pos_assert_line_prices');
  if n <> 10 then raise exception 'POST: overload count % (expected 10)', n; end if;
  if not ('pos.price_override' = any(public.permission_catalog())) then raise exception 'POST: pos.price_override not in catalog'; end if;
end
$post$;

notify pgrst, 'reload schema';
