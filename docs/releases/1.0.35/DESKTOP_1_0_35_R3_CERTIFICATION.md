# Desktop 1.0.35 — R3 Merge Tables: Staging Certification Evidence

Date: 2026-10-09 · Environment: staging `azjxprewycygsocusxjn` · **No production change.**
Scope: R3-A (deterministic/idempotent merge), R3-C (provenance + report exclusions), R3-B (dark deny-by-default + blocked).

## Migrations applied to staging (all additive; NONE on prod)

| File | What |
| --- | --- |
| `20261009140000_r3c_merge_provenance_schema.sql` | `pos_orders.merged_into_order_id` + `merged_into_merge_id` (nullable, single-col FK ON DELETE RESTRICT, NOT VALID→VALIDATE); `_pos_orders_merge_provenance_guard` BEFORE INSERT/UPDATE trigger; `_pos_table_merges_append_only` BEFORE UPDATE/DELETE trigger; REVOKE writes on `pos_table_merges`. |
| `20261009150000_r3a_merge_tables_v2.sql` | `pos_merge_tables_v2` (SECDEF, authenticated-only). |
| `20261009160000_r3c_merge_report_exclusions.sql` | `pos_end_shift_core` / `pos_daily_report` / `pos_range_report` — `AND merged_into_order_id IS NULL` on void/cancel counts only (derived from live defs by substring replacement; self-verifying guards). |
| `20261009170000_r3b_split_merge_denybydefault_gate.sql` | `_pos_merge_split_mode_enabled()` → hard-false, REVOKE from PUBLIC/anon/authenticated (R3-B dark gate). |

Legacy `pos_merge_tables(_core)`, `_pos_merge_assert_eligible`, `pos_op_replay`, `pos_op_record` signatures/bodies UNCHANGED.

## Defects fixed (R3)

1. **False same-shift error** — v2 locks the live shift via FOR UPDATE NOWAIT and requires `status='open'`; it no longer compares a stored origin shift_id. `MERGE_CROSS_SHIFT` now fires only on genuinely different shifts.
2. **Silent `LIMIT 1` bill selection** — v2 asserts exactly one open-unpaid dine-in bill per table (`array_agg` cardinality) and returns **`MERGE_AMBIGUOUS_BILL`** otherwise.
3. **Merged-shown-as-voided** — a merged source now carries canonical provenance; reports exclude it from void/cancel counts; the desktop relabels it "Merged".

## Runtime matrix (impersonated operators; all synthetic fixtures removed, 0 residue)

| # | Case | Result |
| --- | --- | --- |
| 1 | Happy-path merge ($10+$5) | ok, subtotal 15, items moved, source voided+note+provenance, tables flipped, merge row + activity log |
| 2 | Two open bills on a table | `MERGE_AMBIGUOUS_BILL` (no silent pick) |
| 3 | Bills on two open shifts | `MERGE_CROSS_SHIFT` |
| 4 | USD source into LBP primary | `MERGE_CROSS_CURRENCY` |
| 5 | Primary bill on a non-open shift | `MERGE_SHIFT_CLOSED` |
| 6a | Exact replay (same op) | identical cached result, **no re-merge, no version re-bump** (exactly-once) |
| 6b | Same op, different payload | `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| 6c | Same op, different actor | `CROSS_ACTOR_REPLAY_REJECTED` |
| 7a | UPDATE/DELETE `pos_table_merges` | append-only raise |
| 7b | Clear provenance on a merged source | "immutable once set" |
| 7c | Forge provenance on a non-source order | "merge provenance link is not canonical" |
| 8 | Report real-VOID vs MERGED (merged $7 + true void $9) | `cancelled=1`, `cancelled_amount=9.00`, `sales=27.00` (merged value absorbed, not double-counted), route `cancelled_count=1`; `pos_end_shift_core` v_void old=2 → new=1 |
| 9 | Legacy `pos_merge_tables` | still merges, byte-stable, leaves provenance NULL |
| 10 | R3-B gate | `_pos_merge_split_mode_enabled()`=false; authenticated/anon EXECUTE=false; eligibility still rejects payments+splits |

## Forced-concurrency (true two-backend lock interleaving, pg_cron)

A pg_cron worker (separate backend) held the shift row FOR UPDATE; a concurrent merge from another backend:
- hit FOR UPDATE NOWAIT → **`MERGE_SHIFT_BUSY`** (deterministic, retryable; never blocks while holding order locks → no merge-vs-payment/transfer/shift-close inversion deadlock);
- left **zero mutation and zero `pos_op_submissions` row** (record-only-on-success + full rollback — so the same op_id is NOT falsely blocked as a replay);
- **retry after the holder released → success** (ok, subtotal 15).

The idempotency/replay mechanism (pos_op_replay advisory-claim + request_fingerprint + actor-bind) is byte-identical to the certified Transfer-B1 / R2 pattern already proven under real pg_cron concurrency.

## Two real bugs found & fixed during verification

- `min(uuid)` — PostgreSQL has no such aggregate → replaced with `array_agg(... order by created_at, id)` cardinality.
- `request_fingerprint` was never persisted (`pos_op_record` has no fingerprint param) → added an explicit `UPDATE pos_op_submissions SET request_fingerprint` after the record, matching the certified R2 pattern. (Error code aligned to `IDEMPOTENCY_PAYLOAD_MISMATCH`.)

## Classification of the 63 `voided`-referencing functions

Only **3** classify voided/cancelled as a user-facing cancel COUNT (the ones edited). The other 60 use 'voided' for sales-exclusion (`NOT IN (...)`), eligibility gates, or status transitions and are correctly UNCHANGED. Verified: these 3 are the only functions containing the `status in ('voided','cancelled')` cancel-count pattern, and all 3 now carry the matching merged filter.

## Historical backfill

Read-only eligibility report (`DESKTOP_1_0_35_R3_BACKFILL_ELIGIBILITY.md`): 2 historical merges on staging, both ELIGIBLE, 0 exceptions — **not altered**. Prod backfill = explicit HUMAN GO.

## Client (desktop)

`pos_merge_tables_v2` added to the `PosRpcName` allow-list; `mergeTables` calls v2 and always sends a `client_op_id`. The Orders view relabels a merged source as "Merged" (neutral tone) vs a true void ("Voided", red) via the provenance column, with a dedicated "Merged" filter. `tsc` 0; targeted automated suite **225/225** (6 RPC allow-list canaries bumped 59→60 / 48→49, extraction regexes widened to capture the digit in `pos_merge_tables_v2`; money-mover guard unaffected).

## Gates

- Konan arch: 3-cycle converged (sess_0c388b0a / 029c7e1d / 014608c0).
- Konan impl/security: in flight (CLI verbatim payload `konan-r3-impl.json`).
- Interactive desktop render: PENDING (credentialed staging gate; not marked PASS).
- R3-B activation: **BLOCKED** with exact unprovable invariants (`DESKTOP_1_0_35_R3B_DETERMINATION.md`).
- Production: no DB write / publish / rollout this session; **PROD = explicit HUMAN GO.**
