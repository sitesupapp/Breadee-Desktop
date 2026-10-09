# DESKTOP 1.0.35 — R2 Delivery Order Item Editing — CERTIFICATION

Staging-first. **NOT a Production GO.** Branch `feature/desktop-1.0.35-cumulative`; staging
`azjxprewycygsocusxjn`. Preserves 1.0.34, the Transfer workstream, R6 progress, and all dine-in behavior.

## Verdict
**CODE-CERTIFIED (Konan architecture + implementation PASS) + backend runtime-certified + automated-tested.**
One gate remains, non-code: the **credentialed interactive render acceptance (PENDING)** — the desktop test
runner cannot render React and no authenticated tenant session is available. Per directive req 10 this is
retained PENDING; R2 is **not** marked full PASS until that acceptance is performed.

## Konan
- Architecture: cycle-1 sess_0f1ea210 → cycle-2 sess_079d2551 (converged, all AUTO-FIX; direction confirmed).
- Implementation: cycle-1 sess_05fc91d0 (BLOCKER/all-AUTO-FIX) → cycle-2 sess_03ff08ed (3 add-path blockers,
  all AUTO-FIX) → **cycle-3 sess_008450c2 = PASS, BLOCKERS none, REQUIRED_FIXES none.**

## What shipped
- **Backend** (migration `20261009090000_r2_delivery_item_editing.sql` + `r2_add_items_hardening`, staging):
  `pos_edit_order_line_core` gate broadened dine_in→{dine_in,delivery} (dine-in byte-identical; delivery uses
  `finance_apply_order_totals` exactly as the create path + `delivery_*` labels); NEW
  `pos_add_order_items_core` + `pos_add_order_items` (server-authoritative pricing via `pos_menu` predicates;
  authoritative catalogue name snapshots; lock→authz→replay-before-CAS→CAS; actor + full-mutation-field
  fingerprint; modifier-qty guard; `_core` EXECUTE-revoked; wrapper authenticated-only).
- **Client**: `rpc.ts` allow-lists `pos_add_order_items`; `orders.ts` `buildAddItemsPayload` (no price) +
  `addOrderItems`; data layer additively gains `menuItemId`/modifier ids + `pos_entity_version`.
- **UI**: pure `deliveryItemEdit.ts` (gate/reason/mutation-reducer/add-draft) + hook
  `useDeliveryItemEditing.ts` + `DeliveryOrderDetail` per-line qty/remove/Options + Add-items (read-only
  preserved when ineligible) + `DeliveryAddItemsPicker` (reuses `MenuItemGrid`/search/`ModifierDialog`) +
  `DeliveryWorkspace` wiring + menu threaded from `PosWorkspace`.

## Evidence
- `tsc --noEmit` = 0; targeted suite 257/257 + R2 unit/regression tests (eligibility, reason prediction,
  reducer dup-submit/op-id-replay/stale-guard, add-draft identities-only/no-price, name authority, fingerprint
  field-binding, mqty guard). Preservation tests retargeted (delivery REUSES shared ModifierDialog — asserted
  as import, not weakened).
- **Staging runtime (impersonated mgr, QA #2101 Main; synthetic fixtures fully cleaned, 0 residual; real
  orders untouched):** add (server price + fee total), qty edit, removal (+reason-required), modifier change
  (+reason-required), idempotency exactly-once, fingerprint mismatch, cross-actor reject, **dine-in
  byte-identical**; hardening re-proven: name spoof ignored → catalogue names stored; modifier-qty change →
  `IDEMPOTENCY_PAYLOAD_MISMATCH`; modifier qty 0 → rejected (22023).

## Remaining (not code)
1. **Credentialed interactive render acceptance** (PENDING): quantity, removal/reason, modifier editing,
   add-items, busy locking, error recovery, ineligible read-only path — in the running desktop app with an
   authenticated tenant login. Needs a human session.
2. Production migration apply + any publish = separate explicit HUMAN GO.
