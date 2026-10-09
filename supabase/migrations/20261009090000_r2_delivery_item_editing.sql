-- R2 — Delivery Order Item Editing (Desktop 1.0.35)
-- Staging-first. Broadens the canonical dine-in line-edit to DELIVERY (add/edit/delete),
-- preserving dine-in byte-identically. Konan arch sess_0f1ea210 -> sess_079d2551 (converged, all AUTO-FIX).
-- Reuses: pos_assert_operator, can_access_branch, can_user_permission('pos.edit_orders'), CAS pos_entity_version,
-- _pos_insert_order_items, finance_apply_order_totals, deferred kitchen trigger, inventory reversal trigger,
-- pos_op_replay/pos_op_record (+request_fingerprint), pos_menu price predicates.

-- ============================================================================
-- 1) pos_edit_order_line_core: gate broadened to dine_in+delivery; dine-in path BYTE-IDENTICAL;
--    delivery path uses the canonical finance composer and delivery_* audit labels.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.pos_edit_order_line_core(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order   public.pos_orders;
  v_order_id uuid := nullif(p_payload->>'order_id','')::uuid;
  v_target  uuid := nullif(p_payload->>'target_item_id','')::uuid;
  v_op      text := coalesce(nullif(p_payload->>'op',''),'');
  v_reason  text := nullif(btrim(coalesce(p_payload->>'reason','')), '');
  v_ex_ver  int  := nullif(p_payload->>'expected_version','')::int;
  v_super   boolean := public.is_super_admin();
  v_mem uuid; v_allowed boolean;
  v_line    public.pos_order_items;
  v_prev_qty numeric; v_new_qty numeric; v_delta numeric;
  v_batch int; v_sub numeric; v_disc numeric; v_total numeric; v_new_ver int;
  v_mods jsonb; v_items jsonb; v_repl uuid; v_action text; v_snap jsonb;
  v_tickets uuid[];
  v_removes_components boolean := false;
  v_prefix  text;  -- R2: 'dinein' | 'delivery'
begin
  if v_order_id is null or v_target is null then raise exception 'order_id and target_item_id are required'; end if;
  if v_op not in ('set_quantity','change_modifiers') then raise exception 'Unsupported edit operation'; end if;

  select * into v_order from public.pos_orders where id = v_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  perform public.pos_assert_operator(v_order.tenant_id);

  if v_super then v_allowed := true;
  else
    select id into v_mem from public.tenant_users
      where user_id = auth.uid() and tenant_id = v_order.tenant_id and status = 'active' limit 1;
    v_allowed := coalesce(public.can_user_permission(v_order.tenant_id, v_mem, 'pos.edit_orders'), false);
  end if;
  if not v_allowed then raise exception 'You do not have permission to edit orders' using errcode = '42501'; end if;

  -- R2: broadened to delivery (same open+unpaid state). Dine-in unchanged.
  if not (v_order.order_type in ('dine_in','delivery')
          and v_order.status = 'sent_to_kitchen'
          and v_order.payment_status = 'unpaid') then
    raise exception 'This order is not an open, unpaid dine-in or delivery order and cannot be edited' using errcode = '42501';
  end if;

  v_prefix := case when v_order.order_type = 'delivery' then 'delivery' else 'dinein' end;

  if v_ex_ver is null then raise exception 'expected_version is required'; end if;
  if v_order.pos_entity_version is distinct from v_ex_ver then
    perform public.pos_op_error('VERSION_CONFLICT', 'This order changed since it was loaded. Reload and retry.');
  end if;

  select * into v_line from public.pos_order_items
    where id = v_target and order_id = v_order_id and tenant_id = v_order.tenant_id for update;
  if v_line.id is null then raise exception 'Item not found on this order'; end if;
  v_prev_qty := v_line.quantity;

  v_mods := (select coalesce(jsonb_agg(jsonb_build_object(
                'group_id', modifier_group_id, 'option_id', modifier_option_id,
                'name', name_snapshot, 'price_delta', price_delta, 'quantity', quantity) order by created_at), '[]'::jsonb)
             from public.pos_order_item_modifiers where order_item_id = v_target);

  if v_op = 'set_quantity' then
    v_new_qty := (p_payload->>'new_quantity')::numeric;
    if v_new_qty is null or v_new_qty < 0 then raise exception 'new_quantity must be >= 0'; end if;
    if v_new_qty = v_prev_qty then raise exception 'Quantity is unchanged'; end if;
    v_action := case when v_new_qty = 0 then v_prefix||'_line_removed' else v_prefix||'_line_qty_changed' end;
  else
    v_new_qty := coalesce((p_payload->>'quantity')::numeric, v_prev_qty);
    if v_new_qty <= 0 then raise exception 'quantity must be > 0 for a modifier change'; end if;
    v_action := v_prefix||'_line_modifier_changed';
    v_mods := coalesce(p_payload->'modifiers','[]'::jsonb);
  end if;

  v_snap := jsonb_build_object(
    'order_item_id', v_line.id, 'order_id', v_order_id, 'menu_item_id', v_line.menu_item_id,
    'name_snapshot', v_line.name_snapshot, 'quantity', v_line.quantity, 'base_price', v_line.base_price,
    'modifiers_total', v_line.modifiers_total, 'final_unit_price', v_line.final_unit_price, 'line_total', v_line.line_total,
    'final_cost_snapshot', v_line.final_cost_snapshot, 'overhead_cost_snapshot', v_line.overhead_cost_snapshot,
    'total_final_cost_snapshot', v_line.total_final_cost_snapshot, 'batch_no', v_line.batch_no,
    'kitchen_note', v_line.kitchen_note, 'customization_json', v_line.customization_json,
    'modifiers', (select coalesce(jsonb_agg(jsonb_build_object(
        'group_id', modifier_group_id, 'option_id', modifier_option_id,
        'name', name_snapshot, 'price_delta', price_delta, 'quantity', quantity) order by created_at), '[]'::jsonb)
      from public.pos_order_item_modifiers where order_item_id = v_target));

  if v_op = 'change_modifiers' then
    select exists (
      select 1
      from jsonb_array_elements(coalesce(v_snap->'modifiers','[]'::jsonb)) o
      where not exists (
        select 1 from jsonb_array_elements(coalesce(p_payload->'modifiers','[]'::jsonb)) n
        where n->>'group_id'  is not distinct from o->>'group_id'
          and n->>'option_id' is not distinct from o->>'option_id'
          and coalesce(n->>'quantity','1') is not distinct from coalesce(o->>'quantity','1')
      )
    ) into v_removes_components;
  end if;

  if (v_op = 'set_quantity' and v_new_qty < v_prev_qty)
     or (v_op = 'change_modifiers' and v_removes_components) then
    if v_reason is null then
      perform public.pos_op_error('REASON_REQUIRED',
        'A reason is required to remove or reduce an item on this order.');
    end if;
  end if;

  select coalesce(max(batch_no),0) + 1 into v_batch from public.pos_order_items where order_id = v_order_id;

  if v_op = 'set_quantity' and v_new_qty > v_prev_qty then
    v_delta := v_new_qty - v_prev_qty;
    v_items := jsonb_build_array(jsonb_build_object(
      'menu_item_id', v_line.menu_item_id, 'name', v_line.name_snapshot, 'base_price', v_line.base_price,
      'quantity', v_delta, 'kitchen_note', v_line.kitchen_note, 'customization_json', v_line.customization_json,
      'modifiers', v_mods));
    perform public._pos_insert_order_items(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, v_batch, true, auth.uid());
    select id into v_repl from public.pos_order_items
      where order_id = v_order_id and batch_no = v_batch order by created_at desc limit 1;
  else
    v_tickets := (select array_agg(distinct kitchen_ticket_id) from public.kitchen_ticket_items where order_item_id = v_target);
    delete from public.kitchen_ticket_items where order_item_id = v_target;
    delete from public.pos_order_item_modifiers where order_item_id = v_target;
    delete from public.pos_order_items where id = v_target and order_id = v_order_id and tenant_id = v_order.tenant_id;
    if v_tickets is not null then
      perform public._kitchen_rollup_ticket(t) from unnest(v_tickets) as t;
    end if;
    if v_new_qty > 0 then
      v_items := jsonb_build_array(jsonb_build_object(
        'menu_item_id', v_line.menu_item_id, 'name', v_line.name_snapshot, 'base_price', v_line.base_price,
        'quantity', v_new_qty, 'kitchen_note', v_line.kitchen_note, 'customization_json', v_line.customization_json,
        'modifiers', v_mods));
      perform public._pos_insert_order_items(v_order.tenant_id, v_order.branch_id, v_order_id, v_items, v_batch, true, auth.uid());
      select id into v_repl from public.pos_order_items
        where order_id = v_order_id and batch_no = v_batch order by created_at desc limit 1;
    end if;
  end if;

  select coalesce(sum(line_total),0) into v_sub from public.pos_order_items where order_id = v_order_id;
  if v_order.discount_type = 'percent' and coalesce(v_order.discount_value,0) > 0 then
    v_disc := round(v_sub * least(v_order.discount_value,100)/100.0, 2);
  elsif v_order.discount_type = 'amount' and coalesce(v_order.discount_value,0) > 0 then
    v_disc := least(round(v_order.discount_value,2), round(v_sub,2));
  else v_disc := 0; end if;
  v_total := greatest(round(v_sub - v_disc,2), 0);

  update public.pos_orders
     set subtotal = round(v_sub,2), discount_amount = v_disc, total_amount = v_total,
         status = 'sent_to_kitchen', updated_by = auth.uid(),
         pos_entity_version = pos_entity_version + 1
   where id = v_order_id
   returning pos_entity_version into v_new_ver;

  -- R2 delivery: compose the authoritative total (delivery_fee/tax/charges) exactly as the create path does.
  -- Dine-in is intentionally NOT routed through the finance composer (strict 1.0.34 preservation).
  if v_order.order_type = 'delivery' then
    perform public.finance_apply_order_totals(v_order_id);
    select total_amount into v_total from public.pos_orders where id = v_order_id;
  end if;

  perform public.create_activity_log(v_order.tenant_id, 'pos', v_action, 'pos_orders', v_order_id,
    v_snap,
    jsonb_build_object('op', v_op, 'previous_quantity', v_prev_qty, 'new_quantity', v_new_qty,
      'replacement_order_item_id', v_repl, 'reason', v_reason,
      'client_op_id', nullif(p_payload->>'client_op_id',''), 'pos_entity_version', v_new_ver,
      'subtotal', round(v_sub,2), 'total_amount', v_total));

  return jsonb_build_object('ok', true, 'order_id', v_order_id, 'order_number', v_order.order_number,
    'target_item_id', v_target, 'replacement_order_item_id', v_repl,
    'previous_quantity', v_prev_qty, 'new_quantity', v_new_qty,
    'subtotal', round(v_sub,2), 'discount_amount', v_disc, 'total_amount', v_total,
    'action', v_action, 'pos_entity_version', v_new_ver);
end; $function$;

-- ============================================================================
-- 2) pos_add_order_items_core — pure mutation (DELIVERY add). Server-authoritative pricing via pos_menu
--    predicates; client supplies NO prices. Called only by the hardened wrapper.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.pos_add_order_items_core(
  p_order uuid, p_tenant uuid, p_branch uuid, p_items jsonb, p_super boolean, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order public.pos_orders;
  it jsonb; md jsonb;
  v_base numeric; v_grp uuid; v_delta numeric;
  v_resolved jsonb := '[]'::jsonb; v_mods jsonb;
  v_batch int; v_sub numeric; v_disc numeric; v_total numeric; v_new_ver int;
  v_added int := 0; v_qty numeric;
  v_mi uuid; v_name text; v_optname text; v_mqty int;
begin
  select * into v_order from public.pos_orders where id = p_order;  -- already locked by wrapper

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'No items to add';
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_mi := nullif(it->>'menu_item_id','')::uuid;
    v_qty := coalesce((it->>'quantity')::numeric, 0);
    if v_mi is null then raise exception 'menu_item_id required'; end if;
    if v_qty <= 0 then raise exception 'quantity must be > 0'; end if;

    -- Server-authoritative base price + NAME + availability (EXACT pos_menu item predicates).
    -- The name snapshot is resolved from the catalogue row, NEVER the client payload (anti-spoof).
    select coalesce(o.price_override, i.price), i.name
      into v_base, v_name
      from public.menu_item_branch_availability o
      join public.menu_items i on i.id = o.menu_item_id
     where o.menu_item_id = v_mi and o.branch_id = p_branch
       and i.tenant_id = p_tenant
       and o.status = 'published' and o.is_available
       and coalesce(o.archived_at, i.archived_at) is null;
    if v_base is null then
      raise exception 'Menu item % is not available in this operating unit', v_mi using errcode = '42501';
    end if;

    -- Server-authoritative modifier options (EXACT pos_menu option predicates + attachment to this item).
    v_mods := '[]'::jsonb;
    for md in select * from jsonb_array_elements(coalesce(it->'modifiers','[]'::jsonb)) loop
      -- Reject a non-positive / fractional modifier quantity BEFORE any financial use (::int rejects
      -- fractional strings; the guard rejects zero and negative).
      v_mqty := coalesce((md->>'quantity')::int, 1);
      if v_mqty <= 0 then
        raise exception 'Modifier quantity must be a positive integer' using errcode = '22023';
      end if;
      -- Resolve the option's price_delta, group AND name authoritatively from the catalogue row.
      select coalesce(moo.extra_price, mo.extra_price), mo.modifier_group_id, mo.name
        into v_delta, v_grp, v_optname
        from public.modifier_option_ou moo
        join public.modifier_options mo on mo.id = moo.modifier_option_id
       where moo.modifier_option_id = nullif(md->>'option_id','')::uuid
         and moo.branch_id = p_branch
         and moo.is_active and moo.archived_at is null and mo.archived_at is null;
      if v_grp is null then
        raise exception 'Modifier option % is not available in this operating unit', md->>'option_id' using errcode = '42501';
      end if;
      if not exists (select 1 from public.menu_item_modifier_ou mimo
                      where mimo.branch_id = p_branch and mimo.menu_item_id = v_mi
                        and mimo.modifier_group_id = v_grp) then
        raise exception 'Modifier option % does not belong to menu item %', md->>'option_id', v_mi using errcode = '42501';
      end if;
      -- name snapshot is the catalogue option name, NEVER the client payload (anti-spoof).
      v_mods := v_mods || jsonb_build_array(jsonb_build_object(
        'group_id', v_grp, 'option_id', nullif(md->>'option_id','')::uuid,
        'name', coalesce(v_optname,'Option'), 'price_delta', coalesce(v_delta,0),
        'quantity', v_mqty));
    end loop;

    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'menu_item_id', v_mi, 'name', v_name, 'base_price', coalesce(v_base,0),
      'quantity', v_qty, 'kitchen_note', nullif(it->>'kitchen_note',''),
      'customization_json', coalesce(it->'customization_json','{}'::jsonb),
      'modifiers', v_mods));
    v_added := v_added + 1;
  end loop;

  select coalesce(max(batch_no),0) + 1 into v_batch from public.pos_order_items where order_id = p_order;
  perform public._pos_insert_order_items(p_tenant, p_branch, p_order, v_resolved, v_batch, p_super, p_actor);

  select coalesce(sum(line_total),0) into v_sub from public.pos_order_items where order_id = p_order;
  if v_order.discount_type = 'percent' and coalesce(v_order.discount_value,0) > 0 then
    v_disc := round(v_sub * least(v_order.discount_value,100)/100.0, 2);
  elsif v_order.discount_type = 'amount' and coalesce(v_order.discount_value,0) > 0 then
    v_disc := least(round(v_order.discount_value,2), round(v_sub,2));
  else v_disc := 0; end if;
  v_total := greatest(round(v_sub - v_disc,2), 0);

  update public.pos_orders
     set subtotal = round(v_sub,2), discount_amount = v_disc, total_amount = v_total,
         status = 'sent_to_kitchen', updated_by = p_actor,
         pos_entity_version = pos_entity_version + 1
   where id = p_order
   returning pos_entity_version into v_new_ver;

  -- Delivery: authoritative total (delivery_fee/tax/charges), identical to the create contract.
  perform public.finance_apply_order_totals(p_order);
  select total_amount into v_total from public.pos_orders where id = p_order;

  perform public.create_activity_log(p_tenant, 'pos', 'delivery_items_added', 'pos_orders', p_order,
    null,
    jsonb_build_object('added_count', v_added, 'batch_no', v_batch, 'pos_entity_version', v_new_ver,
      'subtotal', round(v_sub,2), 'total_amount', v_total));

  return jsonb_build_object('ok', true, 'order_id', p_order, 'order_number', v_order.order_number,
    'added_count', v_added, 'batch_no', v_batch,
    'subtotal', round(v_sub,2), 'discount_amount', v_disc, 'total_amount', v_total,
    'action', 'delivery_items_added', 'pos_entity_version', v_new_ver);
