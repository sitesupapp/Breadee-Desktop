-- R3-A — Merge Tables v2 (Desktop 1.0.35). Deterministic, concurrency-safe, idempotent, provenance-writing.
-- Fixes the three live merge defects: (1) false same-shift error, (2) silent LIMIT 1 bill selection,
-- (3) merged-source-shown-as-voided (provenance columns from 20261009140000 set here).
-- Konan arch 3-cycle converged (sess_0c388b0a/029c7e1d/014608c0); AUTO-FIX residuals resolved in impl:
--   * authz (operator + branch + pos.tables.merge) runs BEFORE pos_op_replay (server-derived tenant/branch).
--   * provenance integrity/immutability DB-enforced by 20261009140000 (guard + append-only + REVOKEs).
-- Concurrency: deterministic lock order tables(by id) -> participating orders(by id) -> shift FOR UPDATE NOWAIT
--   (MERGE_SHIFT_BUSY on contention; never blocks on the shift while holding order locks => no inversion deadlock).
-- Idempotency: pos_op_replay atomic advisory claim + pos_op_record + request_fingerprint bind
--   (CROSS_ACTOR_REPLAY_REJECTED / IDEMPOTENCY_PAYLOAD_MISMATCH), identical to the certified R2 add-items pattern.
-- Financial recompute (subtotal = sum(line_total); status/void/note/merge-row/activity-log) is BYTE-COMPATIBLE
--   with legacy pos_merge_tables_core; the only additions are the ambiguity/shift/currency gates + provenance.
-- Legacy pos_merge_tables(_core) + _pos_merge_assert_eligible remain UNCHANGED. Staging azjxprewycygsocusxjn only; NO prod.
-- Runtime-verified on staging 2026-10-09: happy-path; MERGE_AMBIGUOUS_BILL / CROSS_SHIFT / CROSS_CURRENCY /
--   SHIFT_CLOSED; idempotent replay (exactly-once) + PAYLOAD_MISMATCH + CROSS_ACTOR; provenance set + guard
--   (append-only INSERT/UPDATE/DELETE, immutable-once-set, non-canonical forgery blocked); legacy untouched.

