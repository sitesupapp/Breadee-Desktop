-- ============================================================================
-- Desktop 1.0.38 Offline — PRODUCTION server contracts (additive).
-- Target: PRODUCTION cltlqfqormkhppmbvyrv. Apply ONCE via apply_migration
-- name = desktop_1038_offline_contracts (single transaction). NOT APPLIED — needs an exact GO.
-- GENERATED from a single delta definition (scratchpad gen1038/deltas.py); do not hand-edit anchors.
--
--   S4  pos_pay_order_core / pos_pay_table_core: charge only the remaining obligation
--       R = T - P, where P = sum(pos_split_settlements.amount_order_ccy, status='paid') read under
--       the existing order row lock. Refuse ALREADY_PAID when R <= 0.005, PAYMENT_RESIDUE when the
--       bill carries pos_payments rows that are not paid split settlements, and
--       SPLIT_DISCOUNT_UNSUPPORTED for a discount on a part-paid bill. Orders with no prior payment
--       rows: byte-for-byte the same behaviour and result JSON (rehearsal-proven on staging).
--   S5  pos_pay_table_core: OPTIONAL payload keys expected_order_ids (bill identity; PAY_BILL_CHANGED /
--       ALREADY_SETTLED) and expected_amount (PAY_AMOUNT_CHANGED). Absent => unchanged.
--   S1  pos_move_table_core: port the staging same-OU + can_access_branch guard (prod OU drift fix).
--       Post-image is byte-identical to the staging body (md5 6195b2add5797e20e40c2d59b913b557).
--   S2  NEW pos_move_table_v2(jsonb): exactly-once, locked, pinned Move Table wrapper over the core.
--   S3  NEW pos_merge_tables_v4(jsonb): pinned / partial-version wrapper over pos_merge_tables_v3
--       (v3 unchanged; already-recorded ops delegate to v3).
--
-- METHOD: each changed function is rebuilt from its LIVE production definition + exact anchored
-- replace() asserted exactly-once; the rebuilt text must hash to the post-image computed read-only
-- from production before it is executed. PRE guards pin every function this migration changes or
-- calls. Signatures are unchanged (CREATE OR REPLACE keeps owner/ACL); POST guards verify md5,
-- ACL, SECURITY DEFINER, search_path, owner, single overload. No business data read or written.
-- Rollback (pre-publication only): prod_1038_offline_contracts_ROLLBACK.sql.
-- ============================================================================

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------- PRE guards
do $pre$
declare
  m text;
begin
  m := md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure));
  if m <> 'e21bac394d8f06b9c63fda903d5651e5' then raise exception 'PRE: public.pos_pay_order_core(jsonb) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure));
  if m <> '7b6ea08ffcbeca5f56d78d33c7cd1198' then raise exception 'PRE: public.pos_pay_table_core(jsonb) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure));
  if m <> 'ecb0e6f3f47d37dc2837ac44985e2e56' then raise exception 'PRE: public.pos_move_table_core(uuid,uuid,integer) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_pay_order(jsonb)'::regprocedure));
  if m <> '70a7ccc17e6df5200b9e00610bda4192' then raise exception 'PRE: public.pos_pay_order(jsonb) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_pay_table(jsonb)'::regprocedure));
  if m <> '56588d0ecbc91069b5184107de0003aa' then raise exception 'PRE: public.pos_pay_table(jsonb) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_move_table(uuid,uuid,uuid,integer)'::regprocedure));
  if m <> 'c342a7fa766ca0ab89c9f8f496e575a4' then raise exception 'PRE: public.pos_move_table(uuid,uuid,uuid,integer) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_merge_tables_v3(jsonb)'::regprocedure));
  if m <> '4eb57a93f43b8dfeb12a6537c26d7cf3' then raise exception 'PRE: public.pos_merge_tables_v3(jsonb) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_op_replay(uuid,uuid,text,uuid)'::regprocedure));
  if m <> '78e42ee7e2d5dc3d6687e297f7a058d4' then raise exception 'PRE: public.pos_op_replay(uuid,uuid,text,uuid) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_op_record(uuid,uuid,uuid,text,uuid,jsonb)'::regprocedure));
  if m <> '8a2df61e34abbb302698c06b377be017' then raise exception 'PRE: public.pos_op_record(uuid,uuid,uuid,text,uuid,jsonb) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_op_error(text,text)'::regprocedure));
  if m <> 'ed70a93fa4e5321e636ba82efe1c15bd' then raise exception 'PRE: public.pos_op_error(text,text) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_op_branch_of(text,text)'::regprocedure));
  if m <> 'c8991f7c7452b82e9a43465e1d462816' then raise exception 'PRE: public.pos_op_branch_of(text,text) drifted (md5 %)', m; end if;
  m := md5(pg_get_functiondef('public.pos_split_settle_core(jsonb)'::regprocedure));
  if m <> '66c8b850bbd5901faefc05559eb97d0b' then raise exception 'PRE: public.pos_split_settle_core(jsonb) drifted (md5 %)', m; end if;
  if to_regprocedure('public.pos_move_table_v2(jsonb)') is not null then raise exception 'PRE: pos_move_table_v2 already exists'; end if;
  if to_regprocedure('public.pos_merge_tables_v4(jsonb)') is not null then raise exception 'PRE: pos_merge_tables_v4 already exists'; end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('pos_pay_order_core','pos_pay_table_core','pos_move_table_core','pos_move_table_v2','pos_merge_tables_v4')) <> 3 then
    raise exception 'PRE: unexpected overloads';
  end if;
