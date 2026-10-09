-- R3-B — split / partially-paid merge: SERVER-AUTHORITATIVE DENY-BY-DEFAULT GATE (dark).
--
-- R3-B (merging the UNPAID remainder of a split or partially-paid bill) is NOT activated. The actual
-- enforcement is that _pos_merge_assert_eligible (UNCHANGED) already hard-rejects ANY bill carrying a payment
-- (MERGE_HAS_PAYMENTS), a split (MERGE_SPLIT), a non-immediate settlement (MERGE_ON_ACCOUNT), consumed inventory
-- (MERGE_CONSUMED) or an adjustment (MERGE_HAS_ADJUSTMENTS). pos_merge_tables_v2 calls that guard for the primary
-- and every source, so only FULLY-UNPAID, clean dine-in bills can merge today.
--
-- This function is the SINGLE, SERVER-OWNED flip point a future certified split-merge path would consult. It
-- returns a hard-coded FALSE with NO argument, NO table read and NO setting lookup, so NO client payload, NO tenant
-- configuration row and NO ordinary database GRANT/UPDATE can enable R3-B — only a reviewed code migration that
-- changes this body (which itself must pass certification + an explicit HUMAN GO) can. There is deliberately NO
-- production activation path. EXECUTE is revoked from PUBLIC/anon/authenticated: only SECURITY DEFINER cores owned
-- by postgres may read it.
--
-- Prove-or-block determination: docs/releases/1.0.35/DESKTOP_1_0_35_R3B_DETERMINATION.md
-- Verdict: R3-B ACTIVATION BLOCKED (amount-level partial and partial-quantity split remainders are unprovable in
-- the canonical model without a synthetic non-canonical balance line or an unsafe order_item split). Staging only; NO prod.
CREATE OR REPLACE FUNCTION public._pos_merge_split_mode_enabled()
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- DENY BY DEFAULT. R3-B (split / partially-paid remainder merge) is activation-BLOCKED pending a certified,
  -- Konan-reviewed, invariant-proven design and an explicit HUMAN GO. See
  -- docs/releases/1.0.35/DESKTOP_1_0_35_R3B_DETERMINATION.md for the prove-or-block analysis. Never flip this to
  -- true without that certification; a true here must never reach production without an explicit production GO.
  select false;
$function$;

REVOKE EXECUTE ON FUNCTION public._pos_merge_split_mode_enabled() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._pos_merge_split_mode_enabled() FROM anon;
REVOKE EXECUTE ON FUNCTION public._pos_merge_split_mode_enabled() FROM authenticated;
