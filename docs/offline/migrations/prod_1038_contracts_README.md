# Desktop 1.0.38 — production server contracts (S1–S5, S2b; S6 separate)

> **S6 (Bug 3, separate migration):** `pos_open_shift_core` optional `require_new` → `SHIFT_ALREADY_OPEN`
> instead of adopting an open shift (chained offline open N+1 after an offline close of N). Files:
> `prod_1038_open_shift_require_new.sql` (+ `_ROLLBACK`, `_anchor_proof_READONLY`) and the staging pair.
> PROD pre `70c310a6…` → post `5dee6e73…` (CRLF body; anchor 1, inverse 1, round-trip = pre, read-only).
> STAGING pre `70af9174…` → post `eb54473f…`: rolled-back rehearsal of the verbatim staging forward +
> rollback files PASS (A–G), then APPLIED to staging (ledger `20261026184030`). PROD: NOT APPLIED — needs an
> exact GO. Without it the 1.0.38 client still fails closed (refuses `reused:true` for a chained open).

Status: **written and rehearsed, NOT applied.** Production (`cltlqfqormkhppmbvyrv`) was read with SELECT only.
Staging (`azjxprewycygsocusxjn`) was used only inside one DO block that ends in `RAISE EXCEPTION`, so it rolled back. After the run, staging was checked: the pre-images were unchanged, there were no v2/v4 functions, and no fixture rows remained.
Applying this needs an exact production GO plus a mandatory Konan review (financial, concurrency, OU, desktop). Include `ai-context/DESKTOP.md` in that review.

| File | Purpose |
|---|---|
| `prod_1038_offline_contracts.sql` | Forward migration. One transaction, with PRE and POST guards. Apply as `desktop_1038_offline_contracts`. |
| `prod_1038_offline_contracts_ROLLBACK.sql` | Rollback. Pre-publication only. It requires `set local breadee.rollback_1038_ack='PRE_PUBLICATION_NO_ADOPTION'` and refuses if it finds adoption evidence. |
| `prod_1038_anchor_proof_READONLY.sql` | SELECT-only proof against live production. |
| `prod_1038_staging_rehearsal_ROLLEDBACK.sql` | Staging behavioural rehearsal. It always rolls back. |
| `prod_1038_staging_rehearsal_pay_onaccount_ROLLEDBACK.sql` | The S4/S5 + S2b subset that was executed for S2b (§8.5). It always rolls back. |

All four SQL files are generated from one delta definition (anchor/replacement pairs plus the new function texts). Do not hand-edit the anchors.
S2b (Bug 9, On Account of a part-paid bill) was added to the same generator and the same single transaction; see §8. The S2b staging runs executed the generated `rehearsal(lean=True)` variant (S4/S5 pay + S2b on-account; the S2/S3 move/merge part is unchanged and was not re-run).

## 1. Fingerprints (live PROD, 2026-10-26, PostgreSQL 17.6)

**Rebuilt functions.** The signature does not change, so `CREATE OR REPLACE` keeps the owner, `SECURITY DEFINER`, `search_path=public` and the ACL.

| Function | PRE md5 | POST md5 (computed read-only on prod) | ACL (unchanged) |
|---|---|---|---|
| `pos_pay_order_core(jsonb)` | `e21bac394d8f06b9c63fda903d5651e5` | `95f3b2a43abb9b5eb60b0965c2735ba8` | `{postgres=X/postgres,service_role=X/postgres}` |
| `pos_pay_table_core(jsonb)` | `7b6ea08ffcbeca5f56d78d33c7cd1198` | `c0682f5d0edf0d0e6bda0db0b916e155` | same |
| `pos_move_table_core(uuid,uuid,integer)` | `ecb0e6f3f47d37dc2837ac44985e2e56` | `6195b2add5797e20e40c2d59b913b557` (**byte-identical to the staging body**) | same |
| `pos_complete_on_account_core(jsonb)` (S2b) | `0655ed697c7b94f2f50573ed10f321f7` | `01e57c4af3d5df7932020eaae7949b50` | same |
| `pos_complete_table_on_account_core(jsonb)` (S2b) | `fd0f3b5bd53504352080fb88bd670bdd` | `c0e34235829d65d633287b5289a54928` | same |

