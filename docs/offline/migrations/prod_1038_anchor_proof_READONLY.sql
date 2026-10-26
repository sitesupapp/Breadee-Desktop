-- Desktop 1.0.38: READ-ONLY anchor proof against LIVE PRODUCTION (SELECT only; no writes).
-- For each rebuilt function: pre-image md5, the count of every anchor at its point in the
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
   || E'  end if;\n')),
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
