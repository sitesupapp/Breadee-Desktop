# DESKTOP 1.0.35 — R2 Delivery Order Item Editing — DESIGN (Konan-converged)

Branch `feature/desktop-1.0.35-cumulative`. Staging `azjxprewycygsocusxjn` only; NO prod.
Konan architecture: cycle-1 sess_0f1ea210 (BLOCKER, all AUTO-FIX) → cycle-2 sess_079d2551 (BLOCKER, all
AUTO-FIX; the three original blockers confirmed resolved in principle; residual = idempotency-sequence
precision → verified at the implementation-review gate per the 3-cycle rule).

## Live contracts (extracted; drift gate satisfied)
- `pos_edit_order_line_core(jsonb)`: only order-type gate is `order_type='dine_in'`; reuses pos_assert_operator,
  perm `pos.edit_orders`, CAS `pos_entity_version`, REASON_REQUIRED on reduction, `_pos_insert_order_items`,
  kitchen rollup, inventory reversal (DELETE trigger). Inline total = `greatest(round(subtotal-disc,2),0)`.
- Canonical total composer `finance_apply_order_totals(order)`: early-returns NULL (no-op) when taxes off + no
  auto-charges + delivery_fee=0 + no combos; else sets `total_amount = total_due` (subtotal−disc+delivery_fee
  +tax+charges±rounding); DELETEs+reinserts tax/charge lines (idempotent).
- Create path `pos_save_order`: sets `total_amount = round(greatest(subtotal-coalesce(discount_amount,0),0),2)`
  THEN calls `finance_apply_order_totals`. This IS the delivery total contract (NO delivery_fee in the
  provisional — finance composes it).
- Effective price (= `pos_menu`): `coalesce(menu_item_ou.price_override, menu_items.price)`; modifier price =
  `modifier_options.extra_price`. No standalone price-override table. Availability via
  `menu_item_branch_availability`.
- Kitchen: DEFERRABLE constraint trigger `trg_pos_orders_kitchen_tickets` (AFTER INS/UPD on pos_orders) →
  idempotent `kitchen_generate_tickets_for_order` (`where not exists kitchen_ticket_items`). So any pos_orders
  UPDATE (version bump) generates tickets for NEW items only — the existing transition; no new kitchen logic.
- Cost snapshots stamped by `trg_pos_item_stamp_cost` (BEFORE INSERT). Delete reverses inventory +
  cancels kitchen via BEFORE DELETE triggers. All reused unchanged.
- NO per-line POS-delivery dispatch table (`internal_order_fulfilments` = procurement/material, not POS
  delivery). POS delivery dispatch is order-level; `delivery_settlements` are post-payment (unpaid gate
  excludes). So editing lines desyncs no dispatch table.
- Idempotency: `pos_op_replay(tenant,op,op_type,branch)` advisory-locks (tenant,op), matches (tenant,
  client_op_id), STRICT branch, returns cached `result_json` or NULL. `pos_op_submissions` has `created_by` +
  `request_fingerprint`. `pos_op_record(tenant,branch,op,op_type,entity,result)` (no fp param → wrapper sets fp
  via follow-up UPDATE). Pattern proven in B1 transfer.

## Implementation (staging migration + client + tests)
### Backend
1. `pos_edit_order_line_core` CREATE OR REPLACE — TWO surgical changes only:
   - gate → `order_type IN ('dine_in','delivery')` (same status='sent_to_kitchen'+payment='unpaid').
   - totals/label branch by order_type: **dine_in BYTE-IDENTICAL** (inline total, `dinein_*` labels, NO
     finance_apply); **delivery**: same UPDATE then `finance_apply_order_totals(order)`, re-read total_amount,
     `delivery_*` labels. Everything else unchanged.
2. NEW `pos_add_order_items_core(jsonb)` (SECDEF, search_path=public, EXECUTE revoked from PUBLIC+authenticated)
   — pure mutation: resolve prices server-side (coalesce(menu_item_ou.price_override, menu_items.price) +
   modifier_options.extra_price; full pos_menu predicates: same-tenant, order OU/branch, branch availability,
   active item/group/attachment/option); insert via `_pos_insert_order_items` with SERVER-resolved prices;
   UPDATE pos_orders (subtotal/discount/status/version+1, provisional total) → fires kitchen trigger;
   `finance_apply_order_totals`; activity log `delivery_items_added`. Append-only.
3. NEW wrapper `pos_add_order_items(jsonb)` (SECDEF; EXECUTE granted to authenticated only) — orchestration in
   Konan's exact order: **lock order FOR UPDATE → derive tenant/branch from locked row → authz
   (pos_assert_operator + can_access_branch + perm pos.edit_orders) → eligibility (delivery+STK+unpaid) →
   `pos_op_replay`; on hit re-check actor (created_by=auth.uid else CROSS_ACTOR_REPLAY_REJECTED) + fingerprint
   (else IDEMPOTENCY_PAYLOAD_MISMATCH) and RETURN cached (no mutation, no version bump) → else CAS
   expected_version → call _core → `pos_op_record` + UPDATE request_fingerprint → return.** Delivery-only.
   Key = (tenant, op_type, client_op_id) + STRICT branch (NOT actor). fingerprint = md5(order_id + sorted items
   (menu_item_id,qty,sorted option_ids) + expected_version).
### Client
- `rpc.ts`: PosRpcName += `pos_add_order_items`.
- `orders.ts`: `buildAddItemsPayload` (items carry NO price) + `addOrderItems`.
- `DeliveryOrderDetail.tsx`: edit/delete/add controls gated on `sent_to_kitchen`+`unpaid`+`pos.edit_orders`,
  reusing `editReason`; mirror DineInWorkspace edit UX. Dine-in round-append flow UNCHANGED.
### Tests (Konan matrix)
concurrent CAS serialize; identical client_op_id retry exactly-once (no version bump, no dup audit/kitchen);
fingerprint mismatch; cross-actor + cross-tenant/OU reject; client price/modifier tampering ignored; foreign
option reject; finance early-return totals; delivery totals WITH fee/tax/charge (no duplicate tax/charge rows);
rollback; kitchen idempotency/history; dine-in outputs byte-identical incl PROOF dine-in never calls finance.

## Rollback: fix-forward; a rollback restores prior `pos_edit_order_line_core` and drops the two new fns.