**New functions:**

| Function | md5 of `pg_get_functiondef` | ACL |
|---|---|---|
| `pos_move_table_v2(jsonb)` | `19c40c262fd55c7f68cfdf838d79422a` | `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` |
| `pos_merge_tables_v4(jsonb)` | `4624ca679d038c5b649e857e6b4d32d7` | same |

The md5 values were predicted locally and then matched exactly in the staging rehearsal. Production and staging have the same default function ACLs, so the post-grant ACL is expected to be the same.
The migration must be applied as `postgres`, as 1.0.37 was. If it runs as another role, the ACL grantor changes, the POST guard fails and the transaction rolls back.

**PRE-guarded unchanged dependencies:**

| Function | md5 |
|---|---|
| `pos_pay_order` | `70a7ccc1…` |
| `pos_pay_table` | `56588d0e…` |
| `pos_move_table` | `c342a7fa…` |
| `pos_merge_tables_v3` | `4eb57a93…` |
| `pos_op_replay` | `78e42ee7…` |
| `pos_op_record` | `8a2df61e…` |
| `pos_op_error` | `ed70a93f…` |
| `pos_op_branch_of` | `c8991f7c…` |
| `pos_split_settle_core` | `66c8b850…` |
| `pos_complete_on_account` (S2b wrapper) | `aff7ce60…` |
| `pos_complete_table_on_account` (S2b wrapper) | `0739f994…` |
| `_pos_recompute_order_payment` (S2b) | `3bfe2160…` |
| `pos_receivables_customer` (S2b balance derivation) | `2ffeed20…` |

The POST guard now re-checks **every** PRE-guarded dependency (generated from the same list).

## 2. Anchor proof (read-only on PROD)

| Function | forward counts | inverse counts | round-trip md5 = PRE | transcription md5 |
|---|---|---|---|---|
| pay_order_core | 1,1,1,1,1 | 1,1,1,1,1 | yes | `d3cccf48…` = local |
| pay_table_core | 1,1,1,1,1,1 | 1,1,1,1,1,1 | yes | `e2de7356…` = local |
| move_table_core | 1 | 1 | yes | `8e270dd6…` = local |
| complete_on_account_core (S2b) | 1,1,1,1,1 | 1,1,1,1,1 | yes (`0655ed69…`) | `788a1b94…` = local |
| complete_table_on_account_core (S2b) | 1,1,1,1,1,1,1 | 1,1,1,1,1,1,1 | yes (`fd0f3b5b…`) | `bdc929ba…` = local |

The S2b post-images were also predicted locally from verbatim transcriptions of the live bodies (md5 = PRE) and matched the prod-computed values exactly. Re-checked 2026-10-26: the S4/S1 pre-images and `pos_split_settle_core`, `pos_op_replay`, `pos_op_record` are still live.

## 3. Where prior payments live (S4 basis, from the live bodies)

`pos_split_settle_core` does three things, all under `pos_orders … FOR UPDATE`:
- inserts a `pos_payments` row (`order_id` = the parent order);
- inserts a `pos_split_settlements` row (`status='paid'`, `amount_order_ccy`, `payment_id`);
- inserts `pos_split_allocations` rows.

It never lowers `total_amount`.

**P** is the authoritative prior amount, in order currency:

    P = Σ pos_split_settlements.amount_order_ccy WHERE parent_order_id = order AND status = 'paid'

It is read under the same order row lock (pay_order_core locks the order; pay_table_core locks every open order of the table in loop 1).
`R = T − P`, where T is `total_amount`. For pay_order, T is taken after `finance_apply_order_totals`.

Rules:
- When `P > 0` and `R ≤ 0.005`, the call refuses with `ALREADY_PAID`.
- Any `pos_payments` row on the order that is not the payment of a paid split settlement gives `PAYMENT_RESIDUE`. That covers manual or orphan payments, refunds, and on-account deposits.
- A discount on a part-paid bill gives `SPLIT_DISCOUNT_UNSUPPORTED`.

Prod data shape (read-only):
- Open unpaid orders with a non-split payment: **0**.
- All 31 split settlements are `paid`.

