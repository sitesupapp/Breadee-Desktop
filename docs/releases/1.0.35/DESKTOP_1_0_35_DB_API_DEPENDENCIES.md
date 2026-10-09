# DESKTOP 1.0.35 — DB / API DEPENDENCIES & SHARED-BACKEND DESIGN

Shared Supabase backend changes required by R1–R7. All additive/backward-compatible; staging-first; **prod only on explicit Production GO** after an identical prod preflight. Every change: Konan arch non-blocking (pre-impl) + impl review + staging acceptance. Status key: ✅ verified · ⛳ designed, Konan-arch-pending · 🔭 Wave-2+ design.

## R6 — OU-LOCAL CUSTOMER IDENTITY (coordinated shared-backend) — ⛳ Konan arch cycle-2 pending (Konan API transiently down)

**Essential R1–R7 requirement (not deferred).** Final behavior: the same canonical phone may exist independently in different OUs; no cross-OU exposure or unintended merging; all records preserved.

### Identity boundary (verified)
`branches` has no parent hierarchy (`is_main`, `unit_type`, no `parent_id`) ⇒ **`branch_id` IS the OU id, 1:1.** Identity key = **(tenant_id, branch_id, canonical `phone_e164`)**; for the rare unnormalizable phone (`phone_e164` NULL) fall back to **raw `phone` within the OU**.

### Writer / matcher inventory (complete)
Only three writers of `pos_customers`: `_customer_capture` (used by POS `pos_upsert_customer_core`, Call Center `cc_customer_save`, E-menu `emenu_create_lead`), `pos_delivery_clients_import` (CSV), `pos_delivery_client_set_consent` (id-based, no phone match — **no change**). **No `ON CONFLICT` on the phone index** anywhere. One benign `trg_pos_customers_updated`. `_customer_capture` EXECUTE acl = `postgres`,`service_role` only (**not** `authenticated`/`anon`) ⇒ reached only via auth-checked wrappers.

### Owner decisions (2026-10-08)
1. **Call Center** customers owned by the **Call Center OU**; destination/fulfillment branch never inherits/merges.
2. **E-menu**: when no authoritative OU resolves ⇒ **keep the lead, do NOT create a `pos_customer`**; **never** the first-active-branch fallback; branch-specific e-menus capture in their OU.
3. **Canonical E.164 uniqueness per (OU, phone)**: same canonical phone may exist across OUs, never duplicate within an OU; consistent normalization on every path; CSV `p_allow_duplicates` must **never** bypass canonical uniqueness within an OU; a same-OU canonical match with **conflicting** info returns a **CONFLICT for review** (no silent overwrite/merge).
4. **Reports** preserve separate OU-local identities (key on `customer_id`); any cross-OU phone roll-up is **analytical-only**, never identity merge.

