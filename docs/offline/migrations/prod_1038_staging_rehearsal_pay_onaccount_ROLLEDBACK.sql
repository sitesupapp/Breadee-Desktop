-- Desktop 1.0.38 server contracts: STAGING rolled-back rehearsal. ONE DO block that always ends in
-- RAISE EXCEPTION (carrying the JSON results), so nothing persists on staging.
do $rh$
declare
  v_t constant uuid := 'd735104d-ed3c-4d58-9148-f1a82e94d418';   -- CPJ #2101 (staging QA)
  v_b constant uuid := 'a5469a61-2504-40e5-bc45-187b1bd4a2fa';
  v_sh constant uuid := 'a978d42d-cc00-439d-b0e4-a8e71c12878d';  -- open shift, cashier = v_u
  v_u constant uuid := '2ddf135f-1a69-42c9-af5f-5f47777692a7';   -- CPJ owner (not a platform user)
  v_u2 uuid;
  tb uuid[];
  res jsonb := '{}'::jsonb;
  d text; j jsonb; j2 jsonb;
  o_ctrl uuid; o_ctrl_po uuid; o_f1 uuid; o_s4po uuid; o_ap uuid; o_res uuid; o_d uuid; o_s5 uuid;
  o_m uuid; o_occ uuid; o_p uuid; o_s uuid; o_x uuid;
  base_tbl jsonb; base_po jsonb; base_tbl_pay jsonb; base_po_pay jsonb; f1_old jsonb; f1_old_pay jsonb;
  op_pay uuid := gen_random_uuid(); op_m1 uuid := gen_random_uuid(); op_g1 uuid := gen_random_uuid();
  v_v1 int; v_v2 int; v_n int; v_n2 int; br2 uuid; tb_x uuid; p_mv jsonb; p_g jsonb;
  -- S2b (Bug 9) on-account rehearsal state
  oa jsonb := '{}'::jsonb; oa_gap jsonb := '{}'::jsonb; oa_t uuid; oa_c uuid; oa_o1 uuid; oa_o2 uuid; oa_op uuid;
  oa_b jsonb; oa_a jsonb; oa_r jsonb; oa_r2 jsonb; oa_r3 jsonb; oa_p jsonb; oa_rate numeric;
  oa_bt uuid; oa_bt2 uuid; oa_bc uuid; oa_bo1 uuid; oa_bo2 uuid; oa_bpo uuid;
  oa_base_t jsonb; oa_base_t_snap jsonb; oa_base_t_bal jsonb; oa_base_o jsonb; oa_base_o_snap jsonb; oa_base_o_bal jsonb;

begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_u::text, true);

  res := res || jsonb_build_object('staging_pre', jsonb_build_object(
    'pos_pay_order_core', md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)),
    'pos_pay_table_core', md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)),
    'pos_move_table_core', md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure)),
    'pos_merge_tables_v3', md5(pg_get_functiondef('public.pos_merge_tables_v3(jsonb)'::regprocedure)),
    'pos_split_settle_core', md5(pg_get_functiondef('public.pos_split_settle_core(jsonb)'::regprocedure))));

  -- ---------------- helpers (pg_temp, die with the transaction)
  execute $h$
create function pg_temp._mk(p_t uuid, p_b uuid, p_sh uuid, p_tbl uuid, p_prices numeric[]) returns uuid language plpgsql as $f$
declare v uuid; p numeric; s numeric := 0; i int := 0;
begin
  insert into public.pos_orders(tenant_id, branch_id, shift_id, table_id, order_type, status, payment_status, subtotal, total_amount,
      order_number, cashier_user_id, created_by)
    values (p_t, p_b, p_sh, p_tbl, 'dine_in', 'draft', 'unpaid', 0, 0, 'R1038-' || substr(md5(random()::text), 1, 6), auth.uid(), auth.uid())
    returning id into v;
  foreach p in array p_prices loop
    i := i + 1;
    insert into public.pos_order_items(tenant_id, branch_id, order_id, name_snapshot, quantity, base_price, final_unit_price, line_total, batch_no)
      values (p_t, p_b, v, 'R1038 item ' || i, 1, p, p, p, 1);
    s := s + p;
  end loop;
  update public.pos_orders set subtotal = s, total_amount = s where id = v;
  if p_tbl is not null then update public.pos_tables set status = 'occupied' where id = p_tbl; end if;
  return v;
end $f$ $h$;
  execute $h$
create function pg_temp._item(p_o uuid, p_n int) returns uuid language sql as $f$
  select id from public.pos_order_items where order_id = p_o order by name_snapshot offset p_n - 1 limit 1 $f$ $h$;
  execute $h$
create function pg_temp._paid(p_o uuid) returns jsonb language sql as $f$
  select jsonb_build_object('n', count(*), 'usd', coalesce(sum(amount_usd), 0)) from public.pos_payments where order_id = p_o $f$ $h$;
  execute $h$
create function pg_temp._split(p_o uuid, p_item uuid) returns jsonb language sql as $f$
  select public.pos_split_settle(jsonb_build_object('order_id', p_o, 'client_op_id', gen_random_uuid(), 'method', 'cash',
    'currency_code', 'USD', 'allocations', jsonb_build_array(jsonb_build_object('order_item_id', p_item, 'quantity', 1)))) $f$ $h$;
  execute $h$
create function pg_temp._try(q text) returns jsonb language plpgsql as $f$
declare r jsonb; st text; m text; dt text;
begin
  execute q into r;
  return jsonb_build_object('ok', true, 'r', r);
exception when others then
  get stacked diagnostics st = returned_sqlstate, m = message_text, dt = pg_exception_detail;
  return jsonb_build_object('ok', false, 'state', st,
    'code', case when dt like '{%' then (dt::jsonb)->>'pos_error_code' end, 'msg', left(m, 140));
end $f$ $h$;
  execute $h$
