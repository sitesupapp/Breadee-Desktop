# DESKTOP 1.0.35 — IMPLEMENTATION LOG

Branch `feature/desktop-1.0.35-cumulative` ← `candidate/posfinal-prod-1034` (61de76a, Desktop 1.0.34). Worktree `D:\BreadeeDev\desktop-1035-wt` (prod identity `app.breadee.desktop`). Dirty rc5 clone untouched. Staging-first; no prod without explicit Production GO. Every wave: Preservation Gate vs 1.0.34 + server-authoritative tenant/OU/role + tx/idempotency proofs + Konan impl review + automated regression + staging acceptance evidence. Unsafe activation = fail-closed + BLOCKED (never PASS). R8 = documentation-only (deferred).

Dev note: worktree `node_modules` is a junction → main clone's `node_modules` (gitignored; remove before finalizing). Node test/tsc launches intermittently hit the Windows spawn storm (exit 5 / "Access is denied") — env instability, not code failure; retry.

## Workspace
- 2026-10-08: clean worktree/branch created off 1.0.34 baseline (`git worktree add`). Verified tauri.conf version 1.0.34, identifier app.breadee.desktop. 491 files.

## Wave 1 — lowest risk, ships (R1 verify · R6 OU-scoped + name-only · R8 doc). R3-C provenance moved to Wave 2 (written by the merge RPC).

### R1 — Transfer Open Orders (data layer) — VERIFY = PASS (no code)
Evidence (live `pos_order_transfer_decide`; function present on prod — body parity to spot-check before any prod claim):
- Reassignment = single `UPDATE pos_orders SET shift_id=target, cashier_user_id=to_user, pos_entity_version+1, updated_by/at` over the transfer's order set. Touches ONLY ownership, IN PLACE (same order id). Items/qty/price/modifiers/discounts/status/table_id/customer_id/payment_status/total untouched → field preservation by construction.
- Atomic (one tx); all-or-nothing (`bool_and(from_shift & from_user & not finalized & status∉voided/cancelled/refunded & pos_entity_version=expected)` precheck → VERSION_CONFLICT else); exactly-once (idempotent replay); CAS + FOR UPDATE on shifts+orders; cross-tenant/OU guarded; never marks paid/complete.
- Acceptance ✓✓✓✓. **R1 PASS** (inherent in 1.0.34 baseline; no change).

### R6 — Customer create/search + OU-local identity
**(a) Name/phone/both creation — CODE COMPLETE; typecheck PASS; regression PASS (existing); Konan impl=FIX (no blockers).**
Change (desktop-only, no shared DB): enable the already-server-supported `allow_name_only` on the delivery create surface (the on-account picker already used it).
- `src/components/pos/CustomerDialogs.tsx` (CustomerFormDialog): create submit gate now allows name-only (phone blank + name non-empty); a non-empty phone must still normalize; edit rule unchanged; subtitle → "Enter a name, a phone number, or both."
- `src/screens/pos/DeliveryWorkspace.tsx`: `decideCreate(..., allowNameOnly:true)` + seed create dialog `name/phone` from the decision; `buildCreatePayload(..., allowNameOnly:true)`. (Debounced search already shows matching customers → operator can pick existing; names are NOT auto-merged per R6.)
Evidence: `tsc --noEmit` exit 0. Customer tests run singly (project convention): create 12/12, search 18/18, contract 18/18, display PASS — no regression. Focused name-only test `test/pos-customer-nameonly.test.ts` WRITTEN (decideCreate/buildCreatePayload matrix: name-only/phone-only/both/blank/invalid-phone/opt-in-gate) — execution pending (spawn storm); logic traced against lib API.
Konan impl review (sess_0558a0e3): **FIX, no blockers** — "Wave 1 changes match the approved desktop-only architecture." FIX items: (1) add focused regression for the changed paths [test written, run pending]; (2) run staging two-OU scenario [pending live staging]; (3) record scope explicitly [done here].

**(b) OU-LOCAL IDENTITY (same phone creatable/lookup in two OUs) — BLOCKED (reported, not PASS). Konan-confirmed.**
Compatibility/dependency review: `_customer_capture` (single shared matcher) matches customers by `tenant_id + phone` TENANT-WIDE (not branch), SECURITY DEFINER, tenant+e164 advisory lock; called by `pos_upsert_customer_core` (POS + web delivery), `cc_customer_save` (call center), `emenu_create_lead` (e-menu), `pos_delivery_clients_import` (CSV). Uniqueness = UNIQUE INDEX `uq_pos_customer_phone(tenant_id,phone) WHERE phone NOT NULL` — relaxing to `(tenant,branch,phone)` is data-safe but GLOBAL: a POS-only matcher change still cannot insert a 2nd same-phone customer in another OU because the global index blocks the insert. ⇒ true OU-local identity requires branch-scoping the shared matcher AND re-keying the global index — both change Web-channel identity (e-menu/call-center/CSV) = fleet-wide, Web-touching. Per user directive (no Web program; index change needs full compat review before staging) ⇒ **BLOCKED pending a coordinated/approved plan + Web-side review.** Konan impl review independently confirmed: "the BLOCKED determination is correct… No safe additive Desktop-only path exists within the current pos_customers contract."
OU-scoped VISIBILITY holds today: `pos_customers` RLS SELECT = `tenant_id = current_tenant_id() AND can_access_branch(branch_id)` (verified) — a cashier sees only their OU's customers; new rows carry `branch_id`. Residual (part of the BLOCKED scope): a same-phone create in OU-B currently matches/mutates OU-A's row under SECURITY DEFINER (cross-OU mutation) and cannot create its own — exactly what the OU-local change would fix. Current tenant-wide dedup preserved (fail-closed, no regression).

