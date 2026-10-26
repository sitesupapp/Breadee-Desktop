-- READ-ONLY anchor proof for S6 on PROD (SELECT only; no DDL/DML).
with s as (select pg_get_functiondef('public.pos_open_shift_core(jsonb)'::regprocedure) d0, E'  if v_id is not null then' a, E'  if v_id is not null then\r\n    -- Desktop 1.0.38 (Bug 3): a chained offline open (require_new) must CREATE a shift, never adopt one.\r\n    if lower(coalesce(p_payload->>''require_new'', '''')) = ''true'' then\r\n      perform public.pos_op_error(''SHIFT_ALREADY_OPEN'', ''Another shift is already open for this cashier on this branch. The shift opened offline was not attached to it.'');\r\n    end if;' r)
select md5(d0) pre, (length(d0) - length(replace(d0, a, ''))) / length(a) anchor_count,
       md5(replace(d0, a, r)) post,
       (length(replace(d0, a, r)) - length(replace(replace(d0, a, r), r, ''))) / length(r) inverse_count,
       md5(replace(replace(d0, a, r), r, a)) roundtrip
from s;
-- expected: pre 70c310a6dbc9194358e3b1b624fc9540, anchor_count 1, post 5dee6e73adb270f536fcf883e00c30d5, inverse_count 1, roundtrip = pre