end; $function$;

-- ============================================================================
-- 3) pos_add_order_items — hardened wrapper (DELIVERY only). Lock -> authz -> replay -> CAS -> mutate ->
--    record. Exactly-once; actor + fingerprint bound (B1 pattern).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.pos_add_order_items(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order   public.pos_orders;
  v_order_id uuid := nullif(p_payload->>'order_id','')::uuid;
  v_items   jsonb := coalesce(p_payload->'items','[]'::jsonb);
  v_op      uuid := nullif(p_payload->>'client_op_id','')::uuid;
  v_ex_ver  int  := nullif(p_payload->>'expected_version','')::int;
  v_super   boolean := public.is_super_admin();
  v_mem uuid; v_allowed boolean;
  v_cached jsonb; v_prev_actor uuid; v_prev_fp text; v_fp text;
  v_resp jsonb;
begin
  if v_order_id is null then raise exception 'order_id is required'; end if;
  if v_op is null then raise exception 'client_op_id is required'; end if;
  if jsonb_array_length(v_items) = 0 then raise exception 'items are required'; end if;

  -- 1) lock the order FIRST (serialization point) and derive tenant/branch from the LOCKED row.
  select * into v_order from public.pos_orders where id = v_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  -- 2) authorize against the locked order (never from payload).
  perform public.pos_assert_operator(v_order.tenant_id);
  if v_super then v_allowed := true;
  else
    select id into v_mem from public.tenant_users
      where user_id = auth.uid() and tenant_id = v_order.tenant_id and status = 'active' limit 1;
    v_allowed := coalesce(public.can_user_permission(v_order.tenant_id, v_mem, 'pos.edit_orders'), false);
  end if;
  if not v_allowed then raise exception 'You do not have permission to edit orders' using errcode = '42501'; end if;
  if not coalesce(public.can_access_branch(v_order.branch_id), false) then
    raise exception 'You do not have access to this operating unit' using errcode = '42501';
  end if;

  -- 3) eligibility: DELIVERY only, open + unpaid.
  if not (v_order.order_type = 'delivery'
          and v_order.status = 'sent_to_kitchen'
          and v_order.payment_status = 'unpaid') then
    raise exception 'This order is not an open, unpaid delivery order and cannot be edited' using errcode = '42501';
  end if;

  -- canonical fingerprint (payload-bound): binds EVERY mutation-affecting field the core consumes —
  -- order + expected_version + per item (menu_item_id, quantity, kitchen_note, customization_json) + per
  -- modifier (option_id, quantity). Client-supplied NAMES are deliberately excluded: _core ignores them and
  -- resolves names authoritatively, so they are not mutation inputs.
  v_fp := md5(coalesce(v_order_id::text,'')||'|'||coalesce(v_ex_ver::text,'')||'|'||
              coalesce((select string_agg(e, ',' order by e) from (
                 select (it->>'menu_item_id')||':'||(it->>'quantity')
                        ||':'||coalesce(it->>'kitchen_note','')
                        ||':'||coalesce((it->'customization_json')::text,'')
                        ||':'||coalesce((select string_agg((m->>'option_id')||'#'||coalesce(m->>'quantity','1'),
                                                '+' order by (m->>'option_id')||'#'||coalesce(m->>'quantity','1'))
                                  from jsonb_array_elements(coalesce(it->'modifiers','[]'::jsonb)) m),'') AS e
                 from jsonb_array_elements(v_items) it) s),''));

  -- 4) replay AFTER lock+authz, BEFORE CAS (a legitimate retry must not fail on the already-bumped version).
  v_cached := public.pos_op_replay(v_order.tenant_id, v_op, 'pos_add_order_items', v_order.branch_id);
  if v_cached is not null then
    select created_by, request_fingerprint into v_prev_actor, v_prev_fp
      from public.pos_op_submissions
     where tenant_id = v_order.tenant_id and client_op_id = v_op limit 1;
    if v_prev_actor is distinct from auth.uid() then
      raise exception 'This operation id belongs to another operator' using errcode = '42501',
        detail = json_build_object('pos_error_code','CROSS_ACTOR_REPLAY_REJECTED')::text;
    end if;
    if v_prev_fp is distinct from v_fp then
      perform public.pos_op_error('IDEMPOTENCY_PAYLOAD_MISMATCH',
        'This operation id was already used with a different request.');
    end if;
    return v_cached;  -- exactly-once: no mutation, no version bump, no duplicate audit/kitchen.
  end if;

  -- 5) CAS (after replay).
  if v_ex_ver is null then raise exception 'expected_version is required'; end if;
  if v_order.pos_entity_version is distinct from v_ex_ver then
    perform public.pos_op_error('VERSION_CONFLICT', 'This order changed since it was loaded. Reload and retry.');
  end if;

  -- 6) mutate (server-authoritative pricing inside _core).
  v_resp := public.pos_add_order_items_core(v_order_id, v_order.tenant_id, v_order.branch_id, v_items, v_super, auth.uid());

  -- 7) record idempotency claim + bind the payload fingerprint (pos_op_record has no fp param).
  perform public.pos_op_record(v_order.tenant_id, v_order.branch_id, v_op, 'pos_add_order_items', v_order_id, v_resp);
  update public.pos_op_submissions set request_fingerprint = v_fp
    where tenant_id = v_order.tenant_id and client_op_id = v_op;

  return v_resp;
end; $function$;

-- ============================================================================
-- 4) Grants — _core is not an authenticated entry point; wrapper is the sole one.
-- ============================================================================
-- Supabase default privileges also grant anon/authenticated EXECUTE on NEW public functions;
-- REVOKE FROM PUBLIC does not remove those explicit grants, so revoke them by name too.
REVOKE EXECUTE ON FUNCTION public.pos_add_order_items_core(uuid,uuid,uuid,jsonb,boolean,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pos_add_order_items_core(uuid,uuid,uuid,jsonb,boolean,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.pos_add_order_items_core(uuid,uuid,uuid,jsonb,boolean,uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_add_order_items(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pos_add_order_items(jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pos_add_order_items(jsonb) TO authenticated;
