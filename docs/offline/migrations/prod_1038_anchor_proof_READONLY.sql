-- Desktop 1.0.38: READ-ONLY anchor proof against LIVE PRODUCTION (SELECT only; no writes).
-- For each rebuilt function (S4/S5, S1, S2b): pre-image md5, the count of every anchor at its point in the
-- sequential rebuild (must all be 1), the post-image md5, the inverse (rollback) anchor counts
-- (must all be 1), the rollback round-trip md5 (must equal the pre-image) and a transcription md5
-- of the delta strings (must equal the generator's local md5). Result 2026-10-26: see
-- prod_1038_contracts_README.md section 2.
with recursive dl(fn, ord, label, a, r) as (values
('public.pos_pay_order_core(jsonb)', 1, 'pay_order.declare', E'  v_fin jsonb;\n',
   E'  v_fin jsonb;\n'
   || E'  v_prior numeric := 0; v_prior_n int := 0;  -- Desktop 1.0.38 S4\n'),
('public.pos_pay_order_core(jsonb)', 2, 'pay_order.prior', E'  v_sub := coalesce(v_order.subtotal, v_order.total_amount + coalesce(v_order.discount_amount, 0));\n',
   E'  -- Desktop 1.0.38 S4: paid split settlements are part of this bill''s payment. They are read under\n'
   || E'  -- this order''s row lock (pos_split_settle_core takes the same lock), so P is authoritative here.\n'
   || E'  select count(*), coalesce(sum(s.amount_order_ccy), 0) into v_prior_n, v_prior\n'
   || E'    from public.pos_split_settlements s where s.parent_order_id = v_order.id and s.status = ''paid'';\n'
   || E'  if exists (select 1 from public.pos_payments p where p.order_id = v_order.id\n'
   || E'               and not exists (select 1 from public.pos_split_settlements s where s.payment_id = p.id and s.status = ''paid'')) then\n'
   || E'    perform public.pos_op_error(''PAYMENT_RESIDUE'', ''This bill already has payment records that are not split settlements. Review it before taking payment.'');\n'
   || E'  end if;\n'
   || E'  v_sub := coalesce(v_order.subtotal, v_order.total_amount + coalesce(v_order.discount_amount, 0));\n'),
('public.pos_pay_order_core(jsonb)', 3, 'pay_order.discount', E'    v_apply := true;\n'
   || E'  end if;\n',
   E'    v_apply := true;\n'
   || E'  end if;\n'
   || E'  if v_apply and v_prior_n > 0 then\n'
   || E'    perform public.pos_op_error(''SPLIT_DISCOUNT_UNSUPPORTED'', ''A discount cannot be applied to a bill that is already part-paid by split settlements.'');\n'
   || E'  end if;\n'),
('public.pos_pay_order_core(jsonb)', 4, 'pay_order.remaining', E'  perform public._pos_finalize_delivery_settlement(v_order.id);\n',
   E'  perform public._pos_finalize_delivery_settlement(v_order.id);\n'
   || E'  -- Desktop 1.0.38 S4: charge only the remaining obligation R = T - P (order currency).\n'
   || E'  if v_prior_n > 0 then\n'
   || E'    if v_amount - v_prior <= 0.005 then\n'
   || E'      perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid by split settlements.'');\n'
   || E'    end if;\n'
   || E'    v_amount := v_amount - v_prior;\n'
   || E'  end if;\n'),
('public.pos_pay_order_core(jsonb)', 5, 'pay_order.return', E'''finance'', v_fin);\n'
   || E'end; $function$',
   E'''finance'', v_fin)\n'
   || E'    || case when v_prior_n > 0 then jsonb_build_object(''prior_paid'', v_prior, ''prior_settlements'', v_prior_n) else ''{}''::jsonb end;\n'
   || E'end; $function$'),
('public.pos_pay_table_core(jsonb)', 1, 'pay_table.declare', E'  v_lock_ccy text;\n',
   E'  v_lock_ccy text;\n'
   || E'  -- Desktop 1.0.38 S4 (remaining obligation) + S5 (optional bill-identity / amount pins)\n'
   || E'  v_locked uuid[] := ''{}''; v_pin uuid[]; v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
   || E'  v_prior numeric; v_prior_n int; v_prior_total numeric := 0; v_prior_cnt int := 0;\n'),
('public.pos_pay_table_core(jsonb)', 2, 'pay_table.pin', E'    v_lock_n := v_lock_n + 1;\n'
   || E'  end loop;\n',
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
   || E'  end if;\n'),
('public.pos_pay_table_core(jsonb)', 3, 'pay_table.prior_check', E'  v_rem := v_bill_disc;\n',
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
   || E'  v_rem := v_bill_disc;\n'),
('public.pos_pay_table_core(jsonb)', 4, 'pay_table.remaining', E'      v_ofinal := r.total_amount;\n',
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
   || E'      end if;\n'),
('public.pos_pay_table_core(jsonb)', 5, 'pay_table.amount_pin', E'    v_orig_total := v_orig_total + v_orig;\n'
   || E'  end loop;\n',
   E'    v_orig_total := v_orig_total + v_orig;\n'
   || E'  end loop;\n'
   || E'  -- Desktop 1.0.38 S5: optional expected_amount (order currency, = the remaining amount the device collected).\n'
   || E'  if v_exp_amount is not null and abs(v_total - v_exp_amount) >= 0.005 then\n'
   || E'    perform public.pos_op_error(''PAY_AMOUNT_CHANGED'', ''The amount due on this table changed since the payment was captured. Reconnect and review before settling.'');\n'
   || E'  end if;\n'),
('public.pos_pay_table_core(jsonb)', 6, 'pay_table.return', E'    ''pos_entity_version'', v_ver);\n'
   || E'end; $function$',
   E'    ''pos_entity_version'', v_ver)\n'
   || E'    || case when v_prior_cnt > 0 then jsonb_build_object(''prior_paid'', v_prior_total, ''prior_settlements'', v_prior_cnt) else ''{}''::jsonb end;\n'
   || E'end; $function$'),
('public.pos_move_table_core(uuid,uuid,integer)', 1, 'move_core.ou', E'  v_tenant := v_from.tenant_id;\n',
   E'  v_tenant := v_from.tenant_id;\n'
   || E'  if v_from.branch_id is distinct from v_to.branch_id then\n'
   || E'    raise exception ''Tables belong to different operating units'' using errcode = ''42501'';\n'
   || E'  end if;\n'
   || E'  if not (public.is_super_admin() or public.can_access_branch(v_from.branch_id)) then\n'
   || E'    raise exception ''Not authorized for this operating unit'' using errcode = ''42501'';\n'
   || E'  end if;\n'),
('public.pos_complete_on_account_core(jsonb)', 1, 'oa_order.declare', E'  v_new_ver int;\n'
   || E'begin\n',
   E'  v_new_ver int;\n'
   || E'  -- Desktop 1.0.38 S2b: remaining-obligation On Account (R = T - P) + optional expected_amount pin\n'
   || E'  v_prior_n int := 0; v_prior_usd numeric := 0; v_prior_primary numeric := 0;\n'
   || E'  v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
   || E'begin\n'),
('public.pos_complete_on_account_core(jsonb)', 2, 'oa_order.prior', E'    v_apply := true;\n'
   || E'  end if;\n'
   || E'  if v_apply then\n',
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
   || E'  if v_apply then\n'),
('public.pos_complete_on_account_core(jsonb)', 3, 'oa_order.remaining', E'  v_total_usd := public._pos_amount_usd(v_total_primary, v_ccy, v_order.usd_to_lbp_rate_snapshot);\n',
   E'  v_total_usd := public._pos_amount_usd(v_total_primary, v_ccy, v_order.usd_to_lbp_rate_snapshot);\n'
   || E'  -- Desktop 1.0.38 S2b: the receivable is only R = T - P. R <= 0 -> ALREADY_PAID (as the pay cores);\n'
   || E'  -- the optional expected_amount (order currency, = R the device showed) refuses a changed bill.\n'
   || E'  if v_prior_n > 0 and v_total_usd - v_prior_usd <= 0.005 then\n'
   || E'    perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid.'');\n'
   || E'  end if;\n'
   || E'  if v_exp_amount is not null and abs(greatest(v_total_primary - v_prior_primary, 0) - v_exp_amount) >= 0.005 then\n'
   || E'    perform public.pos_op_error(''ON_ACCOUNT_AMOUNT_CHANGED'', ''The amount due on this bill changed since On Account was captured. Reconnect and review before settling.'');\n'
   || E'  end if;\n'),
('public.pos_complete_on_account_core(jsonb)', 4, 'oa_order.cap', E'    if v_usd > v_total_usd + 0.005 then raise exception ''Amount paid cannot exceed the order total''; end if;\n',
   E'    if v_prior_n > 0 and v_usd > v_total_usd - v_prior_usd + 0.005 then\n'
   || E'      perform public.pos_op_error(''ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING'', ''The amount paid now cannot exceed the remaining balance of this bill.'');\n'
   || E'    end if;\n'
   || E'    if v_usd > v_total_usd + 0.005 then raise exception ''Amount paid cannot exceed the order total''; end if;\n'),
('public.pos_complete_on_account_core(jsonb)', 5, 'oa_order.return', E'    ''pos_entity_version'', v_new_ver);\n'
   || E'end; $function$',
   E'    ''pos_entity_version'', v_new_ver)\n'
   || E'    || case when v_prior_n > 0 then jsonb_build_object(\n'
   || E'         ''outstanding_usd'', round(v_total_usd - v_prior_usd - coalesce(v_usd,0), 2),\n'
   || E'         ''outstanding'', greatest(v_total_primary - v_prior_primary - coalesce(v_pay_primary, 0), 0),\n'
   || E'         ''remaining'', greatest(v_total_primary - v_prior_primary, 0),\n'
   || E'         ''prior_paid'', v_prior_primary, ''prior_paid_usd'', round(v_prior_usd, 4), ''prior_payments'', v_prior_n)\n'
   || E'       else ''{}''::jsonb end;\n'
   || E'end; $function$'),
('public.pos_complete_table_on_account_core(jsonb)', 1, 'oa_table.declare', E'  v_new_ver int;\n'
   || E'begin\n',
   E'  v_new_ver int;\n'
   || E'  -- Desktop 1.0.38 S2b: remaining-obligation On Account (R = T - P) + optional bill / amount pins\n'
   || E'  v_locked uuid[] := ''{}''; v_pin uuid[]; v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
   || E'  v_prior numeric; v_prior_n int; v_rems numeric[] := ''{}''; v_rem_total numeric := 0;\n'
   || E'  v_prior_total numeric := 0; v_prior_cnt int := 0;\n'
   || E'begin\n'),
('public.pos_complete_table_on_account_core(jsonb)', 2, 'oa_table.pin', E'    v_lock_n := v_lock_n + 1;\n'
   || E'  end loop;\n',
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
   || E'  end if;\n'),
('public.pos_complete_table_on_account_core(jsonb)', 3, 'oa_table.prior_check', E'  v_rem := v_bill_disc;\n',
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
   || E'  v_rem := v_bill_disc;\n'),
('public.pos_complete_table_on_account_core(jsonb)', 4, 'oa_table.remaining', E'    v_finals := array_append(v_finals, v_ofinal);\n',
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
   || E'    end if;\n'),
('public.pos_complete_table_on_account_core(jsonb)', 5, 'oa_table.cap', E'  if v_pay_primary > 0 then\n'
   || E'    v_pay_primary := round(v_pay_primary, case when v_ccy = ''LBP'' then 0 else 2 end);\n'
   || E'    if v_pay_primary > v_bill_total + 0.005 then raise exception ''Amount paid cannot exceed the table total''; end if;\n',
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
   || E'    if v_pay_primary > v_bill_total + 0.005 then raise exception ''Amount paid cannot exceed the table total''; end if;\n'),
('public.pos_complete_table_on_account_core(jsonb)', 6, 'oa_table.alloc', E'      if v_idx < array_length(v_ids, 1) and v_bill_total > 0 then\n'
   || E'        v_alloc := round(v_pay_primary * v_finals[v_idx] / v_bill_total, case when v_ccy = ''LBP'' then 0 else 2 end);\n',
   E'      if v_idx < array_length(v_ids, 1) and v_rem_total > 0 then\n'
   || E'        v_alloc := round(v_pay_primary * v_rems[v_idx] / v_rem_total, case when v_ccy = ''LBP'' then 0 else 2 end);  -- 1.0.38 S2b: by R_i\n'),
('public.pos_complete_table_on_account_core(jsonb)', 7, 'oa_table.return', E'    ''paid_usd'', round(v_paid_total_usd,2), ''outstanding_primary'', round(v_bill_total - coalesce(v_pay_primary,0), 2), ''currency_code'', v_ccy,\n'
   || E'    ''pos_entity_version'', v_new_ver);\n'
   || E'end; $function$',
   E'    ''paid_usd'', round(v_paid_total_usd,2), ''outstanding_primary'', round(v_rem_total - coalesce(v_pay_primary,0), 2), ''currency_code'', v_ccy,\n'
   || E'    ''pos_entity_version'', v_new_ver)\n'
   || E'    || case when v_prior_cnt > 0 then jsonb_build_object(''remaining_total'', v_rem_total, ''prior_paid'', v_prior_total, ''prior_payments'', v_prior_cnt)\n'
   || E'       else ''{}''::jsonb end;  -- Desktop 1.0.38 S2b\n'
   || E'end; $function$')),
