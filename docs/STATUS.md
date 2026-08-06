# Breadee Desktop — status

_Source of truth: the Breadee web app (Next.js 16 + Supabase). This desktop client reuses the same Supabase backend, RLS, tenants, branches, roles, permissions._

## 0. Where the project lives

- **Active repository:** `D:\Claude\Projects\Breadee\Breadee-Desktop` (branch `desktop-staging`).
- **Level 1 worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-1` (branch `feature/desktop-pos-level-1`) — **merged**, kept for reference.
- **Level 2A worktree:** `D:\Claude\Projects\Breadee\Breadee-Desktop-Level-2A` (branch `feature/desktop-pos-level-2a-tables`).
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

## 2. Toolchain

The Rust/MSVC toolchain **is installed** on the development machine (an earlier version of this document said it was missing). `tauri info` reports: MSVC (VS Build Tools 2019), rustc 1.96.1, cargo 1.96.1, rustup 1.29.0, WebView2 151, tauri 2.11.5. A native `tauri build` has still not been produced or verified.

## 3. Explicitly NOT implemented

- **Offline order capture — not implemented.** (An earlier version of this document claimed POS orders were captured into the outbox offline. They were not, and still are not.) Offline blocks ordering with a clear message; the menu remains readable from cache.
- **Sync replay — intentionally disabled.** Every handler still returns `review`; nothing is pushed. It must stay that way until the outbox carries `client_op_id` + `shift_id`, and conflict/idempotency rules are in place.
- **Native printing — pending.** The receipt preview is on-screen only; the Print control is disabled rather than silently doing nothing. Printer discovery, routing to hardware and ESC/POS are untouched.
- **Dine-in ordering and payment — not implemented.** Level 2A shows the table map and the server's open bill; it cannot add a round, submit to the kitchen, move, close, clear or settle a table.
- Delivery, customers, orders workspace, edit/void/refund, reports, KDS, loyalty, Google OAuth deep-link, encrypted local storage.

## 4. Security checklist

- [x] Anon key only; no service_role in app or repo.
- [x] No raw passwords / secrets in local files; `.env*` git-ignored (`.env.example` only).
- [x] Env guard rejects a service_role key; warns on prod env.
- [x] All data via Supabase RLS; the client is never the authorization boundary.
- [x] Owners cannot enter the operational POS; every action re-checked server-side.
- [x] No order can be created without an open shift.
- [x] No dine-in order can be created without a table (`TableRequiredError`), so m218's single-bill rule cannot be bypassed.
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

Current gate results on `feature/desktop-pos-level-2a-tables`: **169 tests, 0 failures**; typecheck clean; production build clean.

Note on this machine: roughly one process spawn in three dies with `EPERM uv_spawn`, `0xC0000005`, `Access is denied` or esbuild's `The service was stopped`. A test *file* reported as failed while listing no failing assertion is that crash, not a real failure — re-run the file alone to tell them apart.

## 7. Pull request

Not opened. Level 2A is local-only by instruction; integration into `desktop-staging` is a separate task.
