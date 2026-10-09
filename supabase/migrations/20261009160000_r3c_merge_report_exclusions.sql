-- R3-C Phase 3 — exclude MERGED source orders (merged_into_order_id IS NOT NULL) from void/cancel COUNTS in the
-- three affected report functions: pos_end_shift_core (cancelled_void), pos_daily_report + pos_range_report
-- (route cancelled_count + summary cancelled + summary cancelled_amount).
--
-- A merged source carries status='voided' only as a folding marker; it is NOT a cancellation. Sales/paid/unpaid/
-- total already exclude it via status and are UNCHANGED. Of all 63 functions referencing status='voided', only
-- these 3 classify voided/cancelled as a user-facing cancel COUNT (verified: they are the only functions whose body
-- contains the `status in ('voided','cancelled')` cancel-filter pattern). All others use 'voided' for
-- sales-exclusion (not in (...)), eligibility gates, or status transitions and are correctly left untouched.
--
-- The new definitions are derived from the LIVE definitions by targeted substring replacement, so signatures,
-- STABLE/SECURITY DEFINER, search_path, owner (postgres) and grants are preserved and every other byte is identical.
-- The report CTE 'o' gains only the merged_into_order_id column it needs to apply the filter. Self-verifying guards
-- assert the exact replacement counts (end_shift 1; daily 3; range 3) or the migration aborts.
--
-- Pre-v2 historical merges keep merged_into_order_id NULL => they remain in cancel counts and are handled separately
-- by the read-only backfill eligibility report (docs/releases/1.0.35/DESKTOP_1_0_35_R3_BACKFILL_ELIGIBILITY.md);
-- they are NEVER auto-altered. Konan arch 3-cycle converged. Staging azjxprewycygsocusxjn only; NO prod.
do $$
declare d text; n int;
begin
  -- pos_end_shift_core: single v_void count feeding rep->'cancelled_void'
  d := pg_get_functiondef('public.pos_end_shift_core(jsonb)'::regprocedure);
  d := replace(d, 'status in (''voided'',''cancelled'')',
                  'status in (''voided'',''cancelled'') and merged_into_order_id is null');
  n := (length(d) - length(replace(d,'and merged_into_order_id is null','')))/length('and merged_into_order_id is null');
  if n <> 1 then raise exception 'pos_end_shift_core: expected 1 merged filter, got %', n; end if;
  execute d;

  -- pos_daily_report: route cancelled_count (CTE o/agg) + summary cancelled + summary cancelled_amount
  d := pg_get_functiondef('public.pos_daily_report(date,uuid)'::regprocedure);
  d := replace(d, 'select id, order_type, status,', 'select id, merged_into_order_id, order_type, status,');
  d := replace(d, 'status in (''voided'',''cancelled'')',
                  'status in (''voided'',''cancelled'') and merged_into_order_id is null');
  n := (length(d) - length(replace(d,'and merged_into_order_id is null','')))/length('and merged_into_order_id is null');
  if n <> 3 then raise exception 'pos_daily_report: expected 3 merged filters, got %', n; end if;
  execute d;

  -- pos_range_report: same three
  d := pg_get_functiondef('public.pos_range_report(date,date,uuid)'::regprocedure);
  d := replace(d, 'select id, order_type, status,', 'select id, merged_into_order_id, order_type, status,');
  d := replace(d, 'status in (''voided'',''cancelled'')',
                  'status in (''voided'',''cancelled'') and merged_into_order_id is null');
  n := (length(d) - length(replace(d,'and merged_into_order_id is null','')))/length('and merged_into_order_id is null');
  if n <> 3 then raise exception 'pos_range_report: expected 3 merged filters, got %', n; end if;
  execute d;
end $$;
