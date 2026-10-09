# Desktop 1.0.35 — R3-B (Split / Partially-Paid Merge): Prove-or-Block Determination

**Verdict: R3-B ACTIVATION BLOCKED. Default-OFF, server-authoritative, no production activation path.**
Date: 2026-10-09 · Environment analysed: staging `azjxprewycygsocusxjn` · No production change.

This is the mandated "prove-or-block" analysis for R3-B (merging the **unpaid remainder** of a split or
partially-paid bill). Per the authorization: *"If any invariant unprovable → BLOCK R3-B activation + report the
exact issue. Never weaken financial safety for a PASS."* The analysis below concludes that the required invariants
are **not provable** in the current canonical model for the general case, so R3-B stays **dark and blocked**.

## What "merge the remainder" would have to mean

A split or partially-paid source bill holds:
- settled money in `pos_payments` (attributed to `order_id` + `shift_id` + `received_by_user_id` + amounts), and —
  for item splits — `pos_split_settlements` (status, `payment_id`, `amount_*`, `split_no`) with
  `pos_split_allocations` (`order_item_id`, `allocated_quantity`, `allocated_amount_order_ccy`).
- an outstanding balance = order total − settled amount.

Merging the remainder into a primary table must satisfy ALL of:
1. **Settled payments immutable** — no payment/settlement row altered, deleted, re-attributed or re-shifted.
2. **Attribution preserved** — each settled amount stays on its original order + shift + cashier for sales,
   collected, shift reconciliation and sub-invoice/receipt history.
3. **No double-count / no re-charge** — the already-paid value is never counted again on the primary, and the
   customer is never charged twice.
4. **Canonical item/inventory provenance** — every line on the primary remains a real menu-item line so recipe
   consumption, COGS, kitchen tickets and reporting stay correct. No invented "balance" line.
5. **Atomic + idempotent + concurrency-safe + fully reversible**, like R3-A.

## Why the general case is unprovable in this model

### Case 1 — amount-level partial payment (payment_status='partial', no item-level split) → **BLOCKED**
A plain partial payment (e.g. $20 cash against a $50 bill) records a `pos_payments` row but creates **no
`pos_split_allocations`**. There is therefore **no canonical attribution of which items/quantities are unpaid** —
the remainder exists only as an *amount*. Moving an amount to the primary would require either:
- (a) inventing a synthetic non-canonical "transferred balance" line with no `menu_item_id` — which breaks
  invariant 4 (recipe/COGS/kitchen/reporting all key off real item lines), or
- (b) moving the underlying item lines wholesale and leaving the $20 payment stranded on a now-empty source —
  which breaks invariant 2 (the payment loses the order it paid for) and invariant 3 (the $20 is now unattributed
  to any sale).

Neither is safe. **Unprovable → BLOCKED.**

### Case 2 — item split with PARTIAL-QUANTITY allocation → **BLOCKED**
`pos_split_allocations.allocated_quantity` can settle part of a line (e.g. 1 of 3 burgers paid). Moving "the other
2" requires **splitting an `order_item` row** — dividing `quantity`, `line_total`, `final_cost_snapshot`,
`overhead_cost_snapshot` and the per-unit kitchen-ticket/print history across the staying and moving halves. The
canonical model has **no primitive** that splits a settled-context order_item while preserving per-unit cost
snapshots and kitchen provenance. Attempting it would fabricate cost/÷ figures → breaks invariants 3 and 4.
**Unprovable → BLOCKED.**

### Case 3 — item split with only WHOLE-LINE unallocated items → *theoretically safe, still dark*
If every unpaid item is a whole line never touched by any settled allocation, moving those whole lines to the
primary and leaving the settled splits + payments + allocations on the source (which then becomes fully settled)
would, in principle, satisfy all five invariants. **But** this narrow case still requires its own: formal proof
that no allocation references the moved lines; a source-settlement recompute that reconciles sales/collected; a
kitchen-ticket consolidation that carries settled-context prep history; and a forced-concurrency suite against
payment / split-settle / shift-close. That is a separate certified sub-project; it is **not** implemented here and
remains dark. It must not ship until proven and Konan-reviewed.

## Enforcement (what is actually deployed)

- `_pos_merge_assert_eligible` (**UNCHANGED**) hard-rejects any bill with a payment (`MERGE_HAS_PAYMENTS`), a split
  (`MERGE_SPLIT`), a non-immediate settlement (`MERGE_ON_ACCOUNT`), consumed inventory (`MERGE_CONSUMED`) or an
  adjustment (`MERGE_HAS_ADJUSTMENTS`). `pos_merge_tables_v2` runs it for the primary **and** every source, so only
  fully-unpaid clean dine-in bills merge. This is the real, server-authoritative OFF switch for R3-B.
- `_pos_merge_split_mode_enabled()` (migration `20261009170000`) is the single documented flip point a future
  certified split-merge path would consult. It returns a hard-coded `false` with no argument, no table read and no
  setting lookup, and EXECUTE is revoked from PUBLIC/anon/authenticated. **No client payload, tenant configuration
  row, or ordinary DB GRANT/UPDATE can enable R3-B** — only a reviewed code migration that changes this body, which
  must itself pass certification and an explicit HUMAN GO. There is no production activation path.

## Conclusion

R3-B is **ACTIVATION BLOCKED** with the exact unprovable invariants named above (Cases 1 and 2), the one
theoretically-safe case (Case 3) left dark pending its own certification, and financial safety never weakened to
force a PASS. R3-A (fully-unpaid merge) is unaffected and certified on staging. Any future R3-B work starts from
Case 3 with a dedicated invariant proof + Konan financial/security review + forced-concurrency suite + explicit GO.