CREATE OR REPLACE FUNCTION public.pos_merge_tables_v2(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_primary_table uuid := nullif(p_payload->>'primary_table_id','')::uuid;
  v_op uuid := nullif(p_payload->>'client_op_id','')::uuid;
  v_expected jsonb := coalesce(p_payload->'expected', '{}'::jsonb);
  v_sources uuid[];
  v_all uuid[];
  v_tenant uuid; v_branch uuid; v_shift uuid; v_shift_row public.pos_shifts;
  v_tbl public.pos_tables;
  v_super boolean := public.is_super_admin();
  v_cached jsonb; v_prev_actor uuid; v_prev_fp text; v_fp text;
  v_order_ids uuid[]; v_ids_arr uuid[]; v_cnt int; v_ord public.pos_orders;
  v_primary_order uuid; v_primary_num text; v_primary_ver int; v_primary_sub numeric; v_primary_cur text;
  v_tid uuid;
  v_src uuid; v_src_order uuid; v_src_num text; v_src_ver int; v_src_items jsonb;
  v_next_batch int; v_sources_prov jsonb := '[]'::jsonb;
  v_new_sub numeric; v_new_ver int; v_merge_id uuid;
begin
  if v_primary_table is null then raise exception 'A primary table is required'; end if;
  if v_op is null then perform public.pos_op_error('MERGE_NO_OP','A client_op_id is required.'); end if;
  v_sources := array(select distinct (e)::uuid from jsonb_array_elements_text(coalesce(p_payload->'source_table_ids','[]'::jsonb)) e);
  if v_sources is null or array_length(v_sources,1) is null then
    perform public.pos_op_error('MERGE_NO_SOURCES','Select at least one other table to merge in.');
  end if;
  if v_primary_table = any(v_sources) then raise exception 'The primary table cannot also be a source table'; end if;
  v_all := array(select unnest(array_prepend(v_primary_table, v_sources)) order by 1);

  -- Server-derive tenant/branch from the primary table, THEN authorize (before any replay lookup / advisory lock).
  select * into v_tbl from public.pos_tables where id = v_primary_table;
  if v_tbl.id is null then raise exception 'Primary table not found'; end if;
  v_tenant := v_tbl.tenant_id; v_branch := v_tbl.branch_id;
  perform public.pos_assert_operator(v_tenant);
  if not (v_super or public.can_access_branch(v_branch)) then
    raise exception 'Not authorized for this operating unit' using errcode = '42501';
  end if;
  perform public._pos_require(v_tenant, 'pos.tables.merge');

  v_fp := md5(coalesce(v_primary_table::text,'')||'|'||
              coalesce((select string_agg(s::text, ',' order by s) from unnest(v_sources) s),'')||'|'||
              coalesce((select string_agg(k||'='||(v_expected->>k), ',' order by k) from jsonb_object_keys(v_expected) k),''));

  v_cached := public.pos_op_replay(v_tenant, v_op, 'pos_merge_tables_v2', v_branch);
  if v_cached is not null then
    select created_by, request_fingerprint into v_prev_actor, v_prev_fp
      from public.pos_op_submissions where tenant_id = v_tenant and client_op_id = v_op limit 1;
    if v_prev_actor is distinct from auth.uid() then
      raise exception 'This operation id belongs to another operator' using errcode = '42501',
        detail = json_build_object('pos_error_code','CROSS_ACTOR_REPLAY_REJECTED')::text;
    end if;
    if v_prev_fp is distinct from v_fp then
      perform public.pos_op_error('IDEMPOTENCY_PAYLOAD_MISMATCH','This operation id was already used with a different merge request.');
    end if;
    return v_cached;
  end if;

  -- Lock tables by id (deterministic) + optional stale-floor CAS on pos_entity_version.
  perform 1 from public.pos_tables where id = any(v_all) order by id for update;
  if v_expected <> '{}'::jsonb then
    if (select count(*) from jsonb_object_keys(v_expected)) <> array_length(v_all,1)
       or exists (select 1 from jsonb_object_keys(v_expected) k where not (k::uuid = any(v_all))) then
      perform public.pos_op_error('MERGE_EXPECTED_MISMATCH','Stale floor: reload and retry the merge.');
    end if;
  end if;
  for v_tbl in select * from public.pos_tables where id = any(v_all) order by id loop
    if v_tbl.tenant_id <> v_tenant then raise exception 'Tables belong to different tenants'; end if;
    if v_tbl.branch_id is distinct from v_branch then
      raise exception 'All tables must be in the same operating unit' using errcode = '42501';
    end if;
    if v_expected ? v_tbl.id::text and v_tbl.pos_entity_version is distinct from (v_expected ->> v_tbl.id::text)::int then
      perform public.pos_op_error('VERSION_CONFLICT','A table changed since the merge was opened. Reload the floor and retry.');
    end if;
  end loop;

  -- Deterministic single-bill invariant per participating table (NO silent LIMIT 1): exactly one open unpaid
  -- dine-in bill each, else MERGE_PRIMARY_EMPTY / MERGE_SOURCE_EMPTY / MERGE_AMBIGUOUS_BILL.
  v_order_ids := '{}';
  foreach v_tid in array v_all loop
    select array_agg(o.id order by o.created_at, o.id) into v_ids_arr from public.pos_orders o
      where o.tenant_id = v_tenant and o.table_id = v_tid
        and o.order_type = 'dine_in' and o.status in ('draft','sent_to_kitchen') and o.payment_status = 'unpaid';
    v_cnt := coalesce(array_length(v_ids_arr,1),0);
    if v_cnt = 0 then
      if v_tid = v_primary_table then perform public.pos_op_error('MERGE_PRIMARY_EMPTY','The primary table has no open bill.');
      else perform public.pos_op_error('MERGE_SOURCE_EMPTY','A selected table has no open bill to merge.'); end if;
    end if;
    if v_cnt > 1 then
      perform public.pos_op_error('MERGE_AMBIGUOUS_BILL','A table has more than one open bill; resolve it before merging.');
    end if;
    v_order_ids := v_order_ids || v_ids_arr[1];
  end loop;

  -- Lock ALL participating orders by id BEFORE the shift (deadlock-safe ordering).
  perform 1 from public.pos_orders where id = any(v_order_ids) order by id for update;

  select o.* into v_ord from public.pos_orders o
    where o.tenant_id = v_tenant and o.table_id = v_primary_table
      and o.order_type='dine_in' and o.status in ('draft','sent_to_kitchen') and o.payment_status='unpaid'
    order by o.created_at, o.id limit 1;
  if v_ord.id is null then perform public.pos_op_error('MERGE_PRIMARY_EMPTY','The primary table has no open bill.'); end if;
  perform public._pos_merge_assert_eligible(v_ord);
  v_primary_order := v_ord.id; v_primary_num := v_ord.order_number; v_primary_ver := v_ord.pos_entity_version;
  v_primary_sub := v_ord.subtotal; v_shift := v_ord.shift_id; v_primary_cur := v_ord.primary_currency_snapshot;

  -- Authoritative operational shift state via FOR UPDATE NOWAIT (never blocks while holding order locks).
  if v_shift is null then perform public.pos_op_error('MERGE_NO_SHIFT','The primary bill is not attached to a shift.'); end if;
  begin
    select * into v_shift_row from public.pos_shifts
      where id = v_shift and tenant_id = v_tenant and branch_id is not distinct from v_branch for update nowait;
  exception when lock_not_available then
    perform public.pos_op_error('MERGE_SHIFT_BUSY','The shift is busy (a payment or close is in progress). Retry in a moment.');
  end;
  if v_shift_row.id is null then raise exception 'Shift not found for this tenant/branch'; end if;
  if v_shift_row.status <> 'open' then perform public.pos_op_error('MERGE_SHIFT_CLOSED','This shift is closed; the bills cannot be merged.'); end if;

  select coalesce(max(batch_no),0) into v_next_batch from public.pos_order_items where order_id = v_primary_order;

  foreach v_src in array v_sources loop
    select o.* into v_ord from public.pos_orders o
      where o.tenant_id = v_tenant and o.table_id = v_src
        and o.order_type='dine_in' and o.status in ('draft','sent_to_kitchen') and o.payment_status='unpaid'
      order by o.created_at, o.id limit 1;
    if v_ord.id is null then perform public.pos_op_error('MERGE_SOURCE_EMPTY','A selected table has no open bill to merge.'); end if;
    perform public._pos_merge_assert_eligible(v_ord);
    if v_ord.shift_id is distinct from v_shift then perform public.pos_op_error('MERGE_CROSS_SHIFT','All tables must be on the same shift to merge.'); end if;
    if v_ord.primary_currency_snapshot is distinct from v_primary_cur then
      perform public.pos_op_error('MERGE_CROSS_CURRENCY','All bills must be in the same currency to merge.');
    end if;

    v_src_order := v_ord.id; v_src_num := v_ord.order_number; v_src_ver := v_ord.pos_entity_version;
    select coalesce(jsonb_agg(jsonb_build_object('order_item_id', id, 'original_batch_no', batch_no, 'line_total', line_total)
             order by batch_no, created_at), '[]'::jsonb)
      into v_src_items from public.pos_order_items where order_id = v_src_order;

    v_next_batch := v_next_batch + 1;
    update public.pos_order_items set order_id = v_primary_order, batch_no = v_next_batch where order_id = v_src_order;
    perform public._pos_merge_consolidate_kitchen_tickets(v_src_order, v_primary_order);

    v_sources_prov := v_sources_prov || jsonb_build_object(
      'source_order_id', v_src_order, 'source_table_id', v_src,
      'source_table_name', (select name from public.pos_tables where id = v_src), 'source_order_number', v_src_num,
      'pre_merge_version', v_src_ver, 'folded_batch_no', v_next_batch, 'items', v_src_items);

    update public.pos_orders
       set status = 'voided', updated_by = auth.uid(), cancelled_by = auth.uid(), cancelled_at = now(),
           notes = left(coalesce(nullif(notes,'') || ' ', '') || '[merged into ' || v_primary_num || ']', 2000),
           pos_entity_version = pos_entity_version + 1
     where id = v_src_order;
    update public.pos_tables set status = 'available', pos_entity_version = pos_entity_version + 1 where id = v_src;
  end loop;

  select coalesce(sum(line_total),0) into v_new_sub from public.pos_order_items where order_id = v_primary_order;
  update public.pos_orders
     set subtotal = round(v_new_sub,2), total_amount = round(v_new_sub,2),
         status = 'sent_to_kitchen', updated_by = auth.uid(), pos_entity_version = pos_entity_version + 1
   where id = v_primary_order returning pos_entity_version into v_new_ver;
  update public.pos_tables set status = 'occupied', pos_entity_version = pos_entity_version + 1 where id = v_primary_table;

  insert into public.pos_table_merges(tenant_id, branch_id, shift_id, primary_table_id, primary_order_id,
      primary_order_number, primary_pre_merge_subtotal, primary_pre_merge_version, sources, merged_by, client_op_id)
    values (v_tenant, v_branch, v_shift, v_primary_table, v_primary_order,
      v_primary_num, v_primary_sub, v_primary_ver, v_sources_prov, auth.uid(), v_op)
    returning id into v_merge_id;

  -- Canonical provenance: linked AFTER the merge row exists so the provenance guard's canonical-linkage check passes.
  update public.pos_orders
     set merged_into_order_id = v_primary_order, merged_into_merge_id = v_merge_id
   where id in (select (s->>'source_order_id')::uuid from jsonb_array_elements(v_sources_prov) s);

  perform public.create_activity_log(v_tenant, 'pos', 'tables_merged', 'pos_orders', v_primary_order,
    jsonb_build_object('primary_table', v_primary_table, 'primary_pre_merge_subtotal', v_primary_sub),
    jsonb_build_object('merge_id', v_merge_id, 'sources', v_sources_prov,
      'subtotal', round(v_new_sub,2), 'pos_entity_version', v_new_ver));

  select jsonb_build_object('ok', true, 'merge_id', v_merge_id,
    'primary_order_id', v_primary_order, 'primary_order_number', v_primary_num,
    'subtotal', round(v_new_sub,2), 'total_amount', round(v_new_sub,2),
    'sources_merged', array_length(v_sources,1), 'pos_entity_version', v_new_ver) into v_cached;
  -- Record success ONLY, in the same tx; failures above rollback with no submission row (per Konan REQUIRED_FIX).
  perform public.pos_op_record(v_tenant, v_branch, v_op, 'pos_merge_tables_v2', v_primary_order, v_cached);
  update public.pos_op_submissions set request_fingerprint = v_fp
    where tenant_id = v_tenant and client_op_id = v_op;

  return v_cached;
end; $function$;

REVOKE EXECUTE ON FUNCTION public.pos_merge_tables_v2(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pos_merge_tables_v2(jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.pos_merge_tables_v2(jsonb) TO authenticated;