end
$pre$;

-- ---------------------------------------------------------------- helper: exactly-once replace
create or replace function pg_temp._d1038_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int;
begin
  n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / nullif(length(p_anchor), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  return replace(p_src, p_anchor, p_repl);
end $f$;

-- ---------------------------------------------------------------- S4 + S5 + S1 (from LIVE bodies)
do $apply$
declare
  d text;
begin
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
  if md5(d) <> '95f3b2a43abb9b5eb60b0965c2735ba8' then raise exception 'BUILD: % post-image md5 % (expected 95f3b2a43abb9b5eb60b0965c2735ba8)', 'public.pos_pay_order_core(jsonb)', md5(d); end if;
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
  if md5(d) <> 'c0682f5d0edf0d0e6bda0db0b916e155' then raise exception 'BUILD: % post-image md5 % (expected c0682f5d0edf0d0e6bda0db0b916e155)', 'public.pos_pay_table_core(jsonb)', md5(d); end if;
  execute d;

  -- public.pos_move_table_core(uuid,uuid,integer)
  d := pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure);
  d := pg_temp._d1038_once(d,
    E'  v_tenant := v_from.tenant_id;\n',
    E'  v_tenant := v_from.tenant_id;\n'
    || E'  if v_from.branch_id is distinct from v_to.branch_id then\n'
    || E'    raise exception ''Tables belong to different operating units'' using errcode = ''42501'';\n'
    || E'  end if;\n'
    || E'  if not (public.is_super_admin() or public.can_access_branch(v_from.branch_id)) then\n'
    || E'    raise exception ''Not authorized for this operating unit'' using errcode = ''42501'';\n'
    || E'  end if;\n',
    'move_core.ou');
  if md5(d) <> '6195b2add5797e20e40c2d59b913b557' then raise exception 'BUILD: % post-image md5 % (expected 6195b2add5797e20e40c2d59b913b557)', 'public.pos_move_table_core(uuid,uuid,integer)', md5(d); end if;
  execute d;
end
$apply$;

-- ---------------------------------------------------------------- S2 pos_move_table_v2 (new)
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

-- ---------------------------------------------------------------- S3 pos_merge_tables_v4 (new)
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

-- explicit ownership + grants (Supabase default privileges grant anon/PUBLIC on new functions)
alter function public.pos_move_table_v2(jsonb) owner to postgres;
revoke all on function public.pos_move_table_v2(jsonb) from public, anon;
grant execute on function public.pos_move_table_v2(jsonb) to authenticated, service_role;
alter function public.pos_merge_tables_v4(jsonb) owner to postgres;
revoke all on function public.pos_merge_tables_v4(jsonb) from public, anon;
grant execute on function public.pos_merge_tables_v4(jsonb) to authenticated, service_role;

