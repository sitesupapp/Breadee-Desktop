# Breadee Desktop — status

_Source of truth: the Breadee web app (Next.js 16 + Supabase). This desktop client reuses the same Supabase backend, RLS, tenants, branches, roles, permissions._

## 0. Where the project lives

- **Active repository:** `D:\Claude\Projects\Breadee\Breadee-Desktop` (branch `desktop-staging`).
- **Level 1 worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-1` (branch `feature/desktop-pos-level-1`) — **merged**, kept for reference.
- **Level 2A worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-2A` (branch `feature/desktop-pos-level-2a-tables`) — **merged** as `c8ccbb5` via PR #4, kept for reference.
- **Level 2B worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-2B` (branch `feature/desktop-pos-level-2b-rounds`) — **merged** as `27410bb` via PR #5, kept for reference.
- **Level 2C worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-2C` (branch `feature/desktop-pos-level-2c-table-ops`).
- `C:\Users\User\Claude\Projects\Breadee\Breadee-Desktop` is a **read-only fallback copy** of the pre-migration state. Do not work in it.
- GitHub remote: `github.com/sitesupapp/Breadee-Desktop` (the repo exists and `desktop-staging` is pushed — an earlier version of this document said otherwise).

## 1. Level 1 — POS foundation (merged)

Merged into `desktop-staging` as `4c60155`, with the CI gate hardening that followed it (`2466a67`, `408d528`):

- **Desktop UI foundation** — measured-width layout system (`lib/layout.ts`), navigation rail, fixed operational status bar, category strip, windowed menu grid, persistent cart, modal + drawer + toast systems, skeleton/empty/error states, route-level error boundary, keyboard provider with an F1 sheet, 44px minimum touch targets, window state persistence and fullscreen.
- **Correct POS access** — `lib/pos/access.ts` replaces the old role-list gate. Access is `pos` feature + `pos.access` permission + active membership, with tenant **owners excluded** (mirroring `pos_assert_operator`, m93). Payment, discount, order-creation, open-shift and end-shift each have their own permission gate; refused controls stay visible with the reason. The old `canUsePOS`/`canOpenShift`/`canApproveShift`/`canViewReports` role helpers were **removed**, not deprecated.
- **Real tenant/branch context** — branch resolved as the web app does (`all_branches ? main_branch_id : branch_id ?? main_branch_id`) and displayed by **name**; the operator is shown by profile name. No UUID fragments in the UI.
- **Shift foundation** — open shift with optional opening float, active-shift detection, live cash box, expected-cash preview, end shift with counted cash and note, and the `pending_manager_review` outcome. All figures come from `pos_open_shift` / `pos_shift_expected` / `pos_cash_box_shift` / `pos_end_shift`; the client computes no financial totals.
- **Takeaway reference route** — categories, search, current prices via the canonical resolver, required/optional modifiers with price deltas, kitchen notes, undoable line removal, discounts, USD/LBP with tendered and change, payment, and a receipt preview.
- **Order contract fixed** — submission now goes through **`pos_submit_order`** (m224) with a stable **`client_op_id`** per logical order, and **every order carries a non-null `shift_id`**. The previous implementation called `pos_save_order` with no shift, which could never be paid (`_pos_lock_open_shift`, m149) and was invisible to the cash box and shift report.

## 1a. Level 2A — Dine-In table foundation (this change set)

On `feature/desktop-pos-level-2a-tables`, local only (not pushed, no PR). This level makes a table **reachable and readable**; it deliberately does not make it orderable or payable.