fns as (select distinct fn from dl),
fwd as (
  select f.fn, 0 as ord, pg_get_functiondef(f.fn::regprocedure) as body, null::int as cnt from fns f
  union all
  select w.fn, w.ord + 1, replace(w.body, d.a, d.r), (length(w.body) - length(replace(w.body, d.a, ''))) / length(d.a)
  from fwd w join dl d on d.fn = w.fn and d.ord = w.ord + 1),
maxo as (select fn, max(ord) mo from dl group by fn),
inv as (
  select w.fn, m.mo as ord, w.body, null::int as cnt from fwd w join maxo m on m.fn = w.fn and w.ord = m.mo
  union all
  select i.fn, i.ord - 1, replace(i.body, d.r, d.a), (length(i.body) - length(replace(i.body, d.r, ''))) / length(d.r)
  from inv i join dl d on d.fn = i.fn and d.ord = i.ord)
select f.fn,
  (select md5(body) from fwd where fn = f.fn and ord = 0) pre_md5,
  (select string_agg(cnt::text, ',' order by ord) from fwd where fn = f.fn and ord > 0) fwd_counts,
  (select md5(body) from fwd w join maxo m on m.fn = w.fn and w.ord = m.mo where w.fn = f.fn) post_md5,
  (select string_agg(cnt::text, ',' order by ord desc) from inv where fn = f.fn and cnt is not null) inv_counts,
  (select md5(body) from inv where fn = f.fn and ord = 0) roundtrip_md5,
  (select md5(string_agg(a || '|' || r, '#' order by ord)) from dl where fn = f.fn) transcription_md5
from fns f order by 1;
