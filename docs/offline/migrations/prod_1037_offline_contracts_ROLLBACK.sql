-- ============================================================================
-- ROLLBACK of desktop_1037_offline_contracts (PRODUCTION cltlqfqormkhppmbvyrv).
-- Restores the exact pre-1.0.37 function bodies (inverse anchored replace on the LIVE bodies;
-- POST guards prove the restored md5s equal the captured pre-images) and drops
-- pos_order_item_map. The nullable column pos_order_items.client_line_id is KEPT by default:
-- it is harmless to the old functions, and dropping it would discard the offline line
-- correlation recorded after the release (fix-forward principle). Drop it only on an explicit
-- decision (statement at the end, commented out).
--
-- !!! PRE-PUBLICATION / NO-ADOPTION USE ONLY !!!
-- This exact-pre-image rollback REMOVES the C1 EXPECTED_ORDER_MISMATCH guard. Installed 1.0.37
-- terminals keep sending expected_order_id on offline dine-in rounds >= 2 (restoring the 1.0.36
-- channel manifest does not downgrade them). Against the restored 1.0.36 pos_save_order body, a
-- queued round whose original bill was closed/replaced would be SILENTLY APPENDED TO ANOTHER OPEN
-- BILL for that table. Therefore:
--   * before 1.0.37 is published to desktop-production-channel (or if no terminal has adopted it):
--     this script may be used;
--   * after publication: this script is PROHIBITED. Recovery is FIX-FORWARD ONLY — a targeted,
--     reviewed migration that keeps C1 (and anything 1.0.37 depends on) and corrects only the
--     contract proven harmful (runbook §5.1).
-- Enforced below: it refuses unless the operator sets
--   set local breadee.rollback_1037_ack = 'PRE_PUBLICATION_NO_ADOPTION';
-- in the same transaction, and it refuses if any 1.0.37 adoption evidence exists
-- (a non-NULL pos_order_items.client_line_id is written only by a 1.0.37 offline replay).
-- ============================================================================

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $ack$
begin
  if coalesce(current_setting('breadee.rollback_1037_ack', true), '') <> 'PRE_PUBLICATION_NO_ADOPTION' then
    raise exception 'ROLLBACK REFUSED: pre-publication only. After 1.0.37 publication recovery is fix-forward (runbook 5.1). Set breadee.rollback_1037_ack = PRE_PUBLICATION_NO_ADOPTION only if 1.0.37 was never published.';
  end if;
  if exists (select 1 from public.pos_order_items where client_line_id is not null) then
    raise exception 'ROLLBACK REFUSED: 1.0.37 adoption evidence (client_line_id rows) exists. Fix-forward only (runbook 5.1).';
  end if;
end
$ack$;

create or replace function pg_temp._r1037_once(p_src text, p_anchor text, p_repl text, p_label text, p_expect int default 1)
returns text language plpgsql as $f$
declare n int;
begin
  n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / nullif(length(p_anchor), 0);
  if n is distinct from p_expect then raise exception 'ANCHOR %: expected % occurrence(s), found %', p_label, p_expect, n; end if;
  return replace(p_src, p_anchor, p_repl);
end $f$;

