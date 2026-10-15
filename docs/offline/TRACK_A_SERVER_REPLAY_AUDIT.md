# Track A — Server Replay Hardening: Authoritative Audit + Contract Manifest

Scope: Full Offline Program, 1.0.37 track. Read-only audit of the **live staging** RPC
contracts (`azjxprewycygsocusxjn`) — the authoritative source (repo ≠ live). Prod
untouched. No migration applied.

## Headline

**The server replay foundation is ALREADY complete and verified. No hardening / no
migration is required.** The prior Desktop-audit inference ("money-movers have no reliable
client_op_id, no CAS, state-guarded only") is **stale** against the current live contracts.
Every money-mover and every table-lifecycle RPC Track C needs already routes through an
exactly-once replay foundation.

## The replay foundation (verified from live source)

- `pos_op_submissions` — ledger keyed UNIQUE `(tenant_id, client_op_id)`, holds
  `op_type, branch_id, entity_id, result_json, created_by, request_fingerprint`.
- `pos_op_replay(tenant, op, op_type, op_branch)` — takes
  `pg_advisory_xact_lock('pos_op:'||tenant||':'||op)` (serializes concurrent duplicates),
  returns the cached `result_json` if the op already ran, **rejects an op-id reused for a
  different op_type (22023)**, and enforces **strict branch equality → 42501
  `CROSS_BRANCH_REPLAY_REJECTED`** (fail-closed cross-OU).
- `pos_op_record(...)` — inserts the result `on conflict (tenant_id, client_op_id) do nothing`.
- Per-RPC pattern: public wrapper `pos_X(p_payload)` reads `client_op_id`; **null op-id →
  legacy passthrough to `pos_X_core`** (behaviourally identical to today); else
  replay-check → cached `{idempotent:true, result_code:DUPLICATE_REPLAY_RETURNED}` or run
  `pos_X_core` + `pos_op_record` → `{idempotent:false, result_code:SUCCESS}`. Wrapper +
  core + record run in ONE RPC transaction (the A3 boundary).
- `pos_X_core` locks the parent row(s) `FOR UPDATE`, re-validates state + `expected_version`
  (CAS → `VERSION_CONFLICT`), checks tenant/branch/permission, then mutates.

## A3 exactly-once contract — VERIFIED on `pos_pay_order` (representative money-mover)

| Contract case | Behaviour (from source) |
|---|---|
| First request | `pos_pay_order_core` runs; `pos_payments` inserted once; `{idempotent:false, SUCCESS}` |
| Exact duplicate (same op-id) | `pos_op_replay` returns cached result; core NOT re-run; **no second payment**; `{idempotent:true, DUPLICATE_REPLAY_RETURNED}` |
| Concurrent duplicate | advisory xact lock serializes; loser returns cached after winner commits → **one effect** |
| Already paid (other request) | core guard `payment_status='paid'` → `This order is already paid` (deterministic) |
| Voided/refunded | core guard → deterministic refusal |
| Version conflict | `expected_version` CAS → structured `VERSION_CONFLICT` |
| Cross tenant/OU | `pos_op_replay` strict branch equality + core `assert_branch_access` + `current_tenant_id` → reject |
| Permission revoked | core `can_user_permission('pos.take_payments')` → reject |

`pos_pay_table`, `pos_complete_on_account`, `pos_complete_table_on_account` share the
identical wrapper+core+replay shape (matrix: client_op_id ✓, pos_op ✓, expected_version ✓,
core FOR UPDATE ✓, state guard ✓/version ✓).

## Replay-safety classification (A0/A1)

Class A = exactly-once (op-id dedup); B = CAS/version safe; C = natural-idempotent;
D = requires hardening; E = unsafe for offline replay.

| RPC | Class | Notes |
|---|---|---|
| `pos_submit_order` | **A** | client_op_id dedup via `pos_order_submissions` + advisory lock; wraps `pos_save_order`. THE order-save path for offline replay. |
| `pos_open_table` (+core) | **A/B** | op-id dedup + `expected_version` CAS; returns `pos_entity_version`. |
| `pos_add_order_items` | **A/B** | op-id dedup + fingerprint + CROSS_ACTOR guard + version CAS; **delivery-only edit** (open/unpaid delivery order). |
| `pos_move_table` (+core) | **B** | op-id dedup + version CAS. Conflict-sensitive. |
| `pos_merge_tables_v3` | **A/B** | op-id dedup + core FOR UPDATE + expected-version map + part-paid state guard. Conflict-sensitive. |
| `pos_close_table` / `pos_clear_table` | **B** | op-id dedup + version CAS. |
| `pos_edit_order` / `pos_edit_order_line` / `pos_remove_order_item` / `pos_void_order` | **B** | op-id dedup + version CAS + core FOR UPDATE. |
| `pos_pay_order` / `pos_pay_table` / `pos_complete_on_account` / `pos_complete_table_on_account` | **A** | money-movers, fully hardened (see A3). |
| `pos_split_settle` (+core) | **B** | op-id dedup + core version CAS. |
| `pos_save_order` | **D (legacy-only)** | **NO client_op_id / NO dedup.** A blind replay double-creates/double-appends. MUST be reached only via `pos_submit_order` (which supplies the op-id). Not a server defect for current online use; a replay rule for Track C. |

## Cross-track CONTRACT MANIFEST (Track C consumes)

For every offline Dine-In operation, use these certified contracts. Every call MUST carry a
stable `client_op_id` (and `expected_version` where the RPC takes it) so replay is
exactly-once. The Phase-B op-log already supplies both.

| Phase-C op | Server RPC | op-id arg | version/CAS | result → canonical | conflict codes |
|---|---|---|---|---|---|
| DINEIN_OPEN_TABLE | `pos_open_table(p_payload)` | `client_op_id` in payload | `expected_version` (optional on create) | `{table_id, pos_entity_version}` | VERSION_CONFLICT; CROSS_BRANCH_REPLAY_REJECTED |
| DINEIN_ADD_ITEMS / DINEIN_SEND_ROUND (dine-in) | `pos_submit_order(p_payload)` | `client_op_id` in payload | advisory-lock dedup (pos_order_submissions) | `{order_id, order_number, batch_no, appended}` | idempotent flag; (append targets the open order for the table) |
| DINEIN_MOVE_TABLE | `pos_move_table(p_from,p_to,p_client_op_id,p_expected_version)` | positional | `p_expected_version` | `{...}` | VERSION_CONFLICT; CROSS_BRANCH_REPLAY_REJECTED |
| DINEIN_MERGE_TABLES | `pos_merge_tables_v3(p_payload)` | `client_op_id` in payload | expected-version map in payload | `{...}` | part-paid guard; VERSION_CONFLICT |
| DINEIN_CLOSE_OR_CLEAR | `pos_close_table` / `pos_clear_table(p_table,p_client_op_id,p_expected_version)` | positional | `p_expected_version` | `{...}` | VERSION_CONFLICT |

Replay class result shapes carry `idempotent` + `result_code`
(SUCCESS | DUPLICATE_REPLAY_RETURNED) for A-class, or structured error codes
(VERSION_CONFLICT, CROSS_BRANCH_REPLAY_REJECTED, CROSS_ACTOR_REPLAY_REJECTED,
IDEMPOTENCY_PAYLOAD_MISMATCH) the orchestrator maps to retry classes.

### Applied Track-A guard (2026-10-15, staging, Konan impl PASS sess_08778193)
`pos_save_order` now accepts an OPTIONAL `expected_order_id` in its payload (migration
`trackc_offline_expected_order_guard`, see `migrations/`). In the dine-in append branch,
under the existing `pos_table_bill` advisory lock + open-order `FOR UPDATE`, if
`expected_order_id` is provided and the table's current open order differs (or none is open),
it raises `EXPECTED_ORDER_MISMATCH` (22023). This gives Track C an ATOMIC server-side
expected-order binding so a later offline round cannot append to a remotely-closed/replaced
bill. Backward compatible (absent → unchanged); only Track-C offline rounds send it. Staging
only — prod unchanged; rollback = restore the prior definition (opt-in, zero data impact).

### Rules for Track C
1. **Never call `pos_save_order` directly for a replayable op** — always `pos_submit_order` with a `client_op_id`.
2. Dine-in round append targets the table's open order server-side; round 1 establishes the
   session's canonical **order_id**, and rounds ≥2 MUST pass `expected_order_id` = that order_id
   so the server atomically binds the append (or refuses with `EXPECTED_ORDER_MISMATCH`).
3. MOVE / MERGE are Class B but conflict-sensitive → Phase-C conflict model (C9/C11), not
   a blind last-writer-wins.
4. Actual payment / split-settle (C10) stays OUT of Phase C by the GO (scope), not by
   server-unsafety — the contracts are certified and available for a later phase.

## A7 output

- SERVER_HARDENING_SHA: **n/a — no server change** (verification only).
- STAGING_MIGRATIONS: **none** (not required).
- RPC matrix before/after: unchanged (already hardened).
- Exactly-once / CAS / grant / RLS / accounting / inventory: verified via live source +
  the established `pos_op_*` foundation; no new code to prove.
- PRODUCTION_UNTOUCHED: yes — read-only reads against staging only.