**No prior payment rows** means the same code path and the same result JSON. The rehearsal proved `pay_table`/`pay_order` result JSON equal to the unchanged bodies, with identical payments.

## 4. Classification

| RPC | Verdict |
|---|---|
| `pos_pay_order_core` | **ADDITIVE SERVER CHANGE REQUIRED** (S4). Before this change it was UNSAFE: F1 double charge, 8 prod orders, $108.72. |
| `pos_pay_table_core` | **ADDITIVE SERVER CHANGE REQUIRED** (S4 + S5 optional pins) |
| `pos_pay_order`, `pos_pay_table` wrappers | **SAFE AS-IS**. Exactly-once by `client_op_id`. Replay has no actor/fingerprint check; the S5 pins carry the bill identity. |
| `pos_split_settle` / `_core` | **SAFE AS-IS** |
| `pos_move_table_core` | **ADDITIVE SERVER CHANGE REQUIRED** (S1 prod OU drift fix) |
| `pos_move_table` (legacy wrapper) | **SAFE AS-IS** for online use. **UNSAFE** for offline replay (no locks or pins), so use `pos_move_table_v2`. |
| `pos_move_table_v2` | **NEW (S2)** |
| `pos_merge_tables_v3` + helpers | **SAFE AS-IS**. Unchanged, and wrapped by v4. Direct offline use is UNSAFE (all-or-nothing map, no pins). |
| `pos_merge_tables_v4` | **NEW (S3)** |
| `pos_op_replay` / `pos_op_record` / `pos_op_error` / `pos_op_branch_of` | **SAFE AS-IS** |
| `pos_complete_on_account_core`, `pos_complete_table_on_account_core` | **ADDITIVE SERVER CHANGE REQUIRED (S2b)**. Before: UNSAFE for part-paid bills (proven on the live bodies, §8.2): paid-now cap, table allocation and reported outstanding all used T. After: SAFE, remainder-only (§8). |
| `pos_complete_on_account`, `pos_complete_table_on_account` wrappers | **SAFE AS-IS**. Exactly-once by `client_op_id` (`pos_op_replay`/`pos_op_record`); the S2b pins carry bill identity/amount. |
| `_pos_recompute_order_payment`, `pos_receivables_customer`, `post_from_pos_sale`, `post_from_pos_payment` | **SAFE AS-IS**. They already derive the receivable as `T − Σ pos_payments`. |
| `pos_merge_tables` v1/v2 | legacy, **UNSAFE**, do not use |

## 5. Client contract (1.0.38)

All refusals come from `pos_op_error`:
- SQLSTATE `P0001` with `detail = {"pos_error_code": CODE}`;
- authority refusals use SQLSTATE `42501` (some carry a code).

Replays must send the **frozen** request again. The fingerprints are canonical: sorted ids, sorted map keys, and JSON key order does not matter.

### 5.1 `pos_move_table_v2(p_payload jsonb)`

Request:

```json
{ "client_op_id": "uuid (REQUIRED)",
  "from_table_id": "uuid", "to_table_id": "uuid",
  "expected_order_ids": ["uuid", "..."],
  "expected_paid_settlements": { "<order_id>": 0 },
  "expected_from_version": 7, "expected_to_version": 3 }
```

- `expected_order_ids`: optional (the offline client must send it). It must be a non-empty array. It is compared by **set equality** against the source table's open orders.
- `expected_paid_settlements`: optional. It is a count of `status='paid'` split settlements per order. When the object is present, an absent key means 0.
- `expected_from_version` and `expected_to_version`: optional, each an int.

Response:

```json
{ "ok": true, "orders_moved": 1, "order_ids": ["uuid"], "from_table_id": "uuid", "to_table_id": "uuid",
  "from_version": 8, "to_version": 4, "table_versions": { "<from>": 8, "<to>": 4 },
  "pos_entity_version": 8, "idempotent": false, "result_code": "SUCCESS" }
```

A replay returns the stored result with `"idempotent": true, "result_code": "DUPLICATE_REPLAY_RETURNED"`.

Errors:

| Error | Client class |
|---|---|
| `MOVE_NO_OP` | VALIDATION |
| `MOVE_SAME_TABLE` | VALIDATION |
| `VERSION_CONFLICT` (source or destination) | CONFLICT |
| `MOVE_SOURCE_CHANGED` | CONFLICT |
| `MOVE_SOURCE_EMPTY` | CONFLICT |
| `MOVE_PAYMENT_STATE_CHANGED` | CONFLICT |
| `MOVE_DEST_OCCUPIED` | CONFLICT |
| `MOVE_DEST_UNAVAILABLE` (destination `inactive`) | CONFLICT |
| `IDEMPOTENCY_PAYLOAD_MISMATCH` | CONFLICT (a client bug) |
| `CROSS_ACTOR_REPLAY_REJECTED`, `CROSS_OU_REJECTED`, `OU_ACCESS_DENIED`, `CROSS_BRANCH_REPLAY_REJECTED`, permission/tenant errors (all 42501) | AUTHORITY_REFUSED |
| 22023: invalid payload, or the op id was already used for another operation type | VALIDATION |
| 40P01 / 55P03 | SERVER_RETRYABLE |

Moving a part-paid bill is allowed when the pins match. Payments and settlements stay unchanged.

### 5.2 `pos_merge_tables_v4(p_payload jsonb)`

Request:

```json
{ "client_op_id": "uuid (REQUIRED)", "primary_table_id": "uuid", "source_table_ids": ["uuid"],
  "expected_orders": { "<table_id>": "<order_id>" },
  "expected_paid_settlements": { "<order_id>": 0 },
  "expected_versions": { "<table_id>": 5 } }
```

- `expected_orders`: a bill-identity pin per table. Send it offline.
- `expected_paid_settlements`: when the object is present, an absent key means 0.
- `expected_versions`: may name **any subset** of the involved tables. `expected` is accepted as an alias.

Response: the v3 result plus extra keys:

```json
{ "ok": true, "merge_id": "uuid", "primary_order_id": "uuid", "primary_order_number": "…",
  "subtotal": 0, "total_amount": 0, "sources_merged": 1,
  "pos_entity_version": 12, "table_versions": { "<table_id>": 9, "...": 0 },
  "v4_fingerprint": "md5", "idempotent": false, "result_code": "SUCCESS" }
```

`pos_entity_version` is the primary **ORDER** version. Use `table_versions` for table CAS chaining.

Errors added by v4:

| Error | Client class |
|---|---|
| `MERGE_EXPECTED_MISMATCH` (a map names a table that is not involved) | CONFLICT |
| `VERSION_CONFLICT` | CONFLICT |
| `MERGE_BILL_CHANGED` | CONFLICT |
| `MERGE_PAYMENT_STATE_CHANGED` | CONFLICT |
| `OU_ACCESS_DENIED` (42501) | AUTHORITY_REFUSED |

The v3 codes pass through unchanged:
- `MERGE_NO_OP`, `MERGE_NO_SOURCES`;
- `MERGE_PRIMARY_EMPTY`, `MERGE_SOURCE_EMPTY`, `MERGE_AMBIGUOUS_BILL`;
- `UNSUPPORTED_STATE(reason)`, `MERGE_NO_SHIFT`;
- `MERGE_SHIFT_BUSY`, which is **SERVER_RETRYABLE**;
- `MERGE_SHIFT_CLOSED`, `MERGE_CROSS_SHIFT`, `MERGE_CROSS_CURRENCY`;
- `CROSS_ACTOR_REPLAY_REJECTED`, `IDEMPOTENCY_PAYLOAD_MISMATCH`.

Replay rules:
- A replay of a recorded op delegates to v3. v3 checks the actor and its own fingerprint and returns the stored result. v4 then also checks `v4_fingerprint`.
- Do not reuse an op id that an online direct v3 call recorded with a non-empty `expected`. That replay fails with `IDEMPOTENCY_PAYLOAD_MISMATCH`.

### 5.3 Pay binding (S5) and remaining-obligation semantics (S4)

`pos_pay_table(p_payload)` accepts the existing keys plus these **optional** keys:

