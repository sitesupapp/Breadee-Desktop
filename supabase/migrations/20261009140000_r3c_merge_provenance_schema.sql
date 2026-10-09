-- R3-C — Merge provenance schema (Desktop 1.0.35). Additive + DB-enforced integrity/immutability.
-- Distinguishes a MERGED source (obligation moved to a primary) from a true VOID, canonically.
-- Konan arch 3-cycle converged (sess_0c388b0a/029c7e1d/014608c0). Staging-first; NO prod.

-- 1) Additive provenance columns on pos_orders (nullable). Single-column FKs for existence; the trigger
--    below enforces tenant/OU + canonical linkage + immutability (no UNIQUE(tenant_id,id) exists to back a
--    composite FK, and Konan approved the trigger approach over adding a redundant high-volume index).
ALTER TABLE public.pos_orders
  ADD COLUMN IF NOT EXISTS merged_into_order_id uuid,
  ADD COLUMN IF NOT EXISTS merged_into_merge_id uuid;

-- FKs created NOT VALID then validated separately (low-lock). ON DELETE RESTRICT (Konan: SET NULL would
-- break both-null-or-both + immutability; RESTRICT keeps provenance consistent — merged sources are
-- terminal and not deleted in normal flow).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_orders_merged_into_order_fk') THEN
    ALTER TABLE public.pos_orders
      ADD CONSTRAINT pos_orders_merged_into_order_fk
      FOREIGN KEY (merged_into_order_id) REFERENCES public.pos_orders(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_orders_merged_into_merge_fk') THEN
    ALTER TABLE public.pos_orders
      ADD CONSTRAINT pos_orders_merged_into_merge_fk
      FOREIGN KEY (merged_into_merge_id) REFERENCES public.pos_table_merges(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;
ALTER TABLE public.pos_orders VALIDATE CONSTRAINT pos_orders_merged_into_order_fk;
ALTER TABLE public.pos_orders VALIDATE CONSTRAINT pos_orders_merged_into_merge_fk;

-- 2) Server-owned provenance guard: canonical linkage + integrity + immutability. Fires on INSERT/UPDATE.
CREATE OR REPLACE FUNCTION public._pos_orders_merge_provenance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- both-null-or-both-populated
  if (new.merged_into_order_id is null) <> (new.merged_into_merge_id is null) then
    raise exception 'merged_into_order_id and merged_into_merge_id must both be set or both null' using errcode = '23514';
  end if;

  if new.merged_into_order_id is not null then
    if new.merged_into_order_id = new.id then
      raise exception 'a merged order cannot reference itself' using errcode = '23514';
    end if;
    -- canonical linkage (UNFORGEABLE): the referenced merge must belong to this tenant, point to the named
    -- primary, AND already list THIS order in its sources[] — a shape only a real merge produces.
    if not exists (
      select 1 from public.pos_table_merges m
      where m.id = new.merged_into_merge_id
        and m.tenant_id = new.tenant_id
        and m.primary_order_id = new.merged_into_order_id
        and exists (select 1 from jsonb_array_elements(coalesce(m.sources,'[]'::jsonb)) s
                    where nullif(s->>'source_order_id','')::uuid = new.id)
    ) then
      raise exception 'merge provenance link is not canonical' using errcode = '23514';
    end if;
    -- primary order: same tenant + same operating unit (branch)
    if not exists (
      select 1 from public.pos_orders po
      where po.id = new.merged_into_order_id
        and po.tenant_id = new.tenant_id
        and po.branch_id is not distinct from new.branch_id
    ) then
      raise exception 'merged_into order must be in the same tenant and operating unit' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- IMMUTABLE once set: cannot change or clear the provenance
    if old.merged_into_order_id is not null
       and (new.merged_into_order_id is distinct from old.merged_into_order_id
            or new.merged_into_merge_id is distinct from old.merged_into_merge_id) then
      raise exception 'merge provenance is immutable once set' using errcode = '23514';
    end if;
    -- defence-in-depth: do not allow the OU of a merged order to drift (branch is already immutable fleet-wide)
    if old.merged_into_order_id is not null and new.branch_id is distinct from old.branch_id then
      raise exception 'cannot change the operating unit of a merged order' using errcode = '23514';
    end if;
  end if;

  return new;
end; $function$;

DROP TRIGGER IF EXISTS trg_pos_orders_merge_provenance ON public.pos_orders;
CREATE TRIGGER trg_pos_orders_merge_provenance
  BEFORE INSERT OR UPDATE OF merged_into_order_id, merged_into_merge_id, branch_id ON public.pos_orders
  FOR EACH ROW EXECUTE FUNCTION public._pos_orders_merge_provenance_guard();

-- 3) pos_table_merges is APPEND-ONLY and server-written only. REVOKE direct client writes (the SECDEF cores
--    owned by postgres still insert), and DB-enforce no UPDATE/DELETE so an existing provenance link cannot
--    be invalidated (sources/tenant_id/primary_order_id become immutable after insert).
REVOKE INSERT, UPDATE, DELETE ON public.pos_table_merges FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.pos_table_merges FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.pos_table_merges FROM authenticated;

CREATE OR REPLACE FUNCTION public._pos_table_merges_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  raise exception 'pos_table_merges is append-only (merge provenance is immutable)' using errcode = '42501';
end; $function$;

DROP TRIGGER IF EXISTS trg_pos_table_merges_append_only ON public.pos_table_merges;
CREATE TRIGGER trg_pos_table_merges_append_only
  BEFORE UPDATE OR DELETE ON public.pos_table_merges
  FOR EACH ROW EXECUTE FUNCTION public._pos_table_merges_append_only();

REVOKE EXECUTE ON FUNCTION public._pos_orders_merge_provenance_guard() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._pos_table_merges_append_only() FROM PUBLIC;