create function pg_temp._jdiff(a jsonb, b jsonb) returns jsonb language sql as $f$
  select coalesce(jsonb_agg(k), '[]'::jsonb) from (select k from jsonb_object_keys(coalesce(a,'{}')) k union select k from jsonb_object_keys(coalesce(b,'{}')) k) s
  where (a->k) is distinct from (b->k) $f$ $h$;

  tb := array(select t.id from public.pos_tables t
    where t.tenant_id = v_t and t.branch_id = v_b and t.status = 'available' and t.is_configured and t.name like 'LH-%'
      and not exists (select 1 from public.pos_orders o where o.table_id = t.id
                      and o.status not in ('completed','voided','cancelled','refunded') and o.payment_status <> 'paid')
    order by t.name limit 16);
  if coalesce(array_length(tb, 1), 0) < 16 then raise exception 'R1038 fixture: not enough free tables (%)', array_length(tb, 1); end if;

  -- ---------------- BASELINE on the UNCHANGED staging bodies (rolled back via a sub-transaction)
  o_ctrl := pg_temp._mk(v_t, v_b, v_sh, tb[1], array[100000, 50000]);
  o_ctrl_po := pg_temp._mk(v_t, v_b, v_sh, tb[2], array[80000]);
  o_f1 := pg_temp._mk(v_t, v_b, v_sh, tb[3], array[100000, 50000]);
  res := res || jsonb_build_object('order_ccy', (select primary_currency_snapshot from public.pos_orders where id = o_ctrl));
  begin
    base_tbl := public.pos_pay_table(jsonb_build_object('table_id', tb[1], 'method', 'cash', 'currency_code', 'USD'));
    base_tbl_pay := pg_temp._paid(o_ctrl);
    base_po := public.pos_pay_order(jsonb_build_object('order_id', o_ctrl_po, 'method', 'cash', 'currency_code', 'USD'));
    base_po_pay := pg_temp._paid(o_ctrl_po);
    perform pg_temp._split(o_f1, pg_temp._item(o_f1, 1));
    f1_old := public.pos_pay_table(jsonb_build_object('table_id', tb[3], 'method', 'cash', 'currency_code', 'USD'));
    f1_old_pay := pg_temp._paid(o_f1);
    raise exception 'R1038_BASELINE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'R1038_BASELINE_ROLLBACK' then res := res || jsonb_build_object('baseline_error', sqlerrm); end if;
  end;
  res := res || jsonb_build_object('F1_old_bodies', jsonb_build_object('order_total', 150000, 'split_paid', 100000,
    'pay_table_charged', f1_old->'amount', 'payments', f1_old_pay));

  -- ================= S2b (Bug 9): install the LIVE PRODUCTION on-account cores on staging (this txn only)
  oa := oa || jsonb_build_object('staging_oa_bodies_before', jsonb_build_object(
    'order', md5(pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure)),
    'table', md5(pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure))));
  -- The staging bodies differ from production only by comments, one message case, a line break and
  -- the prod-only v_total_primary / result keys. Rebuild the exact production text (md5-asserted).
  d := pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure);
  d := replace(d, E'v_total_usd numeric;\n  v_ex_ver int := nullif(p_payload->>''expected_version'','''')::int;   -- Phase 1b\n  v_new_ver int;                                                    -- Phase 1b\n',
                  E'v_total_usd numeric; v_total_primary numeric;\n  v_ex_ver int := nullif(p_payload->>''expected_version'','''')::int;\n  v_new_ver int;\n');
  d := replace(d, E'already an On Account sale.'')', E'already an on account sale.'')');
  d := replace(d, E'  -- Phase 1b: optimistic version guard (order row is FOR UPDATE-locked => race-safe).\n', '');
  d := replace(d, E'  v_total_usd := public._pos_amount_usd((select total_amount from public.pos_orders where id = v_order.id), v_ccy, v_order.usd_to_lbp_rate_snapshot);\n',
                  E'  v_total_primary := (select total_amount from public.pos_orders where id = v_order.id);\n  v_total_usd := public._pos_amount_usd(v_total_primary, v_ccy, v_order.usd_to_lbp_rate_snapshot);\n');
  d := replace(d, E'is not null then\n    update public.pos_tables set status = ''available'' where id = v_order.table_id; end if;\n',
                  E'is not null then update public.pos_tables set status = ''available'' where id = v_order.table_id; end if;\n');
  d := replace(d, E'''finance'', v_fin,\n    ''pos_entity_version''',
                  E'''finance'', v_fin,\n    ''subtotal'', round(v_sub, 2), ''total'', v_total_primary,\n    ''outstanding'', greatest(v_total_primary - coalesce(v_pay_primary, 0), 0), ''delivery_fee'', coalesce(v_order.delivery_fee, 0),\n    ''pos_entity_version''');
  if md5(d) <> '0655ed697c7b94f2f50573ed10f321f7' then raise exception 'R1038 OA: rebuilt order pre-image md5 %', md5(d); end if;
  execute d;
  d := pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure);
  d := replace(d, E'  v_ex_ver int := nullif(p_payload->>''expected_version'','''')::int;   -- Phase 1b\n  v_new_ver int;                                                    -- Phase 1b\n',
                  E'  v_ex_ver int := nullif(p_payload->>''expected_version'','''')::int;\n  v_new_ver int;\n');
  d := replace(d, E'  -- Phase 1b: optimistic staleness guard BEFORE placing on account.\n', '');
  if md5(d) <> 'fd0f3b5bd53504352080fb88bd670bdd' then raise exception 'R1038 OA: rebuilt table pre-image md5 %', md5(d); end if;
  execute d;
  if md5(pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure)) <> '0655ed697c7b94f2f50573ed10f321f7'
     or md5(pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure)) <> 'fd0f3b5bd53504352080fb88bd670bdd' then
    raise exception 'R1038 OA: production pre-image install md5 mismatch';
  end if;
  oa := oa || jsonb_build_object('prod_pre_images_installed', true);

  -- GL queue observable on staging: activate accounting for the fixture tenant (rolled back with everything)
  begin
    insert into public.accounting_settings(tenant_id, is_active, cutover_date, cutover_at) values (v_t, true, current_date - 1, now() - interval '1 day')
      on conflict (tenant_id) do update set is_active = true, cutover_date = current_date - 1, cutover_at = now() - interval '1 day';
  exception when others then oa := oa || jsonb_build_object('gl_activate_error', sqlerrm);
  end;
  oa := oa || jsonb_build_object('gl_queue_active', public.accounting_is_active(v_t));

  -- ---------------- S2b helpers (pg_temp)
  execute $h$
create function pg_temp._oa_tbl(p_t uuid, p_b uuid) returns uuid language sql as $f$
  insert into public.pos_tables(tenant_id, branch_id, name, status, is_configured)
  values (p_t, p_b, 'R1038OA-' || substr(md5(random()::text), 1, 8), 'available', true) returning id $f$ $h$;
  execute $h$
create function pg_temp._oa_cust(p_t uuid) returns uuid language sql as $f$
  insert into public.pos_customers(tenant_id, name, phone)
  values (p_t, 'R1038 OA customer', '+9617' || lpad((floor(random() * 9999999))::bigint::text, 7, '0')) returning id $f$ $h$;
  execute $h$
create function pg_temp._oa_split(p_o uuid, p_item uuid, p_method text) returns jsonb language plpgsql as $f$
declare r jsonb; v_ccy text;
begin
  select coalesce(primary_currency_snapshot, 'USD') into v_ccy from public.pos_orders where id = p_o;
  begin
    r := public.pos_split_settle(jsonb_build_object('order_id', p_o, 'client_op_id', gen_random_uuid(), 'method', p_method,
      'currency_code', v_ccy, 'allocations', jsonb_build_array(jsonb_build_object('order_item_id', p_item, 'quantity', 1))));
  exception when others then
    r := public.pos_split_settle(jsonb_build_object('order_id', p_o, 'client_op_id', gen_random_uuid(), 'method', p_method,
      'currency_code', 'USD', 'allocations', jsonb_build_array(jsonb_build_object('order_item_id', p_item, 'quantity', 1))));
  end;
  return r;
end $f$ $h$;
  execute $h$
create function pg_temp._oa_add_item(p_o uuid, p_price numeric) returns void language sql as $f$
  insert into public.pos_order_items(tenant_id, branch_id, order_id, name_snapshot, quantity, base_price, final_unit_price, line_total, batch_no)
    select tenant_id, branch_id, id, 'R1038 item 9', 1, p_price, p_price, p_price, 1 from public.pos_orders where id = p_o;
  update public.pos_orders set subtotal = subtotal + p_price, total_amount = total_amount + p_price where id = p_o $f$ $h$;
  execute $h$
create function pg_temp._oa_snap(p_orders uuid[]) returns jsonb language sql as $f$
  select jsonb_build_object(
    'pays', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'order_id', p.order_id, 'method', p.method, 'ccy', p.currency_code,
               'orig', p.original_amount, 'usd', p.amount_usd, 'shift', p.shift_id) order by p.id)
             from public.pos_payments p where p.order_id = any(p_orders)), '[]'::jsonb),
    'gl_sale', (select count(*) from public.accounting_posting_outbox x
                where x.event_key in (select 'POS_SALE:' || u::text from unnest(p_orders) u)),
    'gl_pay', (select count(*) from public.accounting_posting_outbox x where x.source_entity = 'pos_payments'
               and x.source_id in (select p.id from public.pos_payments p where p.order_id = any(p_orders))),
    'inv', (select count(*) from public.pos_shift_material_demand d where d.order_id = any(p_orders))
         + (select count(*) from public.inventory_usage_batch_supplement_orders d where d.order_id = any(p_orders))
         + (select count(*) from public.inventory_usage_batch_supplement_lines d where d.order_id = any(p_orders)),
    'orders', (select jsonb_object_agg(o.id::text, jsonb_build_object(
               'st', o.status || '/' || o.payment_status || '/' || coalesce(o.settlement_mode, '-'),
               'total', o.total_amount, 'paid_usd', o.paid_amount_usd, 'cust', o.customer_id))
               from public.pos_orders o where o.id = any(p_orders))) $f$ $h$;
  execute $h$