- **Submit contract extended** — `SubmitOrderPayload` gains an optional `table_id`, and `buildSubmitPayload` now **throws `TableRequiredError`** for a `dine_in` order without one. m218 keys the single-active-bill lookup on `table_id`: a dine-in submit that omits it does not fail loudly, it silently opens a *second* bill on the same table. That is now unrepresentable. The takeaway payload is byte-for-byte unchanged — `table_id` is **absent**, not null.
- **Table permissions** — `pos.tables.view` / `.open` / `.move` / `.clear` / `.close` in `POS_PERMISSIONS`; `canViewTables` (POS access → `pos.dine_in` sub-feature → `pos.tables.view`) and `canOpenTable`. Owners are excluded here as everywhere else.
- **DESKTOP POLICY: opening a table requires an open shift**, although `pos_open_table` itself does not. Opening a table with no shift yields a table that cannot then be ordered on, and Clear/Close are out of scope until Level 2C. This is deliberately *stricter* than the server and never looser.
- **Typed `pos_table_map` reader** (`lib/pos/tables.ts`) — defensive per-row parsing (a malformed row is dropped, the map survives), the tenant's table name used **verbatim**, and a total the server declined to sum kept **null** rather than rendered as `0.00`.
- **Server-owned bill reader** (`lib/pos/tableBill.ts`) — READ ONLY. Re-reads `pos_orders` + items + modifiers for the table, groups lines by the server's `batch_no`, and inherits the server's two refusals: a mixed-currency bill has no total at all (m214), and a bill spanning shifts is flagged because `pos_pay_table` would refuse it. The cart is never shown as the bill.
- **Table state + UI** — `state/tables.ts` (map, selection, bill, freshness; a context change invalidates immediately), `TableMap`, `TableCard`, `TableBillPanel`, `SeatCountDialog`, and `DineInWorkspace`. The table grid uses the **same measured-width resolver** as Takeaway, so display scaling behaves identically on both routes.
- **Dine-In route enabled** — Takeaway and Dine-in share one `PosShell` instance and switch a *mode*, not a router route, so there is one status bar, one layout resolver and one set of shift/menu subscriptions. Takeaway's shortcut layer is disabled while Dine-in is active, so a shared key never has two owners.
- **Deferred actions are rendered honestly, and disabled structurally** — Add items / Submit round / Move / Close / Clear / Pay are declared once in `lib/pos/dineInActions.ts` and render as disabled controls naming the level that delivers them. They have no handler and no reachable RPC: `pos_move_table`, `pos_close_table`, `pos_clear_table` and `pos_pay_table` are absent from the `PosRpcName` union, so `callPosRpc` will not accept them.
  - The shell's bottom bar shares the **Pay slot** between modes. Its disabled state is now decided by `dineInBottomBar()`, whose `payDisabled` is typed as the literal `true` — widening it to `false` is a compile error, not a review question. An earlier revision of this level briefly set that literal to `false`; the handler was a drawer-open and no financial write was ever reachable, but an enabled control in the pay position is not an acceptable resting state, and `test/pos-dine-in-actions.test.ts` now pins all three layers (decision, wiring, reachability).

Explicitly **not** in Level 2A: dine-in ordering, rounds/batches, kitchen submission, Move/Close/Clear, dine-in payment, offline table state, and Levels 2B–2E.

## 1b. Level 2B — Dine-In ordering and rounds (this change set)

On `feature/desktop-pos-level-2b-rounds`, local only (not pushed, no PR). Level 2A made a table reachable and readable; Level 2B makes it **orderable**, up to kitchen submission and no further.

**The cart is a round buffer. The bill belongs to the server.**

```
table selected -> Add Items -> local round buffer -> pos_submit_order with table_id
  -> server appends to (or creates) the active bill -> buffer clears -> bill re-read
```

There is deliberately no client-owned table bill anywhere, and `batch_no` is never computed locally. m218 resolves the single active dine-in bill from `table_id` under an advisory lock and assigns the batch itself — a client that guessed would be wrong the moment a second cashier served the same table.