**R6 release scope: name-only creation DELIVERED (pending test-run + staging); OU-local same-phone-in-two-OUs UNSUPPORTED/BLOCKED.**

### R8 — Desktop/Web parity — DOCUMENTATION-ONLY (deferred; concise handoff from R1–R7 findings). Must not block R1–R7.

## Remaining Wave-1 steps
- Run `test/pos-customer-nameonly.test.ts` (blocked by active spawn storm; retry).
- R6 name/phone/both live staging acceptance (desktop browser).

## R6 OU-LOCAL IDENTITY — shared backend (re-scoped from BLOCKED to ESSENTIAL; owner-authorized)
Konan arch: cycle-1 BLOCKER→…→**cycle-4 FIX, NO BLOCKERS, "non-blocking for staging implementation"** (sess_0606a353). Owner decisions fixed: branch=OU; CC→Call Center OU; E-menu no-OU⇒keep lead,no capture; canonical E.164 uniqueness per OU; reports key customer_id; conflict rule (name-diff ⇒ CUSTOMER_IDENTITY_CONFLICT, per-channel, never overwrite); read isolation = server-enforced OU scoping WITHOUT fleet-wide RLS tightening/direct-SELECT revocation (broader active-OU RLS redesign deferred/Web-coordinated); conflict authority = existing perms (customers.manage / create_orders).

**STAGING migrations applied + PROVEN:**
- m1 `r6_oulocal_m1_normalizer_conflict_infra`: `_pos_name_norm` (NFC+trim+collapse+casefold; verified null/blank/whitespace/case/NFC-composed==decomposed) + `pos_customer_identity_conflicts` token/audit store (RLS-enabled, no policies, revoked from anon/authenticated).
- m2 `r6_oulocal_m2_customer_capture_branch_scoped`: `_customer_capture` rewrite — branch-scoped canonical matcher (e164 preferred, raw fallback, index-aligned), ID-edit vs no-ID separation (sibling-OU id fail-closed; phone-change collision ⇒ conflict), conflict detection + server token, conflict-ACK path (validates token tenant/OU/canonical/matched/issued_to/expiry, consumes, requires customers.manage|create_orders, links WITHOUT modifying identity, audited), 23505 handler scoped to the two new OU indexes only (no-row⇒rethrow), per-(tenant,branch,canonical) advisory lock, non-destructive COALESCE (no name overwrite on no-ID match), branch∈tenant assert. Address block preserved verbatim.
- m3 `r6_oulocal_m3_index_rekey_oulocal`: created `uq_pos_customer_ou_e164 (tenant,branch,phone_e164) WHERE e164 NOT NULL` + `uq_pos_customer_ou_rawphone (tenant,branch,phone) WHERE e164 NULL`, dropped global `uq_pos_customer_phone`. (Staging non-concurrent; PROD plan = CONCURRENTLY + write-quiesce + re-drift.)
- Preflight (staging) CLEAN: 0 e164-mismatch, 0 null tenant/branch, 0 branch-tenant mismatch, 0 OU-dups both populations.

**PROVEN on staging (tenant #2101, Main a5469a61 + Aramoun ae8ccab9, phone 70999777→+96170999777):**
- ✅ Same phone in 2 OUs ⇒ 2 DISTINCT customers (Main 64e798be + Aramoun 404bf437, both is_new).
- ✅ Same-OU re-create ⇒ dedup (matched existing via phone_e164, is_new=false, still 2 rows total).
- ✅ Conflict: same OU+phone + different name ⇒ CUSTOMER_IDENTITY_CONFLICT + server token, NO create, NO overwrite.
- ✅ Conflict-ACK with token ⇒ linked to existing (conflict_linked), existing name UNCHANGED ("R6 Test Alpha"), no 3rd row.
- ✅ Test data cleaned up (back to 45 customers, conflict token cascaded).

**R6 OU-local REMAINING (server + client):** m4 CSV `pos_delivery_clients_import` (canonical OU dedup + 23505-catch + p_allow_duplicates can't bypass + conflict rows + deadlock-safe batch); m5 `emenu_create_lead` (remove first-active fallback; conflict flag; keep lead); m6 read RPCs `pos_customer_search`/`pos_customer_profile` (SECURITY INVOKER, active-OU scoped, PUBLIC revoked, app-role grant) + desktop wiring (searchCustomers/loadCustomerProfile) + conflict UX (handle CUSTOMER_IDENTITY_CONFLICT + token ack); m7 revoke direct INSERT/UPDATE/DELETE on pos_customers from authenticated (close direct-write bypass; verify no direct-write client first); verify order-creation RPCs enforce customer.branch_id=order branch; cc_customer_save conflict propagation (CC Web = handoff). Then Konan IMPLEMENTATION review + full cross-channel/concurrency/security regression (two-OU, raced, sibling-id, stale-ack, CSV conflicts, 1.0.34 fail-closed) + staging acceptance. PROD = separate GO after identical preflight.
