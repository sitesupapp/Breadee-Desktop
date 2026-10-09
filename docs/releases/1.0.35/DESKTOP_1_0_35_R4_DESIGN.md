# Desktop 1.0.35 — R4 Force End Shift (recipient-acceptance handover): Architecture Design

Status: **READ-ONLY AUDIT + DESIGN** (no code written). Staging `azjxprewycygsocusxjn` only; prod = HUMAN GO.
Date: 2026-10-09. Konan architecture review required before any implementation.

## Requirement (user-approved behavior)

- Preserve existing **Standard Transfer** with explicit recipient acceptance (`pos_order_transfer_create` →
  `pos_order_transfer_decide`), unchanged.
- `pos.force_end_shift` **OFF** ⇒ existing end-shift behavior unchanged (a shift with open orders cannot be ended).
- `pos.force_end_shift` **ON** ⇒ the source user may **initiate** the authorized handover workflow.
- The source shift stays **open** until the recipient accepts **and the complete transfer succeeds**.
- Recipient acceptance + order reassignment + source-shift closure = **one safe server-authoritative atomic workflow**.
- Rejection / timeout / concurrency conflict / failure ⇒ source shift NOT closed, orders NOT orphaned.
- Respect the existing pending-approval + reconciliation lifecycle (R7).
- Do **not** silently substitute the separately-permissioned **Force Transfer** (`pos_order_transfer_force`,
  `pos.orders.force_transfer`) for recipient acceptance.

## Audit of existing contracts (live staging, read-only)

