# Ready Desktop 1.0.37 — production rollout / rollback runbook

Scope: production DB contracts `desktop_1037_offline_contracts` (prod `cltlqfqormkhppmbvyrv`) and the
signed 1.0.37 updater release on `desktop-production-channel`. Fix-forward is the default recovery.

## 1. Order (each step is a gate; stop on any failure)

1. **Server first.** `apply_migration desktop_1037_offline_contracts` with
   `docs/offline/migrations/prod_1037_offline_contracts.sql` (one transaction; PRE md5 guards abort on
   any drift, POST guards abort on any ACL/SECDEF/search_path/owner/overload deviation → nothing applied).
   Server-first is required: the contracts are optional/additive, so the existing fleet (web, Desktop
   1.0.36, AI void pack) is unaffected, and 1.0.37 must never meet a server without them.
2. **Post-apply verification** (read-only): new body md5s equal the rehearsal (`save 072c8db8…`,
   `insert 1b64ea09…`, `void fc11408d…`, `core 99f5839b…`); `pos_order_item_map` md5 equals staging
   (`48efe872…`, byte-identical body); ACLs equal the pre-images; column nullable/no default; ledger row
   present; no rows changed in `pos_orders` / `pos_order_items` / `pos_payments` by the migration.
3. **Signed build** of the reviewed SHA via the existing Production-environment build-only workflow
   (existing minisign key; human environment approval). Verify minisign signature against the
   production pubkey + SHA256.
4. **Update-in-place proof** on a Windows runner: install production 1.0.36 → in-app update to the
   signed 1.0.37 served through a local channel redirect → version, `%LOCALAPPDATA%\app.breadee.desktop`
   data folder, WebView2 IndexedDB and a seeded marker preserved.
5. **Publish:** GitHub Release `desktop-prod-v1.0.37` (exe, sig, SHA256SUMS) → channel checkpoint commit
   (preserves the 1.0.36 `latest.json`) → `latest.json` advance (bilingual notes, signature, URL).
6. **Post-publish verification:** manifest = 1.0.37, URL resolves, downloaded bytes match SHA256 and the
   signature, identity `app.breadee.desktop`, production Supabase URL, no staging config.

## 2. Compatibility window (mixed fleet)

| Client | Server before step 1 | Server after step 1 |
| --- | --- | --- |
| Web (prod) | unchanged | unchanged — named-arg subset of void params resolves via the trailing DEFAULT; never sends `expected_order_id` / `client_line_id` |
| Desktop 1.0.36 | unchanged | unchanged — same as web |
| AI void pack (dark) | unchanged | unchanged |
| Desktop 1.0.37 | **never exposed** (server-first order) | full offline contracts |

PostgREST: the migration ends with `notify pgrst, 'reload schema'`; even before the reload, a cached
5-param call shape still resolves in Postgres because the new parameter has a default.

## 3. Health checks after each step

- Postgres logs (prod): no `function ... does not exist` / `ANCHOR` / `POST:` errors for
  `pos_void_order`, `pos_save_order`, `pos_order_item_map`.
- Normal POS activity continues (new `pos_orders` rows) after the migration — read-only count only.
- After publish: channel `latest.json` served = 1.0.37; GitHub release asset download count rising
  (adoption); no spike of `EXPECTED_ORDER_MISMATCH` / `REFUND_*` beyond offline usage.

## 4. Safe-stop conditions

- Any PRE/POST guard failure (migration aborts; nothing applied) → SAFE STOP, investigate drift.
- Signing key unavailable / signature fails verification → SAFE STOP, do not publish.
- Update-in-place proof fails (data folder / IndexedDB / marker / version) → SAFE STOP, do not publish.
- Post-publish mismatch (SHA/signature/identity) → restore the checkpoint manifest (§5.2) immediately.

## 5. Rollback / recovery

### 5.1 Server

**Before 1.0.37 is published to the production channel (no terminal can have adopted it):**
`docs/offline/migrations/prod_1037_offline_contracts_ROLLBACK.sql` may be used (rehearsed on
production in a rolled-back transaction: restores byte-identical pre-image bodies and ACLs). It
refuses to run unless the same transaction sets
`set local breadee.rollback_1037_ack = 'PRE_PUBLICATION_NO_ADOPTION'`, and it refuses if any
`pos_order_items.client_line_id` is non-NULL (1.0.37 adoption evidence).

- It **keeps** `pos_order_items.client_line_id`; it drops `pos_order_item_map` (read-only; no data).

**After publication: the exact-pre-image rollback is PROHIBITED — fix-forward only.**
Reason: it would remove the C1 `EXPECTED_ORDER_MISMATCH` guard while installed 1.0.37 terminals
(which cannot be downgraded) keep sending `expected_order_id` on offline dine-in rounds ≥ 2; the
restored 1.0.36 body ignores that field, so a queued round whose original bill was closed or replaced
would be silently appended to another open bill for the table.

Post-publication recovery if a contract is proven harmful:
- write a targeted, reviewed fix-forward migration that changes ONLY the harmful contract and keeps
  C1 (and every other contract 1.0.37 depends on) in place; same PRE/POST guard discipline; Konan
  review; explicit human GO;
- never remove `p_expected_refund_usd` from `pos_void_order` while 1.0.37 is in the field (offline
  refund replays would fail "function not found" — fail-closed to needs_attention, but avoidable);
- the client side recovers via 1.0.38 on the same channel (§5.2).

### 5.2 Desktop updater channel

- **Stop the rollout:** restore `latest.json` from the checkpoint commit (the 1.0.36 manifest). Clients
  still on 1.0.36 stop being offered 1.0.37.
- **No downgrade:** the Tauri updater only installs a strictly higher version, so terminals already on
  1.0.37 stay on 1.0.37. This is intended — the local Dexie DB is v11 (a superset of v4) and is never
  opened by 1.0.36 code, so no v11→v4 path is needed or attempted. Tenant data is never deleted.
- **Recovery:** fix-forward 1.0.38 through the same channel, same key, same proof gates.

### 5.3 Queued offline operations

Offline operations live in the device's `operations` store and are replayed exactly-once by
`client_op_id`. A channel restore never deletes them; a refused replay is parked in
`needs_attention`, visible in the Sync Center, and never auto-discarded. (Server-side, the C1 guard is
never removed after publication — §5.1 — so a stale dine-in round is always refused, never misrouted.)