do $rb$
declare d text; core_old text; wrap_old text;
begin
  -- C1 pos_save_order: remove the declaration + guard
  d := pg_get_functiondef('public.pos_save_order(jsonb)'::regprocedure);
  d := pg_temp._r1037_once(d,
    E'\n  v_expected_order uuid := nullif(p_payload->>''expected_order_id'','''')::uuid;\nbegin',
    E'\nbegin', 'rb.save_order.declare');
  d := pg_temp._r1037_once(d,
    E'    -- Desktop 1.0.37 offline multi-round guard (atomic, under this advisory lock): a caller that\n'
    || E'    -- pins expected_order_id (a later round of an offline session) MUST append to exactly\n'
    || E'    -- that order. A mismatch (bill closed/paid/replaced remotely, or none open) is refused.\n'
    || E'    if v_expected_order is not null and v_id is distinct from v_expected_order then\n'
    || E'      raise exception ''This table''''s bill changed since it was opened offline and cannot take this round''\n'
    || E'        using errcode = ''22023'', detail = json_build_object(''pos_error_code'',''EXPECTED_ORDER_MISMATCH'')::text;\n'
    || E'    end if;\n',
    '', 'rb.save_order.guard');
  execute d;

  -- C2b _pos_insert_order_items: stop persisting client_line_id
  d := pg_get_functiondef('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)'::regprocedure);
  d := pg_temp._r1037_once(d, 'batch_no,added_by,client_line_id)', 'batch_no,added_by)', 'rb.insert.columns');
  d := pg_temp._r1037_once(d, E',p_actor,nullif(it->>''client_line_id'','''')::uuid)', ',p_actor)', 'rb.insert.values');
  execute d;

  -- C3 void: rebuild the ORIGINAL 4-arg core / 5-arg wrapper
  core_old := pg_get_functiondef('public.pos_void_order_core(uuid,text,boolean,integer,numeric)'::regprocedure);
  core_old := pg_temp._r1037_once(core_old, ', p_expected_refund_usd numeric DEFAULT NULL::numeric)', ')', 'rb.void_core.header');
  core_old := pg_temp._r1037_once(core_old,
    E'  -- Desktop 1.0.37 offline refundable-balance guard (ADDITIVE; NULL for every online caller).\n'
    || E'  if p_expected_refund_usd is not null then\n'
    || E'    if not v_paid then\n'
    || E'      perform public.pos_op_error(''REFUND_BALANCE_CHANGED'',\n'
    || E'        ''This order is no longer in a refundable paid state. Reconnect and review before refunding.'');\n'
    || E'    end if;\n'
    || E'    if abs(coalesce(v_net_usd, 0) - p_expected_refund_usd) >= 0.005 then\n'
    || E'      perform public.pos_op_error(''REFUND_AMOUNT_MISMATCH'',\n'
    || E'        ''The refundable amount changed since this refund was captured offline. Reconnect and review.'');\n'
    || E'    end if;\n'
    || E'  end if;\n',
    '', 'rb.void_core.guard');
  wrap_old := pg_get_functiondef('public.pos_void_order(uuid,text,boolean,uuid,integer,numeric)'::regprocedure);
  wrap_old := pg_temp._r1037_once(wrap_old, ', p_expected_refund_usd numeric DEFAULT NULL::numeric)', ')', 'rb.void_wrap.header');
  wrap_old := pg_temp._r1037_once(wrap_old, ', p_expected_version, p_expected_refund_usd)', ', p_expected_version)', 'rb.void_wrap.calls', 2);
  drop function public.pos_void_order(uuid, text, boolean, uuid, integer, numeric);
  drop function public.pos_void_order_core(uuid, text, boolean, integer, numeric);
  execute core_old;
  execute wrap_old;

  drop function if exists public.pos_order_item_map(uuid, integer);
end
$rb$;

alter function public.pos_void_order_core(uuid, text, boolean, integer) owner to postgres;
alter function public.pos_void_order(uuid, text, boolean, uuid, integer) owner to postgres;
revoke all on function public.pos_void_order_core(uuid, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.pos_void_order_core(uuid, text, boolean, integer) to service_role;
revoke all on function public.pos_void_order(uuid, text, boolean, uuid, integer) from public, anon;
grant execute on function public.pos_void_order(uuid, text, boolean, uuid, integer) to authenticated, service_role;

-- POST: every restored body is byte-identical to the captured production pre-image.
do $post$
declare m text;
begin
  m := md5(pg_get_functiondef('public.pos_save_order(jsonb)'::regprocedure));
  if m <> '2563d514483cb2f3d4a3f7dda6a19cff' then raise exception 'RB POST: pos_save_order md5 %', m; end if;
  m := md5(pg_get_functiondef('public._pos_insert_order_items(uuid,uuid,uuid,jsonb,integer,boolean,uuid)'::regprocedure));
  if m <> 'dc862a87fdb2c9a9d523a78177c1bf7c' then raise exception 'RB POST: _pos_insert_order_items md5 %', m; end if;
  m := md5(pg_get_functiondef('public.pos_void_order(uuid,text,boolean,uuid,integer)'::regprocedure));
  if m <> 'c3576dc8362836174949be3976671325' then raise exception 'RB POST: pos_void_order md5 %', m; end if;
  m := md5(pg_get_functiondef('public.pos_void_order_core(uuid,text,boolean,integer)'::regprocedure));
  if m <> 'b73c49ac6046be1b84fc0405157e4e17' then raise exception 'RB POST: pos_void_order_core md5 %', m; end if;
  if (select proacl::text from pg_proc where oid = 'public.pos_void_order(uuid,text,boolean,uuid,integer)'::regprocedure) <> '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or (select proacl::text from pg_proc where oid = 'public.pos_void_order_core(uuid,text,boolean,integer)'::regprocedure) <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception 'RB POST: void ACL not restored';
  end if;
end
$post$;

-- Optional, explicit decision only (discards offline line correlation recorded after release):
-- alter table public.pos_order_items drop column client_line_id;

notify pgrst, 'reload schema';