create function pg_temp._oa_noid(s jsonb) returns jsonb language sql as $f$
  select (s - 'pays') || jsonb_build_object('pays', coalesce((select jsonb_agg(e - 'id' order by e->>'order_id', (e->>'orig')::numeric)
                                                     from jsonb_array_elements(s->'pays') e), '[]'::jsonb)) $f$ $h$;
  execute $h$
create function pg_temp._oa_new(b jsonb, a jsonb) returns jsonb language sql as $f$
  select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(a->'pays') e where not ((b->'pays') @> jsonb_build_array(e)) $f$ $h$;
  -- customer receivable exactly as pos_receivables_customer derives it (open on-account orders)
  execute $h$
create function pg_temp._oa_bal(p_c uuid) returns jsonb language sql as $f$
  with o as (
    select po.id, coalesce(po.primary_currency_snapshot, 'USD') ccy, po.total_amount,
      public._pos_amount_usd(po.total_amount, coalesce(po.primary_currency_snapshot, 'USD'), po.usd_to_lbp_rate_snapshot) tusd,
      coalesce((select sum(pp.amount_usd) from public.pos_payments pp where pp.order_id = po.id), 0) pusd,
      coalesce((select sum(case when pp.currency_code = coalesce(po.primary_currency_snapshot, 'USD') then pp.original_amount
                                when coalesce(po.primary_currency_snapshot, 'USD') = 'LBP' then round(pp.amount_usd * coalesce(po.usd_to_lbp_rate_snapshot, 1), 0)
                                else round(pp.amount_usd, 2) end)
                from public.pos_payments pp where pp.order_id = po.id), 0) pprim
    from public.pos_orders po
    where po.customer_id = p_c and po.settlement_mode = 'on_account' and po.status = 'completed' and po.payment_status in ('unpaid', 'partial'))
  select jsonb_build_object('n', count(*), 'usd', round(coalesce(sum(tusd - pusd), 0), 2),
    'primary', coalesce(sum(greatest(round(total_amount - pprim, case when ccy = 'LBP' then 0 else 2 end), 0)), 0),
    'per_order', coalesce(jsonb_object_agg(id::text, greatest(round(total_amount - pprim, case when ccy = 'LBP' then 0 else 2 end), 0)), '{}'::jsonb))
  from o $f$ $h$;
  execute $h$
create function pg_temp._oa_ob(p_o uuid) returns jsonb language sql as $f$
  select jsonb_build_object('st', status || '/' || payment_status || '/' || coalesce(settlement_mode, '-'), 'total', total_amount,
    'paid_primary', (select coalesce(sum(original_amount), 0) from public.pos_payments where order_id = p_o), 'paid_usd', paid_amount_usd)
  from public.pos_orders where id = p_o $f$ $h$;
  execute $h$
create function pg_temp._oat(p jsonb) returns jsonb language sql as $f$
  select pg_temp._try(format('select public.pos_complete_table_on_account(%L::jsonb)', p)) $f$ $h$;
  execute $h$
create function pg_temp._oao(p jsonb) returns jsonb language sql as $f$
  select pg_temp._try(format('select public.pos_complete_on_account(%L::jsonb)', p)) $f$ $h$;
  execute $h$
create function pg_temp._oa_check(b jsonb, a jsonb, res jsonb, p_c uuid, p_r numeric, p_up numeric, p_new_n int, p_n int, p_key text)
returns jsonb language plpgsql as $f$
declare nw jsonb := pg_temp._oa_new(b, a); bal jsonb := pg_temp._oa_bal(p_c); s numeric; o jsonb;
  gl_on boolean := public.accounting_is_active('d735104d-ed3c-4d58-9148-f1a82e94d418');
begin
  select coalesce(sum((e->>'orig')::numeric), 0) into s from jsonb_array_elements(nw) e;
  o := jsonb_build_object('call_ok', coalesce((res->>'ok')::boolean, false),
    'err', case when not coalesce((res->>'ok')::boolean, false) then res end,
    'R', p_r, 'paid_now', p_up, 'receivable', bal->'primary', 'receivable_usd', bal->'usd', 'receivable_orders', bal->'n',
    'receivable_eq_R_minus_paid_now', abs((bal->>'primary')::numeric - (p_r - p_up)) < 0.005,
    'reported_outstanding', res->'r'->p_key,
    'reported_ok', abs(coalesce((res->'r'->>p_key)::numeric, -1) - (p_r - p_up)) < 0.005,
    'prior_rows_unchanged', (a->'pays') @> (b->'pays'),
    'new_payment_rows', jsonb_array_length(nw), 'new_payment_sum', s,
    'new_payments_ok', jsonb_array_length(nw) = p_new_n and abs(s - p_up) < 0.005,
    'gl_pos_sale_rows', a->'gl_sale', 'gl_ok', (a->>'gl_sale')::int = case when gl_on then p_n else 0 end,
    'inv_delta', (a->>'inv')::int - (b->>'inv')::int);
  return o || jsonb_build_object('pass', (o->>'call_ok')::boolean and (o->>'receivable_eq_R_minus_paid_now')::boolean
    and (o->>'reported_ok')::boolean and (o->>'prior_rows_unchanged')::boolean and (o->>'new_payments_ok')::boolean
    and (o->>'gl_ok')::boolean and (o->>'inv_delta')::int = 0);