```json
{ "table_id": "uuid", "method": "cash", "currency_code": "USD", "client_op_id": "uuid",
  "expected_version": 4,
  "expected_order_ids": ["uuid"],
  "expected_amount": 50000 }
```

- `expected_order_ids`: set equality with the table's open orders, checked under lock.
- `expected_amount`: in **order currency**. It is Σ R that the device collected, with a tolerance of 0.005.

Outcomes:

| Situation | Result |
|---|---|
| Open-order set differs from the pin | `PAY_BILL_CHANGED` |
| Table has no open order and **all** pinned orders are paid | `ALREADY_SETTLED` (the client may mark the settle as done) |
| Table has no open order and a pinned order is not paid | `PAY_BILL_CHANGED` |
| Amount due differs from `expected_amount` | `PAY_AMOUNT_CHANGED` |

Old callers that omit the keys see no change.

**S4, for both `pos_pay_table` and `pos_pay_order`:** after a paid split, the payment row and the result `amount` are **R, not T**. The result then also carries `prior_paid` (P, in order currency) and `prior_settlements` (a count). Those keys appear only when P > 0.

New codes:

| Error | Client class |
|---|---|
| `ALREADY_PAID` | CONFLICT (it does not mean "settled": the order is still open) |
| `PAYMENT_RESIDUE` | CONFLICT |
| `SPLIT_DISCOUNT_UNSUPPORTED` | VALIDATION |

The offline settle of a part-paid bill must send `expected_order_ids` and `expected_amount = R`.

## 6. Staging rehearsal (rolled back), results

Fixture:
- CPJ staging tenant, branch, and an open shift;
- the owner user set via JWT claims;
- LBP orders, USD tender.

| Test | Result |
|---|---|
| F1 reproduced on the **unchanged** bodies | T=150000, split P=100000, pay_table charged **150000** (2.7778 USD collected for a 1.6667 USD bill) |
| A: no prior payment | pay_table and pay_order JSON identical to the unchanged bodies; payments identical |
| B: pay_table after split | charged **50000** = R, `prior_paid` 100000, order completed/paid, Σ = 1.6667 USD; replay `idempotent:true`, still 2 payments, 1 submission |
| C: pay_order after split | charged **30000** = R |
| D: covered bill | `ALREADY_PAID` (pay_table and pay_order); no payment written |
| E: non-split payment present | `PAYMENT_RESIDUE` (both) |
| F: discount on a part-paid bill | `SPLIT_DISCOUNT_UNSUPPORTED` (both) |
| G (S5): wrong order pin | `PAY_BILL_CHANGED` |
| G (S5): wrong amount | `PAY_AMOUNT_CHANGED` |
| G (S5): correct pins | paid 25000 |
| G (S5): retry with a new op after paid | `ALREADY_SETTLED` |
| G (S5): a newer bill opened on the same table, retry pinned to the old bill | `PAY_BILL_CHANGED` (newer bill not paid) |
| S2: no op | `MOVE_NO_OP` |
| S2: move | ok; order on destination; returned versions = row versions; statuses available/occupied |
| S2: replay | `idempotent:true`, 1 submission |
| S2: different payload, same op | `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| S2: occupied destination | `MOVE_DEST_OCCUPIED`, order not moved |
| S2: wrong order pin | `MOVE_SOURCE_CHANGED` |
| S2: bad version | `VERSION_CONFLICT` |
| S2: split after capture | `MOVE_PAYMENT_STATE_CHANGED` |
| S2: part-paid move with correct pins | ok, payments unchanged |
| S2: cross-OU table | `CROSS_OU_REJECTED` (42501); legacy `pos_move_table` → 42501 |
| S2: second operator replays the op | refused (42501-class *permission* error: that user lacks `pos.tables.move`; see §7) |
| S3: merge with partial version map + order/paid pins | ok; source voided and `merged_into` the primary; primary total 20000; `table_versions` = row versions; 1 `pos_table_merges` row; submission has v3 fingerprint + `v4_fingerprint` |
| S3: replay | delegate, `idempotent:true`, same `merge_id` and versions, no new merge row |
| S3: changed pins | `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| S3: bad bill pin | `MERGE_BILL_CHANGED` |
| S3: bad version | `VERSION_CONFLICT` |
| S3: bad paid pin | `MERGE_PAYMENT_STATE_CHANGED` |
| S3: unknown table in map | `MERGE_EXPECTED_MISMATCH` |
| S3: part-paid source merge | source completed/paid at 12000, source payments unchanged, primary 17000 |
| S3: final pay_table on the primary | charged **17000** = R (design invariant 11) |

