# Desktop 1.0.35 — R3-C Historical Merge Backfill Eligibility & Exception Report

**Read-only. Nothing is altered. Production backfill requires explicit HUMAN GO.**

Date: 2026-10-09 · Environment: staging `azjxprewycygsocusxjn` · Scope: all tenants on staging.

## Purpose

R3-A/R3-C introduce canonical merge provenance (`pos_orders.merged_into_order_id` +
`merged_into_merge_id`). Merges performed **before** v2 (legacy `pos_merge_tables`) recorded a row in
`pos_table_merges` but left the source orders' provenance columns **NULL** (legacy predates them). Those
historical merged sources therefore still appear in void/cancel counts until an authorized backfill links them.

This report classifies every `pos_table_merges` source linkage into **ELIGIBLE** (a backfill UPDATE would pass the
`_pos_orders_merge_provenance_guard` canonical-linkage + immutability checks) vs an **exception** class that must
never be auto-altered.

## Classification rules (per merge-row × source link)

| Class | Meaning |
| --- | --- |
| `ELIGIBLE` | source exists, status='voided', provenance NULL, same tenant, primary exists same tenant+OU, source listed in exactly one merge → backfill would set `merged_into_order_id = primary_order_id`, `merged_into_merge_id = merge.id` and PASS the guard |
| `ALREADY_LINKED` | provenance already points at this same primary+merge (no-op) |
| `EXC_SOURCE_MISSING` | source order row no longer exists |
| `EXC_LINKED_ELSEWHERE` | provenance already set to a different primary/merge |
| `EXC_AMBIGUOUS_MULTI_MERGE` | source referenced by more than one merge row |
| `EXC_SOURCE_NOT_VOIDED` | source is not status='voided' (re-opened / un-voided) |
| `EXC_PRIMARY_MISSING` | the merge's primary order no longer exists |
| `EXC_CROSS_TENANT` | source/primary tenant ≠ merge tenant |
| `EXC_CROSS_OU` | primary and source are in different operating units |

## Result (staging, 2026-10-09)

| Metric | Value |
| --- | --- |
| Total `pos_table_merges` rows | **2** |
| Total source links | **2** |
| `ELIGIBLE` | **2** |
| Exceptions (all classes) | **0** |

Eligible by tenant: Franks `971cf232-a0c0-41fc-a295-60d523d24c32` (#2102) — 2.

Both historical merges are cleanly backfill-eligible; there are no ambiguous, cross-tenant, cross-OU, missing, or
already-diverged records on staging.

## Decision

- **No backfill is performed by this release.** The report is informational.
- A future backfill (staging or prod) must run the UPDATE through the **same** `_pos_orders_merge_provenance_guard`
  (never disabling/bypassing it), process **ELIGIBLE** rows only, and emit any new exceptions for human review.
- **Production backfill = explicit HUMAN GO** (Preservation Gate; no destructive or ambiguous historical rewrite).

## Reproduction query

See the `with src … classified …` statement in the R3 verification log; it is read-only (SELECT/JSON only) and
can be re-run at any time to refresh the counts.