- **Recipient-acceptance spine.** `pos_order_transfer_create` (perms `pos.transfers.create` +
  `pos.transfers.select_recipient`; `create_client_token` idempotency; claims table prevents double-transfer;
  orders must be open/unpaid, same shift+branch, owned by the caller's **open** shift) creates a
  `pending_transfer`. `pos_order_transfer_decide` (recipient = `to_user_id`, perm `pos.transfers.approve`) locks
  source+target shifts, CAS on the transfer, re-validates each order (still on from-shift/from-user, not finalized,
  version matches) and reassigns `shift_id`+`cashier_user_id` in place (version+1). **It does NOT close the source
  shift.** This is exactly the recipient-acceptance mechanism R4 must reuse — NOT the Force Transfer path.
- **Shift close.** `pos_end_shift_core` **blocks** when `pos_shift_unresolved_orders(shift) > 0` (raises 23514 with
  the unresolved list). On success it reconciles cash from the shift's payments + the closing cashier's
  `actual_cash_counted`, writes `report_json`, sets status `pending_manager_review`, and freezes material demand
  (`_pos_freeze_shift_material_demand`). Auth: self (`pos.end_own_shift`), supervisor (`pos.close_other_shifts`),
  or owner (R5 territory). "Unresolved" = not `_pos_sale_is_finalized` and not voided/cancelled/refunded.
- **R7 lifecycle.** `pos_review_shift` approves/rejects a `pending_manager_review` shift; **inventory posts on
  approval**. R4's atomic close MUST land the source shift in `pending_manager_review` (same state) so this
  lifecycle is unchanged.
- **R5 dependency.** If the initiator is an owner-operator, their ability to operate POS is gated by R5 ("POS
  Sales"), not yet implemented. R4 initiation is a POS operation ⇒ R4 depends on R5 for owner-operators, and the
  initiator must never be allowed to approve their own resulting `pending_manager_review` shift (separation of
  duties — already true: the manager reviews later; the recipient, not the initiator, accepts the transfer).
- **Permissions.** `permission_catalog()` has `pos.open_shift / end_own_shift / close_other_shifts /
  approve_shifts`, the transfer keys, and `pos.orders.force_transfer`. **There is NO `pos.force_end_shift` key** —
  R4 must add it (code constant in `permission_catalog()`, default-deny; Web Roles-UI surfacing = Web handoff, as
  with B1's keys).
- **Transfer table.** `pos_order_transfers` already has `transfer_mode` (`standard`/`force`) + `resolution`
  columns; status enum = `pending_transfer`/`approved`/`rejected`.
- **Order-creation serialization (critical).** `pos_save_order` is the SOLE creator of dine-in bills. It verifies
  the shift is `open` with a **plain SELECT (no row lock)** and serializes only **per-table**
  (`pg_advisory_xact_lock('pos_table_bill:'||tenant||':'||branch||':'||table)`). It does **not** take the shift
  row lock. `pos_order_transfer_decide` locks the shift row FOR UPDATE, but a row lock does not block a plain
  SELECT — so a new bill on **another table of the same shift** can be created concurrently with an acceptance.

## Design

### Initiation (`pos.force_end_shift` ON)
A new RPC `pos_force_end_shift_begin(p_payload)` (SECDEF, authenticated-only):
1. Authn + `pos_assert_operator(tenant)` + (R5) owner-operator POS-Sales gate + `can_access_branch`.
2. Require `pos.force_end_shift` (new catalog key, default-deny). OFF ⇒ feature is invisible; existing end-shift unchanged.
3. Lock the caller's own **open** source shift FOR UPDATE; require `cashier_user_id = auth.uid()` (own shift only).
4. Snapshot the **FULL** unresolved set `pos_shift_unresolved_orders(shift)` (NOT a manual subset) so acceptance
   leaves zero behind.
5. Create a `pending_transfer` with **`transfer_mode='shift_handover'`** (a NEW mode, distinct from `force`),
   `to_user_id` = chosen recipient (same validation as `create`), covering exactly that unresolved set, via the
   existing create path (claims + items + `create_client_token`).
6. Capture the source cashier's **closing inputs up front** — `actual_cash_counted`, cash currency,
   `delivery_fee_cash_treatment`, closing note — persisted with the handover (new columns on
   `pos_order_transfers` or a 1:1 `pos_shift_handovers` row). The recipient cannot supply these; the source
   cashier owns their reconciliation.
7. Source shift stays `open`.

### Acceptance (recipient) — ONE atomic tx
Extend the decide path (or a dedicated `pos_force_end_shift_accept`) so that for a `shift_handover` transfer, after
the existing reassignment it also closes the source shift, atomically:
1. Existing `decide` reassignment (orders → recipient's open shift, CAS re-validated) — unchanged logic.
2. Re-assert, under the **source-shift serialization** (see Concurrency), that **zero unresolved orders remain**
   on the source shift. If any remain ⇒ raise `HANDOVER_SHIFT_NOT_EMPTY` and roll back the ENTIRE acceptance
   (orders not reassigned, shift not closed) — never a partial close, never an orphan.
3. Run an extracted reconciliation core `_pos_end_shift_reconcile_and_close(shift, actual_cash, treatment, note,
   closed_by, supervisory)` using the pre-captured inputs → sets `pending_manager_review`, `report_json`,
   freezes material demand. `closed_by` = source cashier (owner of the reconciliation); the record notes the
   recipient as the acceptance trigger.
4. Mark the transfer `approved`, `resolution='shift_handover_closed'`.

### Rejection / timeout / conflict / failure
`decide reject`, a CAS/`VERSION_CONFLICT`, `TRANSFER_CONFLICT`, or any raised error ⇒ whole tx rolls back: orders
stay on the source shift, source shift stays `open`, nothing orphaned. Timeout = the transfer simply stays
`pending_transfer` (the source cashier can cancel it via `pos_order_transfer_cancel`, restoring the normal state).

## Concurrency / phantom resolution (the hard problem)

The orphan risk: between the acceptance's "zero unresolved" recount and the status flip to `pending_manager_review`
(one tx), a concurrent `pos_save_order` could create a new open bill on **another table** of the source shift.
Because `pos_save_order` reads shift status with a plain SELECT and takes only a **per-table** advisory, neither the
acceptance's shift-row FOR UPDATE nor a per-table lock blocks it. A post-recount alone is therefore insufficient
(same class as R3-item-3).

**Required shared serialization (proposed):** add a **per-shift** advisory
`pg_advisory_xact_lock('pos_shift_open:'||tenant||':'||shift)` to `pos_save_order` (acquired when it resolves the
target open shift) AND acquire the same lock in the R4 acceptance-close before the unresolved recount. Then no new
bill can be created on the source shift while the close is in flight, and the recount becomes authoritative. This is
a **small, backward-compatible** addition to `pos_save_order` (adds a lock, no behavior change) but is **fleet-wide
(affects Web order creation)** and therefore preservation-sensitive — it must be Konan-reviewed and proven not to
change `pos_save_order`'s outcomes or materially regress throughput.

**Prove-or-block condition:** if the fleet-wide `pos_save_order` serialization addition is rejected (blast radius)
or cannot be proven safe, then **atomic accept+close cannot be made phantom-safe with the existing architecture →
R4 activation BLOCKED** with this exact reason, and the fallback (non-atomic: acceptance reassigns; the source
cashier then ends the shift via the normal, already-safe `pos_end_shift` which BLOCKS on any unresolved order) is
offered as a separate decision — but that fallback does **not** satisfy the "one atomic workflow" requirement, so it
would be surfaced as a requirement conflict, not silently substituted.

## State machine

| From | Event | Guard | To | Side effects |
| --- | --- | --- | --- | --- |
| (no handover) | initiate | `pos.force_end_shift` ON; own open shift; recipient valid | transfer `pending_transfer` (mode `shift_handover`) | items+claims created; closing inputs captured; **source shift stays open** |
| `pending_transfer` | recipient reject | recipient; `pos.transfers.reject` | `rejected` | source shift open; orders unchanged |
| `pending_transfer` | source cancel | sender; `pos.transfers.cancel_others`/own | `rejected`/cancelled | claims released; source shift open; orders unchanged |
| `pending_transfer` | recipient accept | recipient; `pos.transfers.approve`; target open shift; CAS; **0 unresolved remain after reassignment** under per-shift lock | `approved` + source shift `pending_manager_review` | orders reassigned; source shift reconciled+closed+material-demand frozen (atomic) |
| `pending_transfer` | accept but unresolved remain / CAS fail / conflict | — | stays `pending_transfer` (tx rolled back) | NOTHING closed, NOTHING orphaned |
| source shift `pending_manager_review` | manager review | `pos.approve_shifts`; reviewer ≠ initiator (SoD) | `approved`/`rejected` | inventory posts on approval (R7, unchanged) |

## Preservation gate

Unchanged: Standard Transfer (`create`/`decide` default path), Force Transfer (`pos_order_transfer_force`,
separate perm), `pos_end_shift_core` normal path (if a reconciliation core is extracted, the normal path must stay
byte-identical), `pos_review_shift` + inventory-on-approval, all 1.0.34 + R1/R2/R3/R6/Transfer behavior. New: one
permission key, one `transfer_mode` value, handover closing-input storage, one initiate RPC, the acceptance-close
extension, and (pending Konan) the `pos_save_order` per-shift advisory.

## Open decisions for Konan

1. Approve the **fleet-wide `pos_save_order` per-shift advisory** (required for phantom-safe atomic close), or
   declare R4 atomic close BLOCKED.
2. Extract `_pos_end_shift_reconcile_and_close` from `pos_end_shift_core` (preservation of the normal path) vs. an
   alternative close mechanism.
3. `closed_by` attribution (source cashier vs recipient) and SoD confirmation for the later manager review.
4. Where to store the pre-captured closing inputs (columns on `pos_order_transfers` vs a `pos_shift_handovers` 1:1 table).
