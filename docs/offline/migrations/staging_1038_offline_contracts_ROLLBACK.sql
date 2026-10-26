-- ============================================================================
-- ROLLBACK of desktop_1038_offline_contracts_staging (STAGING azjxprewycygsocusxjn ONLY).
-- Restores the exact staging pre-1.0.38 bodies of pos_pay_order_core, pos_pay_table_core,
-- pos_complete_on_account_core and pos_complete_table_on_account_core (inverse anchored replace on the
-- LIVE bodies; the rebuilt text must hash to the captured staging pre-image before it is executed) and
-- drops pos_move_table_v2 / pos_merge_tables_v4. pos_move_table_core is not touched (S1 was skipped).
-- Refuses unless every changed body is exactly the staging 1.0.38 post-image (no drift / no fix-forward
-- on top). Staging-only: no pre-publication ack. NEVER run against production.
-- GENERATED from the same delta definition as the staging forward migration.
-- ============================================================================

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $guard$
begin
  if to_regprocedure('public.pos_move_table_v2(jsonb)') is null or to_regprocedure('public.pos_merge_tables_v4(jsonb)') is null then
    raise exception 'ROLLBACK REFUSED: staging 1.0.38 contracts are not (fully) installed';
  end if;
  if md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)) <> '637c33d216116863f08d2c3a4af0d29b' then raise exception 'ROLLBACK REFUSED: public.pos_pay_order_core(jsonb) is not the staging 1.0.38 post-image (md5 %)', md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)) <> 'e73c0f3dffef636c2a439ffda50ee90b' then raise exception 'ROLLBACK REFUSED: public.pos_pay_table_core(jsonb) is not the staging 1.0.38 post-image (md5 %)', md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure)) <> '1e671a1f0edad27f1e2019798da4db75' then raise exception 'ROLLBACK REFUSED: public.pos_complete_on_account_core(jsonb) is not the staging 1.0.38 post-image (md5 %)', md5(pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure)) <> 'def3ff9a67a1757673fc9742753310c5' then raise exception 'ROLLBACK REFUSED: public.pos_complete_table_on_account_core(jsonb) is not the staging 1.0.38 post-image (md5 %)', md5(pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure)); end if;
end
$guard$;