end $f$ $h$;

  -- ---------------- S2b BASELINE on the UNCHANGED production bodies (sub-transaction, rolled back)
  -- (1) unpaid bills: a 2-order table with an upfront amount, and a single order with an upfront amount.
  oa_bt := pg_temp._oa_tbl(v_t, v_b); oa_bt2 := pg_temp._oa_tbl(v_t, v_b); oa_bc := pg_temp._oa_cust(v_t);
  oa_bo1 := pg_temp._mk(v_t, v_b, v_sh, oa_bt, array[100000, 50000]);
  oa_bo2 := pg_temp._mk(v_t, v_b, v_sh, oa_bt, array[30000]);
  oa_bpo := pg_temp._mk(v_t, v_b, v_sh, oa_bt2, array[80000]);
  begin
    oa_base_t := pg_temp._oat(jsonb_build_object('table_id', oa_bt, 'customer_id', oa_bc, 'method', 'cash', 'amount', 40000));
    oa_base_t_snap := pg_temp._oa_snap(array[oa_bo1, oa_bo2]); oa_base_t_bal := pg_temp._oa_bal(oa_bc);
    oa_base_o := pg_temp._oao(jsonb_build_object('order_id', oa_bpo, 'customer_id', oa_bc, 'method', 'cash', 'amount', 20000));
    oa_base_o_snap := pg_temp._oa_snap(array[oa_bpo]); oa_base_o_bal := pg_temp._oa_bal(oa_bc);
    raise exception 'R1038_OA_BASELINE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'R1038_OA_BASELINE_ROLLBACK' then oa := oa || jsonb_build_object('baseline_error', sqlerrm); end if;
  end;
  -- GAP demonstration on the UNCHANGED production bodies (rolled back)
  begin
    -- G1: T=150000, split P=100000 (R=50000), On Account with nothing paid now
    oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
    oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[100000, 50000]);
    perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
    oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash'));
    oa_gap := oa_gap || jsonb_build_object('G1_table_no_upfront', jsonb_build_object('call', oa_r->'ok', 'R', 50000,
      'reported_outstanding_primary', oa_r->'r'->'outstanding_primary', 'real_receivable', pg_temp._oa_bal(oa_c)->'primary'));
    -- G2: same bill shape, 150000 paid now (> R) is accepted by the T-based cap -> over-collection
    oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
    oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[100000, 50000]);
    perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
    oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'amount', 150000));
    oa_gap := oa_gap || jsonb_build_object('G2_table_paid_now_over_R', jsonb_build_object('call', oa_r->'ok', 'R', 50000, 'paid_now', 150000,
      'order', pg_temp._oa_ob(oa_o1), 'reported_outstanding_primary', oa_r->'r'->'outstanding_primary'));
    -- G3: two part-paid orders (R1=10000, R2=20000), 30000 = R paid now, allocated by T_i
    oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
    oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[60000, 10000]);
    oa_o2 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[40000, 20000]);
    perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
    perform pg_temp._oa_split(oa_o2, pg_temp._item(oa_o2, 1), 'cash');
    oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'amount', 30000));
    oa_gap := oa_gap || jsonb_build_object('G3_two_partpaid_paid_now_eq_R', jsonb_build_object('call', oa_r->'ok', 'R', 30000, 'paid_now', 30000,
      'customer_receivable_left', pg_temp._oa_bal(oa_c), 'o1', pg_temp._oa_ob(oa_o1), 'o2', pg_temp._oa_ob(oa_o2)));
    -- G4: single order T=50000, split P=30000 (R=20000), 50000 paid now accepted
    oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
    oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[30000, 20000]);
    perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
    oa_r := pg_temp._oao(jsonb_build_object('order_id', oa_o1, 'customer_id', oa_c, 'method', 'cash', 'amount', 50000));
    oa_gap := oa_gap || jsonb_build_object('G4_order_paid_now_over_R', jsonb_build_object('call', oa_r->'ok', 'R', 20000, 'paid_now', 50000,
      'order', pg_temp._oa_ob(oa_o1), 'reported_outstanding', oa_r->'r'->'outstanding'));
    raise exception 'R1038_OA_GAP_ROLLBACK';
  exception when others then
    if sqlerrm <> 'R1038_OA_GAP_ROLLBACK' then oa_gap := oa_gap || jsonb_build_object('gap_error', sqlerrm); end if;
  end;
  oa := oa || jsonb_build_object('GAP_old_prod_bodies', oa_gap);

  -- ---------------- APPLY the 1.0.38 deltas to the STAGING bodies (same anchors as production)
  execute $hh$
