-- Final Foundation (CONC, Track 13) — Tier 2: deterministic server interleavings on STAGING, in ONE transaction
-- that ALWAYS rolls back (the DO block ends in RAISE EXCEPTION; every sub-scenario also ends in its own RAISE,
-- caught, so its writes roll back before the next one starts). Nothing persists (only sequence counters advance).
--
-- Two real actors of the #2101 QA fixture (Classic Pizza Joint, branch a5469a61), each with its own open shift,
-- play terminal A and terminal B: `set local role authenticated` + request.jwt.claims per step. Terminal A does its
-- step, terminal B its step, then A replays — the commit order a real two-session race can produce, because every
-- contended path below serialises on a row lock / advisory lock (see the lock-order notes in the report): the only
-- outcome a true overlap can add is "B waits for A's commit, then re-reads" (READ COMMITTED EvalPlanQual), which is
-- exactly the A-then-B order modelled here. The printed JSON is the assertion record.
--
-- Usage: paste into the Supabase SQL editor / MCP execute_sql for project azjxprewycygsocusxjn (STAGING ONLY).
do $$
declare
  A uuid := '2ddf135f-1a69-42c9-af5f-5f47777692a7'; SA uuid := 'a978d42d-cc00-439d-b0e4-a8e71c12878d';
  B uuid := '7d7ceb53-5df8-44b5-ad1b-6b1c6dae5715'; SB uuid := 'd4a450a0-2bc2-4203-8153-65f43bdafe38';
  BR uuid := 'a5469a61-2504-40e5-bc45-187b1bd4a2fa';
  T1 uuid := '5ee3a45d-f87c-4a92-a45d-0d227299b38b'; T2 uuid := '9e039ce3-27e1-4586-a2dc-d55dee39ecc5'; T3 uuid := '7dbe7377-c370-442d-8a15-d4f474b6f9c1';
  W uuid := '36b54681-52d0-46d7-8cd3-78c7e2ac7a71';  -- Water 500ml, 45 000 LBP, no modifiers
  r jsonb; o1 uuid; o2 uuid; it uuid; op uuid; out jsonb := '{}'; s jsonb; d text; m text;