create or replace function pg_temp._r1038_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int;
begin
  n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / nullif(length(p_anchor), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  return replace(p_src, p_anchor, p_repl);
end $f$;

do $rb$
declare
  d text;
begin
  -- public.pos_pay_order_core(jsonb): inverse deltas, reverse order
  d := pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure);
  d := pg_temp._r1038_once(d,
    E'''finance'', v_fin)\n'
    || E'    || case when v_prior_n > 0 then jsonb_build_object(''prior_paid'', v_prior, ''prior_settlements'', v_prior_n) else ''{}''::jsonb end;\n'
    || E'end; $function$',
    E'''finance'', v_fin);\n'
    || E'end; $function$',
    'rb.pay_order.return');
  d := pg_temp._r1038_once(d,
    E'  perform public._pos_finalize_delivery_settlement(v_order.id);\n'
    || E'  -- Desktop 1.0.38 S4: charge only the remaining obligation R = T - P (order currency).\n'
    || E'  if v_prior_n > 0 then\n'
    || E'    if v_amount - v_prior <= 0.005 then\n'
    || E'      perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid by split settlements.'');\n'
    || E'    end if;\n'
    || E'    v_amount := v_amount - v_prior;\n'
    || E'  end if;\n',
    E'  perform public._pos_finalize_delivery_settlement(v_order.id);\n',
    'rb.pay_order.remaining');
  d := pg_temp._r1038_once(d,
    E'    v_apply := true;\n'
    || E'  end if;\n'
    || E'  if v_apply and v_prior_n > 0 then\n'
    || E'    perform public.pos_op_error(''SPLIT_DISCOUNT_UNSUPPORTED'', ''A discount cannot be applied to a bill that is already part-paid by split settlements.'');\n'
    || E'  end if;\n',
    E'    v_apply := true;\n'
    || E'  end if;\n',
    'rb.pay_order.discount');
  d := pg_temp._r1038_once(d,
    E'  -- Desktop 1.0.38 S4: paid split settlements are part of this bill''s payment. They are read under\n'
    || E'  -- this order''s row lock (pos_split_settle_core takes the same lock), so P is authoritative here.\n'
    || E'  select count(*), coalesce(sum(s.amount_order_ccy), 0) into v_prior_n, v_prior\n'
    || E'    from public.pos_split_settlements s where s.parent_order_id = v_order.id and s.status = ''paid'';\n'
    || E'  if exists (select 1 from public.pos_payments p where p.order_id = v_order.id\n'
    || E'               and not exists (select 1 from public.pos_split_settlements s where s.payment_id = p.id and s.status = ''paid'')) then\n'
    || E'    perform public.pos_op_error(''PAYMENT_RESIDUE'', ''This bill already has payment records that are not split settlements. Review it before taking payment.'');\n'
    || E'  end if;\n'
    || E'  v_sub := coalesce(v_order.subtotal, v_order.total_amount + coalesce(v_order.discount_amount, 0));\n',
    E'  v_sub := coalesce(v_order.subtotal, v_order.total_amount + coalesce(v_order.discount_amount, 0));\n',
    'rb.pay_order.prior');
  d := pg_temp._r1038_once(d,
    E'  v_fin jsonb;\n'
    || E'  v_prior numeric := 0; v_prior_n int := 0;  -- Desktop 1.0.38 S4\n',
    E'  v_fin jsonb;\n',
    'rb.pay_order.declare');
  if md5(d) <> 'fb94df9fef18f25a4e73baf090d43cd2' then raise exception 'RB BUILD: % restored md5 % (expected fb94df9fef18f25a4e73baf090d43cd2)', 'public.pos_pay_order_core(jsonb)', md5(d); end if;
  execute d;

  -- public.pos_pay_table_core(jsonb): inverse deltas, reverse order
  d := pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure);
  d := pg_temp._r1038_once(d,
    E'    ''pos_entity_version'', v_ver)\n'
    || E'    || case when v_prior_cnt > 0 then jsonb_build_object(''prior_paid'', v_prior_total, ''prior_settlements'', v_prior_cnt) else ''{}''::jsonb end;\n'
    || E'end; $function$',
    E'    ''pos_entity_version'', v_ver);\n'
    || E'end; $function$',
    'rb.pay_table.return');
  d := pg_temp._r1038_once(d,
    E'    v_orig_total := v_orig_total + v_orig;\n'
    || E'  end loop;\n'
    || E'  -- Desktop 1.0.38 S5: optional expected_amount (order currency, = the remaining amount the device collected).\n'
    || E'  if v_exp_amount is not null and abs(v_total - v_exp_amount) >= 0.005 then\n'
    || E'    perform public.pos_op_error(''PAY_AMOUNT_CHANGED'', ''The amount due on this table changed since the payment was captured. Reconnect and review before settling.'');\n'
    || E'  end if;\n',
    E'    v_orig_total := v_orig_total + v_orig;\n'
    || E'  end loop;\n',
    'rb.pay_table.amount_pin');
  d := pg_temp._r1038_once(d,
    E'      v_ofinal := r.total_amount;\n'
    || E'      -- Desktop 1.0.38 S4: charge only the remaining obligation R = T - P (order currency).\n'
    || E'      select count(*), coalesce(sum(s.amount_order_ccy), 0) into v_prior_n, v_prior\n'
    || E'        from public.pos_split_settlements s where s.parent_order_id = r.id and s.status = ''paid'';\n'
    || E'      if v_prior_n > 0 then\n'
    || E'        if v_ofinal - v_prior <= 0.005 then\n'
    || E'          perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid by split settlements.'');\n'
    || E'        end if;\n'
    || E'        v_ofinal := v_ofinal - v_prior;\n'
    || E'        v_prior_total := v_prior_total + v_prior; v_prior_cnt := v_prior_cnt + v_prior_n;\n'
    || E'      end if;\n',
    E'      v_ofinal := r.total_amount;\n',
    'rb.pay_table.remaining');
  d := pg_temp._r1038_once(d,
    E'  -- Desktop 1.0.38 S4: paid split settlements are part of each order''s payment (read under the\n'
    || E'  -- order row locks taken above). Refuse residue / discount-on-part-paid / already covered.\n'
    || E'  for r in select o.id, o.total_amount from public.pos_orders o where o.id = any(v_locked) order by o.id loop\n'
    || E'    if exists (select 1 from public.pos_payments p where p.order_id = r.id\n'
    || E'                 and not exists (select 1 from public.pos_split_settlements s where s.payment_id = p.id and s.status = ''paid'')) then\n'
    || E'      perform public.pos_op_error(''PAYMENT_RESIDUE'', ''This bill already has payment records that are not split settlements. Review it before taking payment.'');\n'
    || E'    end if;\n'
    || E'    select count(*), coalesce(sum(s.amount_order_ccy), 0) into v_prior_n, v_prior\n'
    || E'      from public.pos_split_settlements s where s.parent_order_id = r.id and s.status = ''paid'';\n'
    || E'    if v_prior_n > 0 then\n'
    || E'      if v_apply then\n'
    || E'        perform public.pos_op_error(''SPLIT_DISCOUNT_UNSUPPORTED'', ''A discount cannot be applied to a bill that is already part-paid by split settlements.'');\n'
    || E'      end if;\n'
    || E'      if r.total_amount - v_prior <= 0.005 then\n'
    || E'        perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid by split settlements.'');\n'
    || E'      end if;\n'
    || E'    end if;\n'
    || E'  end loop;\n'
    || E'  v_rem := v_bill_disc;\n',
    E'  v_rem := v_bill_disc;\n',
    'rb.pay_table.prior_check');
  d := pg_temp._r1038_once(d,
    E'    v_lock_n := v_lock_n + 1;\n'
    || E'    v_locked := v_locked || r.id;\n'
    || E'  end loop;\n'
    || E'  -- Desktop 1.0.38 S5: a caller that pins expected_order_ids (an offline settle replay) may only pay\n'
    || E'  -- exactly that bill. A newer bill on the same table is never paid by a retried settle.\n'
    || E'  if jsonb_typeof(p_payload->''expected_order_ids'') = ''array'' and jsonb_array_length(p_payload->''expected_order_ids'') > 0 then\n'
    || E'    v_pin := array(select distinct e::uuid from jsonb_array_elements_text(p_payload->''expected_order_ids'') e order by 1);\n'
    || E'    if v_lock_n = 0 then\n'
    || E'      if not exists (select 1 from unnest(v_pin) x where not exists (\n'
    || E'            select 1 from public.pos_orders o where o.id = x and o.tenant_id = v_tbl.tenant_id and o.payment_status = ''paid'')) then\n'
    || E'        perform public.pos_op_error(''ALREADY_SETTLED'', ''This bill was already paid.'');\n'
    || E'      end if;\n'
    || E'      perform public.pos_op_error(''PAY_BILL_CHANGED'', ''The bill on this table changed since the payment was captured. Reconnect and review before settling.'');\n'
    || E'    end if;\n'
    || E'    if v_pin is distinct from array(select x from unnest(v_locked) x order by 1) then\n'
    || E'      perform public.pos_op_error(''PAY_BILL_CHANGED'', ''The bill on this table changed since the payment was captured. Reconnect and review before settling.'');\n'
    || E'    end if;\n'
    || E'  end if;\n',
    E'    v_lock_n := v_lock_n + 1;\n'
    || E'  end loop;\n',
    'rb.pay_table.pin');
  d := pg_temp._r1038_once(d,
    E'  v_lock_ccy text;\n'
    || E'  -- Desktop 1.0.38 S4 (remaining obligation) + S5 (optional bill-identity / amount pins)\n'
    || E'  v_locked uuid[] := ''{}''; v_pin uuid[]; v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
    || E'  v_prior numeric; v_prior_n int; v_prior_total numeric := 0; v_prior_cnt int := 0;\n',
    E'  v_lock_ccy text;\n',
    'rb.pay_table.declare');
  if md5(d) <> 'eb0636059f5e1e6ce83bc28de3a59567' then raise exception 'RB BUILD: % restored md5 % (expected eb0636059f5e1e6ce83bc28de3a59567)', 'public.pos_pay_table_core(jsonb)', md5(d); end if;
  execute d;

  -- public.pos_complete_on_account_core(jsonb): inverse deltas, reverse order
  d := pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure);
  d := pg_temp._r1038_once(d,
    E'    ''pos_entity_version'', v_new_ver)\n'
    || E'    || case when v_prior_n > 0 then jsonb_build_object(\n'
    || E'         ''outstanding_usd'', round(v_total_usd - v_prior_usd - coalesce(v_usd,0), 2),\n'
    || E'         ''outstanding'', greatest(v_total_primary - v_prior_primary - coalesce(v_pay_primary, 0), 0),\n'
    || E'         ''remaining'', greatest(v_total_primary - v_prior_primary, 0),\n'
    || E'         ''prior_paid'', v_prior_primary, ''prior_paid_usd'', round(v_prior_usd, 4), ''prior_payments'', v_prior_n)\n'
    || E'       else ''{}''::jsonb end;\n'
    || E'end; $function$',
    E'    ''pos_entity_version'', v_new_ver);\n'
    || E'end; $function$',
    'rb.oa_order.return');
  d := pg_temp._r1038_once(d,
    E'    if v_prior_n > 0 and v_usd > v_total_usd - v_prior_usd + 0.005 then\n'
    || E'      perform public.pos_op_error(''ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING'', ''The amount paid now cannot exceed the remaining balance of this bill.'');\n'
    || E'    end if;\n'
    || E'    if v_usd > v_total_usd + 0.005 then raise exception ''Amount paid cannot exceed the order total''; end if;\n',
    E'    if v_usd > v_total_usd + 0.005 then raise exception ''Amount paid cannot exceed the order total''; end if;\n',
    'rb.oa_order.cap');
  d := pg_temp._r1038_once(d,
    E'  v_total_primary := (select total_amount from public.pos_orders where id = v_order.id);  -- Desktop 1.0.38 S2b\n'
    || E'  v_total_usd := public._pos_amount_usd(v_total_primary, v_ccy, v_order.usd_to_lbp_rate_snapshot);\n'
    || E'  -- Desktop 1.0.38 S2b: the receivable is only R = T - P. R <= 0 -> ALREADY_PAID (as the pay cores);\n'
    || E'  -- the optional expected_amount (order currency, = R the device showed) refuses a changed bill.\n'
    || E'  if v_prior_n > 0 and v_total_usd - v_prior_usd <= 0.005 then\n'
    || E'    perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid.'');\n'
    || E'  end if;\n'
    || E'  if v_exp_amount is not null and abs(greatest(v_total_primary - v_prior_primary, 0) - v_exp_amount) >= 0.005 then\n'
    || E'    perform public.pos_op_error(''ON_ACCOUNT_AMOUNT_CHANGED'', ''The amount due on this bill changed since On Account was captured. Reconnect and review before settling.'');\n'
    || E'  end if;\n',
    E'  v_total_usd := public._pos_amount_usd((select total_amount from public.pos_orders where id = v_order.id), v_ccy, v_order.usd_to_lbp_rate_snapshot);\n',
    'rb.oa_order.remaining');
  d := pg_temp._r1038_once(d,
    E'    v_apply := true;\n'
    || E'  end if;\n'
    || E'  -- Desktop 1.0.38 S2b: every payment row already on this order (paid split settlements, earlier\n'
    || E'  -- tenders) is part of this bill''s payment. Read under this order''s row lock (split settle and the\n'
    || E'  -- pay cores take the same lock), so P is authoritative here.\n'
    || E'  select count(*), coalesce(sum(p.amount_usd), 0),\n'
    || E'         coalesce(sum(coalesce((select s.amount_order_ccy from public.pos_split_settlements s where s.payment_id = p.id and s.status = ''paid'' limit 1),\n'
    || E'             case when p.currency_code = v_ccy then p.original_amount\n'
    || E'                  when v_ccy = ''LBP'' then round(p.amount_usd * coalesce(v_order.usd_to_lbp_rate_snapshot, 1), 0)\n'
    || E'                  else round(p.amount_usd, 2) end)), 0)\n'
    || E'    into v_prior_n, v_prior_usd, v_prior_primary\n'
    || E'    from public.pos_payments p where p.order_id = v_order.id;\n'
    || E'  if v_apply and v_prior_n > 0 then\n'
    || E'    perform public.pos_op_error(''SPLIT_DISCOUNT_UNSUPPORTED'', ''A discount cannot be applied to a bill that is already part-paid.'');\n'
    || E'  end if;\n'
    || E'  if v_apply then\n',
    E'    v_apply := true;\n'
    || E'  end if;\n'
    || E'  if v_apply then\n',
    'rb.oa_order.prior');
  d := pg_temp._r1038_once(d,
    E'-- Phase 1b\n'
    || E'  -- Desktop 1.0.38 S2b: remaining-obligation On Account (R = T - P) + optional expected_amount pin\n'
    || E'  v_prior_n int := 0; v_prior_usd numeric := 0; v_prior_primary numeric := 0;\n'
    || E'  v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
    || E'  v_total_primary numeric;  -- Desktop 1.0.38 S2b (staging: prod declares it next to v_total_usd)\n'
    || E'begin\n',
    E'-- Phase 1b\n'
    || E'begin\n',
    'rb.oa_order.declare');
  if md5(d) <> '49a5038b339ae463e011a0da76ea9006' then raise exception 'RB BUILD: % restored md5 % (expected 49a5038b339ae463e011a0da76ea9006)', 'public.pos_complete_on_account_core(jsonb)', md5(d); end if;
  execute d;

  -- public.pos_complete_table_on_account_core(jsonb): inverse deltas, reverse order
  d := pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure);
  d := pg_temp._r1038_once(d,
    E'    ''paid_usd'', round(v_paid_total_usd,2), ''outstanding_primary'', round(v_rem_total - coalesce(v_pay_primary,0), 2), ''currency_code'', v_ccy,\n'
    || E'    ''pos_entity_version'', v_new_ver)\n'
    || E'    || case when v_prior_cnt > 0 then jsonb_build_object(''remaining_total'', v_rem_total, ''prior_paid'', v_prior_total, ''prior_payments'', v_prior_cnt)\n'
    || E'       else ''{}''::jsonb end;  -- Desktop 1.0.38 S2b\n'
    || E'end; $function$',
    E'    ''paid_usd'', round(v_paid_total_usd,2), ''outstanding_primary'', round(v_bill_total - coalesce(v_pay_primary,0), 2), ''currency_code'', v_ccy,\n'
    || E'    ''pos_entity_version'', v_new_ver);\n'
    || E'end; $function$',
    'rb.oa_table.return');
  d := pg_temp._r1038_once(d,
    E'      if v_idx < array_length(v_ids, 1) and v_rem_total > 0 then\n'
    || E'        v_alloc := round(v_pay_primary * v_rems[v_idx] / v_rem_total, case when v_ccy = ''LBP'' then 0 else 2 end);  -- 1.0.38 S2b: by R_i\n',
    E'      if v_idx < array_length(v_ids, 1) and v_bill_total > 0 then\n'
    || E'        v_alloc := round(v_pay_primary * v_finals[v_idx] / v_bill_total, case when v_ccy = ''LBP'' then 0 else 2 end);\n',
    'rb.oa_table.alloc');
  d := pg_temp._r1038_once(d,
    E'  -- Desktop 1.0.38 S2b: optional expected_amount (order currency, = the remaining R the device showed,\n'
    || E'  -- before the amount paid now). The upfront amount is capped at R and allocated by R_i.\n'
    || E'  if v_exp_amount is not null and abs(v_rem_total - v_exp_amount) >= 0.005 then\n'
    || E'    perform public.pos_op_error(''ON_ACCOUNT_AMOUNT_CHANGED'', ''The amount due on this bill changed since On Account was captured. Reconnect and review before settling.'');\n'
    || E'  end if;\n'
    || E'  if v_pay_primary > 0 then\n'
    || E'    v_pay_primary := round(v_pay_primary, case when v_ccy = ''LBP'' then 0 else 2 end);\n'
    || E'    if v_prior_cnt > 0 and v_pay_primary > v_rem_total + 0.005 then\n'
    || E'      perform public.pos_op_error(''ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING'', ''The amount paid now cannot exceed the remaining balance of this bill.'');\n'
    || E'    end if;\n'
    || E'    if v_pay_primary > v_bill_total + 0.005 then raise exception ''Amount paid cannot exceed the table total''; end if;\n',
    E'  if v_pay_primary > 0 then\n'
    || E'    v_pay_primary := round(v_pay_primary, case when v_ccy = ''LBP'' then 0 else 2 end);\n'
    || E'    if v_pay_primary > v_bill_total + 0.005 then raise exception ''Amount paid cannot exceed the table total''; end if;\n',
    'rb.oa_table.cap');
  d := pg_temp._r1038_once(d,
    E'    v_finals := array_append(v_finals, v_ofinal);\n'
    || E'    -- Desktop 1.0.38 S2b: R_i = T_i - P_i (order currency).\n'
    || E'    select count(*), coalesce(sum(coalesce((select s.amount_order_ccy from public.pos_split_settlements s where s.payment_id = p.id and s.status = ''paid'' limit 1),\n'
    || E'             case when p.currency_code = v_ccy then p.original_amount\n'
    || E'                  when v_ccy = ''LBP'' then round(p.amount_usd * coalesce(r.usd_to_lbp_rate_snapshot, 1), 0)\n'
    || E'                  else round(p.amount_usd, 2) end)), 0)\n'
    || E'      into v_prior_n, v_prior from public.pos_payments p where p.order_id = r.id;\n'
    || E'    if v_prior_n > 0 then\n'
    || E'      v_rems := array_append(v_rems, greatest(v_ofinal - v_prior, 0));\n'
    || E'      v_rem_total := v_rem_total + greatest(v_ofinal - v_prior, 0);\n'
    || E'      v_prior_total := v_prior_total + v_prior; v_prior_cnt := v_prior_cnt + v_prior_n;\n'
    || E'    else\n'
    || E'      v_rems := array_append(v_rems, v_ofinal);\n'
    || E'      v_rem_total := v_rem_total + v_ofinal;\n'
    || E'    end if;\n',
    E'    v_finals := array_append(v_finals, v_ofinal);\n',
    'rb.oa_table.remaining');
  d := pg_temp._r1038_once(d,
    E'  -- Desktop 1.0.38 S2b: payments already on each order (paid split settlements, earlier tenders) are\n'
    || E'  -- part of this bill''s payment (read under the order row locks taken above). Refuse a discount on a\n'
    || E'  -- part-paid bill and an order whose total is already covered, before anything is written.\n'
    || E'  for r in select o.id, o.total_amount, o.primary_currency_snapshot, o.usd_to_lbp_rate_snapshot\n'
    || E'             from public.pos_orders o where o.id = any(v_locked) order by o.id loop\n'
    || E'    select count(*), coalesce(sum(p.amount_usd), 0) into v_prior_n, v_prior\n'
    || E'      from public.pos_payments p where p.order_id = r.id;\n'
    || E'    if v_prior_n > 0 then\n'
    || E'      if v_apply then\n'
    || E'        perform public.pos_op_error(''SPLIT_DISCOUNT_UNSUPPORTED'', ''A discount cannot be applied to a bill that is already part-paid.'');\n'
    || E'      end if;\n'
    || E'      if public._pos_amount_usd(r.total_amount, coalesce(r.primary_currency_snapshot,''USD''), r.usd_to_lbp_rate_snapshot) - v_prior <= 0.005 then\n'
    || E'        perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid.'');\n'
    || E'      end if;\n'
    || E'    end if;\n'
    || E'  end loop;\n'
    || E'  v_rem := v_bill_disc;\n',
    E'  v_rem := v_bill_disc;\n',
    'rb.oa_table.prior_check');
  d := pg_temp._r1038_once(d,
    E'    v_lock_n := v_lock_n + 1;\n'
    || E'    v_locked := v_locked || r.id;\n'
    || E'  end loop;\n'
    || E'  -- Desktop 1.0.38 S2b: a caller that pins expected_order_ids (an offline On Account replay) may only\n'
    || E'  -- place exactly that bill on account. A newer bill on the same table is never charged.\n'
    || E'  if jsonb_typeof(p_payload->''expected_order_ids'') = ''array'' and jsonb_array_length(p_payload->''expected_order_ids'') > 0 then\n'
    || E'    v_pin := array(select distinct e::uuid from jsonb_array_elements_text(p_payload->''expected_order_ids'') e order by 1);\n'
    || E'    if v_lock_n = 0 then\n'
    || E'      if not exists (select 1 from unnest(v_pin) x where not exists (\n'
    || E'            select 1 from public.pos_orders o where o.id = x and o.tenant_id = v_tbl.tenant_id and o.status = ''completed''\n'
    || E'              and (o.payment_status = ''paid'' or o.settlement_mode = ''on_account''))) then\n'
    || E'        perform public.pos_op_error(''ALREADY_SETTLED'', ''This bill was already settled.'');\n'
    || E'      end if;\n'
    || E'      perform public.pos_op_error(''ON_ACCOUNT_BILL_CHANGED'', ''The bill on this table changed since On Account was captured. Reconnect and review before settling.'');\n'
    || E'    end if;\n'
    || E'    if v_pin is distinct from array(select x from unnest(v_locked) x order by 1) then\n'
    || E'      perform public.pos_op_error(''ON_ACCOUNT_BILL_CHANGED'', ''The bill on this table changed since On Account was captured. Reconnect and review before settling.'');\n'
    || E'    end if;\n'
    || E'  end if;\n',
    E'    v_lock_n := v_lock_n + 1;\n'
    || E'  end loop;\n',
    'rb.oa_table.pin');
  d := pg_temp._r1038_once(d,
    E'-- Phase 1b\n'
    || E'  -- Desktop 1.0.38 S2b: remaining-obligation On Account (R = T - P) + optional bill / amount pins\n'
    || E'  v_locked uuid[] := ''{}''; v_pin uuid[]; v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
    || E'  v_prior numeric; v_prior_n int; v_rems numeric[] := ''{}''; v_rem_total numeric := 0;\n'
    || E'  v_prior_total numeric := 0; v_prior_cnt int := 0;\n'
    || E'begin\n',
    E'-- Phase 1b\n'
    || E'begin\n',
    'rb.oa_table.declare');
  if md5(d) <> '9c5b12f51ccd50c2653d7133957e87a2' then raise exception 'RB BUILD: % restored md5 % (expected 9c5b12f51ccd50c2653d7133957e87a2)', 'public.pos_complete_table_on_account_core(jsonb)', md5(d); end if;
  execute d;
  drop function public.pos_move_table_v2(jsonb);
  drop function public.pos_merge_tables_v4(jsonb);