-- install marker (read by the ROLLBACK adoption-evidence guard)
do $mark$
begin
  execute format('comment on function public.pos_move_table_v2(jsonb) is %L',
    'Desktop 1.0.38 S2 offline Move Table. installed_at=' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  execute format('comment on function public.pos_merge_tables_v4(jsonb) is %L',
    'Desktop 1.0.38 S3 offline Merge Tables (wraps pos_merge_tables_v3).');
end
$mark$;

-- ---------------------------------------------------------------- POST guards
do $post$
declare r record; v text;
begin
  if md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)) <> '95f3b2a43abb9b5eb60b0965c2735ba8' then raise exception 'POST: public.pos_pay_order_core(jsonb) md5 % (expected 95f3b2a43abb9b5eb60b0965c2735ba8)', md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)) <> 'c0682f5d0edf0d0e6bda0db0b916e155' then raise exception 'POST: public.pos_pay_table_core(jsonb) md5 % (expected c0682f5d0edf0d0e6bda0db0b916e155)', md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure)) <> '6195b2add5797e20e40c2d59b913b557' then raise exception 'POST: public.pos_move_table_core(uuid,uuid,integer) md5 % (expected 6195b2add5797e20e40c2d59b913b557)', md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure)); end if;
  for r in
    select * from (values
      ('public.pos_pay_order_core(jsonb)', '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.pos_pay_table_core(jsonb)', '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.pos_move_table_core(uuid,uuid,integer)', '{postgres=X/postgres,service_role=X/postgres}'),
      ('public.pos_move_table_v2(jsonb)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
      ('public.pos_merge_tables_v4(jsonb)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}')
    ) t(sig, acl)
  loop
    if to_regprocedure(r.sig) is null then raise exception 'POST: missing %', r.sig; end if;
    select p.proacl::text into v from pg_proc p where p.oid = to_regprocedure(r.sig);
    if v is distinct from r.acl then raise exception 'POST: ACL of % is % (expected %)', r.sig, v, r.acl; end if;
    if not (select prosecdef from pg_proc where oid = to_regprocedure(r.sig)) then raise exception 'POST: % lost SECURITY DEFINER', r.sig; end if;
    if (select proconfig from pg_proc where oid = to_regprocedure(r.sig)) is distinct from array['search_path=public'] then raise exception 'POST: % search_path changed', r.sig; end if;
    if (select pg_get_userbyid(proowner) from pg_proc where oid = to_regprocedure(r.sig)) <> 'postgres' then raise exception 'POST: % owner changed', r.sig; end if;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('pos_pay_order_core','pos_pay_table_core','pos_move_table_core','pos_move_table_v2','pos_merge_tables_v4')) <> 5 then
    raise exception 'POST: overload count is not exactly one each';
  end if;
  -- new functions: exact definitions (md5 of pg_get_functiondef, PG 17.6; identical on the staging rehearsal)
  if md5(pg_get_functiondef('public.pos_move_table_v2(jsonb)'::regprocedure)) <> '19c40c262fd55c7f68cfdf838d79422a'
     or md5(pg_get_functiondef('public.pos_merge_tables_v4(jsonb)'::regprocedure)) <> '4624ca679d038c5b649e857e6b4d32d7' then
    raise exception 'POST: new function definition differs from the reviewed text';
  end if;
  -- unchanged dependencies stay byte-identical
  if md5(pg_get_functiondef('public.pos_merge_tables_v3(jsonb)'::regprocedure)) <> '4eb57a93f43b8dfeb12a6537c26d7cf3'
     or md5(pg_get_functiondef('public.pos_pay_table(jsonb)'::regprocedure)) <> '56588d0ecbc91069b5184107de0003aa'
     or md5(pg_get_functiondef('public.pos_pay_order(jsonb)'::regprocedure)) <> '70a7ccc17e6df5200b9e00610bda4192'
     or md5(pg_get_functiondef('public.pos_move_table(uuid,uuid,uuid,integer)'::regprocedure)) <> 'c342a7fa766ca0ab89c9f8f496e575a4' then
    raise exception 'POST: an unchanged dependency changed';
  end if;
end
$post$;

notify pgrst, 'reload schema';
