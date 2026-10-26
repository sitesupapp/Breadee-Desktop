-- ============================================================================
-- ROLLBACK of desktop_1038_offline_contracts (PRODUCTION cltlqfqormkhppmbvyrv).
-- Restores the exact pre-1.0.38 bodies of pos_pay_order_core, pos_pay_table_core and
-- pos_move_table_core (inverse anchored replace on the LIVE bodies; the rebuilt text must hash to
-- the captured pre-image before it is executed) and drops pos_move_table_v2 / pos_merge_tables_v4.
-- GENERATED from the same delta definition as the forward migration.
--
-- !!! PRE-PUBLICATION / NO-ADOPTION USE ONLY !!!
-- This rollback RE-OPENS the F1 double charge (pay after a split re-charges the split portion),
-- removes the prod OU guard on pos_move_table_core, removes the S5 bill/amount pins (a 1.0.38
-- terminal sending expected_order_ids to the restored body is silently ignored, so a retried
-- offline settle could pay a newer bill), and makes every 1.0.38 move/merge replay fail with
-- "function not found". Therefore:
--   * before 1.0.38 is published to desktop-production-channel (and nothing used the contracts):
--     this script may be used;
--   * after publication: PROHIBITED. Recovery is FIX-FORWARD ONLY (targeted reviewed migration).
-- Enforced below: refuses unless the operator sets, in the same transaction,
--   set local breadee.rollback_1038_ack = 'PRE_PUBLICATION_NO_ADOPTION';
-- and refuses on any adoption evidence (v2/v4 submissions, S4 results, or a non-split payment on a
-- split-settled order since installed_at).
-- ============================================================================

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $ack$
declare v_installed timestamptz;
begin
  if coalesce(current_setting('breadee.rollback_1038_ack', true), '') <> 'PRE_PUBLICATION_NO_ADOPTION' then
    raise exception 'ROLLBACK REFUSED: pre-publication only. After 1.0.38 publication recovery is fix-forward. Set breadee.rollback_1038_ack = PRE_PUBLICATION_NO_ADOPTION only if 1.0.38 was never published.';
  end if;
  if to_regprocedure('public.pos_move_table_v2(jsonb)') is null or to_regprocedure('public.pos_merge_tables_v4(jsonb)') is null then
    raise exception 'ROLLBACK REFUSED: 1.0.38 contracts are not (fully) installed';
  end if;
  v_installed := substring(obj_description('public.pos_move_table_v2(jsonb)'::regprocedure, 'pg_proc') from 'installed_at=([0-9TZ:-]+)')::timestamptz;
  if v_installed is null then raise exception 'ROLLBACK REFUSED: install marker missing'; end if;
  if exists (select 1 from public.pos_op_submissions where op_type = 'pos_move_table_v2')
     or exists (select 1 from public.pos_op_submissions where op_type = 'pos_merge_tables_v3' and result_json ? 'v4_fingerprint')
     or exists (select 1 from public.pos_op_submissions where op_type in ('pos_pay_table','pos_pay_order') and result_json ? 'prior_paid') then
    raise exception 'ROLLBACK REFUSED: 1.0.38 adoption evidence (pos_op_submissions). Fix-forward only.';
  end if;
  if exists (select 1 from public.pos_payments p
             where p.created_at >= v_installed
               and exists (select 1 from public.pos_split_settlements s where s.parent_order_id = p.order_id and s.status = 'paid')
               and not exists (select 1 from public.pos_split_settlements s where s.payment_id = p.id)) then
    raise exception 'ROLLBACK REFUSED: a part-paid bill was settled under the 1.0.38 remaining-obligation rule. Fix-forward only.';
  end if;
  if md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)) <> '95f3b2a43abb9b5eb60b0965c2735ba8' then raise exception 'ROLLBACK REFUSED: public.pos_pay_order_core(jsonb) is not the 1.0.38 post-image (md5 %); fix-forward only', md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)) <> 'c0682f5d0edf0d0e6bda0db0b916e155' then raise exception 'ROLLBACK REFUSED: public.pos_pay_table_core(jsonb) is not the 1.0.38 post-image (md5 %); fix-forward only', md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure)) <> '6195b2add5797e20e40c2d59b913b557' then raise exception 'ROLLBACK REFUSED: public.pos_move_table_core(uuid,uuid,integer) is not the 1.0.38 post-image (md5 %); fix-forward only', md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure)); end if;