end
$rb$;

-- POST: every restored body is byte-identical to the captured staging pre-image; ACLs unchanged.
do $post$
begin
  if md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)) <> 'fb94df9fef18f25a4e73baf090d43cd2' then raise exception 'RB POST: public.pos_pay_order_core(jsonb) md5 %', md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)) <> 'eb0636059f5e1e6ce83bc28de3a59567' then raise exception 'RB POST: public.pos_pay_table_core(jsonb) md5 %', md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure)) <> '49a5038b339ae463e011a0da76ea9006' then raise exception 'RB POST: public.pos_complete_on_account_core(jsonb) md5 %', md5(pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure)) <> '9c5b12f51ccd50c2653d7133957e87a2' then raise exception 'RB POST: public.pos_complete_table_on_account_core(jsonb) md5 %', md5(pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure)); end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_pay_order_core(jsonb)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'RB POST: ACL of public.pos_pay_order_core(jsonb) changed'; end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_pay_table_core(jsonb)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'RB POST: ACL of public.pos_pay_table_core(jsonb) changed'; end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_complete_on_account_core(jsonb)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'RB POST: ACL of public.pos_complete_on_account_core(jsonb) changed'; end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_complete_table_on_account_core(jsonb)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'RB POST: ACL of public.pos_complete_table_on_account_core(jsonb) changed'; end if;
  if to_regprocedure('public.pos_move_table_v2(jsonb)') is not null or to_regprocedure('public.pos_merge_tables_v4(jsonb)') is not null then
    raise exception 'RB POST: new functions still present';
  end if;
  if md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure)) <> '6195b2add5797e20e40c2d59b913b557'
     or md5(pg_get_functiondef('public.pos_pay_order(jsonb)'::regprocedure)) <> '70a7ccc17e6df5200b9e00610bda4192'
     or md5(pg_get_functiondef('public.pos_pay_table(jsonb)'::regprocedure)) <> '56588d0ecbc91069b5184107de0003aa'
     or md5(pg_get_functiondef('public.pos_move_table(uuid,uuid,uuid,integer)'::regprocedure)) <> 'c342a7fa766ca0ab89c9f8f496e575a4'
     or md5(pg_get_functiondef('public.pos_merge_tables_v3(jsonb)'::regprocedure)) <> '421821ff4022368815167326f37d5c45'
     or md5(pg_get_functiondef('public.pos_op_replay(uuid,uuid,text,uuid)'::regprocedure)) <> 'd196ad1ce7025419fc5a32f4e87461e3'
     or md5(pg_get_functiondef('public.pos_op_record(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure)) <> '8a2df61e34abbb302698c06b377be017'
     or md5(pg_get_functiondef('public.pos_op_error(text,text)'::regprocedure)) <> 'ed70a93fa4e5321e636ba82efe1c15bd'
     or md5(pg_get_functiondef('public.pos_op_branch_of(text,text)'::regprocedure)) <> 'c8991f7c7452b82e9a43465e1d462816'
     or md5(pg_get_functiondef('public.pos_split_settle_core(jsonb)'::regprocedure)) <> '05263195a3209ac518c33b909c8c8c57'
     or md5(pg_get_functiondef('public.pos_complete_on_account(jsonb)'::regprocedure)) <> 'aff7ce602c0843598c5d50ef6eb94dbb'
     or md5(pg_get_functiondef('public.pos_complete_table_on_account(jsonb)'::regprocedure)) <> '0739f9941891fa9cde520de41d164c18'
     or md5(pg_get_functiondef('public._pos_recompute_order_payment(uuid)'::regprocedure)) <> '3bfe2160b6bd9bfc34ebfaf499ab8e9f'
     or md5(pg_get_functiondef('public.pos_receivables_customer(uuid)'::regprocedure)) <> '324394d86b48c14603c8e54aa52d30f7'
     or md5(pg_get_functiondef('public.can_access_branch(uuid)'::regprocedure)) <> '507e0704c87bdab4787b2dab5c8beda2'
     or md5(pg_get_functiondef('public.assert_branch_access(uuid)'::regprocedure)) <> '9a113a18e688679e7be10fc77200f795'
     or md5(pg_get_functiondef('public.pos_assert_operator(uuid)'::regprocedure)) <> 'e7b00619726f4edb6f2a4036bc430b40'
     or md5(pg_get_functiondef('public.is_super_admin()'::regprocedure)) <> 'd5f505777a0d1b2af313fa550663155a'
     or md5(pg_get_functiondef('public._pos_require(uuid,text)'::regprocedure)) <> '023ecb886453330d7b6b07fbf8900674'
     or md5(pg_get_functiondef('public._pos_amount_usd(numeric,text,numeric)'::regprocedure)) <> '0e06334a38e0c28d6c41c15967a498f1' then
    raise exception 'RB POST: an unchanged dependency changed';
  end if;
end
$post$;

notify pgrst, 'reload schema';