## 7. Fidelity limits and what is unproven

**Fidelity limits:**
- Staging `pos_pay_order_core` / `pos_pay_table_core` differ from prod. Staging uses `_pos_settlement_usd` and `_pos_assert_tender_currency` and moves the delivery-fee block.
  - The same anchors exist exactly once in both, and the S4/S5 delta text is identical.
  - The prod post-images are proven by read-only md5/anchor math only, not by execution.
- `pos_move_table_core` staging = prod post-image (exact).
- `pos_merge_tables_v3` staging logic = prod (only comments differ, per the design audit).

**Not exercised:**
- The `CROSS_ACTOR_REPLAY_REJECTED` branch of move_v2. The second operator was refused earlier by permission. The code is the same pattern as prod v3.
- Concurrency and deadlock behaviour. The lock order is advisory, then orders, then tables. It matches `pos_save_order` / `pos_pay_table_core`. Legacy v3 locks tables, then orders; a 40P01 between them is possible and is retryable.
- v4 replay of an op recorded by a direct v3 call.

**Business decisions (human gate A):**
- the refusal policy for a discount on a part-paid bill;
- `PAYMENT_RESIDUE` now also blocks `pos_pay_order` on the 7 prod on-account `completed/partial` orders. That path previously would have charged the full total again.
- an `ALREADY_PAID` bill stays open and needs a manual close path;
- remediation of the 8 over-collected orders ($108.72);
- ~~the on-account cores audit~~ done: S2b, §8 (the S2b refusal choices below are listed there for the same gate).

**Rollback:**
- It restores the exact pre-images (now five functions, incl. both on-account cores) and drops v2/v4.
- It re-opens F1, the prod OU drift and Bug 9.
- It also refuses on S2b adoption evidence: a recorded `pos_complete_on_account` / `pos_complete_table_on_account` result carrying `prior_payments`, or an On Account completion since `installed_at` of an order that already had a payment row before it was completed.
- It is **prohibited after 1.0.38 publication**: recovery after that is fix-forward only.

## 8. S2b — Bug 9: PARTIALLY PAID → ON ACCOUNT creates only the unpaid remainder

### 8.1 How On Account works on live prod (read-only trace)

- **There is no receivable table.** `pos_complete_on_account_core` (order) / `pos_complete_table_on_account_core` (table, every open order of the table, `FOR UPDATE` in id order) set `status='completed'`, `settlement_mode='on_account'`, `customer_id`. The order itself is the receivable.
- **Balance** = `total_amount − Σ pos_payments` of the order. `_pos_recompute_order_payment` writes `paid_amount_usd` and `payment_status` (unpaid/partial/paid, USD, 0.005 tolerance). `pos_receivables_customer` lists completed on-account orders in `unpaid/partial` with `bal_primary = total − paid_primary`.
- **Paid now** (`amount`, order currency) inserts `pos_payments` rows: one row (order path) or one per order, pro-rata (table path), in the open shift. These are the only drawer rows. The on-account part writes no payment row.
- **GL**: the `trg_accounting_pos_sale` trigger enqueues `POS_SALE:<order_id>` once on the transition to completed (`accounting_enqueue … on conflict (tenant_id,event_key) do nothing`). `post_from_pos_sale` posts Dr AR T. Each payment enqueues `POS_PAYMENT:<payment_id>`: Cr customer_deposits before the sale is recognised, else Cr AR. Deposits are moved to AR by `POS_DEPOSIT_APPLY:<order>`. So GL AR already nets to T − P − paid now.
- **Inventory/COGS**: only the completion triggers (`_pos_order_freeze_demand_on_finalize`) run. They are the same for every completion. There is no consumption on settle (COGS comes from the Daily-Used engine).
- **Idempotency**: the wrappers use `pos_op_replay` / `pos_op_record` with op types `pos_complete_on_account` / `pos_complete_table_on_account`. A replay returns the stored result with `idempotent:true`.

