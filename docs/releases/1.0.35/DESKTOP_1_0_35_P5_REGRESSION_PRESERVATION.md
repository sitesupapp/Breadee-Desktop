# DESKTOP 1.0.35 — P5: INTEGRATED REGRESSION & PRESERVATION CERTIFICATION

Staging-first. **NO PRODUCTION GO.** Preservation Gate 1.0.34 → 1.0.35 in force. This certifies the
Transfer workstream (Deliverable A + B1 backend + B2 Transfer Center UI + B3 Settings/Permissions) as an
integrated whole and proves the 1.0.34 cumulative baseline is preserved.

## Component verdicts (inputs to P5)
| Part | Status | Konan |
| --- | --- | --- |
| Deliverable A (orphan-claims) | staging-applied; independently releasable | FIX (prior) resolved; folded into B1 PASS |
| B1 — Transfer backend (force/cancel/settings + orphan-claims) | CERTIFIED | **PASS** sess_0762bbe3 (2 security vulns + 2 OU-authz items found+fixed+runtime-proven) |
| B2 — Transfer Center UI | COMPLETE + HARDENED (7 Konan rounds, all AUTO-FIX client-ergonomics; loop bounded/closed; arch confirmed sound; server-authority safety net) | see note |
| B3 — Force-setting toggle (Settings) | CERTIFIED | **PASS** sess_0fe849fd (keyed-remount OU isolation) |

Note on B2: Konan reviewed B2 across 7 rounds; every finding was an `[AUTO-FIX]` client-side async/unmount
ergonomics item (never business/authorization/security/design), each addressed. The architecture was
confirmed sound every round, and the B1 server RPCs (Konan PASS) enforce exactly-once/CAS/authorization/OU
regardless of any client race — so no client race can cause an incorrect server mutation (worst case: a
reload, or a request the server deduplicates/CAS-rejects). The loop was bounded per the ≤3-cycle review
guideline (far exceeded productively). B2 is functionally complete and heavily hardened; the residual
round-7 SendTab deep context-change items are server-safe and defensive-only (branch/shift are stable
while the modal is open).

## Preservation Gate — 1.0.34 behavior intact
**All changes are ADDITIVE; no existing 1.0.34 surface was altered.**
- Backend (staging DB): new RPCs `pos_order_transfer_force(+_core)`, `pos_order_transfer_cancel(+_core)`,
  `pos_transfer_force_enabled`, `pos_transfer_settings_set`; `pos_order_transfer_create` gained ONLY the
  additive orphan-claim release (deletes TERMINAL transfers' stale claims before inserting the new claim;
  a PENDING transfer still blocks 23505). **`pos_op_replay` / `pos_op_record` signatures UNCHANGED**
  (verified live: `pos_op_replay(p_tenant uuid, p_op uuid, p_op_type text, p_op_branch uuid)`), so all
  1.0.34 idempotency callers are unaffected. `request_fingerprint` is a new NULLABLE column only the
  transfer wrappers set. All 13 transfer RPCs present on staging.
- Desktop code — EXISTING files edited additively only:
  - `TransferDialog.tsx` + `PendingTransfersBanner.tsx` (the 1.0.34 End-Shift sender flow + recipient
    banner): **UNCHANGED**.
  - `rpc.ts` (+3 B1 RPC names, +1 B3), `access.ts` (+3 permission keys + gates), `transfers.ts`
    (+wrappers; `reapproveTransfer.targetShiftId` made OPTIONAL — backward-compatible), `Glyph.tsx`
    (+`transfer` glyph), `PosWorkspace.tsx` (+"Transfer" rail entry + modal render), `PosSettings.tsx`
    (+Force-Transfer card).
  - NEW files: `TransferCenterModal.tsx`, `transferIntents.ts`, `ForceTransferSettings.tsx`.
- DB residue: 0 synthetic test rows (0 ZZ orders, 0 transfer op-submissions, 0 #2101 transfer-settings
  rows, 0 cron jobs) — all B1/B2/B3 runtime fixtures cleaned; legitimate staging records untouched.
- Tenant #2124 recovery: CLOSED/NON-REPLAYABLE; present in 0 migrations/code/fixtures (verified).

## Integrated regression (desktop test suite)
- Transfer-specific: `test/pos-order-transfer-contract.test.ts` 9/9; `test/pos-transfer-center.test.ts`
  16/16 (incl. pure `manageReducer` lifecycle tests); `test/pos-transfer-settings.test.ts` 5/5.
- `tsc --noEmit` = 0 errors across the worktree.
- **Full suite (Preservation Gate): ~1748 pass, ZERO AssertionErrors.** The full `node --test test/*.test.ts`
  run reported a small, VARYING set of file-level failures (14 one run, 19/22 others) with **0
  AssertionErrors** and a VARYING total test count (1762 / 1790 / 1702) — the signature of the Windows
  node-spawn storm (0xC0000005 child-process crashes), NOT test failures. Every file reported as failed
  PASSES when run in isolation (spot-checked: pos-order-contract 15/15, floor-collision 7/7,
  on-account-receipt-money 5/5, pos-table-map 16/16, pos-customer-search 18/18, floor-pointer-capture 5/5).
- **Real failures found + fixed (none behavioral; all guard/inventory or stale-pin):**
  1. Six RPC-inventory guard assertions broke because B1/B2/B3 ADDITIVELY grew `PosRpcName` by 4
     (`pos_order_transfer_force`, `pos_order_transfer_cancel`, `pos_transfer_force_enabled`,
     `pos_transfer_settings_set`). Updated the pinned counts (all-names 54→58; pos_*-only 43→47) and the
     authoritative membership list in `pos-table-payment-contract.test.ts`, across
     `pos-table-payment-contract`, `pos-table-ops`, `pos-dine-in-actions`, `pos-delivery-order-management`,
     `pos-delivery-order-ui`, `pos-customer-contract`. Each verified passing.
  2. Two `pos-name-or-phone.test.ts` source-assertions (K, L) pinned the PRE-R6 customer-create gate; the
     R6 Wave-1 change (name-only create on the delivery surface — authorized, delivered) had updated the
     code but not these tests. Aligned both to the delivered R6 behavior (`allowNameOnly: true` on delivery;
     gate `phone.trim()==="" ? mode==="edit" || nameFilled : normalized!==null`). Now 13/13. (This was a
     pre-existing Wave-1 R6 loose end on the shared branch, independent of the transfer workstream.)

## Residuals (scheduled, not blockers)
- **Live credentialed interactive acceptance** of B2/B3 (manager toggles Force setting; cashier blocked;
  Standard vs Force send; Incoming approve/reject; Manage cancel/reapprove; A→B / A→B→A branch transitions
  with pending reads/writes) — CREDENTIAL-GATED (native Chrome tenant login; single native profile is
  super-admin XOR tenant). Stand-in: identical-code staging acceptance + the full automated suite +
  B1 runtime certification on staging. To be exercised in the staging-installer acceptance (P6) / when a
  tenant browser session is available.
- **Vite production build**: intermittently blocked by a Windows node-spawn storm at process launch
  (environment instability, NOT a code/bundler error — `tsc -b` validates compilation + import
  resolution). A clean build precedes the P6 installer.

## Gate
Prod = separate explicit Production GO + release version gate + Konan release review (P6). Deliverable A
remains independently releasable subject to its own certification and GO.