end
$ack$;

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
  if md5(d) <> 'e21bac394d8f06b9c63fda903d5651e5' then raise exception 'RB BUILD: % restored md5 % (expected e21bac394d8f06b9c63fda903d5651e5)', 'public.pos_pay_order_core(jsonb)', md5(d); end if;
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
  if md5(d) <> '7b6ea08ffcbeca5f56d78d33c7cd1198' then raise exception 'RB BUILD: % restored md5 % (expected 7b6ea08ffcbeca5f56d78d33c7cd1198)', 'public.pos_pay_table_core(jsonb)', md5(d); end if;
  execute d;

  -- public.pos_move_table_core(uuid,uuid,integer): inverse deltas, reverse order
  d := pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure);
  d := pg_temp._r1038_once(d,
    E'  v_tenant := v_from.tenant_id;\n'
    || E'  if v_from.branch_id is distinct from v_to.branch_id then\n'
    || E'    raise exception ''Tables belong to different operating units'' using errcode = ''42501'';\n'
    || E'  end if;\n'
    || E'  if not (public.is_super_admin() or public.can_access_branch(v_from.branch_id)) then\n'
    || E'    raise exception ''Not authorized for this operating unit'' using errcode = ''42501'';\n'
    || E'  end if;\n',
    E'  v_tenant := v_from.tenant_id;\n',
    'rb.move_core.ou');
  if md5(d) <> 'ecb0e6f3f47d37dc2837ac44985e2e56' then raise exception 'RB BUILD: % restored md5 % (expected ecb0e6f3f47d37dc2837ac44985e2e56)', 'public.pos_move_table_core(uuid,uuid,integer)', md5(d); end if;
  execute d;
  drop function public.pos_move_table_v2(jsonb);
  drop function public.pos_merge_tables_v4(jsonb);
end
$rb$;

-- POST: every restored body is byte-identical to the captured production pre-image; ACLs unchanged.
do $post$
begin
  if md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)) <> 'e21bac394d8f06b9c63fda903d5651e5' then raise exception 'RB POST: public.pos_pay_order_core(jsonb) md5 %', md5(pg_get_functiondef('public.pos_pay_order_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)) <> '7b6ea08ffcbeca5f56d78d33c7cd1198' then raise exception 'RB POST: public.pos_pay_table_core(jsonb) md5 %', md5(pg_get_functiondef('public.pos_pay_table_core(jsonb)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure)) <> 'ecb0e6f3f47d37dc2837ac44985e2e56' then raise exception 'RB POST: public.pos_move_table_core(uuid,uuid,integer) md5 %', md5(pg_get_functiondef('public.pos_move_table_core(uuid,uuid,integer)'::regprocedure)); end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_pay_order_core(jsonb)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'RB POST: ACL of public.pos_pay_order_core(jsonb) changed'; end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_pay_table_core(jsonb)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'RB POST: ACL of public.pos_pay_table_core(jsonb) changed'; end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_move_table_core(uuid,uuid,integer)'::regprocedure) is distinct from '{postgres=X/postgres,service_role=X/postgres}' then raise exception 'RB POST: ACL of public.pos_move_table_core(uuid,uuid,integer) changed'; end if;
  if to_regprocedure('public.pos_move_table_v2(jsonb)') is not null or to_regprocedure('public.pos_merge_tables_v4(jsonb)') is not null then
    raise exception 'RB POST: new functions still present';
  end if;
end
$post$;

notify pgrst, 'reload schema';