### 8.2 Root cause (live bodies)

P (split settlements and earlier tenders already on the order) is counted correctly by the balance derivation. The money is still wrong because the cores size everything else from the full total T:
- order: `if v_usd > v_total_usd + 0.005 then raise 'Amount paid cannot exceed the order total'` → paid now up to T is accepted (over-collection). It reports `outstanding = T − paid now` and `outstanding_usd = T_usd − paid now`.
- table: `if v_pay_primary > v_bill_total + 0.005 …` (T cap). The allocation is `round(v_pay_primary * v_finals[i] / v_bill_total)` (by T_i, not R_i). It reports `outstanding_primary = v_bill_total − paid now`.

Proven on the unchanged prod bodies (staging, rolled back):

| Case | Expected | Old body |
|---|---|---|
| G1: T=150000, split 100000 | outstanding 50000 | **reported 150000** (real balance 50000) |
| G2: same bill, 150000 paid now | refuse (R=50000) | accepted: Σ paid **250000** on a 150000 bill |
| G4: order T=50000, split 30000, 50000 paid now | refuse | accepted: Σ paid **80000** |
| G3: two orders R1=10000 / R2=20000, 30000 paid now | 0 left | o1 over-paid, o2 left owing **6154** |

Prod data: 37 on-account orders, 0 with a split or prior payment, 0 over-paid. The gap has not occurred yet.

### 8.3 Delta (both cores, same transaction as S1–S5)

P is computed per order as Σ over all `pos_payments` of the order, read under the existing order row lock(s): paid split settlements count at `amount_order_ccy`; other rows count as `pos_receivables_customer` counts them. R = max(T − P, 0) and R_usd = T_usd − Σ amount_usd.

- Paid now must be ≤ R, else `ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING`. The old T cap and message are kept for bills with no prior payments.
- Table: paid now is allocated by R_i. Reported `outstanding_primary` = Σ R_i − paid now. The order path reports `outstanding`, `outstanding_usd` = R − paid now.
- R ≤ 0.005 USD with P > 0 gives `ALREADY_PAID`. This is the same rule as the S4 pay cores. The order stays open and nothing is written.
- A discount on a part-paid bill gives `SPLIT_DISCOUNT_UNSUPPORTED` (as S4).
- Previous payment rows are never touched. The on-account part writes no payment row, and GL/POS_SALE and inventory are unchanged.
- No prior payment and no pins means identical arithmetic and result JSON. The new result keys appear only when P > 0.

### 8.4 Client contract (S2b)

**on_account_order** → `pos_complete_on_account(p_payload)`:
- Existing keys are unchanged.
- Optional `expected_amount` (order currency) = R before the amount paid now, with a tolerance of 0.005. If R differs, the call refuses with `ON_ACCOUNT_AMOUNT_CHANGED`.
- When P > 0, the result also carries `remaining`, `prior_paid` (order ccy), `prior_paid_usd` and `prior_payments` (row count). `outstanding` and `outstanding_usd` are R-based.