### Changes
- **`_customer_capture` (CREATE OR REPLACE)** — signature/owner/grants/`SET search_path`/SECURITY DEFINER/error contracts preserved: (a) require a non-null authoritative `p_branch` for a NEW capture AND assert `branch.tenant_id = p_tenant`; (b) matcher **branch-scoped + canonical**: `tenant_id=p_tenant AND branch_id=p_branch AND phone_e164=v_e164` (null-e164 ⇒ raw within the OU); (c) **ID-path branch-scoped**: id match requires `tenant_id=p_tenant AND branch_id=p_branch` (a sibling-OU id is *not found*, fail-closed — fixes the SECDEF cross-OU risk); (d) advisory lock `cust:tenant:branch:e164`; (e) legacy **null-branch rows never matched/claimed/reassigned**; (f) non-destructive COALESCE update (same-OU canonical match = the SAME customer = dedup).
- **Index re-key (sequence, fail-closed window):** (i) **PREFLIGHT per-env** — 0 dup groups for `(tenant,branch,phone_e164)` and for `(tenant,branch,phone)`-where-e164-null, else **STOP + ESCALATE** (never auto-merge). *Staging now: 0 / 0, null_branch 0, raw_no_e164 2, total 45.* (ii) `CREATE UNIQUE INDEX CONCURRENTLY uq_pos_customer_ou_e164 ON pos_customers(tenant_id,branch_id,phone_e164) WHERE phone_e164 IS NOT NULL`; (iii) `CREATE UNIQUE INDEX CONCURRENTLY uq_pos_customer_ou_rawphone ON pos_customers(tenant_id,branch_id,phone) WHERE phone_e164 IS NULL AND phone IS NOT NULL`; (iv) deploy matcher + CSV + search changes; (v) `DROP INDEX uq_pos_customer_phone` (the global tenant-wide one). Create → switch → drop; invalid-index cleanup check.
- **CSV `pos_delivery_clients_import` (CREATE OR REPLACE):** canonical e164 OU dedup; `p_allow_duplicates` never bypasses canonical uniqueness within an OU; explicit `inserted/matched/skipped/conflict` per-row results; same-OU canonical+conflicting-info ⇒ `conflict` (no overwrite). New unique index backstops.
- **E-menu `emenu_create_lead` (CREATE OR REPLACE):** remove the coalesce-to-first-active-branch fallback; capture a customer only when an authoritative `v_branch` resolves; else skip capture and still store the lead (keep the exception-safe wrapper).
- **Active-OU search (desktop):** `searchCustomers` + customer reads add an explicit `branch_id = operator's ACTIVE branch` filter (RLS `can_access_branch` is permission-scoped, not active-OU-scoped) so a multi-OU user sees only the active OU's customers.
- **No change:** `pos_delivery_client_set_consent` (id-based, branch-authorized); reporting fns `accounting_receivables_*`, `pos_receivables_*`, `pos_range_report`, `pos_delivery_client_*` (key on `customer_id`; confirm per-fn during reconciliation tests).

### Backward compatibility & recovery
No RPC signature changes; behavior becomes consistently branch-scoped (reads/CSV already were). **Activation is a point of no return**: once genuine cross-OU same-phone rows exist, the global index / tenant-wide matcher cannot be restored without violating record preservation ⇒ staged validation + monitoring + **write-stop / forward-fix** + explicit HUMAN GO (not a naive index recreate).

### Staging test matrix (R6 OU-local)
two OUs same raw phone · equivalent formatted phones (e164) · concurrent POS/CSV capture · multi-OU user searching within one active OU · forged sibling customer id (fail-closed) · null-branch legacy rows (untouched) · unauthorized branch id · CC & E-menu routing (incl no-authoritative-branch e-menu) · old-client (1.0.34) compat · unique-conflict retries · receivables/report reconciliation (no identity merge).

---

## R1 — Transfer Open Orders — ✅ no DB change (verified live; see implementation log). Staging end-to-end acceptance still required for final cert.

## R2 — Edit Delivery Items — 🔭 CREATE OR REPLACE `pos_edit_order_line_core`: additively broaden `order_type` from dine_in to also delivery (dine_in path byte-identical) + add an `add_items` op (reuse `_pos_insert_order_items`); same eligibility (`sent_to_kitchen`+`unpaid`), same canonical reversal trigger. Konan arch non-blocking required before impl.

## R3 — Merge Tables — 🔭 NEW `pos_merge_tables_v2` (legacy byte-stable); additive FK cols `pos_orders.merged_into_order_id` + `merge_id` (DB-enforced same-tenant/OU); R3-B partial-paid = dark/opt-in, immutable payments, prove-or-block. Konan arch non-blocking required before impl.

## R4 / R5 / R7 — shared prereqs — 🔭 dark/default-OFF; activation-blocked per Web-owned contracts. (R4 `pos.force_end_shift` + recipient-acceptance close; R5 new default-OFF `pos.sales` + narrow `pos_assert_operator`; R7 inert `shift_approval_required`.) Konan arch non-blocking + (R5) security review required before impl.
