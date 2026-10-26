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

  -- ---------------- APPLY the 1.0.38 deltas to the STAGING bodies (same anchors as production)
  execute $hh$
create or replace function pg_temp._d1038_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int;
begin
  n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / nullif(length(p_anchor), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
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

  execute $mv$
create function public.pos_move_table_v2(p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
-- Desktop 1.0.38 S2: offline-replay-safe Move Table. Thin wrapper over pos_move_table_core.
-- Exactly-once (pos_op_replay/pos_op_record + actor + request fingerprint), same-OU and
-- can_access_branch, pos_table_bill advisory locks on BOTH tables (same key as pos_save_order),
-- then row locks (open orders, then tables), optional table-version CAS for both tables, and
-- bill-identity + paid-settlement pins. Payments, settlements, items, drawer: untouched.
declare
  v_op uuid := nullif(p_payload->>'client_op_id','')::uuid;
  v_from_id uuid := nullif(p_payload->>'from_table_id','')::uuid;
  v_to_id uuid := nullif(p_payload->>'to_table_id','')::uuid;
  v_exp_from int := nullif(p_payload->>'expected_from_version','')::int;
  v_exp_to int := nullif(p_payload->>'expected_to_version','')::int;
  v_pin_orders uuid[];
  v_pin_paid jsonb := nullif(p_payload->'expected_paid_settlements', 'null'::jsonb);
  v_super boolean := public.is_super_admin();
  v_from public.pos_tables; v_to public.pos_tables;
  v_tenant uuid; v_branch uuid; v_tid uuid; v_oid uuid;
  v_fp text; v_cached jsonb; v_prev_actor uuid; v_prev_fp text;
  v_src_orders uuid[]; v_cnt int;
  v_core jsonb; v_from_ver int; v_to_ver int; v_result jsonb;
begin
  if v_op is null then perform public.pos_op_error('MOVE_NO_OP', 'A client_op_id is required.'); end if;
  if v_from_id is null or v_to_id is null then
    raise exception 'from_table_id and to_table_id are required' using errcode = '22023';
  end if;
  if v_from_id = v_to_id then perform public.pos_op_error('MOVE_SAME_TABLE', 'Choose a different destination table.'); end if;
  if nullif(p_payload->'expected_order_ids', 'null'::jsonb) is not null then
    if jsonb_typeof(p_payload->'expected_order_ids') <> 'array' or jsonb_array_length(p_payload->'expected_order_ids') = 0 then
      raise exception 'expected_order_ids must be a non-empty array' using errcode = '22023';
    end if;
    v_pin_orders := array(select distinct e::uuid from jsonb_array_elements_text(p_payload->'expected_order_ids') e order by 1);
  end if;
  if v_pin_paid is not null and jsonb_typeof(v_pin_paid) <> 'object' then
    raise exception 'expected_paid_settlements must be an object' using errcode = '22023';
  end if;

  select * into v_from from public.pos_tables where id = v_from_id;
  select * into v_to from public.pos_tables where id = v_to_id;
  if v_from.id is null or v_to.id is null then raise exception 'Table not found'; end if;
  v_tenant := v_from.tenant_id; v_branch := v_from.branch_id;
  perform public.pos_assert_operator(v_tenant);
  if v_to.tenant_id <> v_tenant then raise exception 'Tables belong to different tenants' using errcode = '42501'; end if;
  if v_to.branch_id is distinct from v_branch then
    raise exception 'Tables belong to different operating units' using errcode = '42501',
      detail = json_build_object('pos_error_code','CROSS_OU_REJECTED')::text;
  end if;
  if not (v_super or public.can_access_branch(v_branch)) then
    raise exception 'Not authorized for this operating unit' using errcode = '42501',
      detail = json_build_object('pos_error_code','OU_ACCESS_DENIED')::text;
  end if;
  perform public._pos_require(v_tenant, 'pos.tables.move');

  v_fp := md5('mv2|' || v_from_id::text || '|' || v_to_id::text || '|' || coalesce(v_exp_from::text, '') || '|'
    || coalesce(v_exp_to::text, '') || '|' || coalesce(array_to_string(v_pin_orders, ','), '') || '|'
    || coalesce((select string_agg(k || '=' || (v_pin_paid->>k), ',' order by k) from jsonb_object_keys(v_pin_paid) k), ''));

  v_cached := public.pos_op_replay(v_tenant, v_op, 'pos_move_table_v2', v_branch);
  if v_cached is not null then
    select created_by, request_fingerprint into v_prev_actor, v_prev_fp
      from public.pos_op_submissions where tenant_id = v_tenant and client_op_id = v_op limit 1;
    if v_prev_actor is distinct from auth.uid() then
      raise exception 'This operation id belongs to another operator' using errcode = '42501',
        detail = json_build_object('pos_error_code','CROSS_ACTOR_REPLAY_REJECTED')::text;
    end if;
    if v_prev_fp is distinct from v_fp then
      perform public.pos_op_error('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This operation id was already used with a different move request.');
    end if;
    return v_cached || jsonb_build_object('idempotent', true, 'result_code', 'DUPLICATE_REPLAY_RETURNED');
  end if;

  -- Locks: bill advisory locks for both tables in id order (same key as pos_save_order), then the
  -- open orders of both tables, then both table rows (orders before tables, as pos_save_order /
  -- pos_pay_table_core do).
  foreach v_tid in array array(select unnest(array[v_from_id, v_to_id]) order by 1) loop
    perform pg_advisory_xact_lock(hashtextextended('pos_table_bill:' || v_tenant::text || ':' || coalesce(v_branch::text,'') || ':' || v_tid::text, 0));
  end loop;
  perform 1 from public.pos_orders
    where tenant_id = v_tenant and table_id in (v_from_id, v_to_id)
      and status not in ('completed','voided','cancelled','refunded') and payment_status <> 'paid'
    order by id for update;
  perform 1 from public.pos_tables where id in (v_from_id, v_to_id) order by id for update;
  select * into v_from from public.pos_tables where id = v_from_id;
  select * into v_to from public.pos_tables where id = v_to_id;

  if v_exp_from is not null and v_from.pos_entity_version is distinct from v_exp_from then
    perform public.pos_op_error('VERSION_CONFLICT', 'The source table changed since it was loaded. Reload the table map and retry.');
  end if;
  if v_exp_to is not null and v_to.pos_entity_version is distinct from v_exp_to then
    perform public.pos_op_error('VERSION_CONFLICT', 'The destination table changed since it was loaded. Reload the table map and retry.');
  end if;

  v_src_orders := array(select o.id from public.pos_orders o
    where o.tenant_id = v_tenant and o.table_id = v_from_id
      and o.status not in ('completed','voided','cancelled','refunded') and o.payment_status <> 'paid'
    order by o.id);
  if v_pin_orders is not null and v_src_orders is distinct from v_pin_orders then
    perform public.pos_op_error('MOVE_SOURCE_CHANGED', 'The bill on the source table changed since the move was captured. Reconnect and review.');
  end if;
  if coalesce(array_length(v_src_orders, 1), 0) = 0 then
    perform public.pos_op_error('MOVE_SOURCE_EMPTY', 'That table has no open order to move.');
  end if;
  if v_pin_paid is not null then
    if exists (select 1 from jsonb_object_keys(v_pin_paid) k where not (k::uuid = any(v_src_orders))) then
      perform public.pos_op_error('MOVE_SOURCE_CHANGED', 'The bill on the source table changed since the move was captured. Reconnect and review.');
    end if;
    foreach v_oid in array v_src_orders loop
      select count(*) into v_cnt from public.pos_split_settlements s where s.parent_order_id = v_oid and s.status = 'paid';
      if v_cnt <> coalesce((v_pin_paid->>v_oid::text)::int, 0) then
        perform public.pos_op_error('MOVE_PAYMENT_STATE_CHANGED', 'A payment was taken on this bill since the move was captured. Reconnect and review.');
      end if;
    end loop;
  end if;
  if exists (select 1 from public.pos_orders o where o.tenant_id = v_tenant and o.table_id = v_to_id
             and o.status not in ('completed','voided','cancelled','refunded') and o.payment_status <> 'paid') then
    perform public.pos_op_error('MOVE_DEST_OCCUPIED', 'The destination table already has an open bill.');
  end if;
  if v_to.status = 'inactive' then
    perform public.pos_op_error('MOVE_DEST_UNAVAILABLE', 'The destination table is not in service.');
  end if;

  v_core := public.pos_move_table_core(v_from_id, v_to_id, v_exp_from);
  if (v_core->>'orders_moved')::int is distinct from array_length(v_src_orders, 1) then
    raise exception 'Move invariant violated (moved %, pinned %)', v_core->>'orders_moved', array_length(v_src_orders, 1);
  end if;
  v_from_ver := (v_core->>'pos_entity_version')::int;
  select pos_entity_version into v_to_ver from public.pos_tables where id = v_to_id;
  v_result := jsonb_build_object('ok', true, 'orders_moved', array_length(v_src_orders, 1), 'order_ids', to_jsonb(v_src_orders),
    'from_table_id', v_from_id, 'to_table_id', v_to_id, 'from_version', v_from_ver, 'to_version', v_to_ver,
    'table_versions', jsonb_build_object(v_from_id::text, v_from_ver, v_to_id::text, v_to_ver),
    'pos_entity_version', v_from_ver);
  perform public.pos_op_record(v_tenant, v_branch, v_op, 'pos_move_table_v2', v_to_id, v_result);
  update public.pos_op_submissions set request_fingerprint = v_fp where tenant_id = v_tenant and client_op_id = v_op;
  return v_result || jsonb_build_object('idempotent', false, 'result_code', 'SUCCESS');
end; $function$;

$mv$;
  execute $mg$
create function public.pos_merge_tables_v4(p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
-- Desktop 1.0.38 S3: offline-replay-safe Merge Tables. Thin wrapper over pos_merge_tables_v3,
-- whose financial semantics are reused UNCHANGED. Adds: pos_table_bill advisory locks, bill
-- identity pins (expected_orders), paid-settlement pins (expected_paid_settlements), a PARTIAL
-- table-version map (expected_versions; any subset of the involved tables) and table_versions in
-- the result. v3 is always called with expected = {} (v4 has already checked versions under lock),
-- so v3's request fingerprint is stable across retries; the v4 fingerprint is kept in result_json.
declare
  v_primary_table uuid := nullif(p_payload->>'primary_table_id','')::uuid;
  v_op uuid := nullif(p_payload->>'client_op_id','')::uuid;
  v_exp jsonb := nullif(coalesce(p_payload->'expected_versions', p_payload->'expected'), 'null'::jsonb);
  v_pin_orders jsonb := nullif(p_payload->'expected_orders', 'null'::jsonb);
  v_pin_paid jsonb := nullif(p_payload->'expected_paid_settlements', 'null'::jsonb);
  v_sources uuid[]; v_all uuid[];
  v_tbl public.pos_tables; v_tenant uuid; v_branch uuid; v_tid uuid; v_oid uuid;
  v_super boolean := public.is_super_admin();
  v_fp4 text; v_cached jsonb; v_v3_payload jsonb; v_res jsonb; v_versions jsonb;
  v_ids uuid[]; v_bill_ids uuid[] := '{}'; v_cnt int; v_n int;
begin
  if v_primary_table is null then raise exception 'A primary table is required'; end if;
  if v_op is null then perform public.pos_op_error('MERGE_NO_OP', 'A client_op_id is required.'); end if;
  v_sources := array(select distinct (e)::uuid from jsonb_array_elements_text(coalesce(p_payload->'source_table_ids','[]'::jsonb)) e order by 1);
  if v_sources is null or array_length(v_sources, 1) is null then
    perform public.pos_op_error('MERGE_NO_SOURCES', 'Select at least one other table to merge in.');
  end if;
  if v_primary_table = any(v_sources) then raise exception 'The primary table cannot also be a source table'; end if;
  v_all := array(select unnest(array_prepend(v_primary_table, v_sources)) order by 1);
  if (v_exp is not null and jsonb_typeof(v_exp) <> 'object')
     or (v_pin_orders is not null and jsonb_typeof(v_pin_orders) <> 'object')
     or (v_pin_paid is not null and jsonb_typeof(v_pin_paid) <> 'object') then
    raise exception 'expected_versions / expected_orders / expected_paid_settlements must be objects' using errcode = '22023';
  end if;

  select * into v_tbl from public.pos_tables where id = v_primary_table;
  if v_tbl.id is null then raise exception 'Primary table not found'; end if;
  v_tenant := v_tbl.tenant_id; v_branch := v_tbl.branch_id;
  perform public.pos_assert_operator(v_tenant);
  if not (v_super or public.can_access_branch(v_branch)) then
    raise exception 'Not authorized for this operating unit' using errcode = '42501',
      detail = json_build_object('pos_error_code','OU_ACCESS_DENIED')::text;
  end if;
  perform public._pos_require(v_tenant, 'pos.tables.merge');

  v_fp4 := md5('v4|' || v_primary_table::text || '|' || array_to_string(v_sources, ',') || '|'
    || coalesce((select string_agg(k || '=' || (v_exp->>k), ',' order by k) from jsonb_object_keys(v_exp) k), '') || '|'
    || coalesce((select string_agg(k || '=' || (v_pin_orders->>k), ',' order by k) from jsonb_object_keys(v_pin_orders) k), '') || '|'
    || coalesce((select string_agg(k || '=' || (v_pin_paid->>k), ',' order by k) from jsonb_object_keys(v_pin_paid) k), ''));
  v_v3_payload := jsonb_build_object('primary_table_id', v_primary_table, 'source_table_ids', to_jsonb(v_sources),
    'client_op_id', v_op, 'expected', '{}'::jsonb);

  -- Already recorded => delegate to v3 (actor + v3 fingerprint check, cached result), then v4 fingerprint.
  v_cached := public.pos_op_replay(v_tenant, v_op, 'pos_merge_tables_v3', v_branch);
  if v_cached is not null then
    v_res := public.pos_merge_tables_v3(v_v3_payload);
    if (v_res ? 'v4_fingerprint') and (v_res->>'v4_fingerprint') is distinct from v_fp4 then
      perform public.pos_op_error('IDEMPOTENCY_PAYLOAD_MISMATCH', 'This operation id was already used with a different merge request.');
    end if;
    return v_res || jsonb_build_object('idempotent', true, 'result_code', 'DUPLICATE_REPLAY_RETURNED');
  end if;

  -- Locks: bill advisory locks in table-id order (same key as pos_save_order), open orders, tables.
  foreach v_tid in array v_all loop
    perform pg_advisory_xact_lock(hashtextextended('pos_table_bill:' || v_tenant::text || ':' || coalesce(v_branch::text,'') || ':' || v_tid::text, 0));
  end loop;
  perform 1 from public.pos_orders
    where tenant_id = v_tenant and table_id = any(v_all)
      and status not in ('completed','voided','cancelled','refunded') and payment_status <> 'paid'
    order by id for update;
  perform 1 from public.pos_tables where id = any(v_all) order by id for update;

  if v_exp is not null then
    if exists (select 1 from jsonb_object_keys(v_exp) k where not (k::uuid = any(v_all))) then
      perform public.pos_op_error('MERGE_EXPECTED_MISMATCH', 'Stale floor: reload and retry the merge.');
    end if;
    if exists (select 1 from public.pos_tables t where t.id = any(v_all) and v_exp ? t.id::text
               and t.pos_entity_version is distinct from (v_exp->>t.id::text)::int) then
      perform public.pos_op_error('VERSION_CONFLICT', 'A table changed since the merge was opened. Reload the floor and retry.');
    end if;
  end if;
  if v_pin_orders is not null and exists (select 1 from jsonb_object_keys(v_pin_orders) k where not (k::uuid = any(v_all))) then
    perform public.pos_op_error('MERGE_EXPECTED_MISMATCH', 'Stale floor: reload and retry the merge.');
  end if;
  foreach v_tid in array v_all loop
    -- the same "one open bill" predicate as pos_merge_tables_v3
    v_ids := array(select o.id from public.pos_orders o
      where o.tenant_id = v_tenant and o.table_id = v_tid
        and o.order_type = 'dine_in' and o.status in ('draft','sent_to_kitchen') and o.payment_status = 'unpaid'
      order by o.id);
    if v_pin_orders is not null and v_pin_orders ? v_tid::text
       and v_ids is distinct from array[(v_pin_orders->>v_tid::text)::uuid] then
      perform public.pos_op_error('MERGE_BILL_CHANGED', 'A bill changed since the merge was captured. Reconnect and review.');
    end if;
    v_bill_ids := v_bill_ids || v_ids;
  end loop;
  if v_pin_paid is not null then
    if exists (select 1 from jsonb_object_keys(v_pin_paid) k where not (k::uuid = any(v_bill_ids))) then
      perform public.pos_op_error('MERGE_BILL_CHANGED', 'A bill changed since the merge was captured. Reconnect and review.');
    end if;
    foreach v_oid in array v_bill_ids loop
      select count(*) into v_cnt from public.pos_split_settlements s where s.parent_order_id = v_oid and s.status = 'paid';
      if v_cnt <> coalesce((v_pin_paid->>v_oid::text)::int, 0) then
        perform public.pos_op_error('MERGE_PAYMENT_STATE_CHANGED', 'A payment was taken on a bill since the merge was captured. Reconnect and review.');
      end if;
    end loop;
  end if;

  v_res := public.pos_merge_tables_v3(v_v3_payload);
  select jsonb_object_agg(t.id::text, t.pos_entity_version) into v_versions from public.pos_tables t where t.id = any(v_all);
  v_res := v_res || jsonb_build_object('table_versions', v_versions, 'v4_fingerprint', v_fp4);
  update public.pos_op_submissions set result_json = v_res
   where tenant_id = v_tenant and client_op_id = v_op and op_type = 'pos_merge_tables_v3';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'Merge submission record not found for %', v_op; end if;
  return v_res || jsonb_build_object('idempotent', false, 'result_code', 'SUCCESS');
end; $function$;

$mg$;
  revoke all on function public.pos_move_table_v2(jsonb) from public, anon;
  grant execute on function public.pos_move_table_v2(jsonb) to authenticated, service_role;
  revoke all on function public.pos_merge_tables_v4(jsonb) from public, anon;
  grant execute on function public.pos_merge_tables_v4(jsonb) to authenticated, service_role;
  res := res || jsonb_build_object('staging_post', jsonb_build_object(
    'pos_pay_order_core', md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)),
    'pos_pay_table_core', md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)),
    'pos_move_table_v2', md5(pg_get_functiondef('public.pos_move_table_v2(jsonb)'::regprocedure)),
    'pos_merge_tables_v4', md5(pg_get_functiondef('public.pos_merge_tables_v4(jsonb)'::regprocedure)),
    'acl_move_v2', (select proacl::text from pg_proc where oid = 'public.pos_move_table_v2(jsonb)'::regprocedure),
    'acl_merge_v4', (select proacl::text from pg_proc where oid = 'public.pos_merge_tables_v4(jsonb)'::regprocedure)));

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

  -- ================= S2 move_v2 =================
  o_m := pg_temp._mk(v_t, v_b, v_sh, tb[9], array[12000, 8000]);
  o_occ := pg_temp._mk(v_t, v_b, v_sh, tb[11], array[5000]);
  select pos_entity_version into v_v1 from public.pos_tables where id = tb[9];
  select pos_entity_version into v_v2 from public.pos_tables where id = tb[10];
  p_mv := jsonb_build_object('client_op_id', op_m1, 'from_table_id', tb[9], 'to_table_id', tb[10],
    'expected_order_ids', jsonb_build_array(o_m), 'expected_paid_settlements', '{}'::jsonb,
    'expected_from_version', v_v1, 'expected_to_version', v_v2);
  res := res || jsonb_build_object('S2_no_op', pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)', p_mv - 'client_op_id')));
  j := public.pos_move_table_v2(p_mv);
  res := res || jsonb_build_object('S2_move', jsonb_build_object('result', j - 'order_ids' - 'from_table_id' - 'to_table_id' - 'table_versions',
    'order_now_on_dest', (select table_id = tb[10] from public.pos_orders where id = o_m),
    'versions_match_rows', (j->>'from_version')::int = (select pos_entity_version from public.pos_tables where id = tb[9])
                       and (j->>'to_version')::int = (select pos_entity_version from public.pos_tables where id = tb[10]),
    'table_status', (select jsonb_agg(status order by id = tb[10]) from public.pos_tables where id in (tb[9], tb[10]))));
  j := public.pos_move_table_v2(p_mv);
  res := res || jsonb_build_object('S2_replay', jsonb_build_object('idempotent', j->'idempotent',
    'submissions', (select count(*) from public.pos_op_submissions where client_op_id = op_m1),
    'order_still_on_dest', (select table_id = tb[10] from public.pos_orders where id = o_m)));
  res := res || jsonb_build_object('S2_replay_diff_payload', pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)', p_mv || jsonb_build_object('to_table_id', tb[12]))));
  res := res || jsonb_build_object('S2_dest_occupied', pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)',
      jsonb_build_object('client_op_id', gen_random_uuid(), 'from_table_id', tb[10], 'to_table_id', tb[11]))),
    'S2_dest_occupied_order_unmoved', (select table_id = tb[10] from public.pos_orders where id = o_m));
  res := res || jsonb_build_object('S2_source_changed', pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)',
      jsonb_build_object('client_op_id', gen_random_uuid(), 'from_table_id', tb[10], 'to_table_id', tb[9], 'expected_order_ids', jsonb_build_array(o_occ)))));
  res := res || jsonb_build_object('S2_version_conflict', pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)',
      jsonb_build_object('client_op_id', gen_random_uuid(), 'from_table_id', tb[10], 'to_table_id', tb[9], 'expected_from_version', 9999))));
  perform pg_temp._split(o_m, pg_temp._item(o_m, 1));
  res := res || jsonb_build_object('S2_paid_state_changed', pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)',
      jsonb_build_object('client_op_id', gen_random_uuid(), 'from_table_id', tb[10], 'to_table_id', tb[9], 'expected_order_ids', jsonb_build_array(o_m), 'expected_paid_settlements', '{}'::jsonb))));
  j2 := pg_temp._paid(o_m);
  j := pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)',
      jsonb_build_object('client_op_id', gen_random_uuid(), 'from_table_id', tb[10], 'to_table_id', tb[9], 'expected_order_ids', jsonb_build_array(o_m), 'expected_paid_settlements', jsonb_build_object(o_m::text, 1))));
  res := res || jsonb_build_object('S2_partpaid_move', jsonb_build_object('ok', j->'ok', 'orders_moved', j->'r'->'orders_moved', 'payments_unchanged', pg_temp._paid(o_m) = j2,
    'order', (select jsonb_build_object('table_ok', table_id = tb[9], 'total', total_amount, 'status', status) from public.pos_orders where id = o_m)));
  select b.id into br2 from public.branches b where b.tenant_id = v_t and b.id <> v_b limit 1;
  if br2 is not null then
    insert into public.pos_tables(tenant_id, branch_id, name, status, is_configured) values (v_t, br2, 'R1038-X', 'available', true) returning id into tb_x;
    res := res || jsonb_build_object('S2_cross_ou', pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)',
      jsonb_build_object('client_op_id', gen_random_uuid(), 'from_table_id', tb[9], 'to_table_id', tb_x))),
      'S1_core_cross_ou', pg_temp._try(format('select public.pos_move_table(%L::uuid, %L::uuid)', tb[9], tb_x)));
  else
    res := res || jsonb_build_object('S2_cross_ou', 'SKIPPED: tenant has a single branch on staging');
  end if;
  select tu.user_id into v_u2 from public.tenant_users tu
   where tu.tenant_id = v_t and tu.status = 'active' and tu.user_id <> v_u
     and (select x.tenant_id from public.tenant_users x where x.user_id = tu.user_id and x.status = 'active' order by x.created_at limit 1) = v_t
   limit 1;
  if v_u2 is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_u2, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_u2::text, true);
    res := res || jsonb_build_object('S2_cross_actor_replay', pg_temp._try(format('select public.pos_move_table_v2(%L::jsonb)', p_mv)));
    perform set_config('request.jwt.claims', json_build_object('sub', v_u, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_u::text, true);
  else
    res := res || jsonb_build_object('S2_cross_actor_replay', 'SKIPPED: no second operator');
  end if;

  -- ================= S3 merge_v4 =================
  o_p := pg_temp._mk(v_t, v_b, v_sh, tb[12], array[15000]);
  o_s := pg_temp._mk(v_t, v_b, v_sh, tb[13], array[5000]);
  select pos_entity_version into v_v1 from public.pos_tables where id = tb[12];
  select count(*) into v_n from public.pos_table_merges where tenant_id = v_t;
  p_g := jsonb_build_object('client_op_id', op_g1, 'primary_table_id', tb[12], 'source_table_ids', jsonb_build_array(tb[13]),
    'expected_orders', jsonb_build_object(tb[12]::text, o_p, tb[13]::text, o_s),
    'expected_paid_settlements', '{}'::jsonb, 'expected_versions', jsonb_build_object(tb[12]::text, v_v1));
  j := public.pos_merge_tables_v4(p_g);
  res := res || jsonb_build_object('S3_merge', jsonb_build_object('ok', j->'ok', 'idempotent', j->'idempotent', 'sources_merged', j->'sources_merged',
    'total_amount', j->'total_amount', 'has_table_versions_for_both', (j->'table_versions') ? tb[12]::text and (j->'table_versions') ? tb[13]::text,
    'source', (select jsonb_build_object('status', status, 'merged_into_primary', merged_into_order_id = o_p) from public.pos_orders where id = o_s),
    'primary_total', (select total_amount from public.pos_orders where id = o_p),
    'versions_match_rows', (select bool_and((j->'table_versions'->>t.id::text)::int = t.pos_entity_version) from public.pos_tables t where t.id in (tb[12], tb[13])),
    'merges_added', (select count(*) from public.pos_table_merges where tenant_id = v_t) - v_n,
    'submission', (select jsonb_build_object('op_type', op_type, 'has_v4_fp', result_json ? 'v4_fingerprint', 'has_v3_fp', request_fingerprint is not null)
                     from public.pos_op_submissions where client_op_id = op_g1)));
  j2 := public.pos_merge_tables_v4(p_g);
  res := res || jsonb_build_object('S3_replay_delegate', jsonb_build_object('idempotent', j2->'idempotent', 'same_merge_id', j2->'merge_id' = j->'merge_id',
    'same_table_versions', j2->'table_versions' = j->'table_versions',
    'merges_added_total', (select count(*) from public.pos_table_merges where tenant_id = v_t) - v_n));
  res := res || jsonb_build_object('S3_replay_diff_pins', pg_temp._try(format('select public.pos_merge_tables_v4(%L::jsonb)',
    p_g || jsonb_build_object('expected_versions', jsonb_build_object(tb[12]::text, 999)))));
  -- negatives against the part-paid source o_m (tb[9], 1 paid split) into a fresh primary o_x (tb[14])
  o_x := pg_temp._mk(v_t, v_b, v_sh, tb[14], array[9000]);
  p_g := jsonb_build_object('primary_table_id', tb[14], 'source_table_ids', jsonb_build_array(tb[9]));
  res := res || jsonb_build_object('S3_bill_changed', pg_temp._try(format('select public.pos_merge_tables_v4(%L::jsonb)',
      p_g || jsonb_build_object('client_op_id', gen_random_uuid(), 'expected_orders', jsonb_build_object(tb[9]::text, gen_random_uuid())))),
    'S3_version_conflict', pg_temp._try(format('select public.pos_merge_tables_v4(%L::jsonb)',
      p_g || jsonb_build_object('client_op_id', gen_random_uuid(), 'expected_versions', jsonb_build_object(tb[9]::text, 9999)))),
    'S3_paid_state_changed', pg_temp._try(format('select public.pos_merge_tables_v4(%L::jsonb)',
      p_g || jsonb_build_object('client_op_id', gen_random_uuid(), 'expected_paid_settlements', '{}'::jsonb))),
    'S3_expected_unknown_table', pg_temp._try(format('select public.pos_merge_tables_v4(%L::jsonb)',
      p_g || jsonb_build_object('client_op_id', gen_random_uuid(), 'expected_versions', jsonb_build_object(gen_random_uuid()::text, 1)))));
  -- part-paid source merged with correct pins, then the primary is paid: must charge exactly R = 9000 + 8000
  j2 := pg_temp._paid(o_m);
  j := pg_temp._try(format('select public.pos_merge_tables_v4(%L::jsonb)',
      p_g || jsonb_build_object('client_op_id', gen_random_uuid(), 'expected_orders', jsonb_build_object(tb[9]::text, o_m, tb[14]::text, o_x),
        'expected_paid_settlements', jsonb_build_object(o_m::text, 1))));
  res := res || jsonb_build_object('S3_partpaid_merge', jsonb_build_object('ok', j->'ok', 'err', j - 'r' - 'ok',
    'source', (select jsonb_build_object('status', status || '/' || payment_status, 'total', total_amount) from public.pos_orders where id = o_m),
    'source_payments_unchanged', pg_temp._paid(o_m) = j2,
    'primary_total', (select total_amount from public.pos_orders where id = o_x)));
  if (j->>'ok')::boolean then
    j := public.pos_pay_table(jsonb_build_object('table_id', tb[14], 'method', 'cash', 'currency_code', 'USD', 'client_op_id', gen_random_uuid()));
    res := res || jsonb_build_object('S3_final_pay_after_partpaid_merge', jsonb_build_object('charged', j->'amount', 'pass', (j->>'amount')::numeric = 17000,
      'prior_paid', j->'prior_paid'));
  end if;

  raise exception 'R1038_REHEARSAL_RESULT %', res::text;
end $rh$;