**on_account_table** → `pos_complete_table_on_account(p_payload)`:
- Optional `expected_order_ids` (a set of the table's open orders, checked under lock) and `expected_amount` (Σ R_i, order currency).
- Pinned and the bill differs → `ON_ACCOUNT_BILL_CHANGED`.
- Pinned and the table has no open order while every pinned order is completed (paid or on account) → `ALREADY_SETTLED`.
- The amount differs → `ON_ACCOUNT_AMOUNT_CHANGED`.
- When P > 0, the result carries `remaining_total`, `prior_paid` and `prior_payments`. `outstanding_primary` is R-based.

New refusal codes, all from `pos_op_error` (SQLSTATE `P0001`):

| Error | Client class |
|---|---|
| `ON_ACCOUNT_AMOUNT_CHANGED` | CONFLICT |
| `ON_ACCOUNT_BILL_CHANGED` | CONFLICT |
| `ALREADY_PAID` | CONFLICT |
| `ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING` | VALIDATION |
| `SPLIT_DISCOUNT_UNSUPPORTED` | VALIDATION |
| `ALREADY_SETTLED` | (the client may mark the op done) |

An offline On Account of a part-paid bill must send `expected_amount = R` (and `expected_order_ids` for a table) and a frozen payload on replay. Client amounts are guards only; R is always computed by the server.

### 8.5 Staging rehearsal (rolled back, two runs)

Both runs were one DO block ending in `RAISE`.
- **Fixture.** The exact **production** on-account pre-images were rebuilt on staging from the staging bodies (6 + 2 anchored text fixes, md5 asserted `0655ed69…` / `fd0f3b5b…`). The S2b deltas were applied through the same anchors. The post md5 asserted `01e57c4a…` / `c0e34235…`, and the transcription md5 of every applied delta equals the generator's value.
- **Run 1** = S4/S5 pay + S2b; accounting was inactive. Run 1 re-proved S4/S5 A–G: A identical, B charged 50000, C charged 30000, D `ALREADY_PAID`, E `PAYMENT_RESIDUE`, F `SPLIT_DISCOUNT_UNSUPPORTED`, G pins and `ALREADY_SETTLED`, newer-bill `PAY_BILL_CHANGED`.
- **Run 2** = S2b with the GL queue active (accounting activated in the txn).
- **Every success case asserted:**
  - the receivable equals R − paid now (`pos_receivables_customer` formula);
  - the reported outstanding is the same value;
  - prior payment rows are unchanged (ids, amounts);
  - new payment rows equal the paid-now amount exactly (0 rows when nothing was paid now);
  - there is exactly 1 `POS_SALE:<order>` outbox row per order;
  - the inventory/demand delta is 0.

| # | Scenario | Result |
|---|---|---|
| 1 | unpaid 2-order table + 40000 paid now; unpaid order + 20000 | result JSON, rows (ex ids), receivable and POS_SALE count **identical** to the old body |
| 2 | cash split 100000 of 150000, 20000 paid now, with pins | receivable **30000**, 1 new payment row of 20000, `prior_paid` 100000, POS_SALE 1 |
| 2x | earlier non-split tender 4000 on 10000 | receivable **6000** |
| 3 | card split 60000 of 90000, order path | receivable **30000**, 0 new rows, `payment_status` partial |
| 4 | cash + card splits 80000 of 100000 | receivable **20000** (`prior_payments` 2) |
| 5 | two part-paid orders (R 10000 + 20000), 15000 paid now | per order **5000 / 10000**, 2 new rows Σ 15000, POS_SALE 2 |
| 5b | same shape, R paid now | receivable 0, both orders completed/paid |
| 6 | R = 0 | `ALREADY_PAID` (table and order), nothing written |
| 7/8/9 | same `client_op_id` ×3 | `idempotent:true` ×3, same result, rows/GL unchanged, 1 submission |
| 10a | newer bill opened, replay pinned to the old one | `ON_ACCOUNT_BILL_CHANGED`, nothing written |
| 10b | item added, `expected_amount` stale | `ON_ACCOUNT_AMOUNT_CHANGED` (table and order), nothing written |
| 10c/d | current pins | R on account (25000 / 20000); retry with a new op → `ALREADY_SETTLED` |
| E1/E2 | paid now > R; discount on a part-paid bill | `ON_ACCOUNT_AMOUNT_EXCEEDS_REMAINING`, `SPLIT_DISCOUNT_UNSUPPORTED`, nothing written |

After both runs, staging was checked: the pre-images were unchanged (`49a5038b…`, `9c5b12f5…`, `fb94df9f…`, `eb063605…`), with 0 fixture orders, tables or customers, and `accounting_settings` was untouched.

**Not proven / residual:**
- Concurrency was not exercised. Correctness relies on the existing order row locks, which split settle and the pay cores also take.
- Staging's own `pos_receivables_customer` (a different body) showed 30003 for case 2, because of a USD-rounding path. The prod formula, reproduced exactly, gives 30000.
- An LBP device-side R must use `amount_order_ccy` for split rows, or `expected_amount` can be off by rounding.
- Business gate (A): refuse `ALREADY_PAID` rather than auto-close a zero-remainder bill, and refuse a discount on a part-paid bill.