- **Add Items mode** (`2B-01`) — gated on POS access + dine-in feature + `pos.tables.view` + `pos.create_orders` + an open shift + a selected table + an online connection. It does **not** consult payment permission. The main work area switches from the table map to the existing menu; the table, its bill and the round stay on the right. Add Items never leaves the shell, so there is one status bar and one layout resolver.
- **One menu, not two** — Takeaway and Add Items render the *same* `MenuItemGrid`, `CategoryNavigation`, `ModifierDialog` and `LineNoteDialog`. A second menu would be a second place for prices to drift.
- **One cart, with an owner** (`state/cart.ts`) — reusing the single cart store as the round buffer makes ownership load-bearing. `CartOwner` records whether the buffer belongs to Takeaway or to a specific table, and a claim from anyone else is refused. Without it, half-built takeaway lines would end up on a table's kitchen ticket.
- **Round contract** (`lib/pos/tableRounds.ts`) — every payload carries `order_type: dine_in`, `table_id`, `shift_id`, the resolved branch, items, modifiers and notes, and one `client_op_id`. It carries **no order id**: asserting which bill is active is exactly the decision that must stay on the server. Building fails locally — before any request exists — without a table, shift, branch, items, a connection, or with an unanswered required modifier group.
- **Per-round idempotency** (`2B-03`) — one operation id per logical round: minted when the first line lands in an empty buffer, reused for every retry, and cleared **only** by the buffer reset that follows a definitively accepted round. Round 2 therefore cannot inherit round 1's id, and a retry replays under m224 instead of appending a duplicate batch.
- **The submit sequence is stated once and tested** — `ROUND_SEQUENCE` is `build → submit → clear-buffer → refresh`, implemented by `performRound()`. The ordering is the safety property: clearing the buffer after a *failure* would destroy a round the kitchen never saw and the cashier can no longer reconstruct.
- **Bill panel** (`2B-06`) — batches are labelled from the server's own numbers ("Sent round 1", "Sent round 2"), alongside order number, status, payment status, split-shift flag and totals. In Add Items the unsent round sits in a dashed, differently-coloured box labelled "Round being prepared", above a "Current bill" section. An unsent round is never drawn as though it were already owed.
- **Unsent rounds are never discarded silently** — leaving Add Items with lines buffered opens a confirmation whose default action *keeps* the round.
- **Concurrency** — the bill is re-read on entering Add Items and again after every submit, and `describeBillChange()` tells the operator what moved under them (another cashier's round, a changed order number, a settled bill) rather than absorbing it silently.

### Explicitly still deferred

Move, Close, Clear and Pay remain disabled with no click handler, and `pos_move_table`, `pos_close_table`, `pos_clear_table` and `pos_pay_table` remain absent from `PosRpcName`. Also out of scope: dine-in receipts, table configuration, editing or voiding a submitted round, delivery, and Levels 2C–2E.

### Online only

Dine-in ordering is online-only. `OfflineOrderingError` refuses a round outright — nothing is enqueued, the Dexie schema is untouched, and sync replay remains disabled (every handler still returns `review`, and `enqueue()` still has zero call sites). Offline, the cached menu and table map stay readable and Add Items / Submit round are disabled with the reason.

### Staging verification status

**Deferred to Level 2C, by design.** The Level 2B smoke test opens a table and submits two rounds, and Level 2B cannot pay, clear, close or move a table afterwards — so the test table would have stayed occupied with an unsettleable bill. Level 2C provides Clear, which is the cleanup path; the combined smoke test runs there.

## 1c. Level 2C — Dine-In table operations (this change set)

On `feature/desktop-pos-level-2c-table-ops`, local only (not pushed, no PR). Level 2B made a table orderable; Level 2C makes a bill **movable and disposable** — but still not payable.

The three contracts were read from the **staging definitions**, not inferred:

| RPC | What it does | Refuses |
|---|---|---|
| `pos_move_table(p_from, p_to)` | Moves every open unpaid order to the destination; frees the source, occupies the target. | Same table, different tenants, an occupied destination, a source with no open order. |
| `pos_close_table(p_table)` | Completes already-**paid** orders and frees the table. | **Any unpaid order** — *"Pay the table bill first, or clear the table"*. |
| `pos_clear_table(p_table, p_reason)` | **VOIDS** every open unpaid order, stamps `cancelled_by`/`cancelled_at`, appends `[cleared: reason]`, writes a `table_cleared` activity log, frees the table. | Nothing — it always succeeds, which is precisely why it is confirmed so heavily. |

- **Permissions** — `canMoveTable` / `canCloseTable` / `canClearTable`, each mirroring the `_pos_require(tenant, 'pos.tables.X')` the RPC itself runs. Table view is a prerequisite for all three; owners stay excluded.
- **DESKTOP POLICY 1 — a reason is mandatory for Clear.** The server accepts an empty one and writes a bare `[cleared]`: an audit row recording that money was voided and nothing about why. That is indistinguishable from theft after the fact, so the desktop refuses to send one. Enforced in the dialog *and* in `clearTable()`, so no caller can skip it.
- **DESKTOP POLICY 2 — all three require an open shift**, though none of the RPCs demand it. Each mutates open orders belonging to a shift; doing so with no shift of your own leaves the change attributable to a person but not to a till.
- **Confirmations sized to consequence** — Move lists only *free* destinations; Close predicts the server's refusal before the button is pressed; Clear names the amount that will not be collected, says **VOIDS**, requires typing, and carries an Audited badge.
- **Separation** — Move and Close sit together; Clear is below a dashed rule, styled `danger`. Pay remains a disabled placeholder.
- **Keyboard** — `Ctrl+Shift+M` Move, **`Alt+C`** Close, `Ctrl+Shift+X` Clear. Every chord *opens a confirmation*; none performs the operation. Two corrections this level forced: Close moved **off `Ctrl+Shift+C`** (the Chromium DevTools inspector, which the Tauri webview inherits — it would have been eaten in development and in a devtools-enabled build), and none of the three is `worksInInput` any more, so a chord cannot fire from inside the table search box or the Clear dialog's own reason field.
- **No local patching** — `runOp` refreshes the map and re-reads the bill after every operation. A cleared table still showing as occupied would invite a second clear of a bill that is already void.

The RPC allow-list grows from 8 names to **11**. `pos_pay_table` is deliberately **not** among them.

## 2. Toolchain

The Rust/MSVC toolchain **is installed** on the development machine (an earlier version of this document said it was missing). `tauri info` reports: MSVC (VS Build Tools 2019), rustc 1.96.1, cargo 1.96.1, rustup 1.29.0, WebView2 151, tauri 2.11.5. A native `tauri build` has still not been produced or verified.

## 3. Explicitly NOT implemented

- **Offline order capture — not implemented.** (An earlier version of this document claimed POS orders were captured into the outbox offline. They were not, and still are not.) Offline blocks ordering with a clear message; the menu remains readable from cache.
- **Sync replay — intentionally disabled.** Every handler still returns `review`; nothing is pushed. It must stay that way until the outbox carries `client_op_id` + `shift_id`, and conflict/idempotency rules are in place.
- **Native printing — pending.** The receipt preview is on-screen only; the Print control is disabled rather than silently doing nothing. Printer discovery, routing to hardware and ESC/POS are untouched.
- **Dine-in settlement — not implemented.** Level 2C moves, closes and clears a table, but **cannot pay one**. `pos_pay_table` is still absent from `PosRpcName`, and Close refusing an unpaid bill is the server saying settlement is missing — that refusal is surfaced with its own hint, never worked around.
- Delivery, customers, orders workspace, edit/void/refund, reports, KDS, loyalty, Google OAuth deep-link, encrypted local storage.

## 4. Security checklist

- [x] Anon key only; no service_role in app or repo.
- [x] No raw passwords / secrets in local files; `.env*` git-ignored (`.env.example` only).
- [x] Env guard rejects a service_role key; warns on prod env.
- [x] All data via Supabase RLS; the client is never the authorization boundary.
- [x] Owners cannot enter the operational POS; every action re-checked server-side.
- [x] No order can be created without an open shift.
- [x] No dine-in order can be created without a table (`TableRequiredError`), so m218's single-bill rule cannot be bypassed.
- [x] One `client_op_id` per logical round; a retry replays under m224 rather than adding a batch.
- [x] The dine-in round path reaches no offline queue - `enqueue()` still has zero call sites.
- [x] Table mutation RPCs beyond `pos_open_table` are not reachable from the client — they are not in the `PosRpcName` union.
- [x] No production migration; production Supabase untouched.
- [ ] Local IndexedDB is not yet encrypted at rest.
- [ ] Audit records are local-only until sync RPC wiring lands.

## 5. Known gaps / risks

- **Generated DB types are stale.** `src/lib/database.types.ts` predates m212/m213 (price metadata) and m216/m224 (`pos_submit_order`, `pos_void_order.p_refund`). POS RPCs therefore go through the single documented boundary in `lib/pos/rpc.ts`, and the two menu selects re-type their rows. Regenerating the schema types is the clean fix.
- **Google OAuth** needs a registered redirect + a Tauri deep-link handler. Email/password is the working path.
- **Native build not verified** — `tauri build` has not been run here.
- **SPA vs web app parity**: gating and data loading are re-implemented client-side and must be kept in step with the web app.

## 6. Running it

`npm install` (once) → `npm run dev` (http://localhost:5173). `npm run typecheck`, `npm run test`, `npm run build`. Tests use Node's built-in runner with its native TypeScript support — no test framework dependency is installed. Node ≥ 22.18 is required for the runner's TypeScript support; CI pins Node 24.

Current gate results on `feature/desktop-pos-level-2c-table-ops`: **265 tests, 0 failures**; typecheck clean; production build clean.

Note on this machine: roughly one process spawn in three dies with `EPERM uv_spawn`, `0xC0000005`, `Access is denied` or esbuild's `The service was stopped`. A test *file* reported as failed while listing no failing assertion is that crash, not a real failure — re-run the file alone to tell them apart.

## 7. Pull request

Not opened. Level 2C is local-only by instruction; integration into `desktop-staging` is a separate task.
