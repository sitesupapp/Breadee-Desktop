# DESKTOP 1.0.35 — R3 Merge Tables — CURRENT-STATE AUDIT + DESIGN

Staging-first. NOT a Production GO. Preserves 1.0.34, dine-in, the Transfer workstream, and R6.

## Live contracts (extracted; drift gate satisfied)
- `pos_merge_tables(p_payload)` wrapper → `pos_merge_tables_core(p_payload)` (SECDEF). Flow: lock all tables
  FOR UPDATE (order by id) → per table pick the open unpaid dine-in bill via `order by created_at,id LIMIT 1`
  → `_pos_merge_assert_eligible` → move source items to primary (`update pos_order_items set order_id`,
  new batch_no) → consolidate kitchen tickets → set source `status='voided'` (+ notes "[merged into N]") →
  recompute primary subtotal=total → record `pos_table_merges` + `tables_merged` activity log.
- `_pos_merge_assert_eligible(o)`: rejects non-open/unpaid dine-in, on_account, inventory_consumed,
  ANY discount/tax/charge/tip/offer/rounding/delivery_fee or total≠subtotal (MERGE_HAS_ADJUSTMENTS), ANY
  `pos_payments` (MERGE_HAS_PAYMENTS), ANY `pos_split_settlements` (MERGE_SPLIT).
- `_pos_lock_open_shift(shift_id, tenant, branch)`: locks the shift row, requires `status='open'`.
- `pos_table_merges`: id, tenant, branch, shift_id, primary_table_id, primary_order_id, primary_order_number,
  primary_pre_merge_subtotal/version, sources(jsonb), merged_by, merged_at, client_op_id.
- `pos_orders`: NO merge columns yet.

## Defects (confirmed)
- **R3-A false same-shift + non-determinism:** the merge compares each source order's STORED origin
  `shift_id` to the primary's and never re-validates the shift is OPEN (a bill can outlive its shift → a
  closed-shift bill can be merged). Single-bill-per-table selection is `LIMIT 1` — **silent** when a table has
  >1 open bill (confirmed: 1 such table exists on staging now), so other open bills are orphaned.
- **R3-C merged shown as voided:** the source is set `status='voided'`; provenance exists ONLY in
  `pos_table_merges` + the activity log + a notes string, so reports/accounting conflate a MERGE with a VOID.

## Design
### R3-A — `pos_merge_tables_v2(+_core)` (NEW; legacy byte-stable), ships
- **Deterministic single bill:** if any participating table has >1 open unpaid dine-in bill → structured
  error `MERGE_AMBIGUOUS_BILL` (never a silent LIMIT 1). Otherwise the unique bill is used.
- **Operational shift OPEN + locked:** resolve the primary bill's `shift_id`, lock via `_pos_lock_open_shift`
  (requires open); require every participating bill to share that SAME open shift (else `MERGE_CROSS_SHIFT`).
- **Guards:** same OU/branch (already enforced), same `primary_currency_snapshot` across bills
  (`MERGE_CROSS_CURRENCY`), per-table CAS via `expected`.
- **Eligibility UNCHANGED** (strict `_pos_merge_assert_eligible`) → inventory/tax/adjustment preservation
  inherited (unpaid + not consumed ⇒ no inventory/tax/adjustment movement). Item move + kitchen consolidation
  + provenance record reused from the current core.
### R3-C — provenance columns (additive), ships
- Add `pos_orders.merged_into_order_id uuid` (FK pos_orders.id) + `merged_into_merge_id uuid`
  (FK pos_table_merges.id); DB constraints: same tenant/OU, no self-reference; set atomically on each source
  in the same tx as the item move. Reports/Orders relabel a merged source "merged into <primary #>" instead
  of "voided"; the source stays `status='voided'` (financially correct — the obligation moved to the primary).
### R3-B — split/partial-paid merge (DARK, activation-blocked; APPROVED but prove-or-block)
- Relax eligibility to admit bills with settled payments / splits / remaining balance behind a default-OFF
  opt-in; settled payments IMMUTABLE (never moved/re-charged/duplicated); only legit UNPAID obligation
  transfers; group outstanding DERIVED from settlements+reversals; terminal non-void merged lifecycle; legacy
  cores reject merged sources; full invariant suite (mixed methods, partial splits, kitchen tickets, shift
  reconciliation, refunds/currency/receipts/reports/sub-invoices). If ANY invariant is unprovable on staging →
  activation BLOCKED + exact issue reported. Never weaken financial safety for a PASS.

## Preservation / rollback
Legacy `pos_merge_tables(_core)` left byte-stable (R3-A is a NEW v2; the desktop switches to v2). Additive
columns are nullable + constraint-guarded. Fix-forward; a rollback drops the additive columns/v2 and restores
the client to the legacy RPC. No prod writes without explicit GO.