begin
  set local role authenticated;

  -- ---------------------------------------------------------------- G1a: B's round lands before A's pinned pay
  s := '{}';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SA,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',2,'modifiers','[]'::jsonb))));
    o1 := (r->>'order_id')::uuid;                          -- A presented T = 90 000 for [o1]
    perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SB,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',1,'modifiers','[]'::jsonb))));
    s := s || jsonb_build_object('b_round_appended', r->'appended');
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    begin
      r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),
            'expected_order_ids', jsonb_build_array(o1), 'expected_amount', 90000));
      s := s || jsonb_build_object('a_pay_full_pins', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('a_pay_full_pins', d);
    end;
    s := s || jsonb_build_object('payments_after_refusal', (select count(*) from public.pos_payments where order_id=o1));
    -- the same request WITHOUT the amount pin (ids only) — and the legacy ONLINE request (no pins at all)
    begin
      r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),'expected_order_ids', jsonb_build_array(o1)));
      s := s || jsonb_build_object('a_pay_ids_only', jsonb_build_object('charged', r->'amount'));
      raise exception 'rollback-sub';
    exception when others then if sqlerrm <> 'rollback-sub' then s := s || jsonb_build_object('a_pay_ids_only', sqlerrm); end if;
    end;
    begin
      r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP'));
      s := s || jsonb_build_object('a_pay_legacy_unpinned', jsonb_build_object('charged', r->'amount', 'presented', 90000));
      raise exception 'rollback-sub';
    exception when others then if sqlerrm <> 'rollback-sub' then s := s || jsonb_build_object('a_pay_legacy_unpinned', sqlerrm); end if;
    end;
    raise exception 'rollback-sub';
  exception when others then if sqlerrm <> 'rollback-sub' then s := s || jsonb_build_object('error', sqlerrm); end if;
  end;
  out := out || jsonb_build_object('G1a_round_then_pay', s);

  -- ---------------------------------------------------------------- G1b (G-T1): A pays, then B's round creates a NEW bill
  s := '{}';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SA,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',2,'modifiers','[]'::jsonb))));
    o1 := (r->>'order_id')::uuid; op := gen_random_uuid();
    r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',op,'expected_order_ids', jsonb_build_array(o1),'expected_amount',90000));
    s := s || jsonb_build_object('a_pay', r->'amount');
    perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
    begin  -- B's OFFLINE round 2 (pinned to the bill it saw) → refused
      r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SB,'client_op_id',gen_random_uuid(),'expected_order_id',o1,
            'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',1,'modifiers','[]'::jsonb))));
      s := s || jsonb_build_object('b_pinned_round', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('b_pinned_round', d);
    end;
    -- B's unpinned (online / round-1) round → a NEW bill o2 on the now-free table
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SB,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',1,'modifiers','[]'::jsonb))));
    o2 := (r->>'order_id')::uuid;
    s := s || jsonb_build_object('b_new_bill', jsonb_build_object('new_order', o2 <> o1, 'appended', r->'appended'));
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',op,'expected_order_ids', jsonb_build_array(o1),'expected_amount',90000));
    s := s || jsonb_build_object('a_same_op_replay', r->'result_code');
    begin  -- a SECOND (stale) settle of A's old bill, pinned → refused, the new bill o2 is untouched
      r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),'expected_order_ids', jsonb_build_array(o1),'expected_amount',90000));
      s := s || jsonb_build_object('a_stale_pinned_settle', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('a_stale_pinned_settle', d);
    end;
    perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
    r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',op,'expected_order_ids', jsonb_build_array(o1),'expected_amount',90000));
    s := s || jsonb_build_object('b_replays_a_op', r->'result_code');
    reset role;
    s := s || jsonb_build_object('db', jsonb_build_object(
      'o1', (select jsonb_build_array(status, payment_status) from public.pos_orders where id=o1),
      'o2', (select jsonb_build_array(status, payment_status) from public.pos_orders where id=o2),
      'payments_o1', (select jsonb_agg(original_amount) from public.pos_payments where order_id=o1),
      'payments_o2', (select count(*) from public.pos_payments where order_id=o2),
      'table_status', (select status from public.pos_tables where id=T1)));
    set local role authenticated;
    raise exception 'rollback-sub';
  exception when others then if sqlerrm <> 'rollback-sub' then s := s || jsonb_build_object('error', sqlerrm); end if;
  end;
  out := out || jsonb_build_object('G1b_pay_then_new_bill', s);

  -- ---------------------------------------------------------------- SP: split leg on A vs full pay on B
  s := '{}';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SA,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',2,'modifiers','[]'::jsonb))));
    o1 := (r->>'order_id')::uuid;
    reset role; select id into it from public.pos_order_items where order_id=o1 limit 1; set local role authenticated;
    r := public.pos_split_settle(jsonb_build_object('order_id',o1,'method','card','currency_code','LBP','client_op_id',gen_random_uuid(),
          'allocations', jsonb_build_array(jsonb_build_object('order_item_id',it,'quantity',1))));
    s := s || jsonb_build_object('a_split', jsonb_build_object('ok', r->'ok', 'amount', r->'amount'));
    perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
    begin  -- B captured T = 90 000 before A's leg
      r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),'expected_order_ids', jsonb_build_array(o1),'expected_amount',90000));
      s := s || jsonb_build_object('b_pay_stale_T', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('b_pay_stale_T', d);
    end;
    r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),'expected_order_ids', jsonb_build_array(o1),'expected_amount',45000));
    s := s || jsonb_build_object('b_pay_R', r->'amount');
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    begin  -- A's second leg after B closed the bill
      r := public.pos_split_settle(jsonb_build_object('order_id',o1,'method','card','currency_code','LBP','client_op_id',gen_random_uuid(),
            'allocations', jsonb_build_array(jsonb_build_object('order_item_id',it,'quantity',1))));
      s := s || jsonb_build_object('a_split_after_close', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('a_split_after_close', d);
    end;
    reset role;
    s := s || jsonb_build_object('db', jsonb_build_object('payments', (select jsonb_agg(jsonb_build_array(method, original_amount) order by created_at) from public.pos_payments where order_id=o1),
      'collected_eq_T', (select sum(original_amount) from public.pos_payments where order_id=o1) = 90000));
    set local role authenticated;
    raise exception 'rollback-sub';
  exception when others then if sqlerrm <> 'rollback-sub' then s := s || jsonb_build_object('error', sqlerrm); end if;
  end;
  out := out || jsonb_build_object('SP_split_vs_pay', s);

  -- ---------------------------------------------------------------- MG: merge T2→T1 on A vs pay T2 on B
  s := '{}';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SA,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',2,'modifiers','[]'::jsonb))));
    o1 := (r->>'order_id')::uuid;
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T2,'shift_id',SA,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',1,'modifiers','[]'::jsonb))));
    o2 := (r->>'order_id')::uuid;
    op := gen_random_uuid();
    r := public.pos_merge_tables_v4(jsonb_build_object('client_op_id',op,'primary_table_id',T1,'source_table_ids',jsonb_build_array(T2),
          'expected_orders', jsonb_build_object(T1::text,o1,T2::text,o2)));
    s := s || jsonb_build_object('a_merge', r->'ok');
    perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
    begin  -- B's stale settle of T2 (pinned [o2], 45 000)
      r := public.pos_pay_table(jsonb_build_object('table_id',T2,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),'expected_order_ids', jsonb_build_array(o2),'expected_amount',45000));
      s := s || jsonb_build_object('b_pay_merged_source', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; m := sqlerrm; s := s || jsonb_build_object('b_pay_merged_source', coalesce(nullif(d,''), m));
    end;
    begin  -- B's stale settle of T1 captured BEFORE the merge (pinned [o1], 90 000)
      r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),'expected_order_ids', jsonb_build_array(o1),'expected_amount',90000));
      s := s || jsonb_build_object('b_pay_primary_stale', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('b_pay_primary_stale', d);
    end;
    begin  -- B replays A's merge op id (cloned device) → cross-actor refusal
      r := public.pos_merge_tables_v4(jsonb_build_object('client_op_id',op,'primary_table_id',T1,'source_table_ids',jsonb_build_array(T2),
            'expected_orders', jsonb_build_object(T1::text,o1,T2::text,o2)));
      s := s || jsonb_build_object('b_replays_merge_op', r->'idempotent');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('b_replays_merge_op', d);
    end;
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    r := public.pos_pay_table(jsonb_build_object('table_id',T1,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),'expected_order_ids', jsonb_build_array(o1),'expected_amount',135000));
    s := s || jsonb_build_object('a_pay_merged', r->'amount');
    reset role;
    s := s || jsonb_build_object('db', jsonb_build_object('o2', (select jsonb_build_array(status, payment_status) from public.pos_orders where id=o2),
      'payments', (select jsonb_agg(jsonb_build_array(order_id=o1, original_amount)) from public.pos_payments where order_id in (o1,o2))));
    set local role authenticated;
    raise exception 'rollback-sub';
  exception when others then if sqlerrm <> 'rollback-sub' then s := s || jsonb_build_object('error', sqlerrm); end if;
  end;
  out := out || jsonb_build_object('MG_merge_vs_pay', s);

  -- ---------------------------------------------------------------- PM: B pays T2 FIRST, then A's offline merge replays
  s := '{}';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SA,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',2,'modifiers','[]'::jsonb))));
    o1 := (r->>'order_id')::uuid;
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T2,'shift_id',SA,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',1,'modifiers','[]'::jsonb))));
    o2 := (r->>'order_id')::uuid;
    perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
    r := public.pos_pay_table(jsonb_build_object('table_id',T2,'method','cash','currency_code','LBP','client_op_id',gen_random_uuid(),'expected_order_ids', jsonb_build_array(o2),'expected_amount',45000));
    s := s || jsonb_build_object('b_pay_T2', r->'amount');
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    begin
      r := public.pos_merge_tables_v4(jsonb_build_object('client_op_id',gen_random_uuid(),'primary_table_id',T1,'source_table_ids',jsonb_build_array(T2),
            'expected_orders', jsonb_build_object(T1::text,o1,T2::text,o2)));
      s := s || jsonb_build_object('a_merge_after_pay', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('a_merge_after_pay', d);
    end;
    reset role;
    s := s || jsonb_build_object('db', jsonb_build_object('o1_items', (select sum(quantity) from public.pos_order_items where order_id=o1),
      'o2', (select jsonb_build_array(status, payment_status) from public.pos_orders where id=o2)));
    set local role authenticated;
    raise exception 'rollback-sub';
  exception when others then if sqlerrm <> 'rollback-sub' then s := s || jsonb_build_object('error', sqlerrm); end if;
  end;
  out := out || jsonb_build_object('PM_pay_then_merge', s);

  -- ---------------------------------------------------------------- MV: move T1→T3 on A vs round on T1 on B
  s := '{}';
  begin
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SA,'client_op_id',gen_random_uuid(),
          'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',2,'modifiers','[]'::jsonb))));
    o1 := (r->>'order_id')::uuid; op := gen_random_uuid();
    r := public.pos_move_table_v2(jsonb_build_object('client_op_id',op,'from_table_id',T1,'to_table_id',T3,'expected_order_ids',jsonb_build_array(o1)));
    s := s || jsonb_build_object('a_move', r->'orders_moved');
    perform set_config('request.jwt.claims', json_build_object('sub',B,'role','authenticated')::text, true);
    begin  -- B's offline round 2 for the bill it saw on T1
      r := public.pos_submit_order(jsonb_build_object('branch_id',BR,'order_type','dine_in','table_id',T1,'shift_id',SB,'client_op_id',gen_random_uuid(),'expected_order_id',o1,
            'items', jsonb_build_array(jsonb_build_object('menu_item_id',W,'name','Water 500ml','base_price',45000,'quantity',1,'modifiers','[]'::jsonb))));
      s := s || jsonb_build_object('b_pinned_round_on_source', 'ACCEPTED');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('b_pinned_round_on_source', d);
    end;
    begin  -- B replays A's move op id (cloned device / restored backup)
      r := public.pos_move_table_v2(jsonb_build_object('client_op_id',op,'from_table_id',T1,'to_table_id',T3,'expected_order_ids',jsonb_build_array(o1)));
      s := s || jsonb_build_object('b_replays_move_op', r->'idempotent');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('b_replays_move_op', d);
    end;
    perform set_config('request.jwt.claims', json_build_object('sub',A,'role','authenticated')::text, true);
    begin  -- A's same op with a DIFFERENT request body (fingerprint)
      r := public.pos_move_table_v2(jsonb_build_object('client_op_id',op,'from_table_id',T1,'to_table_id',T2,'expected_order_ids',jsonb_build_array(o1)));
      s := s || jsonb_build_object('a_same_op_other_body', r->'idempotent');
    exception when others then get stacked diagnostics d = pg_exception_detail; s := s || jsonb_build_object('a_same_op_other_body', d);
    end;
    r := public.pos_move_table_v2(jsonb_build_object('client_op_id',op,'from_table_id',T1,'to_table_id',T3,'expected_order_ids',jsonb_build_array(o1)));
    s := s || jsonb_build_object('a_same_op_replay', r->'idempotent');
    reset role;
    s := s || jsonb_build_object('db', jsonb_build_object('o1_table_is_T3', (select table_id = T3 from public.pos_orders where id=o1),
      'o1_qty', (select sum(quantity) from public.pos_order_items where order_id=o1),
      'open_on_T1', (select count(*) from public.pos_orders where table_id=T1 and status in ('draft','sent_to_kitchen'))));
    set local role authenticated;
    raise exception 'rollback-sub';
  exception when others then if sqlerrm <> 'rollback-sub' then s := s || jsonb_build_object('error', sqlerrm); end if;
  end;
  out := out || jsonb_build_object('MV_move_vs_round', s);

  reset role;
  out := out || jsonb_build_object('residue_orders_last_minute', (select count(*) from public.pos_orders where table_id in (T1,T2,T3) and created_at > now() - interval '1 minute'));
  raise exception 'TIER2 RESULT %', out;
end $$;