create or replace function pg_temp._d1038_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int;
begin
  n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / nullif(length(p_anchor), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  perform set_config('r1038.tx_' || split_part(p_label, '.', 1), coalesce(nullif(current_setting('r1038.tx_' || split_part(p_label, '.', 1), true), '') || '#', '') || p_anchor || '|' || p_repl, true);
  return replace(p_src, p_anchor, p_repl);
end $f$;

$hh$;
  -- public.pos_pay_order_core(jsonb)
  d := pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure);
  d := pg_temp._d1038_once(d,
    E'  v_fin jsonb;\n',
    E'  v_fin jsonb;\n'
    || E'  v_prior numeric := 0; v_prior_n int := 0;  -- Desktop 1.0.38 S4\n',
    'pay_order.declare');
  d := pg_temp._d1038_once(d,
    E'  v_sub := coalesce(v_order.subtotal, v_order.total_amount + coalesce(v_order.discount_amount, 0));\n',
    E'  -- Desktop 1.0.38 S4: paid split settlements are part of this bill''s payment. They are read under\n'
    || E'  -- this order''s row lock (pos_split_settle_core takes the same lock), so P is authoritative here.\n'
    || E'  select count(*), coalesce(sum(s.amount_order_ccy), 0) into v_prior_n, v_prior\n'
    || E'    from public.pos_split_settlements s where s.parent_order_id = v_order.id and s.status = ''paid'';\n'
    || E'  if exists (select 1 from public.pos_payments p where p.order_id = v_order.id\n'
    || E'               and not exists (select 1 from public.pos_split_settlements s where s.payment_id = p.id and s.status = ''paid'')) then\n'
    || E'    perform public.pos_op_error(''PAYMENT_RESIDUE'', ''This bill already has payment records that are not split settlements. Review it before taking payment.'');\n'
    || E'  end if;\n'
    || E'  v_sub := coalesce(v_order.subtotal, v_order.total_amount + coalesce(v_order.discount_amount, 0));\n',
    'pay_order.prior');
  d := pg_temp._d1038_once(d,
    E'    v_apply := true;\n'
    || E'  end if;\n',
    E'    v_apply := true;\n'
    || E'  end if;\n'
    || E'  if v_apply and v_prior_n > 0 then\n'
    || E'    perform public.pos_op_error(''SPLIT_DISCOUNT_UNSUPPORTED'', ''A discount cannot be applied to a bill that is already part-paid by split settlements.'');\n'
    || E'  end if;\n',
    'pay_order.discount');
  d := pg_temp._d1038_once(d,
    E'  perform public._pos_finalize_delivery_settlement(v_order.id);\n',
    E'  perform public._pos_finalize_delivery_settlement(v_order.id);\n'
    || E'  -- Desktop 1.0.38 S4: charge only the remaining obligation R = T - P (order currency).\n'
    || E'  if v_prior_n > 0 then\n'
    || E'    if v_amount - v_prior <= 0.005 then\n'
    || E'      perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid by split settlements.'');\n'
    || E'    end if;\n'
    || E'    v_amount := v_amount - v_prior;\n'
    || E'  end if;\n',
    'pay_order.remaining');
  d := pg_temp._d1038_once(d,
    E'''finance'', v_fin);\n'
    || E'end; $function$',
    E'''finance'', v_fin)\n'
    || E'    || case when v_prior_n > 0 then jsonb_build_object(''prior_paid'', v_prior, ''prior_settlements'', v_prior_n) else ''{}''::jsonb end;\n'
    || E'end; $function$',
    'pay_order.return');
  execute d;

  -- public.pos_pay_table_core(jsonb)
  d := pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure);
  d := pg_temp._d1038_once(d,
    E'  v_lock_ccy text;\n',
    E'  v_lock_ccy text;\n'
    || E'  -- Desktop 1.0.38 S4 (remaining obligation) + S5 (optional bill-identity / amount pins)\n'
    || E'  v_locked uuid[] := ''{}''; v_pin uuid[]; v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
    || E'  v_prior numeric; v_prior_n int; v_prior_total numeric := 0; v_prior_cnt int := 0;\n',
    'pay_table.declare');
  d := pg_temp._d1038_once(d,
    E'    v_lock_n := v_lock_n + 1;\n'
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
    || E'  end if;\n',
    'pay_table.pin');
  d := pg_temp._d1038_once(d,
    E'  v_rem := v_bill_disc;\n',
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
    'pay_table.prior_check');
  d := pg_temp._d1038_once(d,
    E'      v_ofinal := r.total_amount;\n',
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
    'pay_table.remaining');
  d := pg_temp._d1038_once(d,
    E'    v_orig_total := v_orig_total + v_orig;\n'
    || E'  end loop;\n',
    E'    v_orig_total := v_orig_total + v_orig;\n'
    || E'  end loop;\n'
    || E'  -- Desktop 1.0.38 S5: optional expected_amount (order currency, = the remaining amount the device collected).\n'
    || E'  if v_exp_amount is not null and abs(v_total - v_exp_amount) >= 0.005 then\n'
    || E'    perform public.pos_op_error(''PAY_AMOUNT_CHANGED'', ''The amount due on this table changed since the payment was captured. Reconnect and review before settling.'');\n'
    || E'  end if;\n',
    'pay_table.amount_pin');
  d := pg_temp._d1038_once(d,
    E'    ''pos_entity_version'', v_ver);\n'
    || E'end; $function$',
    E'    ''pos_entity_version'', v_ver)\n'
    || E'    || case when v_prior_cnt > 0 then jsonb_build_object(''prior_paid'', v_prior_total, ''prior_settlements'', v_prior_cnt) else ''{}''::jsonb end;\n'
    || E'end; $function$',
    'pay_table.return');
  execute d;

  -- public.pos_complete_on_account_core(jsonb)
  d := pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure);
  d := pg_temp._d1038_once(d,
    E'  v_new_ver int;\n'
    || E'begin\n',
    E'  v_new_ver int;\n'
    || E'  -- Desktop 1.0.38 S2b: remaining-obligation On Account (R = T - P) + optional expected_amount pin\n'
    || E'  v_prior_n int := 0; v_prior_usd numeric := 0; v_prior_primary numeric := 0;\n'
    || E'  v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
    || E'begin\n',
    'oa_order.declare');
  d := pg_temp._d1038_once(d,
    E'    v_apply := true;\n'
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
    || E'  if v_apply then\n',
    'oa_order.prior');
  d := pg_temp._d1038_once(d,
    E'  v_total_usd := public._pos_amount_usd(v_total_primary, v_ccy, v_order.usd_to_lbp_rate_snapshot);\n',
    E'  v_total_usd := public._pos_amount_usd(v_total_primary, v_ccy, v_order.usd_to_lbp_rate_snapshot);\n'
    || E'  -- Desktop 1.0.38 S2b: the receivable is only R = T - P. R <= 0 -> ALREADY_PAID (as the pay cores);\n'
    || E'  -- the optional expected_amount (order currency, = R the device showed) refuses a changed bill.\n'
    || E'  if v_prior_n > 0 and v_total_usd - v_prior_usd <= 0.005 then\n'
    || E'    perform public.pos_op_error(''ALREADY_PAID'', ''This bill is already fully paid.'');\n'
    || E'  end if;\n'
    || E'  if v_exp_amount is not null and abs(greatest(v_total_primary - v_prior_primary, 0) - v_exp_amount) >= 0.005 then\n'
    || E'    perform public.pos_op_error(''ON_ACCOUNT_AMOUNT_CHANGED'', ''The amount due on this bill changed since On Account was captured. Reconnect and review before settling.'');\n'
    || E'  end if;\n',
    'oa_order.remaining');
  d := pg_temp._d1038_once(d,
    E'    if v_usd > v_total_usd + 0.005 then raise exception ''Amount paid cannot exceed the order total''; end if;\n',
    E'    if v_prior_n > 0 and v_usd > v_total_usd - v_prior_usd + 0.005 then\n'
    || E'      perform public.pos_op_error(''ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING'', ''The amount paid now cannot exceed the remaining balance of this bill.'');\n'
    || E'    end if;\n'
    || E'    if v_usd > v_total_usd + 0.005 then raise exception ''Amount paid cannot exceed the order total''; end if;\n',
    'oa_order.cap');
  d := pg_temp._d1038_once(d,
    E'    ''pos_entity_version'', v_new_ver);\n'
    || E'end; $function$',
    E'    ''pos_entity_version'', v_new_ver)\n'
    || E'    || case when v_prior_n > 0 then jsonb_build_object(\n'
    || E'         ''outstanding_usd'', round(v_total_usd - v_prior_usd - coalesce(v_usd,0), 2),\n'
    || E'         ''outstanding'', greatest(v_total_primary - v_prior_primary - coalesce(v_pay_primary, 0), 0),\n'
    || E'         ''remaining'', greatest(v_total_primary - v_prior_primary, 0),\n'
    || E'         ''prior_paid'', v_prior_primary, ''prior_paid_usd'', round(v_prior_usd, 4), ''prior_payments'', v_prior_n)\n'
    || E'       else ''{}''::jsonb end;\n'
    || E'end; $function$',
    'oa_order.return');
  if md5(d) <> '01e57c4af3d5df7932020eaae7949b50' then raise exception 'BUILD: % post-image md5 % (expected 01e57c4af3d5df7932020eaae7949b50)', 'public.pos_complete_on_account_core(jsonb)', md5(d); end if;
  execute d;

  -- public.pos_complete_table_on_account_core(jsonb)
  d := pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure);
  d := pg_temp._d1038_once(d,
    E'  v_new_ver int;\n'
    || E'begin\n',
    E'  v_new_ver int;\n'
    || E'  -- Desktop 1.0.38 S2b: remaining-obligation On Account (R = T - P) + optional bill / amount pins\n'
    || E'  v_locked uuid[] := ''{}''; v_pin uuid[]; v_exp_amount numeric := nullif(p_payload->>''expected_amount'','''')::numeric;\n'
    || E'  v_prior numeric; v_prior_n int; v_rems numeric[] := ''{}''; v_rem_total numeric := 0;\n'
    || E'  v_prior_total numeric := 0; v_prior_cnt int := 0;\n'
    || E'begin\n',
    'oa_table.declare');
  d := pg_temp._d1038_once(d,
    E'    v_lock_n := v_lock_n + 1;\n'
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
    || E'  end if;\n',
    'oa_table.pin');
  d := pg_temp._d1038_once(d,
    E'  v_rem := v_bill_disc;\n',
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
    'oa_table.prior_check');
  d := pg_temp._d1038_once(d,
    E'    v_finals := array_append(v_finals, v_ofinal);\n',
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
    'oa_table.remaining');
  d := pg_temp._d1038_once(d,
    E'  if v_pay_primary > 0 then\n'
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
    || E'    if v_pay_primary > v_bill_total + 0.005 then raise exception ''Amount paid cannot exceed the table total''; end if;\n',
    'oa_table.cap');
  d := pg_temp._d1038_once(d,
    E'      if v_idx < array_length(v_ids, 1) and v_bill_total > 0 then\n'
    || E'        v_alloc := round(v_pay_primary * v_finals[v_idx] / v_bill_total, case when v_ccy = ''LBP'' then 0 else 2 end);\n',
    E'      if v_idx < array_length(v_ids, 1) and v_rem_total > 0 then\n'
    || E'        v_alloc := round(v_pay_primary * v_rems[v_idx] / v_rem_total, case when v_ccy = ''LBP'' then 0 else 2 end);  -- 1.0.38 S2b: by R_i\n',
    'oa_table.alloc');
  d := pg_temp._d1038_once(d,
    E'    ''paid_usd'', round(v_paid_total_usd,2), ''outstanding_primary'', round(v_bill_total - coalesce(v_pay_primary,0), 2), ''currency_code'', v_ccy,\n'
    || E'    ''pos_entity_version'', v_new_ver);\n'
    || E'end; $function$',
    E'    ''paid_usd'', round(v_paid_total_usd,2), ''outstanding_primary'', round(v_rem_total - coalesce(v_pay_primary,0), 2), ''currency_code'', v_ccy,\n'
    || E'    ''pos_entity_version'', v_new_ver)\n'
    || E'    || case when v_prior_cnt > 0 then jsonb_build_object(''remaining_total'', v_rem_total, ''prior_paid'', v_prior_total, ''prior_payments'', v_prior_cnt)\n'
    || E'       else ''{}''::jsonb end;  -- Desktop 1.0.38 S2b\n'
    || E'end; $function$',
    'oa_table.return');
  if md5(d) <> 'c0e34235829d65d633287b5289a54928' then raise exception 'BUILD: % post-image md5 % (expected c0e34235829d65d633287b5289a54928)', 'public.pos_complete_table_on_account_core(jsonb)', md5(d); end if;
  execute d;
  res := res || jsonb_build_object('transcription_md5_ok', jsonb_build_object('pay_order', md5(current_setting('r1038.tx_pay_order')) = 'd3cccf48501fbc5ca14121f1b4283928', 'pay_table', md5(current_setting('r1038.tx_pay_table')) = 'e2de7356d9a486c76ead2336b15ec21b', 'oa_order', md5(current_setting('r1038.tx_oa_order')) = '788a1b94f5f3f50a8043a02162162aa3', 'oa_table', md5(current_setting('r1038.tx_oa_table')) = 'bdc929baa2715d74eacbc6a53aa78521'));

  res := res || jsonb_build_object('staging_post', jsonb_build_object(
    'pos_pay_order_core', md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)),
    'pos_pay_table_core', md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure))));

  -- ================= S4 / S5 =================
  -- A. no prior payment: identical result JSON and payments as the unchanged bodies
  j := public.pos_pay_table(jsonb_build_object('table_id', tb[1], 'method', 'cash', 'currency_code', 'USD'));
  j2 := public.pos_pay_order(jsonb_build_object('order_id', o_ctrl_po, 'method', 'cash', 'currency_code', 'USD'));
  res := res || jsonb_build_object('A_no_prior_unchanged', jsonb_build_object(
    'pay_table_json_equal', j = base_tbl, 'pay_table_diff', pg_temp._jdiff(j, base_tbl),
    'pay_table_payments_equal', pg_temp._paid(o_ctrl) = base_tbl_pay,
    'pay_order_json_equal', j2 = base_po, 'pay_order_diff', pg_temp._jdiff(j2, base_po),
    'pay_order_payments_equal', pg_temp._paid(o_ctrl_po) = base_po_pay, 'baseline_amount', base_tbl->'amount'));

  -- B. F1 scenario on NEW bodies: T=150000, split P=100000, pay_table must charge exactly R=50000; replay = no 2nd payment
  perform pg_temp._split(o_f1, pg_temp._item(o_f1, 1));
  j := public.pos_pay_table(jsonb_build_object('table_id', tb[3], 'method', 'cash', 'currency_code', 'USD', 'client_op_id', op_pay));
  j2 := public.pos_pay_table(jsonb_build_object('table_id', tb[3], 'method', 'cash', 'currency_code', 'USD', 'client_op_id', op_pay));
  res := res || jsonb_build_object('B_pay_table_remaining', jsonb_build_object(
    'charged', j->'amount', 'expected_R', 50000, 'pass', (j->>'amount')::numeric = 50000,
    'prior_paid', j->'prior_paid', 'order_status', (select status || '/' || payment_status from public.pos_orders where id = o_f1),
    'payments', pg_temp._paid(o_f1), 'old_bodies_payments', f1_old_pay,
    'replay_idempotent', j2->'idempotent', 'replay_payments_n', pg_temp._paid(o_f1)->'n',
    'submissions', (select count(*) from public.pos_op_submissions where client_op_id = op_pay)));

  -- C. pay_order after split: T=100000, P=70000 -> R=30000
  o_s4po := pg_temp._mk(v_t, v_b, v_sh, tb[4], array[70000, 30000]);
  perform pg_temp._split(o_s4po, pg_temp._item(o_s4po, 1));
  j := public.pos_pay_order(jsonb_build_object('order_id', o_s4po, 'method', 'cash', 'currency_code', 'USD', 'client_op_id', gen_random_uuid()));
  res := res || jsonb_build_object('C_pay_order_remaining', jsonb_build_object(
    'charged', j->'amount', 'pass', (j->>'amount')::numeric = 30000, 'prior_paid', j->'prior_paid', 'payments', pg_temp._paid(o_s4po)));

  -- D. R <= 0.005 -> ALREADY_PAID (synthetic: total lowered to the split amount), nothing written
  o_ap := pg_temp._mk(v_t, v_b, v_sh, tb[5], array[40000, 20000]);
  perform pg_temp._split(o_ap, pg_temp._item(o_ap, 1));
  update public.pos_orders set total_amount = 40000, subtotal = 40000 where id = o_ap;
  res := res || jsonb_build_object('D_already_paid', jsonb_build_object(
    'pay_table', pg_temp._try(format('select public.pos_pay_table(%L::jsonb)', jsonb_build_object('table_id', tb[5], 'method', 'cash'))),
    'pay_order', pg_temp._try(format('select public.pos_pay_order(%L::jsonb)', jsonb_build_object('order_id', o_ap, 'method', 'cash'))),
    'payments_after', pg_temp._paid(o_ap)));

  -- E. non-split payment residue -> PAYMENT_RESIDUE
  o_res := pg_temp._mk(v_t, v_b, v_sh, tb[6], array[10000]);
  insert into public.pos_payments(tenant_id, branch_id, order_id, shift_id, method, amount, received_by_user_id, currency_code, original_amount, amount_usd)
    values (v_t, v_b, o_res, v_sh, 'cash', 1, v_u, 'USD', 1, 1);
  res := res || jsonb_build_object('E_residue', jsonb_build_object(
    'pay_order', pg_temp._try(format('select public.pos_pay_order(%L::jsonb)', jsonb_build_object('order_id', o_res, 'method', 'cash'))),
    'pay_table', pg_temp._try(format('select public.pos_pay_table(%L::jsonb)', jsonb_build_object('table_id', tb[6], 'method', 'cash')))));

  -- F. discount on a part-paid bill -> SPLIT_DISCOUNT_UNSUPPORTED
  o_d := pg_temp._mk(v_t, v_b, v_sh, tb[7], array[60000, 40000]);
  perform pg_temp._split(o_d, pg_temp._item(o_d, 1));
  res := res || jsonb_build_object('F_discount', jsonb_build_object(
    'pay_table', pg_temp._try(format('select public.pos_pay_table(%L::jsonb)', jsonb_build_object('table_id', tb[7], 'method', 'cash', 'discount_type', 'amount', 'discount_value', 1000))),
    'pay_order', pg_temp._try(format('select public.pos_pay_order(%L::jsonb)', jsonb_build_object('order_id', o_d, 'method', 'cash', 'discount_type', 'amount', 'discount_value', 1000))),
    'payments_after', pg_temp._paid(o_d)));

  -- G. S5 pins on pay_table
  o_s5 := pg_temp._mk(v_t, v_b, v_sh, tb[8], array[25000]);
  res := res || jsonb_build_object('G_s5_wrong_order_pin', pg_temp._try(format('select public.pos_pay_table(%L::jsonb)', jsonb_build_object('table_id', tb[8], 'method', 'cash', 'client_op_id', gen_random_uuid(), 'expected_order_ids', jsonb_build_array(gen_random_uuid())))));
  res := res || jsonb_build_object('G_s5_wrong_amount_pin', pg_temp._try(format('select public.pos_pay_table(%L::jsonb)', jsonb_build_object('table_id', tb[8], 'method', 'cash', 'client_op_id', gen_random_uuid(), 'expected_order_ids', jsonb_build_array(o_s5), 'expected_amount', 99))));
  res := res || jsonb_build_object('G_s5_payments_before_ok', pg_temp._paid(o_s5));
  res := res || jsonb_build_object('G_s5_correct_pins', pg_temp._try(format('select public.pos_pay_table(%L::jsonb)', jsonb_build_object('table_id', tb[8], 'method', 'cash', 'client_op_id', gen_random_uuid(), 'expected_order_ids', jsonb_build_array(o_s5), 'expected_amount', 25000))) #- '{r,exchange_rate}');
  res := res || jsonb_build_object('G_s5_retry_new_op_after_paid', pg_temp._try(format('select public.pos_pay_table(%L::jsonb)', jsonb_build_object('table_id', tb[8], 'method', 'cash', 'client_op_id', gen_random_uuid(), 'expected_order_ids', jsonb_build_array(o_s5)))));
  perform pg_temp._mk(v_t, v_b, v_sh, tb[8], array[11000]);   -- a NEWER bill opened on the same table
  res := res || jsonb_build_object('G_s5_newer_bill_on_table', pg_temp._try(format('select public.pos_pay_table(%L::jsonb)', jsonb_build_object('table_id', tb[8], 'method', 'cash', 'client_op_id', gen_random_uuid(), 'expected_order_ids', jsonb_build_array(o_s5)))));
  res := res || jsonb_build_object('G_s5_payments_after', pg_temp._paid(o_s5));

  -- ================= S2b (Bug 9) on the 1.0.38 post-images (applied above from the production pre-images)
  oa := oa || jsonb_build_object('staging_oa_post', jsonb_build_object(
    'order', md5(pg_get_functiondef('public.pos_complete_on_account_core(jsonb)'::regprocedure)),
    'table', md5(pg_get_functiondef('public.pos_complete_table_on_account_core(jsonb)'::regprocedure)),
    'acl_order', (select proacl::text from pg_proc where oid = 'public.pos_complete_on_account_core(jsonb)'::regprocedure),
    'acl_table', (select proacl::text from pg_proc where oid = 'public.pos_complete_table_on_account_core(jsonb)'::regprocedure),
    'secdef_both', (select bool_and(prosecdef) from pg_proc where oid in ('public.pos_complete_on_account_core(jsonb)'::regprocedure, 'public.pos_complete_table_on_account_core(jsonb)'::regprocedure))));

  -- (1) unpaid bills -> On Account: identical to the unchanged production bodies (same fixtures)
  oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_bt, 'customer_id', oa_bc, 'method', 'cash', 'amount', 40000));
  oa_a := pg_temp._oa_snap(array[oa_bo1, oa_bo2]); oa_p := pg_temp._oa_bal(oa_bc);
  oa_r2 := pg_temp._oao(jsonb_build_object('order_id', oa_bpo, 'customer_id', oa_bc, 'method', 'cash', 'amount', 20000));
  oa := oa || jsonb_build_object('S1_unpaid_unchanged', jsonb_build_object(
    'table_json_equal', oa_r = oa_base_t, 'table_diff', pg_temp._jdiff(oa_r->'r', oa_base_t->'r'),
    'table_rows_equal_ex_ids', pg_temp._oa_noid(oa_a) = pg_temp._oa_noid(oa_base_t_snap),
    'table_receivable_equal', oa_p = oa_base_t_bal,
    'order_json_equal', oa_r2 = oa_base_o, 'order_diff', pg_temp._jdiff(oa_r2->'r', oa_base_o->'r'),
    'order_rows_equal_ex_ids', pg_temp._oa_noid(pg_temp._oa_snap(array[oa_bpo])) = pg_temp._oa_noid(oa_base_o_snap),
    'order_receivable_equal', pg_temp._oa_bal(oa_bc) = oa_base_o_bal,
    'table_result', oa_r->'r', 'receivable_after_both', pg_temp._oa_bal(oa_bc)->'primary', 'gl_pos_sale_rows', pg_temp._oa_snap(array[oa_bo1, oa_bo2, oa_bpo])->'gl_sale'));

  -- (2) partial CASH split -> table On Account (with 20000 paid now; S2b pins sent) ; (7)(8)(9) replays
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[100000, 50000]);
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
  oa_op := gen_random_uuid();
  oa_p := jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'amount', 20000, 'client_op_id', oa_op,
    'expected_order_ids', jsonb_build_array(oa_o1), 'expected_amount', 50000);
  oa_b := pg_temp._oa_snap(array[oa_o1]);
  oa_r := pg_temp._oat(oa_p);
  oa_a := pg_temp._oa_snap(array[oa_o1]);
  oa := oa || jsonb_build_object('S2_partial_cash_table', pg_temp._oa_check(oa_b, oa_a, oa_r, oa_c, 50000, 20000, 1, 1, 'outstanding_primary')
    || jsonb_build_object('result', oa_r->'r', 'order', pg_temp._oa_ob(oa_o1),
         'receivables_rpc_summary', pg_temp._try(format('select public.pos_receivables_customer(%L::uuid)', oa_c))->'r'->'summary'));
  oa_r2 := pg_temp._oat(oa_p);   -- (7) duplicate replay, same client_op_id + frozen payload
  oa_r3 := pg_temp._oat(oa_p);   -- (8) after restart
  oa := oa || jsonb_build_object('S7_9_replay_same_op', jsonb_build_object(
    'idempotent', jsonb_build_array(oa_r2->'r'->'idempotent', oa_r3->'r'->'idempotent', pg_temp._oat(oa_p)->'r'->'idempotent'),  -- (9) second reconnect
    'same_result', ((oa_r2->'r') - 'idempotent' - 'result_code') = ((oa_r->'r') - 'idempotent' - 'result_code'),
    'rows_unchanged', pg_temp._oa_snap(array[oa_o1]) = oa_a,
    'receivable_still', pg_temp._oa_bal(oa_c)->'primary',
    'submissions', (select count(*) from public.pos_op_submissions where client_op_id = oa_op)));

  -- (2b) a prior NON-split payment row (earlier tender, 4000) -> table On Account, R = 6000
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[10000]);
  insert into public.pos_payments(tenant_id, branch_id, order_id, shift_id, method, amount, received_by_user_id, currency_code, original_amount, exchange_rate_usd_to_lbp, amount_usd)
    select o.tenant_id, o.branch_id, o.id, o.shift_id, 'cash',
           round(public._pos_amount_usd(4000, coalesce(o.primary_currency_snapshot, 'USD'), o.usd_to_lbp_rate_snapshot), 4), v_u,
           coalesce(o.primary_currency_snapshot, 'USD'), 4000, o.usd_to_lbp_rate_snapshot,
           round(public._pos_amount_usd(4000, coalesce(o.primary_currency_snapshot, 'USD'), o.usd_to_lbp_rate_snapshot), 4)
      from public.pos_orders o where o.id = oa_o1;
  oa_b := pg_temp._oa_snap(array[oa_o1]);
  oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid()));
  oa := oa || jsonb_build_object('S2b_prior_nonsplit_payment_table', pg_temp._oa_check(oa_b, pg_temp._oa_snap(array[oa_o1]), oa_r, oa_c, 6000, 0, 0, 1, 'outstanding_primary')
    || jsonb_build_object('prior_paid', oa_r->'r'->'prior_paid'));

  -- (3) partial CARD split -> single ORDER On Account (old payload shape: no pins), + replay
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[60000, 30000]);
  oa := oa || jsonb_build_object('S3_card_split_result', pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'card') - 'exchange_rate');
  oa_op := gen_random_uuid();
  oa_p := jsonb_build_object('order_id', oa_o1, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', oa_op);
  oa_b := pg_temp._oa_snap(array[oa_o1]);
  oa_r := pg_temp._oao(oa_p);
  oa_a := pg_temp._oa_snap(array[oa_o1]);
  oa_r2 := pg_temp._oao(oa_p);
  oa := oa || jsonb_build_object('S3_partial_card_order', pg_temp._oa_check(oa_b, oa_a, oa_r, oa_c, 30000, 0, 0, 1, 'outstanding')
    || jsonb_build_object('result', (oa_r->'r') - 'finance', 'prior_methods', (select jsonb_agg(e->>'method') from jsonb_array_elements(oa_b->'pays') e),
         'replay_idempotent', oa_r2->'r'->'idempotent', 'replay_rows_unchanged', pg_temp._oa_snap(array[oa_o1]) = oa_a,
         'submissions', (select count(*) from public.pos_op_submissions where client_op_id = oa_op)));

  -- (4) multiple split payments (cash + card) -> table On Account, R = 20000
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[50000, 30000, 20000]);
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 2), 'card');
  oa_b := pg_temp._oa_snap(array[oa_o1]);
  oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid()));
  oa := oa || jsonb_build_object('S4_multi_split_table', pg_temp._oa_check(oa_b, pg_temp._oa_snap(array[oa_o1]), oa_r, oa_c, 20000, 0, 0, 1, 'outstanding_primary')
    || jsonb_build_object('prior_payments', oa_r->'r'->'prior_payments', 'prior_paid', oa_r->'r'->'prior_paid'));

  -- (5) two orders on one table, each part-paid (R1=10000, R2=20000), 15000 paid now -> allocated by R_i
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[60000, 10000]);
  oa_o2 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[40000, 20000]);
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
  perform pg_temp._oa_split(oa_o2, pg_temp._item(oa_o2, 1), 'card');
  oa_b := pg_temp._oa_snap(array[oa_o1, oa_o2]);
  oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'amount', 15000, 'client_op_id', gen_random_uuid()));
  oa_p := pg_temp._oa_bal(oa_c);
  oa := oa || jsonb_build_object('S5_two_partpaid_orders', pg_temp._oa_check(oa_b, pg_temp._oa_snap(array[oa_o1, oa_o2]), oa_r, oa_c, 30000, 15000, 2, 2, 'outstanding_primary')
    || jsonb_build_object('per_order_receivable', oa_p->'per_order',
         'per_order_ok', (oa_p->'per_order'->>oa_o1::text)::numeric = 5000 and (oa_p->'per_order'->>oa_o2::text)::numeric = 10000));
  -- (5b) same shape, R paid in full now -> no receivable left, both orders paid (old body left 4545.. owing, see GAP G3)
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[60000, 10000]);
  oa_o2 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[40000, 20000]);
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
  perform pg_temp._oa_split(oa_o2, pg_temp._item(oa_o2, 1), 'cash');
  oa_b := pg_temp._oa_snap(array[oa_o1, oa_o2]);
  oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'amount', 30000, 'client_op_id', gen_random_uuid()));
  oa := oa || jsonb_build_object('S5b_partpaid_R_paid_now', pg_temp._oa_check(oa_b, pg_temp._oa_snap(array[oa_o1, oa_o2]), oa_r, oa_c, 30000, 30000, 2, 2, 'outstanding_primary')
    || jsonb_build_object('o1', pg_temp._oa_ob(oa_o1), 'o2', pg_temp._oa_ob(oa_o2)));

  -- (6) zero remaining (synthetic: total lowered to the split amount) -> ALREADY_PAID, nothing written
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[40000, 20000]);
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
  update public.pos_orders set total_amount = 40000, subtotal = 40000 where id = oa_o1;
  oa_b := pg_temp._oa_snap(array[oa_o1]);
  oa := oa || jsonb_build_object('S6_zero_remaining', jsonb_build_object(
    'table', pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid())),
    'order', pg_temp._oao(jsonb_build_object('order_id', oa_o1, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid())),
    'nothing_written', pg_temp._oa_snap(array[oa_o1]) = oa_b, 'receivable', pg_temp._oa_bal(oa_c)->'primary'));

  -- (10a) bill changed before replay: a NEWER bill opened on the table; replay pinned to the old bill
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[30000, 20000]);
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
  oa_o2 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[7000]);
  oa_b := pg_temp._oa_snap(array[oa_o1, oa_o2]);
  oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid(),
    'expected_order_ids', jsonb_build_array(oa_o1), 'expected_amount', 20000));
  oa := oa || jsonb_build_object('S10a_newer_bill_pinned', jsonb_build_object('result', oa_r,
    'nothing_written', pg_temp._oa_snap(array[oa_o1, oa_o2]) = oa_b, 'receivable', pg_temp._oa_bal(oa_c)->'primary'));
  -- (10b) amount changed (item added) before replay: expected_amount 20000 vs R now 25000
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[30000, 20000]);
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
  perform pg_temp._oa_add_item(oa_o1, 5000);
  oa_b := pg_temp._oa_snap(array[oa_o1]);
  oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid(),
    'expected_order_ids', jsonb_build_array(oa_o1), 'expected_amount', 20000));
  oa_r2 := pg_temp._oao(jsonb_build_object('order_id', oa_o1, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid(),
    'expected_amount', 20000));
  oa := oa || jsonb_build_object('S10b_amount_changed', jsonb_build_object('table', oa_r, 'order', oa_r2,
    'nothing_written', pg_temp._oa_snap(array[oa_o1]) = oa_b, 'receivable', pg_temp._oa_bal(oa_c)->'primary'));
  -- (10c) reviewed again with the current amount -> R = 25000 on account; a later retry pinned to it -> ALREADY_SETTLED
  oa_r := pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid(),
    'expected_order_ids', jsonb_build_array(oa_o1), 'expected_amount', 25000));
  oa_a := pg_temp._oa_snap(array[oa_o1]);
  oa := oa || jsonb_build_object('S10c_current_pins_ok', pg_temp._oa_check(oa_b, oa_a, oa_r, oa_c, 25000, 0, 0, 1, 'outstanding_primary'),
    'S10c_retry_new_op_after_settled', pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash',
      'client_op_id', gen_random_uuid(), 'expected_order_ids', jsonb_build_array(oa_o1))),
    'S10c_retry_nothing_written', pg_temp._oa_snap(array[oa_o1]) = oa_a);

  -- (E1) amount paid now above R (but below T) -> ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING (old body accepted it, GAP G2/G4)
  -- (E2) discount on a part-paid bill -> SPLIT_DISCOUNT_UNSUPPORTED
  oa_t := pg_temp._oa_tbl(v_t, v_b); oa_c := pg_temp._oa_cust(v_t);
  oa_o1 := pg_temp._mk(v_t, v_b, v_sh, oa_t, array[30000, 20000]);
  perform pg_temp._oa_split(oa_o1, pg_temp._item(oa_o1, 1), 'cash');
  oa_b := pg_temp._oa_snap(array[oa_o1]);
  oa := oa || jsonb_build_object('E1_paid_now_over_R', jsonb_build_object(
      'table', pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'amount', 25000)),
      'order', pg_temp._oao(jsonb_build_object('order_id', oa_o1, 'customer_id', oa_c, 'method', 'cash', 'amount', 25000))),
    'E2_discount_partpaid', jsonb_build_object(
      'table', pg_temp._oat(jsonb_build_object('table_id', oa_t, 'customer_id', oa_c, 'method', 'cash', 'discount_type', 'amount', 'discount_value', 1000)),
      'order', pg_temp._oao(jsonb_build_object('order_id', oa_o1, 'customer_id', oa_c, 'method', 'cash', 'discount_type', 'amount', 'discount_value', 1000))),
    'E_nothing_written', pg_temp._oa_snap(array[oa_o1]) = oa_b);
  -- (10d) single-order expected_amount pin with the right value succeeds (R = 20000)
  oa_r := pg_temp._oao(jsonb_build_object('order_id', oa_o1, 'customer_id', oa_c, 'method', 'cash', 'client_op_id', gen_random_uuid(), 'expected_amount', 20000));
  oa := oa || jsonb_build_object('S10d_order_pin_ok', pg_temp._oa_check(oa_b, pg_temp._oa_snap(array[oa_o1]), oa_r, oa_c, 20000, 0, 0, 1, 'outstanding'));

  res := res || jsonb_build_object('S2b', oa);

  raise exception 'R1038_REHEARSAL_RESULT %', res::text;
end $rh$;
